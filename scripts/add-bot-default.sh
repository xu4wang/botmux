#!/usr/bin/env bash
# 按「默认偏好」新增一个 botmux 机器人：读隔离 + 角色系统 + 私聊全开 + 唯一管理员。
#
#   ./scripts/add-bot-default.sh --app-id cli_xxx --app-secret xxx [--name 小助手] [--cli claude-code]
#   环境变量 BOTMUX_OWNER 可覆盖默认管理员（默认 = 王旭）
#
# 做完这些（每步失败即停，不留半成品）：
#   ① botmux setup add        —— 凭证换 token 校验通过才写盘；只拉起这个 bot，不动其它
#   ② 角色库骨架 + 三件套      —— defaultWorkingDir / brandLabel / tuiSlashAllow
#   ③ bots.json 补两字段       —— readIsolation: true, p2pOpen: true（改前自动备份）
#   ④ botmux restart + 自检
#
# 之后还需人工做的（脚本管不到，末尾会提示）：飞书后台发版 + 设「可用范围」（p2pOpen 下这就是
# 私聊的唯一闸门）、把 bot 拉进群、开一个新话题说句话（种目录信任）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOTS_JSON="$HOME/.botmux/bots.json"
OWNER="${BOTMUX_OWNER:-ou_052754a5b3b938d10627d818729737bf}"   # 王旭：默认唯一管理员

APP_ID=""; APP_SECRET=""; NAME=""; CLI="claude-code"
while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) APP_ID="$2"; shift 2 ;;
    --app-secret) APP_SECRET="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --cli) CLI="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
[ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] || { echo "必须给 --app-id 与 --app-secret" >&2; exit 1; }

command -v botmux >/dev/null || { echo "找不到 botmux（把 ~/.botmux/bin 加进 PATH）" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { echo "读隔离只支持 macOS —— 本机不是 macOS，别用这个脚本" >&2; exit 1; }

echo "== ① botmux setup add =="
add_args=(setup add --app-id "$APP_ID" --app-secret "$APP_SECRET" --allowed-users "$OWNER" --cli "$CLI")
[ -n "$NAME" ] && add_args+=(--name "$NAME")
botmux "${add_args[@]}"

echo "== ② 角色库骨架 + 角色三件套 =="
"$REPO_ROOT/scripts/role-deploy.sh" --bots "$APP_ID" --configure-bots --skip-build

echo "== ③ 读隔离 + 私聊全开 =="
cp "$BOTS_JSON" "$BOTS_JSON.bak-addbot-$(date +%Y%m%d-%H%M%S)"
node -e '
const fs=require("fs"); const [p,appId,owner]=process.argv.slice(1);
const bots=JSON.parse(fs.readFileSync(p,"utf8"));
const b=bots.find(x=>x.larkAppId===appId);
if (!b) { console.error("bots.json 里找不到 "+appId+"（setup add 是不是失败了？）"); process.exit(1); }
b.readIsolation = true;
b.p2pOpen = true;
// 兜底：p2pOpen 没有管理员会导致群聊锁死 + 无人可管（fail-closed）
if (!(b.allowedUsers||[]).length) b.allowedUsers = [owner];
fs.writeFileSync(p, JSON.stringify(bots,null,2)+"\n");
console.log("readIsolation=true, p2pOpen=true, allowedUsers=["+b.allowedUsers.join(",")+"]");
' "$BOTS_JSON" "$APP_ID" "$OWNER"

echo "== ④ 重启 + 自检 =="
botmux restart >/dev/null 2>&1 || true
sleep 3
node -e '
const fs=require("fs"); const [p,appId]=process.argv.slice(1);
const b=JSON.parse(fs.readFileSync(p,"utf8")).find(x=>x.larkAppId===appId);
const ok=(k,v)=>console.log((v?"  ✅":"  ❌")+" "+k);
console.log("配置自检：");
ok("readIsolation", b.readIsolation===true);
ok("p2pOpen（私聊全开）", b.p2pOpen===true);
ok("allowedUsers（管理员非空 —— p2pOpen 的前提）", (b.allowedUsers||[]).length>0);
ok("defaultWorkingDir（角色系统）", !!b.defaultWorkingDir);
ok("brandLabel（角色名脚注）", (b.brandLabel||"").includes("{cwdName}"));
if (!(b.allowedUsers||[]).length) { console.error("\n❌ 管理员为空：p2pOpen 会锁死群聊且无人可管，务必修复"); process.exit(1); }
' "$BOTS_JSON" "$APP_ID"

cat <<EOF

== 还剩三件人工的事 ==
1) 飞书开放平台：发布版本 → 设「可用范围」
   ⚠️ p2pOpen 已开 —— 「可用范围」就是「谁能私聊这个 bot」的唯一闸门
   顺带核对：事件用「长连接(WebSocket)」，已订阅 im.message.receive_v1 与 card.action.trigger
2) 把 bot 拉进群（群设置 → 群机器人 → 添加）
3) 开一个新话题跟它说句话 —— 这次冷启动会种下角色目录的信任标记，
   否则第一次切角色可能被 Claude Code 的信任框卡死

群聊放开（按需）：allowedChatGroups 加群 chat_id，或群里 /oncall bind。
⚠️ 别开 defaultOncall —— 它与角色系统的 defaultWorkingDir 互斥。
EOF
