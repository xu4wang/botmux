#!/usr/bin/env bash
# bot-cred-refresh —— 主动刷新共享 claude token(到期前)并播种给所有 bot,
# 从根上消除"多进程各自刷新→refresh token 轮换互相作废"的投毒。搭配 launchd 定时触发。
#   用法: bot-cred-refresh.sh          # 近到期才刷(定时任务默认)
#         bot-cred-refresh.sh --force  # 无视到期,立刻刷+播(验证/手动)
#         bot-cred-refresh.sh --check  # 只报到期情况,不刷不播(安全)
#   环境: MARGIN_MIN(默认60,剩余分钟数≤它才刷) SUSPEND(默认1,播种后 suspend all 强制重读)
#         CLAUDE_CREDENTIALS / CLAUDE_BIN / BOTMUX_BIN
#
# 原理见记忆 claude-cred-keychain-file-split。要点:
#  ▸ 单一刷新权威:只有本脚本刷,bot 从不自己刷 → 没有并发轮换竞争。
#  ▸ 刷新手段:把凭证副本的 expiresAt 改成过去 → 用它跑 claude -p,骗 claude 用自己的
#    OAuth 逻辑刷新(robust,不逆向端点)→ 从副本抓回新 {AT,RT}。
#  ▸ 【沙箱 deny-keychain】跑刷新的 claude:launchd 任务其实在 Aqua 会话、有 keychain 写权限,
#    无沙箱的 claude 会把刷新写进 keychain(中午翻车根因)→ 套 Seatbelt deny ~/Library/Keychains
#    逼它只写文件,我们才抓得到。(隔离 bot 每天以同机制刷新写文件为证)
#  ▸ 只有确认"新 token 已捕获且有效"才动 live 文件;否则 live 不动、安全退出。
#  ▸ SUSPEND=1(默认):播种后 suspend all,让正在跑的 bot 冷启动重读新 token —— 否则进程
#    内存里攥旧 token,文件换了也不重读,到期即掉(中午 SUSPEND=0 的第二个 bug)。
#
# ⚠️ 残留脆弱点:正确性押在"cron 可靠地在到期前刷新"。cron 漏一个周期(Mac 长睡)→ 某 bot
#    到期自刷 → 非隔离 bot 重建 keychain / 隔离 bot 轮换 RT → 分裂回来,需 bot-login-doctor 兜底。
#    彻底根治仍是 ANTHROPIC_API_KEY(不刷新不轮换)。
# ══════════════════════════════════════════════════════════════════════════════
# 定时任务(launchd)—— 其它 agent 按此安装 / 管理 / 排查
# ══════════════════════════════════════════════════════════════════════════════
#   已装为用户级 LaunchAgent(macOS):
#     plist:  ~/Library/LaunchAgents/com.botmux.cred-refresh.plist
#     触发:   StartInterval=1800s(每 30min)+ RunAtLoad;每次跑本脚本默认模式
#             (读 expiresAt,剩余 ≤ MARGIN_MIN=60 才真刷,否则秒退 no-op)
#     env:    HOME / MARGIN_MIN=60 / SUSPEND=0
#     日志:   ~/.botmux/logs/cred-refresh.log        ← 脚本自己写,主要看这个
#             ~/.botmux/logs/cred-refresh.{out,err}.log(launchd stdout/err 兜底)
#   管理命令(uid 用 $(id -u),本机=501):
#     装/重载:  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.botmux.cred-refresh.plist
#               (旧法回退: launchctl load -w <plist>)
#     卸载:     launchctl bootout gui/$(id -u)/com.botmux.cred-refresh
#     看状态:   launchctl list | grep cred-refresh     # 第1列=PID(-=空闲) 第2列=最近退出码
#     立刻跑:   launchctl kickstart -k gui/$(id -u)/com.botmux.cred-refresh
#     看日志:   tail -f ~/.botmux/logs/cred-refresh.log
#   改触发间隔/margin:编辑 plist 后 bootout 再 bootstrap 重载。
#   Linux 部署:改用 cron 或 systemd timer 调本脚本即可(逻辑跨平台;非 macOS 无 keychain 更简单)。
#
#   ⚠️ 相关铁律(见记忆):CC CLI 登录只在 SSH、别在 GUI /login(否则 keychain 复活分裂);
#      反应式排查/修复用姊妹脚本 bot-login-doctor.sh。
# ══════════════════════════════════════════════════════════════════════════════
set -u

CRED="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
STATE_JSON="$HOME/.claude/.claude.json"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo /opt/homebrew/bin/claude)}"
BOTMUX_BIN="${BOTMUX_BIN:-$(command -v botmux || echo "$HOME/.botmux/bin/botmux")}"
MARGIN_MIN="${MARGIN_MIN:-60}"
SUSPEND="${SUSPEND:-1}"          # 默认 1:播种后 suspend all 强制冷启动重读,消除"进程攥旧 token"掉线(中午 SUSPEND=0 的教训)
UID_N="$(id -u)"
LOG="$HOME/.botmux/logs/cred-refresh.log"
LOCKDIR="$HOME/.botmux/cred-refresh.lock.d"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"   # launchd 下 PATH 很瘦

MODE=refresh
case "${1:-}" in
  --force) MODE=force ;;
  --check) MODE=check ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  "") ;;
  *) printf '未知参数 %s(用 --force/--check/--help)\n' "$1"; exit 64 ;;
esac
[ -x "$CLAUDE_BIN" ] || command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "找不到 claude: $CLAUDE_BIN"; exit 69; }
mkdir -p "$(dirname "$LOG")"
# log(): 时间戳 + PID,写进 cred-refresh.log 并回显。出问题主要 grep 这个文件。
log(){ printf '%s [%d] %s\n' "$(date '+%m-%d %H:%M:%S')" "$$" "$*" | tee -a "$LOG"; }

# ── mkdir 原子锁(macOS 无 flock)──
if ! mkdir "$LOCKDIR" 2>/dev/null; then log "另一实例在跑(锁 $LOCKDIR),跳过"; exit 0; fi
TMP="$(mktemp -d)"
trap 'rmdir "$LOCKDIR" 2>/dev/null; rm -rf "$TMP"' EXIT

log "==== 启动 mode=$MODE margin=${MARGIN_MIN} suspend=${SUSPEND} claude=$CLAUDE_BIN ===="
[ -f "$CRED" ] || { log "❌ 凭证文件不存在 $CRED(需先 SSH /login)"; exit 2; }
accfp(){ node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;console.log(require("crypto").createHash("sha256").update(String(o.accessToken)).digest("hex").slice(0,16))}catch(e){console.log("ERR")}' "$1"; }
leftmin(){ node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;console.log(Math.round((Number(o.expiresAt)-Date.now())/60000))}catch(e){console.log("ERR")}' "$1"; }

LEFT=$(leftmin "$CRED"); OLD=$(accfp "$CRED")
log "共享凭证 acc=$OLD 剩余 ${LEFT} 分钟"
[ "$MODE" = check ] && { log "check 模式,结束"; exit 0; }
if [ "$MODE" = refresh ]; then
  case "$LEFT" in ''|*[!0-9-]*) log "expiresAt 解析失败(LEFT=$LEFT),跳过"; exit 3 ;; esac
  if [ "$LEFT" -gt "$MARGIN_MIN" ]; then log "未进入刷新窗口(剩 ${LEFT}>${MARGIN_MIN}),no-op 退出"; exit 0; fi
fi

# ── 刷新:伪过期副本 → 【沙箱 deny keychain】里跑 claude → 逼它写文件而非 keychain → 抓新 token ──
# 中午翻车根因:无沙箱的 claude 有 keychain 写权限 → 刷新写进了 keychain,我们从文件读到 ERR
# 没捕获,但服务端 RT 已轮换 → 投毒掉线。这里套 Seatbelt deny ~/Library/Keychains(和隔离
# bot 同一机制,已被隔离 bot 每天证明:keychain 被 deny + CLAUDE_CONFIG_DIR 文件模式 → claude
# 刷新写文件)。sandbox-exec 缺失(非 macOS)则退回无沙箱(Linux 本就无 keychain,claude 只写文件)。
mkdir -p "$TMP/cfg"
node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1]));o.claudeAiOauth.expiresAt=Date.now()-3600000;fs.writeFileSync(process.argv[2],JSON.stringify(o));' "$CRED" "$TMP/cfg/.credentials.json"
[ -f "$STATE_JSON" ] && cp "$STATE_JSON" "$TMP/cfg/.claude.json"
CLAUDE_OUT="$TMP/claude.out"
SB_PREFIX=()
if command -v sandbox-exec >/dev/null 2>&1; then
  SB_PROFILE="$TMP/deny-keychain.sb"
  printf '(version 1)\n(allow default)\n(deny file-read* (subpath "%s/Library/Keychains"))\n(deny file-write* (subpath "%s/Library/Keychains"))\n' "$HOME" "$HOME" > "$SB_PROFILE"
  SB_PREFIX=(sandbox-exec -f "$SB_PROFILE")
  log "触发 claude 刷新(沙箱 deny-keychain, CLAUDE_CONFIG_DIR=$TMP/cfg)…"
else
  log "触发 claude 刷新(无 sandbox-exec,非 macOS;CLAUDE_CONFIG_DIR=$TMP/cfg)…"
fi
CLAUDE_CONFIG_DIR="$TMP/cfg" perl -e 'alarm 90; exec @ARGV' "${SB_PREFIX[@]}" "$CLAUDE_BIN" -p "reply with exactly: OK" </dev/null >"$CLAUDE_OUT" 2>&1
CRC=$?
NEWCRED="$TMP/cfg/.credentials.json"
NEW=$(accfp "$NEWCRED"); NEWLEFT=$(leftmin "$NEWCRED")
log "claude 退出码=$CRC;刷新后 acc=$NEW 剩=${NEWLEFT}(旧 acc=$OLD)"
if [ "$NEW" = "ERR" ] || [ "$NEW" = "$OLD" ] || ! printf '%s' "${NEWLEFT:-x}" | grep -qE '^[0-9]+$' || [ "${NEWLEFT:-0}" -le 5 ]; then
  log "⚠️ 刷新未发生或无效(token 未变/过期)。live 未改动、安全退出。claude 输出↓"
  sed 's/^/      claude| /' "$CLAUDE_OUT" 2>/dev/null | head -15 | tee -a "$LOG"
  exit 4
fi
log "✅ 刷新成功 $OLD → $NEW,新剩 ${NEWLEFT} 分钟。开始播种…"

# ── 播种:原子写(同目录 temp+mv)。先共享文件,再所有隔离拷贝 ──
SEEDED=0
seed(){ local dst="$1" t="$1.tmp.$$"; if cp "$NEWCRED" "$t" && chmod 600 "$t" && mv -f "$t" "$dst"; then log "  ↳ 播种 $dst"; SEEDED=$((SEEDED+1)); else log "  ✗ 播种失败 $dst"; rm -f "$t"; fi; }
seed "$CRED"
for f in "$HOME"/.botmux/bots/*/claude/.credentials.json; do [ -f "$f" ] && seed "$f"; done
log "✅ 播种完成,共 ${SEEDED} 个文件。"

# ── 可选:强制 bot 重读(去掉"claude 是否刷新前重读文件"的依赖)──
if [ "$SUSPEND" = 1 ]; then
  log "SUSPEND=1 → botmux suspend all + 重启 cc-connect(强制冷启动重读)"
  if "$BOTMUX_BIN" suspend all >>"$LOG" 2>&1; then log "  suspend all 完成"; else log "  ✗ suspend all 失败"; fi
  CC=$(launchctl list 2>/dev/null | grep -i cc-connect | awk '{print $3}' | head -1)
  if [ -n "$CC" ]; then
    if launchctl kickstart -k "gui/$UID_N/$CC" >>"$LOG" 2>&1; then log "  cc-connect($CC) 重启"; else log "  ⚠️ cc-connect kickstart 失败(可能权限;它共享文件靠重读兜底)"; fi
  fi
fi
log "==== done. seeded=${SEEDED} ===="
