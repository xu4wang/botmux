#!/usr/bin/env bash
# cred-contract-audit.sh — 【完全被动】审计 OAuth 刷新所依赖的两个外部常量是否还成立。
#
# 监控对象（bot-cred-refresh-oauth.sh 的两个外部假设）：
#   ① client_id  9d1c250a-… 仍存在于 claude 二进制中
#   ② token 路径 /v1/oauth/token 仍存在于 claude 二进制中
#
# 为什么只看二进制：这两个常量是从 claude 二进制里扒出来的非公开契约，
# 唯一会让它们变的事件就是 claude 升级。所以本脚本 = "升级检测 + 常量复查"。
#
# 被动性保证（刻意的）：
#   · 不读、不写、不碰任何凭证文件；不发任何网络请求
#   · 不碰刷新脚本、不碰它的锁和状态文件
#   · 只读 claude 二进制 + 自己的状态文件 ~/.botmux/logs/.cred-contract-state.json
#   · 二进制 size+mtime 没变就秒退（不算 sha、不 grep）
#
# 用法:
#   scripts/cred-contract-audit.sh              # 增量：二进制没变就秒退
#   FULL=1 scripts/cred-contract-audit.sh       # 强制重查（忽略 size/mtime 短路）
#   QUIET=1 …                                   # 只写日志不发飞书（首次建基线用）
#   CLAUDE_BIN=/path/to/fake …                  # 指定被审计的二进制（演练用）
# 退出码: 0=常量都在（或本轮无变化）  1=常量对不上(已红警)  2=二进制不可读(已告警)

set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  # 必须盯 daemon 真正 spawn 的那个 claude。daemon 用登录 shell 的 PATH，
  # 而 cron 的 PATH 往往不含 ~/.local/bin —— 旧写法 `command -v claude ||
  # echo ~/.local/bin/claude` 的兜底只在「PATH 上完全没有 claude」时才触发，
  # 所以在「cron PATH 里有另一个 claude（如 homebrew 的 npm 版）」的机器上
  # 它会静默审计错的那个二进制：升了 .local 的 claude 审计看不见，报的是假的绿。
  # （2026-07-30 在 tian 那台实撞：.local=2.1.220 / homebrew=2.1.178，审计盯的是后者。）
  # 定案：native 安装位优先，其次才回落 PATH 解析。
  if [ -x "$HOME/.local/bin/claude" ]; then
    RAW="$HOME/.local/bin/claude"
  else
    RAW="$(command -v claude || echo "$HOME/.local/bin/claude")"
  fi
  CLAUDE_BIN="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$RAW" 2>/dev/null || echo "$RAW")"
fi
STATE="${CONTRACT_STATE:-$HOME/.botmux/logs/.cred-contract-state.json}"
CLIENT_ID="${CLAUDE_OAUTH_CLIENT_ID:-9d1c250a-e61b-44d9-88ed-5944d1962f5e}"
TOKEN_PATH="${CLAUDE_OAUTH_TOKEN_PATH:-/v1/oauth/token}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /Users/ksher/.local/node-v24/bin/node)}"
HOSTTAG="${HOSTTAG:-$(hostname -s 2>/dev/null || echo host)}"
ALERT_APP="${ALERT_APP:-cli_aacd7ceeb5789cc6}"
ALERT_TO="${ALERT_TO:-ou_e0be3737b53350f5c529e6cfb5227157}"
FULL="${FULL:-0}"
QUIET="${QUIET:-0}"

log(){ printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*"; }
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true

# 告警走 lark-cli bot 身份，不依赖 claude 凭证（凭证挂了告警也要能出去）
say(){
  [ "$QUIET" = 1 ] && { log "  ↳ QUIET=1，跳过飞书"; return 0; }
  if LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
       perl -e 'alarm 30; exec @ARGV' lark-cli im +messages-send \
         --as bot --user-id "$ALERT_TO" --text "$1" >/dev/null 2>&1; then
    log "  ↳ 已通知(飞书)"; return 0
  else
    log "  ⚠️ 通知发送失败(查 ~/.lark-cli-bots/$ALERT_APP)"; return 1
  fi
}

# 状态读写：单个 JSON，字段 size/mtime/sha/version/alerted_sha
sget(){ "$NODE_BIN" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s[process.argv[2]]??"")}catch(e){console.log("")}' "$STATE" "$1" 2>/dev/null; }
sput(){ "$NODE_BIN" -e '
  const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.argv[1]))}catch(e){}
  for(let i=2;i<process.argv.length;i+=2) s[process.argv[i]]=process.argv[i+1];
  s.updated_at=new Date().toISOString();
  fs.writeFileSync(process.argv[1], JSON.stringify(s,null,2));
' "$STATE" "$@"; }

# ── 二进制可读性 ──
if [ ! -r "$CLAUDE_BIN" ]; then
  log "❌ claude 二进制不可读: $CLAUDE_BIN"
  if [ "$(sget missing)" != "1" ]; then
    say "🔴【${HOSTTAG}】契约审计: claude 二进制不见了/读不到
路径: $CLAUDE_BIN
刷新脚本本身不依赖 claude 可执行（它直连 OAuth 端点），所以刷新暂时不受影响；
但 client_id / 端点路径这两个常量的来源没了，claude 装坏了也需要人看一眼。"
    sput missing 1
  fi
  exit 2
fi
[ "$(sget missing)" = "1" ] && sput missing 0

SIZE="$(stat -f %z "$CLAUDE_BIN" 2>/dev/null)"
MTIME="$(stat -f %m "$CLAUDE_BIN" 2>/dev/null)"

# ── 增量短路：size+mtime 没变 → 秒退（不算 sha、不 grep）──
if [ "$FULL" != 1 ] && [ "$SIZE" = "$(sget size)" ] && [ "$MTIME" = "$(sget mtime)" ]; then
  log "无变化(bin=$CLAUDE_BIN size=$SIZE mtime=$MTIME) → 秒退"
  exit 0
fi

SHA="$(shasum -a 256 "$CLAUDE_BIN" 2>/dev/null | awk '{print $1}')"
VER="$("$CLAUDE_BIN" --version 2>/dev/null | head -1 | tr -d '\n')"; [ -n "$VER" ] || VER="?"
PREVVER="$(sget version)"; PREVSHA="$(sget sha)"

# ── 常量复查 ──
# ⚠️ grep 找不到时退出码是 1，不能写成 `$(grep -c … || echo 0)`——那会把 grep 自己输出的 "0"
#    和 echo 的 "0" 拼成 "0\n0"，后面所有整数比较当场报错。只取第一行并兜空值。
CID_HITS="$(grep -ac -- "$CLIENT_ID" "$CLAUDE_BIN" 2>/dev/null | head -1)"; CID_HITS="${CID_HITS:-0}"
PATH_HITS="$(grep -ac -- "$TOKEN_PATH" "$CLAUDE_BIN" 2>/dev/null | head -1)"; PATH_HITS="${PATH_HITS:-0}"
log "被审计二进制: $CLAUDE_BIN"
log "版本: ${PREVVER:-(无基线)} → $VER ; sha ${PREVSHA:0:12}… → ${SHA:0:12}… ; client_id 命中=$CID_HITS 路径命中=$PATH_HITS"

if [ "${CID_HITS:-0}" -ge 1 ] && [ "${PATH_HITS:-0}" -ge 1 ]; then
  sput size "$SIZE" mtime "$MTIME" sha "$SHA" version "$VER" cid_hits "$CID_HITS" path_hits "$PATH_HITS" verdict ok
  if [ -z "$PREVSHA" ]; then
    log "✅ 基线已建立（首次运行，不告警）"
  else
    log "✅ claude 变了但契约常量仍在 → 刷新脚本无需改动"
    say "🟦【${HOSTTAG}】契约审计: claude 已变更（${PREVVER:-?} → ${VER}），但 OAuth 契约常量仍在
· client_id 9d1c250a-… 仍在二进制中（命中 ${CID_HITS} 处）
· token 路径 ${TOKEN_PATH} 仍在（命中 ${PATH_HITS} 处）
→ bot-cred-refresh-oauth.sh 无需改动。（本条只在 claude 变化时发一次）"
  fi
  exit 0
fi

# ── 常量对不上：红警，并给出人工修正所需的线索 ──
CANDS="$(grep -aoE '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' "$CLAUDE_BIN" 2>/dev/null | sort | uniq -c | sort -rn | head -6 | awk '{printf "%s(x%s) ", $2, $1}')"
PATHS="$(grep -aoE '/(v1/)?oauth/[a-z_]+' "$CLAUDE_BIN" 2>/dev/null | sort -u | tr '\n' ' ')"
log "❌ 契约常量对不上 — client_id 命中=$CID_HITS 路径命中=$PATH_HITS"
log "   候选 UUID: $CANDS"
log "   候选 oauth 路径: $PATHS"
sput size "$SIZE" mtime "$MTIME" sha "$SHA" version "$VER" cid_hits "$CID_HITS" path_hits "$PATH_HITS" verdict drift

if [ "$(sget alerted_sha)" != "$SHA" ]; then
  say "🔴【${HOSTTAG}】契约审计: claude 升级后 OAuth 常量对不上了（${PREVVER:-?} → ${VER}）
· client_id 命中 ${CID_HITS} 处$([ "${CID_HITS:-0}" -lt 1 ] && echo "  ← 不见了")
· token 路径 ${TOKEN_PATH} 命中 ${PATH_HITS} 处$([ "${PATH_HITS:-0}" -lt 1 ] && echo "  ← 不见了")

自动刷新可能在下一次真刷新时失败（约每 6.5 小时一次）。二进制里的候选值：
· UUID: ${CANDS:-（没扒到）}
· oauth 路径: ${PATHS:-（没扒到）}

需要人工核对并更新 scripts/bot-cred-refresh-oauth.sh 里的 CLIENT_ID / TOKEN_URL。
（同一个 sha 只报一次）"
  sput alerted_sha "$SHA"
fi
exit 1
