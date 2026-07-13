#!/usr/bin/env bash
# bot-cred-refresh-inplace.sh — 手动【原地】刷新 ~/.claude/.credentials.json
#
# 与 bot-cred-refresh.sh(temp 刷新)的区别:直接在默认文件上刷新,成功时文件始终
# "token 与 RT 配套一致",不会留下"token 在、RT 已被轮换死"的错配(21:06 掉线的坑)。
# 代价:原地刷新失败时 claude 会把文件清空(登出行为)→ 本脚本用【备份+校验+回滚】兜底:
#   备份 → 伪过期 → claude 刷新 → 校验(非空/有效/token 变了) → 成功:播种; 失败:从备份回滚。
#
# 机制铁律(今日实测):
#   · CLAUDE_CONFIG_DIR 一设 = 文件模式,claude 只读写该目录的 .credentials.json、不碰 keychain。
#     这里指向 $HOME/.claude 本身 → 原地写文件、保证不重建 keychain。
#   · keychain 里【必须没有】Claude Code-credentials 条目,否则别的 native 进程会走 keychain 分裂。
#   · 刷新会轮换 refresh token → 运行中、手握旧 RT 的进程(bot/cc-connect/GUI/本会话)之后自刷会失败
#     并清空自己 → 所以刷新成功后应 SUSPEND=1 逼 bot 冷启动重读(本脚本管不到 GUI/独立会话,见末尾)。
#
# 用法:
#   scripts/bot-cred-refresh-inplace.sh              # 刷新 + 播种隔离bot(不 suspend)
#   SUSPEND=1 scripts/bot-cred-refresh-inplace.sh    # 刷新 + 播种 + botmux suspend all(推荐)
#   SEED=0   scripts/bot-cred-refresh-inplace.sh     # 只刷新默认文件,不播种隔离bot
# 退出码: 0=刷新成功  1=刷新失败(已回滚,live 未损)  2=前置缺失  3=keychain 有条目(拒跑)

set -uo pipefail

CRED="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
KC_SVC="${CLAUDE_KEYCHAIN_SERVICE:-Claude Code-credentials}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
BOTMUX_BIN="${BOTMUX_BIN:-$(command -v botmux || echo "$HOME/.botmux/bin/botmux")}"
SEED="${SEED:-1}"          # 1=把新凭证播种到 ~/.botmux/bots/*/claude/.credentials.json
SUSPEND="${SUSPEND:-0}"    # 1=刷新成功后 botmux suspend all(逼运行中进程冷启动重读)
BK="$CRED.bak-$(date '+%Y%m%d-%H%M%S')"

log(){ printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# 只打指纹,绝不打原始 token
fp(){ node -e 'try{const o=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth)||{};const a=o.accessToken||"";const l=o.expiresAt?Math.round((Number(o.expiresAt)-Date.now())/60000):"?";console.log((a?require("crypto").createHash("sha256").update(a).digest("hex").slice(0,12):"EMPTY")+" 剩"+l+"m")}catch(e){console.log("READ-ERR")}' "$1"; }
# 全指纹(仅用于比较,不打印)
accfp(){ node -e 'try{const a=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth||{}).accessToken||"";console.log(a?require("crypto").createHash("sha256").update(a).digest("hex"):"")}catch(e){console.log("")}' "$1"; }
# 有效 = accessToken/refreshToken 非空 且 expiresAt 在 5 分钟后
valid(){ node -e 'try{const o=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth)||{};process.exit((o.accessToken&&o.refreshToken&&Number(o.expiresAt)>Date.now()+300000)?0:1)}catch(e){process.exit(1)}' "$1"; }

# ── 前置检查 ──
[ -n "$CLAUDE_BIN" ] || { log "❌ 找不到 claude 可执行"; exit 2; }
[ -f "$CRED" ] || { log "❌ 凭证文件不存在: $CRED — 先在 SSH 里 /login"; exit 2; }

# keychain 铁律:条目必须不存在
if command -v security >/dev/null 2>&1 && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
  log "❌ keychain 条目【存在】—— 原地刷新可能被 native 路径写进 keychain 造成分裂。"
  log "   请先在 GUI Terminal 删:  security delete-generic-password -s \"$KC_SVC\""
  exit 3
fi

log "起点: $(fp "$CRED")"

# ── 刷新时机门:默认只在接近到期时刷新(cron 友好),FORCE=1 / --force 无条件刷新(手动用)──
FORCE="${FORCE:-0}"
[ "${1:-}" = "--force" ] && FORCE=1
MARGIN_MIN="${MARGIN_MIN:-90}"
LEFT="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;console.log(Math.round((Number(o.expiresAt)-Date.now())/60000))}catch(e){console.log(-99999)}' "$CRED")"
if [ "$FORCE" != 1 ] && [ "${LEFT:-0}" -gt "$MARGIN_MIN" ] 2>/dev/null; then
  log "剩余 ${LEFT}m > 阈值 ${MARGIN_MIN}m → 无需刷新(no-op)。手动强刷加 --force 或 FORCE=1"
  exit 0
fi
log "剩余 ${LEFT}m ≤ 阈值 ${MARGIN_MIN}m(或 --force)→ 执行刷新"

# ── 备份 ──
cp -p "$CRED" "$BK" || { log "❌ 备份失败,中止"; exit 2; }
log "已备份 → $BK"
OLDFP="$(accfp "$BK")"

# .claude.json 防缩水:CLAUDE_CONFIG_DIR=$HOME/.claude 会让 claude 读写 .claude.json,
# 历史上出现过它被重建/缩水(972 projects→1、onboarding 丢)。跑前备份 + 跑后核对项目数骤降则回滚。
CFG="$HOME/.claude/.claude.json"
CFGBK="$CFG.credrefresh-bak"
projcount(){ node -e 'try{console.log(Object.keys((JSON.parse(require("fs").readFileSync(process.argv[1])).projects)||{}).length)}catch(e){console.log(-1)}' "$1"; }
CFGN0=-1
if [ -f "$CFG" ]; then cp -p "$CFG" "$CFGBK" && CFGN0="$(projcount "$CFG")" && log ".claude.json 已备份(projects=$CFGN0)"; fi

# ── 伪过期(原地),逼 claude 刷新 ──
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.claudeAiOauth.expiresAt=Date.now()-3600000;fs.writeFileSync(p,JSON.stringify(j))' "$CRED" \
  || { log "❌ 伪过期写入失败,从备份回滚"; cp -p "$BK" "$CRED"; exit 2; }
log "已伪过期,触发 claude 原地刷新(CLAUDE_CONFIG_DIR=\$HOME/.claude,文件模式)…"

# ── 刷新(强制文件模式在默认目录;keychain 空 → 写文件)──
OUT="$(mktemp)"
CLAUDE_CONFIG_DIR="$HOME/.claude" perl -e 'alarm 90; exec @ARGV' "$CLAUDE_BIN" -p "reply with exactly: OK" </dev/null >"$OUT" 2>&1
RC=$?
HEAD="$(head -2 "$OUT" 2>/dev/null)"; rm -f "$OUT"

# .claude.json 缩水守卫:项目数骤降(<跑前一半)则从备份回滚(与凭证成败无关,claude 失败也可能缩)
if [ -f "$CFG" ] && [ -f "$CFGBK" ] && [ "${CFGN0:-0}" -gt 10 ]; then
  CFGN1="$(projcount "$CFG")"
  if [ "${CFGN1:-0}" -lt $((CFGN0 / 2)) ] 2>/dev/null; then
    cp -p "$CFGBK" "$CFG" && log "⚠️ .claude.json 项目数骤降 ${CFGN0}→${CFGN1},已从备份回滚(config 保住)"
  fi
fi

# ── 校验 & 决策 ──
NEWFP="$(accfp "$CRED")"
if valid "$CRED" && [ -n "$NEWFP" ] && [ "$NEWFP" != "$OLDFP" ]; then
  log "✅ 刷新成功: $(fp "$CRED")   (claude rc=$RC out=$HEAD)"

  # keychain 复核(不该出现)
  if command -v security >/dev/null 2>&1 && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
    log "⚠️ 刷新后 keychain 竟出现条目! 建议 GUI 删除: security delete-generic-password -s \"$KC_SVC\""
  fi

  # 播种隔离 bot
  if [ "$SEED" = 1 ]; then
    for d in "$HOME"/.botmux/bots/*/claude/.credentials.json; do
      [ -e "$d" ] || continue
      cp "$CRED" "$d.tmp.$$" && chmod 600 "$d.tmp.$$" && mv -f "$d.tmp.$$" "$d" \
        && log "  ↳ seed $(echo "$d" | sed -E 's#.*/bots/##; s#/.*##')"
    done
  fi

  # 逼运行中进程冷启动重读(否则它们仍握旧 RT,之后自刷会失败→清空→掉线)
  # 注意:suspend all 常因个别 session_not_active 返回非0,不能用 `cmd && log`(会吞掉状态行)
  if [ "$SUSPEND" = 1 ]; then
    if [ -x "$BOTMUX_BIN" ]; then
      if "$BOTMUX_BIN" suspend all >/dev/null 2>&1; then
        log "  ↳ botmux suspend all 完成(逼冷启动重读新 token)"
      else
        log "  ↳ botmux suspend all 已执行(返回非0,通常是个别 session_not_active,无碍);建议瞄一眼 bot"
      fi
    else
      log "  ⚠️ SUSPEND=1 但找不到可执行 botmux($BOTMUX_BIN),已跳过 —— 请手动 'botmux suspend all'"
    fi
  else
    log "  ℹ️ 未 suspend(SUSPEND=0):运行中的 bot/cc-connect 仍握旧 RT,建议手动 'botmux suspend all'"
  fi

  log "完成。备份保留 $BK(确认无误可删)。"
  log "  ⚠️ 注意:本脚本管不到 GUI 里的 claude / 独立 Claude Code 会话——它们仍握旧 RT,"
  log "     到期自刷会失败并可能清空 ~/.claude。这就是共享 OAuth 的根本脆弱点。"
  exit 0
else
  # 失败:回滚,保证 live 不被留空/伪过期
  cp -p "$BK" "$CRED" && log "❌ 刷新失败/无效(claude rc=$RC out=$HEAD) — 已从备份回滚: $(fp "$CRED")"
  log "   若刚才别处已轮换过 RT,回滚的 RT 可能已死;access token 通常仍可用一阵,必要时重新 /login。"
  exit 1
fi
