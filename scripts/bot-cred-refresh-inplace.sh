#!/usr/bin/env bash
# ⛔️ 已停用（DEPRECATED，2026-07-29 23:46 起）——生产刷新改走 scripts/bot-cred-refresh-oauth.sh
#    （直连 OAuth 端点：不碰 live 文件、无伪过期/备份/回滚、失败原因可分辨）。
#    本文件只作回滚备胎保留。**不要手动跑它**：它会把 live 凭证伪过期后交给 claude 去写,
#    失败时 claude 可能清空文件,而且伪过期那 7~12 秒里任何消费者读到都会去自刷 → 轮换 RT → 全员掉线。
#    回滚办法见 docs/token-refresh-setup.md 的「回滚」一节。
#
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
#   · 伪过期窗口里【新起】的 CLI 会自己去刷 → 同样轮换掉 RT,把本脚本这次刷新搞废。所以真要刷之前
#     先 `botmux freeze`(只拦新起,不动在跑的),EXIT trap 里 `freeze --release`。两个闸门分工:
#     freeze 管"新的别起",SUSPEND 管"老的收干净"。
#
# 用法:
#   scripts/bot-cred-refresh-inplace.sh              # 刷新 + 播种隔离bot(不 suspend)
#   SUSPEND=1 scripts/bot-cred-refresh-inplace.sh    # 刷新 + 播种 + botmux suspend all(推荐)
#   SEED=0   scripts/bot-cred-refresh-inplace.sh     # 只刷新默认文件,不播种隔离bot
# 退出码: 0=刷新成功  1=刷新失败(已回滚,live 未损)  2=前置缺失  3=keychain 有条目(拒跑)
#         4=起点凭证被清空/损坏(熔断:已告警并停止自动刷新,等人工 /login 或 doctor --fix)
#
# 通知: 每轮跑完都发一条飞书心跳(无论结果):无需刷新/刷新成功/刷新失败/熔断中/锁跳过,
#       内容含 token 到期时间与预计下次真刷新时间。HEARTBEAT=0 只关心跳(失败/熔断告警仍在);
#       走 lark-cli bot 身份,不依赖 claude 凭证。用 ALERT=0 全关,ALERT_APP/ALERT_TO 改收发方。

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
# ── 心跳:每轮跑完都发一条结果通知(2026-07-28 起从"故障才有声"升级为"每轮有声")──
# 与 alert 同通道,但语义不同:heartbeat 是常规状态播报,可用 HEARTBEAT=0 单独关掉;
# 真故障(失败/熔断/锁卡死)一律走 alert,不受 HEARTBEAT 开关影响。
HEARTBEAT="${HEARTBEAT:-1}"
heartbeat(){ [ "${HEARTBEAT:-1}" = 1 ] || return 0; alert "$1"; }
# expiresAt → 本地时间 "MM-DD HH:MM"
expfmt(){ node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;const d=new Date(Number(o.expiresAt));const p=n=>String(n).padStart(2,"0");console.log(p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()))}catch(e){console.log("?")}' "$1"; }
# 预计下次真刷新 = (expiresAt - MARGIN) 之后的第一个整半点 cron 槽(*/30 对齐);
# 已进入刷新窗口则给"下一个半点"。仅为预估,实际以每轮门槛判断为准。
nextref(){ node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;const m=Number(process.argv[2]||90);let t=Number(o.expiresAt)-m*60000;const now=Date.now();if(t<now)t=now;const slot=1800000;t=Math.ceil(t/slot)*slot;if(t<=now)t+=slot;const d=new Date(t);const p=n=>String(n).padStart(2,"0");console.log(p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()))}catch(e){console.log("?")}' "$1" "$2"; }
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
  # 不在这里读 CRED 的到期时间:持锁实例可能正处于"伪过期后/半写入"中间态,读出来是误导
  heartbeat "⏭️【${HOSTTAG}】凭证心跳:本轮跳过(另一实例正在刷新,锁 pid=${owner});凭证状态以持锁实例本轮的心跳为准"
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
# 释放时校验 owner:绝不删别人的锁。
# spawn 冻结也在这里解:成功、失败回滚、中途 exit 全都覆盖(FROZE 此刻还没定义,
# 所以必须写 ${FROZE:-0} —— set -u 下裸 $FROZE 会让 trap 自己炸掉,连锁都不会释放)。
trap 'if [ "${FROZE:-0}" = 1 ] && [ -x "$BOTMUX_BIN" ]; then "$BOTMUX_BIN" freeze --release --pid $$ >/dev/null 2>&1 && log "已解冻新 CLI 会话"; fi; if [ "$(cat "$LOCKPID" 2>/dev/null)" = "$$" ]; then rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null; rmdir "$LOCKDIR" 2>/dev/null; fi' EXIT

log "起点: $(fp "$CRED")"

# ── 熔断:起点已被清空/损坏 → 停止自动刷新 ──
# 2026-07-27 事故:文件被某个 claude 清空后,本脚本仍照常"备份空的 → 伪过期 → 刷新失败 →
# 从空备份回滚成空",连转 9 轮 4 小时,毫无产出也毫无声音。空文件是人工介入信号,不是重试信号。
if ! haskeys "$CRED"; then
  n=$(failcount)
  if [ "${n:-0}" -lt 900 ]; then                      # 900+ = 熔断态,值随跳过轮数递增
    # 发送成功才落 900 标记:否则(网络抖动等)下一轮重试完整告警,不会静默进入熔断态。
    # 这条必须走 alert 而非 heartbeat —— HEARTBEAT=0 时熔断也必须有声。
    if alert "🔴【${HOSTTAG}】凭证文件已被清空/损坏,已停止自动刷新
文件: $CRED
需人工处理: SSH 里 claude /login,或 bot-login-doctor --fix
(在人工处理前,每 30 分钟会心跳提醒一次,不再空转刷新)"; then
      setcount 900
    fi
  else
    # 计数封顶 99998:failcount 对 6 位以上数字按 0 处理,放任递增 5 年多后会绕回"首报"重刷屏
    [ "$n" -lt 99998 ] && setcount $((n + 1))
    heartbeat "🔴【${HOSTTAG}】凭证心跳:仍处熔断(已跳过 $((n - 899)) 轮),等待人工 /login 或 doctor --fix"
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
  heartbeat "🟢【${HOSTTAG}】凭证心跳:本轮无需刷新(剩 ${LEFT}m > 阈值 ${MARGIN_MIN}m)
token 到期: $(expfmt "$CRED")
预计下次刷新: $(nextref "$CRED" "$MARGIN_MIN")"
  exit 0
fi
log "剩余 ${LEFT}m ≤ 阈值 ${MARGIN_MIN}m(或 --force)→ 执行刷新"

# ── 冻结「新起 CLI」(botmux freeze) ────────────────────────────────────────
# 为什么:下面的伪过期会让 live 凭证在几秒内呈"已过期"态。这期间冷启动的 CLI 会
# 看到过期 token 并【自己去刷】→ 轮换掉 refresh token → 本脚本这次刷新用的旧 RT
# 当场作废 → 失败回滚 → 全队投毒。读隔离 bot 更糟:它每次冷启动都把"最新凭证"
# 复制进自己那份副本,伪过期的文件会被原样拷走。
# 冻结【只拦新起】,已在跑的 CLI 由成功分支里的 suspend 收拾 —— 两件事分开。
# --pid $$ :本脚本一死立刻解冻(kill -9 也能自愈);daemon 侧另有按文件 mtime 算的
#           10 分钟硬上限,即使 trap 没跑到也不会把机器冻死。解冻也带 --pid $$,
#           只删自己那份声明 —— 绝不解除别人的维护窗口。
# ⚠️ 闸门只保证【每个会话的第一条消息】解冻后自动重放;同一会话窗口内的后续消息不排队
#    (会打日志、--notify 时还会在群里说一声,需人工重发)。所以窗口要短。
# 只在"真要刷"之后才冻:no-op 轮(每 30 分钟大多是 no-op)完全不碰闸门。
FROZE=0
if [ -x "$BOTMUX_BIN" ] && "$BOTMUX_BIN" freeze --reason cred-refresh --for 240s --pid $$ >/dev/null 2>&1; then
  FROZE=1
  log "已冻结新 CLI 会话(cred-refresh,240s 上限;被拦下的 spawn 解冻后自动重放)"
else
  # 刻意 fail-open:老版本 botmux 没有 freeze 子命令,或 daemon 状态异常时,
  # 【继续刷新】。拿不到闸门是"小概率竞态",拒绝刷新是"必定过期掉线" —— 后者更糟。
  log "⚠️ 未能冻结(botmux 无 freeze 子命令 / 已有别的维护窗口在跑)—— 本轮无 spawn 闸门,继续刷新"
fi

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

  # 恢复说明并入成功心跳(每轮都有心跳,单独报喜会变成两条)
  PREVFAIL=$(failcount)
  RECOV=""
  if [ "${PREVFAIL:-0}" -ge 900 ]; then
    RECOV="
(此前处于「已清空·熔断」状态,现已恢复,自动刷新重新接管)"
  elif [ "${PREVFAIL:-0}" -gt 0 ]; then
    RECOV="
(此前连续失败 ${PREVFAIL} 次,现已恢复)"
  fi
  setcount 0
  heartbeat "✅【${HOSTTAG}】凭证心跳:本轮已刷新成功
新 token 到期: $(expfmt "$CRED")
预计下次刷新: $(nextref "$CRED" "$MARGIN_MIN")${RECOV}"

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

  # 告警:每轮都报(每轮心跳都要有结果;2026-07-27 那次静默了 4.5 小时才被人发现)。
  # 走 alert 而非 heartbeat:失败属于真故障,不能被 HEARTBEAT=0 关掉。
  n=$(failcount); [ "${n:-0}" -ge 900 ] && n=0        # 从熔断态回到普通失败态,重新计数
  n=$((n + 1)); setcount "$n"
  alert "🔴【${HOSTTAG}】凭证刷新失败 第${n}次
out=$HEAD
当前: $(fp "$CRED")(${ACTION})
token 到期: $(expfmt "$CRED")
下轮重试: 30 分钟后;若文件被清空会转为熔断并停刷。"
  exit 1
fi
