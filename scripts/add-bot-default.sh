#!/usr/bin/env bash
# 按「默认偏好」新增一个 botmux 机器人：读隔离 + 角色系统 + 私聊全开 + 唯一管理员。
#
#   ./scripts/add-bot-default.sh --app-id cli_xxx --app-secret xxx [--name 小助手] [--cli claude-code]
#   ./scripts/add-bot-default.sh --admin --app-id cli_xxx --app-secret xxx   # 管理 bot（首次安装第一个）
#   环境变量 BOTMUX_OWNER 可覆盖默认管理员（默认 = 王旭的邮箱）
#
#   ⚠️ owner 用「邮箱」或 union_id(on_)，别用 open_id(ou_)：飞书 open_id 按 app 隔离，同一个人
#   在不同 app 下的 ou_ 不同。把别的 app 视角的 ou_ 填进 allowedUsers → 这个 bot 认不出 owner
#   （群里 @ 它弹「申请在本群使用我」、私聊无人可管），owner 被自己的 bot 锁死。daemon 启动时会用
#   每个 bot 自己的 app 凭证把邮箱 / union_id 解析成该 app 的 open_id（im/lark/client.ts
#   resolveAllowedUsersWithMap），所以邮箱是唯一到处都对的写法。
#
# 做完这些（每步失败即停，不留半成品）：
#   ① botmux setup add        —— 凭证换 token 校验通过才写盘；只拉起这个 bot，不动其它
#   ② 角色库骨架 + 三件套      —— defaultWorkingDir / brandLabel / tuiSlashAllow
#   ③ bots.json 补字段         —— p2pOpen: true；readIsolation: true（--admin 时为 false）
#   ④ lark-cli 身份 —— 建 ~/.lark-cli-bots/<appId>/，让它用自己的飞书 app
#   ⑤ botmux restart + 自检
#
# --admin（管理 bot）：**关闭读隔离**，其余（角色系统、p2pOpen、唯一管理员）不变。
#   为什么不能隔离：读隔离会 deny 掉 ~/.botmux/bots.json、daemon logs、其它 bot 的 BOT_HOME
#   （read-isolation.ts:137-138），隔离的 bot 根本读不到这些 → 当不了管理员（管不了别的 bot、
#   看不了日志、跑不了 botmux setup）。首次安装的第一个 bot 就该用 --admin。
#
# 之后还需人工做的（脚本管不到，末尾会提示）：飞书后台发版 + 设「可用范围」（p2pOpen 下这就是
# 私聊的唯一闸门）、把 bot 拉进群、开一个新话题说句话（种目录信任）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOTS_JSON="$HOME/.botmux/bots.json"
OWNER="${BOTMUX_OWNER:-austin.wangxu@ksher.com}"   # 王旭：默认唯一管理员（邮箱 —— 跨 app 通用）

APP_ID=""; APP_SECRET=""; NAME=""; CLI="claude-code"; ADMIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) APP_ID="$2"; shift 2 ;;
    --app-secret) APP_SECRET="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --cli) CLI="$2"; shift 2 ;;
    --admin) ADMIN=1; shift ;;
    # 打印头部注释块（跳过 shebang，直到第一个非注释行）——别写死行号，改注释就会漂
    -h|--help) awk 'NR==1{next} /^#/{print; next} {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
[ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] || { echo "必须给 --app-id 与 --app-secret" >&2; exit 1; }

command -v botmux >/dev/null || { echo "找不到 botmux（把 ~/.botmux/bin 加进 PATH）" >&2; exit 1; }
if [ "$ADMIN" -eq 0 ] && [ "$(uname -s)" != "Darwin" ]; then
  echo "读隔离只支持 macOS。本机不是 macOS —— 要么加 --admin（不隔离），要么别用这个脚本" >&2
  exit 1
fi
[ "$ADMIN" -eq 1 ] && echo "模式：管理 bot（不开读隔离；角色系统 / p2pOpen / 唯一管理员照常）" || true

# open_id 按 app 隔离：别的 app 视角的 ou_ 会让这个 bot 认不出 owner（群里弹「申请在本群使用我」、
# 私聊无人可管）。邮箱 / on_ 由 daemon 按各 bot 自己的 app 解析，才是跨 app 通用的写法。
case "$OWNER" in
  ou_*) echo "⚠️  owner 用了 open_id（${OWNER}）——open_id 按 app 隔离，除非它确实是 $APP_ID 这个 app 视角的值，否则 bot 会认不出 owner（群里弹「申请在本群使用我」、私聊无人可管）。建议改用邮箱或 union_id(on_)：BOTMUX_OWNER=<邮箱>" >&2 ;;
esac

echo "== ① botmux setup add =="
add_args=(setup add --app-id "$APP_ID" --app-secret "$APP_SECRET" --allowed-users "$OWNER" --cli "$CLI")
[ -n "$NAME" ] && add_args+=(--name "$NAME")
botmux "${add_args[@]}"

echo "== ② 角色库骨架 + 角色三件套 =="
"$REPO_ROOT/scripts/role-deploy.sh" --bots "$APP_ID" --configure-bots --skip-build

echo "== ③ 读隔离 + 私聊全开 =="
cp "$BOTS_JSON" "$BOTS_JSON.bak-addbot-$(date +%Y%m%d-%H%M%S)"
node -e '
const fs=require("fs"); const [p,appId,owner,admin]=process.argv.slice(1);
const bots=JSON.parse(fs.readFileSync(p,"utf8"));
const b=bots.find(x=>x.larkAppId===appId);
if (!b) { console.error("bots.json 里找不到 "+appId+"（setup add 是不是失败了？）"); process.exit(1); }
if (admin==="1") {
  // 管理 bot：绝不开读隔离——隔离会 deny bots.json / logs / 别的 bot 的家，它就管不了任何东西
  delete b.readIsolation;
} else {
  b.readIsolation = true;
}
b.p2pOpen = true;
// 群聊全开：defaultOncall 自动把 bot 进的每个新群绑成 oncall → 群里任何人都能 @ 它
// （oncall 腿只放行 canTalk，不授 canOperate —— 管理操作仍只限 allowedUsers）。
// ⚠️ workingDir 必须 === defaultWorkingDir：有 oncall 绑定时 pin 取 oncallEntry.workingDir，
// 角色目录压根不会被查询（daemon.ts resolvePinnedWorkingDir）→ 两值不一致会让角色系统在群里失效。
if (b.defaultWorkingDir) {
  b.defaultOncall = { enabled: true, workingDir: b.defaultWorkingDir, since: Date.now() };
}
// 兜底：p2pOpen 没有管理员会导致群聊锁死 + 无人可管（fail-closed）
if (!(b.allowedUsers||[]).length) b.allowedUsers = [owner];
fs.writeFileSync(p, JSON.stringify(bots,null,2)+"\n");
console.log("readIsolation="+(admin==="1"?"false（管理 bot）":"true")+", p2pOpen=true, allowedUsers=["+b.allowedUsers.join(",")+"]");
' "$BOTS_JSON" "$APP_ID" "$OWNER" "$ADMIN"

echo "== ④ lark-cli 身份：让这个 bot 用自己的 appid 操作飞书 =="
# 每个 bot 必须用**自己的**飞书 app 调 lark-cli，否则会以别人的身份读写文档/发消息，
# 数据权限也没法按 bot 管。机制：botmux 给每个会话注入 BOTMUX_LARK_APP_ID，~/.zshenv 据此把
# LARKSUITE_CLI_CONFIG_DIR 指到 ~/.lark-cli-bots/<appId>/ —— 这里就是把那个配置目录建出来。
LARK_CFG="$HOME/.lark-cli-bots/$APP_ID"
if command -v lark-cli >/dev/null; then
  if [ -f "$LARK_CFG/config.json" ]; then
    echo "  已存在：${LARK_CFG}（跳过）"
  else
    mkdir -p "$LARK_CFG"
    # secret 走 stdin，不进 argv（免得 ps 看得见）
    printf '%s' "$APP_SECRET" | LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG"       lark-cli config init --app-id "$APP_ID" --app-secret-stdin --brand feishu >/dev/null
    LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG" lark-cli config default-as bot >/dev/null 2>&1 || true
    LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG" lark-cli config strict-mode bot >/dev/null 2>&1 || true
    echo "  已配置：${LARK_CFG}（default-as bot + strict-mode bot，纯 bot 身份）"
  fi
  # ~/.zshenv 的映射是全局前提（不是 .zshrc —— 非交互 shell 只 source .zshenv）
  if ! grep -q "LARKSUITE_CLI_CONFIG_DIR" "$HOME/.zshenv" 2>/dev/null; then
    echo "  ⚠️  ~/.zshenv 里没有 BOTMUX_LARK_APP_ID → LARKSUITE_CLI_CONFIG_DIR 的映射，追加中…"
    cat >> "$HOME/.zshenv" <<'ZE'

# botmux: 每个 bot 用自己的飞书 app 操作 lark-cli（必须放 .zshenv —— 非交互 shell 只 source 它）
if [ -n "$BOTMUX_LARK_APP_ID" ]; then
  export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$BOTMUX_LARK_APP_ID"
fi
ZE
    echo "  已追加到 ~/.zshenv"
  fi
else
  echo "  ⚠️ 没装 lark-cli —— 该 bot 将无法操作飞书文档/消息。装好后手动补这一步。"
fi

echo "== ⑤ 重启 + 自检 =="
# 首次安装时 daemon 还没起来，restart 会失败 —— 退化成 start。
if ! botmux restart >/dev/null 2>&1; then
  echo "  （restart 失败，按首次安装处理：botmux start）"
  botmux start >/dev/null 2>&1 || echo "  ⚠️ botmux start 也失败了，手动查 botmux status / logs"
fi
sleep 3
node -e '
const fs=require("fs"); const [p,appId,admin]=process.argv.slice(1);
const b=JSON.parse(fs.readFileSync(p,"utf8")).find(x=>x.larkAppId===appId);
const ok=(k,v)=>console.log((v?"  ✅":"  ❌")+" "+k);
console.log("配置自检：");
if (admin==="1") ok("readIsolation=false（管理 bot 必须不隔离，否则读不到 bots.json）", b.readIsolation!==true);
else ok("readIsolation", b.readIsolation===true);
ok("p2pOpen（私聊全开）", b.p2pOpen===true);
ok("allowedUsers（管理员非空 —— p2pOpen 的前提）", (b.allowedUsers||[]).length>0);
ok("defaultWorkingDir（角色系统）", !!b.defaultWorkingDir);
ok("brandLabel（角色名脚注）", (b.brandLabel||"").includes("{cwdName}"));
ok("defaultOncall（群聊全开，且 workingDir = 角色目录）",
   b.defaultOncall?.enabled === true && b.defaultOncall.workingDir === b.defaultWorkingDir);
ok("lark-cli 用自己的 appid", fs.existsSync(process.env.HOME+"/.lark-cli-bots/"+appId+"/config.json"));
if (!(b.allowedUsers||[]).length) { console.error("\n❌ 管理员为空：p2pOpen 会锁死群聊且无人可管，务必修复"); process.exit(1); }
' "$BOTS_JSON" "$APP_ID" "$ADMIN"

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
