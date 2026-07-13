#!/usr/bin/env bash
# 把「存量 bot」批量迁移到默认偏好：读隔离 + 角色系统 + 私聊全开(p2pOpen) + owner 唯一管理员。
#
#   ./scripts/migrate-bots-default.sh --exclude cli_admin --dry-run   # 先看要改什么（强烈建议）
#   ./scripts/migrate-bots-default.sh --exclude cli_admin             # 真改
#
#   --exclude cli_a,cli_b   排除这些 bot（**管理 bot 必须排除** —— 它开了读隔离就读不到
#                           bots.json / 日志，管不了任何东西）
#   --owner <邮箱>          管理员，默认 austin.wangxu@ksher.com
#   --dry-run               只打印将要做的改动，不落盘
#   --migrate-memory        顺带把旧记忆搬进 bot 的新家（默认不搬，见下）
#   --bots-json <path>      改哪个 bots.json（默认 ~/.botmux/bots.json；仅供演练/测试）
#
# 记忆为什么会「丢」（其实没删，是新身份读不到）：迁移同时动了两个维度 ——
#   ① 读隔离把 CLI 数据目录重定向到 BOT_HOME，且 Seatbelt deny 了 ~/.claude
#      → 原来 ~/.claude/projects/** 下的记忆，隔离后物理上读不到
#   ② 角色系统给了 defaultWorkingDir → cwd 变了 → 记忆桶（按 cwd 路径 slug 分桶）也变了
#   旧：~/.claude/projects/<slug(旧cwd)>/memory
#   新：~/.botmux/bots/<appId>/claude/projects/<slug(角色目录)>/memory
#
# --migrate-memory 的策略（**桶是按 cwd 分的，不是按 bot 分的**，所以不能无脑搬）：
#   - bot 有自己的 workingDir  → 桶是它专属的 → 整桶 memory/ **拷贝**（不删原件）到新家
#   - bot 回落到 `~`（没配 workingDir）→ 那是**公共桶**：所有这类 bot + 你自己在 $HOME 跑的
#     claude 全混在一起 → **拒绝自动搬**，只列出桶里有什么，让人自己挑（否则就是跨 bot
#     记忆串味 —— 而那正是读隔离要防的东西）
#
# 与 add-bot-default.sh 的分工：那个是「新建 bot」，这个是「改造已有 bot」。
#
# ⚠️ 前提：全局 botmux 必须是 deploy/all 源码版。npm 版不认识 readIsolation / p2pOpen ——
#    字段写进去了也会被**静默忽略**（看起来成功，实际没隔离）。脚本会硬校验这一点。
#
# allowedUsers 的处理（唯一有歧义的地方，规则写死在这里）：
#   - 邮箱 / union_id(on_)  → 原样保留（跨 app 通用，本来就对）
#   - open_id(ou_)          → **有风险**：open_id 按 app 隔离，别的 app 视角的 ou_ 会让这个 bot
#                             认不出该用户。脚本用**管理 bot 的 app** 反查它的邮箱：
#                               查到 → 换成邮箱（同一个人，跨 app 通用）
#                               查不到 → 保留原值并告警（可能属于别的 app，需要人判断）
#   - 结果为空              → 兜底填 owner（p2pOpen 没有管理员会锁死群聊且无人可管）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOTS_JSON="$HOME/.botmux/bots.json"
OWNER="austin.wangxu@ksher.com"
EXCLUDE=""
DRY=0
MIGRATE_MEM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --exclude) EXCLUDE="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --migrate-memory) MIGRATE_MEM=1; shift ;;
    --bots-json) BOTS_JSON="$2"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{print; next} {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[ -f "$BOTS_JSON" ] || { echo "找不到 ${BOTS_JSON}（你不是管理 bot？读隔离的 bot 读不到它）" >&2; exit 1; }

# --bots-json 只是演练用的：后面的 role-deploy / lark-cli / restart 都作用在**真实系统**上，
# 拿它去真跑会「改了假 bots.json、却把真 daemon 重启了」。所以硬绑定 --dry-run。
if [ "$BOTS_JSON" != "$HOME/.botmux/bots.json" ] && [ "$DRY" -eq 0 ]; then
  echo "--bots-json 只能与 --dry-run 一起用（它只影响第①步，后续步骤仍作用于真实系统）" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "读隔离只支持 macOS，本机不是 —— 迁移会写入一个永远不生效的 readIsolation，拒绝执行" >&2
  exit 1
fi

# ⚠️ 硬校验：跑的必须是源码版 botmux。npm 版会静默忽略 readIsolation / p2pOpen。
# 判别不能用 `botmux --version`（源码版与 npm 版都打印 0.0.0），只能看 wrapper 指向哪。
BM="$(command -v botmux || true)"
[ -n "$BM" ] || { echo "PATH 里找不到 botmux（把 ~/.botmux/bin 加到 PATH 最前）" >&2; exit 1; }
if ! grep -q "$REPO_ROOT/dist/cli.js" "$BM" 2>/dev/null; then
  cat >&2 <<EOF
❌ 全局 botmux 没指向本 checkout —— 拒绝迁移（否则 readIsolation / p2pOpen 会被静默忽略）

   command -v botmux  = ${BM}
   它指向             = $(sed -n 's/^exec node "\(.*\)".*/\1/p' "$BM" 2>/dev/null || echo "（不是 wrapper，多半是 npm 装的）")
   本 checkout 期望   = ${REPO_ROOT}/dist/cli.js

   修：在本 checkout 跑  npx pnpm@9 switch:here
       并确保 ~/.botmux/bin 在 PATH **最前**（npm 版会抢在前面）
       彻底点：npm rm -g botmux
EOF
  exit 1
fi

# 管理 bot 绝不能开读隔离（隔离后读不到 bots.json / 日志 → 自废武功、再也管不了任何 bot）。
# 脚本跑在 bot 会话里时，botmux 注入的 BOTMUX_LARK_APP_ID 就是「我自己」—— 自动排除，
# 这样即使人忘了 --exclude 也不会把管理 bot 隔离掉。
SELF="${BOTMUX_LARK_APP_ID:-}"
if [ -n "$SELF" ] && ! echo ",${EXCLUDE}," | grep -q ",${SELF},"; then
  EXCLUDE="${EXCLUDE:+${EXCLUDE},}${SELF}"
  echo "ℹ️  自动排除当前管理 bot：${SELF}（读隔离会让它读不到 bots.json，从此谁也管不了）"
fi
if [ -z "$EXCLUDE" ]; then
  cat >&2 <<'EOF'
❌ 没有指定 --exclude，也检测不到当前 bot 身份（BOTMUX_LARK_APP_ID 未设）。

   不排除管理 bot 就跑，会给它开读隔离 → 它再也读不到 bots.json / 日志 → 自废武功。
   请显式指定：--exclude <管理 bot 的 appId>
EOF
  exit 1
fi

echo "bots.json : ${BOTS_JSON}"
echo "owner     : ${OWNER}"
echo "排除      : ${EXCLUDE}"
[ "$DRY" -eq 1 ] && echo "模式      : DRY-RUN（不落盘）"
echo

# ── 第一遍：算出每个 bot 要改什么，并把 ou_ 反查成邮箱 ──────────────────────────
PLAN="$(mktemp)"; trap 'rm -f "$PLAN"' EXIT
node -e '
const fs=require("fs");
const [p,excludeRaw,owner,planOut]=process.argv.slice(1);
const exclude=new Set(excludeRaw.split(",").map(s=>s.trim()).filter(Boolean));
const bots=JSON.parse(fs.readFileSync(p,"utf8"));
const plan=[];
for (const b of bots) {
  const id=b.larkAppId;
  if (exclude.has(id)) { console.log(`  ⏭  ${id}  跳过（--exclude）`); continue; }
  const changes=[];
  if (b.readIsolation!==true) changes.push("readIsolation: "+JSON.stringify(b.readIsolation)+" → true");
  if (b.p2pOpen!==true)       changes.push("p2pOpen: "+JSON.stringify(b.p2pOpen)+" → true");
  if (!b.defaultWorkingDir)   changes.push("角色系统: 缺 defaultWorkingDir → 由 role-deploy 补");
  if (!(b.brandLabel||"").includes("{cwdName}")) changes.push("角色名脚注: 缺 brandLabel → 由 role-deploy 补");
  const users=b.allowedUsers||[];
  const rawOu=users.filter(u=>typeof u==="string" && u.startsWith("ou_"));
  if (rawOu.length) changes.push("allowedUsers 含裸 open_id（按 app 隔离，可能锁死）: "+rawOu.join(",")+" → 反查邮箱");
  if (!users.length) changes.push("allowedUsers 为空 → 兜底填 "+owner);
  plan.push({id, name:b.name||"", changes, rawOu, users});
  console.log(`  ${changes.length? "🔧":"✅"} ${id}  ${changes.length? changes.length+" 处改动":"已符合默认偏好"}`);
  for (const c of changes) console.log(`       - ${c}`);
}
fs.writeFileSync(planOut, JSON.stringify(plan,null,2));
' "$BOTS_JSON" "$EXCLUDE" "$OWNER" "$PLAN"

TARGETS="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(p.filter(x=>x.changes.length).map(x=>x.id).join(","))' "$PLAN")"
if [ -z "$TARGETS" ]; then
  echo
  echo "✅ 没有 bot 需要迁移（都已符合默认偏好）"
  exit 0
fi

# ── ou_ → 邮箱：用管理 bot 自己的 app 反查（open_id 是 app-scoped 的，只有本 app 认得） ──
RESOLVED="$(mktemp)"; trap 'rm -f "$PLAN" "$RESOLVED"' EXIT
echo "{}" > "$RESOLVED"
for OU in $(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([...new Set(p.flatMap(x=>x.rawOu))].join(" "))' "$PLAN"); do
  EMAIL=""
  if command -v lark-cli >/dev/null; then
    EMAIL="$(lark-cli contact +get-user --user-id "$OU" --as bot 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j?.data?.user?.email||"")}catch{}})' || true)"
  fi
  if [ -n "$EMAIL" ]; then
    echo "  🔎 ${OU} → ${EMAIL}"
    node -e 'const fs=require("fs");const[f,k,v]=process.argv.slice(1);const m=JSON.parse(fs.readFileSync(f,"utf8"));m[k]=v;fs.writeFileSync(f,JSON.stringify(m));' "$RESOLVED" "$OU" "$EMAIL"
  else
    echo "  ⚠️  ${OU} 反查不到邮箱（可能属于别的 app）—— 保留原值，请人工确认该 bot 的 owner"
  fi
done

if [ "$MIGRATE_MEM" -eq 1 ]; then
echo
echo "== 记忆迁移（拷贝，不删原件）=="
# 桶 = cwd 绝对路径把非字母数字全换成 "-"（与 role-deploy.sh 的 slug() 同构）
for ID in $(echo "$TARGETS" | tr ',' ' '); do
  OLD_CWD="$(node -e '
    const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).find(x=>x.larkAppId===process.argv[2]);
    let w=b?.workingDir || "~";
    if (w==="~" || w.startsWith("~/")) w = process.env.HOME + w.slice(1);
    process.stdout.write(w);
  ' "$BOTS_JSON" "$ID")"
  NEW_CWD="$HOME/botmux-roles/$ID/shared/default"
  SLUG_OLD="$(node -e 'process.stdout.write(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$OLD_CWD")"
  SLUG_NEW="$(node -e 'process.stdout.write(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$NEW_CWD")"
  SRC="$HOME/.claude/projects/$SLUG_OLD/memory"
  DST="$HOME/.botmux/bots/$ID/claude/projects/$SLUG_NEW/memory"

  if [ "$OLD_CWD" = "$HOME" ]; then
    echo "  🛑 ${ID}: 旧 cwd 回落到 \$HOME —— 那是**公共桶**（所有没配 workingDir 的 bot + 你自己在 \$HOME 跑的 claude 全混在一起）"
    echo "     拒绝自动搬（会造成跨 bot 记忆串味，正是读隔离要防的）。桶里现有的记忆："
    if [ -d "$SRC" ]; then ls -1 "$SRC" 2>/dev/null | sed 's/^/       - /'; else echo "       （该桶没有 memory/，无事可做）"; fi
    echo "     要搬的话人工挑文件拷到：${DST}/"
    continue
  fi

  if [ ! -d "$SRC" ]; then
    echo "  ⏭  ${ID}: 旧桶没有记忆（${SRC} 不存在），跳过"
    continue
  fi

  echo "  📦 ${ID}: ${SRC}  →  ${DST}"
  ls -1 "$SRC" | sed 's/^/       - /'
  if [ "$DRY" -eq 0 ]; then
    mkdir -p "$DST"
    cp -R "$SRC/." "$DST/"
    echo "     ✅ 已拷贝（原件保留在 ${SRC}）"
  fi
done
fi

if [ "$DRY" -eq 1 ]; then
  echo
  echo "DRY-RUN 结束。去掉 --dry-run 即执行。"
  exit 0
fi

# ── 落盘 ────────────────────────────────────────────────────────────────────
echo
echo "== ① 改 bots.json（先备份）=="
cp "$BOTS_JSON" "${BOTS_JSON}.bak-migrate-$(date +%Y%m%d-%H%M%S)"
node -e '
const fs=require("fs");
const [p,targetsRaw,owner,resolvedPath]=process.argv.slice(1);
const targets=new Set(targetsRaw.split(",").filter(Boolean));
const resolved=JSON.parse(fs.readFileSync(resolvedPath,"utf8"));
const bots=JSON.parse(fs.readFileSync(p,"utf8"));
for (const b of bots) {
  if (!targets.has(b.larkAppId)) continue;
  b.readIsolation = true;
  b.p2pOpen = true;
  let users = (b.allowedUsers||[]).map(u => (typeof u==="string" && u.startsWith("ou_") && resolved[u]) ? resolved[u] : u);
  users = [...new Set(users)];
  if (!users.length) users = [owner];   // p2pOpen 无管理员 = 群聊锁死 + 无人可管
  b.allowedUsers = users;
  console.log(`  ${b.larkAppId}: readIsolation=true, p2pOpen=true, allowedUsers=[${users.join(",")}]`);
}
fs.writeFileSync(p, JSON.stringify(bots,null,2)+"\n");
' "$BOTS_JSON" "$TARGETS" "$OWNER" "$RESOLVED"

echo
echo "== ② 角色系统（骨架 + 三件套）=="
"$REPO_ROOT/scripts/role-deploy.sh" --bots "$TARGETS" --configure-bots --skip-build

echo
echo "== ③ lark-cli 身份：每个 bot 用自己的飞书 app =="
# secret 直接从 bots.json 取 —— 管理 bot 不隔离，读得到，不用再找人要
for ID in $(echo "$TARGETS" | tr ',' ' '); do
  LARK_CFG="$HOME/.lark-cli-bots/$ID"
  if [ -f "$LARK_CFG/config.json" ]; then
    echo "  已存在：${LARK_CFG}（跳过）"
    continue
  fi
  SECRET="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).find(x=>x.larkAppId===process.argv[2]);process.stdout.write(b?.larkAppSecret||"")' "$BOTS_JSON" "$ID")"
  if [ -z "$SECRET" ] || ! command -v lark-cli >/dev/null; then
    echo "  ⚠️  ${ID}: 缺 larkAppSecret 或没装 lark-cli —— 跳过，该 bot 的飞书身份需手动补"
    continue
  fi
  mkdir -p "$LARK_CFG"
  printf '%s' "$SECRET" | LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG" \
    lark-cli config init --app-id "$ID" --app-secret-stdin --brand feishu >/dev/null
  LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG" lark-cli config default-as bot   >/dev/null 2>&1 || true
  LARKSUITE_CLI_CONFIG_DIR="$LARK_CFG" lark-cli config strict-mode bot  >/dev/null 2>&1 || true
  echo "  已配置：${LARK_CFG}"
done

echo
echo "== ④ 重启 + 自检 =="
botmux restart >/dev/null 2>&1 || echo "  ⚠️ botmux restart 失败，手动查 botmux status / logs"
sleep 3
node -e '
const fs=require("fs");
const [p,targetsRaw]=process.argv.slice(1);
const targets=targetsRaw.split(",").filter(Boolean);
const bots=JSON.parse(fs.readFileSync(p,"utf8"));
let bad=0;
for (const id of targets) {
  const b=bots.find(x=>x.larkAppId===id);
  const checks=[
    ["readIsolation", b.readIsolation===true],
    ["p2pOpen", b.p2pOpen===true],
    ["allowedUsers 非空", (b.allowedUsers||[]).length>0],
    ["allowedUsers 无裸 ou_", !(b.allowedUsers||[]).some(u=>String(u).startsWith("ou_"))],
    ["defaultWorkingDir", !!b.defaultWorkingDir],
    ["brandLabel", (b.brandLabel||"").includes("{cwdName}")],
    ["lark-cli 自己的 app", fs.existsSync(process.env.HOME+"/.lark-cli-bots/"+id+"/config.json")],
  ];
  console.log(`  ${id}:`);
  for (const [k,v] of checks) { console.log(`    ${v?"✅":"❌"} ${k}`); if(!v) bad++; }
}
if (bad) { console.error(`\n❌ ${bad} 项未通过，检查上面的 ❌`); process.exit(1); }
console.log("\n✅ 全部通过");
' "$BOTS_JSON" "$TARGETS"

cat <<EOF

== 还剩人工的事 ==
1) 每个迁移过的 bot，在飞书开放平台确认：事件用「长连接(WebSocket)」、已订阅
   im.message.receive_v1 与 card.action.trigger、已发布版本并设了「可用范围」
   ⚠️ p2pOpen 已开 —— 「可用范围」就是「谁能私聊这个 bot」的唯一闸门
2) 每个 bot 开一个新话题说句话（种角色目录的信任标记，否则切角色会被信任框卡死）
3) 抽查：让某个 bot 跑 lark-cli whoami，appId 必须等于它自己的 appId
EOF
