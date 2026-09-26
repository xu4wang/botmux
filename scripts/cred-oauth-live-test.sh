#!/usr/bin/env bash
# cred-oauth-live-test.sh — 一次性：在会话外做 bot-cred-refresh-oauth.sh 的首次真刷新演练。
#
# 为什么必须在会话外跑：刷新会轮换 RT，而【轮换会立即吊销旧 access token】——
# 发起刷新的那个 claude 会话自己手上的 AT 当场作废，它下一次请求就会 401、
# 甚至按登出逻辑清空 ~/.claude（2026-07-29 21:18 事故就是这条路径）。
# 所以：刷新 → 播种 → 自检 → 发报告 → 最后才 suspend all，全程不依赖任何 claude 会话。

#
# ⚠️ 本脚本会做【真刷新】(FORCE=1) 并在成功后 suspend all，不是只读演练。
#    所以要 CONFIRM=1 才肯动。误跑的代价见上面 2026-07-29 那条。
#
# 用法：CONFIRM=1 ALERT_APP=<本机管理bot appId> ALERT_TO=<owner open_id> scripts/cred-oauth-live-test.sh
#
# ⚠️ 这里不给 ALERT_APP/ALERT_TO 默认值：历史上写死过 dev-beta 的身份，
#    结果是告警"发送成功但发给了别人"，本机 owner 反而以为没事。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.botmux/logs/cred-oauth-live-test.log"
CRED="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
ALERT_APP="${ALERT_APP:-}"
ALERT_TO="${ALERT_TO:-}"
NODE="${NODE:-$(command -v node)}"
if [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
else
  CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"
fi

if [ "${CONFIRM:-0}" != 1 ]; then
  echo "❌ 拒绝执行：本脚本会真刷新凭证(轮换 RT、吊销现有 access token)并 suspend all。" >&2
  echo "   确认要跑请显式加 CONFIRM=1。" >&2
  exit 2
fi
for v in ALERT_APP ALERT_TO NODE CLAUDE_BIN; do
  eval "val=\${$v}"
  [ -n "${val:-}" ] || { echo "❌ $v 未配置/未找到 — 必须显式指定本机的值，不再有默认值。" >&2; exit 2; }
done

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') live test 开始 ====="

fps(){
  for f in "$CRED" "$HOME"/.botmux/bots/*/claude/.credentials.json; do
    [ -e "$f" ] || continue
    printf '  %-58s ' "${f#$HOME/}"
    "$NODE" -e 'const c=require("crypto"),fs=require("fs");const h=s=>s?c.createHash("sha256").update(s).digest("hex").slice(0,12):"EMPTY";try{const o=JSON.parse(fs.readFileSync(process.argv[1])).claudeAiOauth||{};console.log("acc",h(o.accessToken),"rt",h(o.refreshToken),"exp",o.expiresAt?new Date(Number(o.expiresAt)).toLocaleString("sv"):"?")}catch(e){console.log("READ-ERR")}' "$f"
  done
}

say(){ LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
        perl -e 'alarm 30; exec @ARGV' lark-cli im +messages-send --as bot --user-id "$ALERT_TO" --text "$1" >/dev/null 2>&1; }

echo "[before]"; fps

ALERT_APP=$ALERT_APP ALERT_TO=$ALERT_TO FORCE=1 SEED=1 SUSPEND=0 \
  bash "$SCRIPT_DIR/bot-cred-refresh-oauth.sh"
RC=$?
echo "refresh rc=$RC"
echo "[after]"; fps

if [ "$RC" -ne 0 ]; then
  say "🟠【live test】新脚本首次真刷新【未成功】(rc=$RC)，live 凭证未被改动，旧 token 仍在用。
详见 $LOG（新脚本失败时不回滚、不清空，所以现状是安全的）。
没有 suspend，你的会话不受影响。"
  echo "===== 失败退出，不 suspend ====="
  exit "$RC"
fi

# 自检：用新 AT 真跑一次推理（此刻文件是新的，不会触发刷新）
OUT=$(CLAUDE_CONFIG_DIR="$HOME/.claude" perl -e 'alarm 90; exec @ARGV' "$CLAUDE_BIN" -p "reply with exactly: OK" </dev/null 2>&1)
CRC=$?
echo "selfcheck rc=$CRC out=$(printf '%s' "$OUT" | head -2 | tr -d '\n')"
EXPS=$("$NODE" -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;const d=new Date(Number(o.expiresAt));const p=n=>String(n).padStart(2,"0");console.log(p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()))' "$CRED")
UNIQ=$(for f in "$CRED" "$HOME"/.botmux/bots/*/claude/.credentials.json; do [ -e "$f" ] && "$NODE" -e 'const c=require("crypto"),fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1])).claudeAiOauth||{};console.log(c.createHash("sha256").update(o.accessToken||"").digest("hex").slice(0,12))' "$f"; done | sort -u | wc -l | tr -d ' ')

say "✅【live test】新脚本（直连 OAuth 端点）首次真刷新成功
· 新 token 到期: $EXPS
· 四份凭证指纹一致: $([ "$UNIQ" = 1 ] && echo 是 || echo "否（$UNIQ 种，要查）")
· 新 AT 自检: rc=$CRC out=$(printf '%s' "$OUT" | head -1 | tr -d '\n')
· 全程没碰 live 文件：拿到新凭证才原子写，没有伪过期、没有备份回滚
接下来我会执行 botmux suspend all（旧 AT 已被服务端吊销，运行中会话必须冷启动）。
你下一条消息会自动 --resume 续上下文。日志: $LOG"

echo "--- suspend all ---"
"$HOME/.botmux/bin/botmux" suspend all
echo "suspend rc=$? ; ===== $(date '+%F %T') live test 结束 ====="
