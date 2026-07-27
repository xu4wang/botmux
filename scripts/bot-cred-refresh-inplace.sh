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
#         4=起点凭证被清空/损坏(熔断:已告警并停止自动刷新,等人工 /login 或 doctor --fix)
#
# 告警: 失败第 1 次立刻发飞书,之后每 4 次(=2 小时)再发一次;恢复时发一次;熔断发一次。
#       走 lark-cli bot 身份,不依赖 claude 凭证。用 ALERT=0 关闭,ALERT_APP/ALERT_TO 改收发方。

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
# 有 token 键(不看到期时间)—— 熔断判据专用:区分"被清空/损坏"和"还没过期但快到了"。
# ⚠️ 熔断绝不能用 valid():正常刷新时机就是"剩余很少",用 valid() 会把正常场景误判成故障。
haskeys(){ node -e 'try{const o=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth)||{};process.exit((o.accessToken&&o.refreshToken)?0:1)}catch(e){process.exit(1)}' "$1"; }

# ── 告警通道 ──
# 走 lark-cli 的 bot 身份(app_id/app_secret 自己换 token),【完全不依赖 claude 凭证】——
# 否则凭证一挂告警也跟着哑,就失去意义。cron 不读 .zshenv,所以配置目录必须在这里显式指定。
ALERT_APP="${ALERT_APP:-cli_aaa13c2a5422dcc9}"                        # 本机管理 bot 的 appId
ALERT_TO="${ALERT_TO:-ou_052754a5b3b938d10627d818729737bf}"           # 收件人 open_id
ALERT_STATE="${ALERT_STATE:-$HOME/.botmux/logs/.cred-fail-count}"     # 连续失败计数
HOSTTAG="${HOSTTAG:-$(hostname -s 2>/dev/null || echo host)}"        # 可覆盖,便于演练时标注"测试"
mkdir -p "$(dirname "$ALERT_STATE")" 2>/dev/null || true             # 目录不存在则计数永远写不进去
# 返回值必须真实反映"发出去了没有":调用方要靠它决定是否落"已通知"标记。
# 写成 `cmd && log || log` 会让函数永远返回 0,标记一落就再也不重试 —— 那等于故障重新变哑。
alert(){
  [ "${ALERT:-1}" = 1 ] || return 0
  if LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
       perl -e 'alarm 30; exec @ARGV' lark-cli im +messages-send \
         --as bot --user-id "$ALERT_TO" --text "$1" >/dev/null 2>&1; then
    log "  ↳ 已告警(飞书)"; return 0
  else
    log "  ⚠️ 告警发送失败(查 ~/.lark-cli-bots/$ALERT_APP)"; return 1
  fi
}
# 进程是否存在。kill -0 返回非零不只有 ESRCH(不存在),也可能是 EPERM(存在但无权发信号),
# 两者都当"已死"就会去删别人的活锁 → 再用 ps -p 复核;拿不准一律当"存在",宁可不清锁。
alive(){ kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }
# 只接受十进制数字,其余一律当 0。
# ⚠️ 不能把文件内容直接丢给 [ ] 或 $(( )):内容若是 abc,`n=$((n+1))` 会把 abc 当变量名再解析,
#    在 set -u 下当场 unbound variable 退出 —— 告警路径会在发出任何消息之前就被自己打死。
# ⚠️ 还要用 10# 强制十进制:白名单放行的 "08"/"09" 在 $(( )) 里会被当八进制,报
#    "value too great for base" 并以 1 退出 —— 又是一条能在告警发出前打死脚本的路径。
# 位数也要限:6 位以上的纯数字在 bash 3.2 里可能整数溢出成负数,扰乱告警节奏。
failcount(){ local v; v="$(cat "$ALERT_STATE" 2>/dev/null)"; case "$v" in ''|*[!0-9]*|??????*) v=0;; esac; printf '%s' "$((10#$v))"; }
setcount(){ printf '%s\n' "$1" > "$ALERT_STATE.tmp.$$" 2>/dev/null && mv -f "$ALERT_STATE.tmp.$$" "$ALERT_STATE" 2>/dev/null; }

# ── 前置检查 ──
[ -n "$CLAUDE_BIN" ] || { log "❌ 找不到 claude 可执行"; exit 2; }
[ -f "$CRED" ] || { log "❌ 凭证文件不存在: $CRED — 先在 SSH 里 /login"; exit 2; }

# keychain 铁律:条目必须不存在
if command -v security >/dev/null 2>&1 && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
  log "❌ keychain 条目【存在】—— 原地刷新可能被 native 路径写进 keychain 造成分裂。"
  log "   请先在 GUI Terminal 删:  security delete-generic-password -s \"$KC_SVC\""
  exit 3
fi

# ── 互斥锁:全程独占(备份→伪过期→刷新→校验→回滚→播种→suspend)──
# 无锁时两个实例重叠会互相糟蹋:后者把前者"伪过期后的文件"当备份、同秒启动连 BK 文件名都撞、
# 一方成功另一方失败还会把刚刷好的 token 用旧备份盖回去。正常一轮约 5 秒(claude 调用有 alarm 90
# 封顶),所以只要不卡死就不会撞;但 `botmux suspend all` 没有超时,daemon 卡住时确实会拖长。
LOCKDIR="${CRED_LOCK:-$HOME/.botmux/logs/.cred-refresh.lock}"
LOCKPID="$LOCKDIR/pid"
# 陈旧锁的判据必须是【持有者进程已死】,不能只看 mtime:第一个实例卡在 botmux suspend all
# 超过阈值时人还活着,按 mtime 误删会让两个实例同时进危险区,而且它退出时的 trap 还会顺手
# 删掉第二个实例刚建的同名锁 —— 等于锁形同虚设。
if [ -d "$LOCKDIR" ]; then
  owner="$(cat "$LOCKPID" 2>/dev/null)"; case "$owner" in ''|*[!0-9]*) owner=0;; esac
  if [ "$owner" -eq 0 ]; then
    # 没有 pid 记录 ≠ 持有者已死:另一实例可能刚 mkdir 完、还没来得及写 pid(微秒级空窗),
    # 立刻清理会把刚建好的活锁删掉、两个实例一起进危险区。给 2 分钟宽限期。
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null
      rmdir "$LOCKDIR" 2>/dev/null && log "⚠️ 清理无主陈旧锁(无 pid 记录且已存在 >2 分钟)"
    fi
  elif ! alive "$owner"; then
    rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null
    rmdir "$LOCKDIR" 2>/dev/null && log "⚠️ 清理陈旧锁(持有者 pid=$owner 已不存在,上次运行疑似被杀/宕机)"
  fi
fi
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  owner="$(cat "$LOCKPID" 2>/dev/null || echo '?')"
  log "⏭️ 另一实例正在刷新(锁 $LOCKDIR, pid=$owner),本轮跳过"
  # 持有者活着但卡死 → 后续每轮都会静默跳过,又变成"无声故障"。超过 30 分钟报一次。
  # ⚠️ 标记必须【发送成功之后】再落:先落标记后发送的话,一次网络失败就等于永久闭嘴。
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +30 2>/dev/null)" ] && [ ! -e "$LOCKDIR/alerted" ]; then
    if alert "🔴【${HOSTTAG}】凭证刷新已被锁卡住超过 30 分钟(持有者 pid=$owner)
自动刷新在连续跳过,请检查该进程是否卡死(最可能卡在没有超时的 botmux suspend all)"; then
      : > "$LOCKDIR/alerted" 2>/dev/null
    fi
  fi
  exit 0
fi
# pid 写不进去就等于没锁,绝不能带着"假锁"继续跑
printf '%s\n' "$$" > "$LOCKPID" 2>/dev/null || {
  log "❌ 锁 pid 写入失败($LOCKPID)—— 不敢无锁运行,本轮放弃"
  rm -f "$LOCKPID" 2>/dev/null; rmdir "$LOCKDIR" 2>/dev/null
  alert "🔴【${HOSTTAG}】凭证刷新拿到锁但 pid 写入失败,已放弃本轮(疑似磁盘满/权限问题)
锁目录: $LOCKDIR"
  exit 2
}
# 释放时校验 owner:绝不删别人的锁
trap 'if [ "$(cat "$LOCKPID" 2>/dev/null)" = "$$" ]; then rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null; rmdir "$LOCKDIR" 2>/dev/null; fi' EXIT

log "起点: $(fp "$CRED")"

# ── 熔断:起点已被清空/损坏 → 停止自动刷新 ──
# 2026-07-27 事故:文件被某个 claude 清空后,本脚本仍照常"备份空的 → 伪过期 → 刷新失败 →
# 从空备份回滚成空",连转 9 轮 4 小时,毫无产出也毫无声音。空文件是人工介入信号,不是重试信号。
if ! haskeys "$CRED"; then
  n=$(failcount)
  if [ "${n:-0}" -lt 900 ]; then                      # 900 = 已告警过熔断,不重复刷屏
    alert "🔴【${HOSTTAG}】凭证文件已被清空/损坏,已停止自动刷新
文件: $CRED
需人工处理: SSH 里 claude /login,或 bot-login-doctor --fix
(在此之前每 30 分钟的自动刷新都会跳过,不再空转)"
    setcount 900
  fi
  log "❌ 起点无 token(EMPTY/损坏)→ 拒绝继续,避免空转死循环。等待人工 /login 或 doctor --fix"
  exit 4
fi

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
cp -p "$CRED" "$BK" || {
  log "❌ 备份失败,中止(live 未被改动)"
  alert "🔴【${HOSTTAG}】凭证刷新在「备份」步骤失败,已中止
live 文件未被改动,但自动刷新无法进行 —— token 会一路走到过期,请尽快人工处理
目标: $BK"
  exit 2
}
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
# ⚠️ 这一步之后 live 文件就已经被改动了,任何失败都必须【出声】:
#    node 可能已经截断/半写,若回滚也失败,live 就是坏的,只留一行本地日志等于没人知道。
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.claudeAiOauth.expiresAt=Date.now()-3600000;fs.writeFileSync(p,JSON.stringify(j))' "$CRED" \
  || {
    if cp -p "$BK" "$CRED"; then RB="已从备份回滚,live 完好"; else RB="⚠️ 回滚也失败 —— live 文件可能已损坏,需立即人工处理"; fi
    log "❌ 伪过期写入失败 — $RB"
    alert "🔴【${HOSTTAG}】凭证刷新在「伪过期写入」步骤失败
$RB
文件: $CRED
备份: $BK"
    exit 2
  }
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

  # 恢复通知:之前连续失败过才发(否则每 6.5 小时报一次喜就成骚扰)
  PREVFAIL=$(failcount)
  if [ "${PREVFAIL:-0}" -gt 0 ]; then
    if [ "${PREVFAIL}" -ge 900 ]; then
      alert "✅【${HOSTTAG}】凭证已恢复正常,自动刷新重新接管(此前处于「已清空·熔断」状态)"
    else
      alert "✅【${HOSTTAG}】凭证刷新已恢复(此前连续失败 ${PREVFAIL} 次)"
    fi
  fi
  setcount 0

  # keychain 复核(不该出现)
  if command -v security >/dev/null 2>&1 && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
    log "⚠️ 刷新后 keychain 竟出现条目! 建议 GUI 删除: security delete-generic-password -s \"$KC_SVC\""
  fi

  # 播种隔离消费者(botmux 隔离 bot + 各自持 CLAUDE_CONFIG_DIR 的常驻服务)
  # ⚠️ 铁律:凡是被隔离出去、拿自己那份 .credentials.json 的消费者,都必须在这里播种。
  #    漏播 = 它那份副本会老化到自己过期 → 它自刷 → 轮换掉中心 RT → 全员掉线(比不隔离更糟)。
  if [ "$SEED" = 1 ]; then
    for d in "$HOME"/.botmux/bots/*/claude/.credentials.json \
             "$HOME"/.cc-connect/claude/.credentials.json \
             "$HOME"/.lark-channel/claude/.credentials.json; do
      [ -e "$d" ] || continue
      lbl="${d#$HOME/}"; lbl="${lbl%/claude/.credentials.json}"; lbl="${lbl#.botmux/bots/}"
      cp "$CRED" "$d.tmp.$$" && chmod 600 "$d.tmp.$$" && mv -f "$d.tmp.$$" "$d" \
        && log "  ↳ seed $lbl"
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
  # 失败:回滚,保证 live 不被留空/伪过期。
  # ⚠️ 回滚前复核一次:校验与这里之间有个毫秒级窗口,若别的进程(GUI claude / 人工 /login /
  #    其它服务)刚写入了另一份【有效】凭证,直接 cp 旧备份会把它盖成失效的旧 token。
  if valid "$CRED" && [ "$(accfp "$CRED")" != "$OLDFP" ]; then
    ACTION="保留外部写入的有效凭证,未回滚"
    log "❌ 刷新失败(claude rc=$RC out=$HEAD)"
    log "⚠️ 但检测到外部进程已写入另一份【有效】凭证 → 保留现状,跳过回滚: $(fp "$CRED")"
  else
    if cp -p "$BK" "$CRED"; then
      ACTION="已回滚"
      log "❌ 刷新失败/无效(claude rc=$RC out=$HEAD) — 已从备份回滚: $(fp "$CRED")"
      log "   若刚才别处已轮换过 RT,回滚的 RT 可能已死;access token 通常仍可用一阵,必要时重新 /login。"
    else
      ACTION="⚠️ 回滚也失败,live 可能已损坏"
      log "❌ 刷新失败/无效(claude rc=$RC out=$HEAD) — 且【回滚失败】! 备份仍在 $BK,需人工处理"
    fi
  fi

  # 告警:第 1 次立刻报(2026-07-27 那次静默了 4.5 小时才被人发现),之后每 4 次(=2 小时)再报一次
  n=$(failcount); [ "${n:-0}" -ge 900 ] && n=0        # 从熔断态回到普通失败态,重新计数
  n=$((n + 1)); setcount "$n"
  if [ "$n" = 1 ] || [ $((n % 4)) = 0 ]; then
    alert "🔴【${HOSTTAG}】凭证刷新失败 第${n}次
out=$HEAD
当前: $(fp "$CRED")(${ACTION})
连续失败会每 2 小时再报一次;若文件被清空会转为熔断并停刷。"
  fi
  exit 1
fi
