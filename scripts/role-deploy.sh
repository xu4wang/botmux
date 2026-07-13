#!/usr/bin/env bash
# 在一台新机器（Linux / macOS 通用）上把当前 checkout 部署成「带角色系统」的 botmux。
#
#   ./scripts/role-deploy.sh --bots cli_xxx,cli_yyy      # 全新：建角色库骨架
#   ./scripts/role-deploy.sh --import <export.tar.gz>    # 迁移：带上源机的角色与记忆
#   加 --configure-bots 顺带改 ~/.botmux/bots.json（会先备份）
#   加 --skip-build 跳过 pnpm install/build
#
# 做四件事：① 前置检查 ② build + 认领全局 botmux ③ 角色库（骨架或导入，记忆桶按本机路径重算）
# ④ 可选改 bots.json。跑完还需人工做两步（脚本末尾会提示）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROLES_ROOT="$HOME/botmux-roles"
BOTS_JSON="$HOME/.botmux/bots.json"
MIN_CLAUDE="2.1.205"

IMPORT_TAR=""; BOTS=""; CONFIGURE=0; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --import) IMPORT_TAR="$2"; shift 2 ;;
    --bots) BOTS="$2"; shift 2 ;;
    --configure-bots) CONFIGURE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
[ -n "$IMPORT_TAR" ] || [ -n "$BOTS" ] || { echo "要么 --import <tar>，要么 --bots <appId,appId>" >&2; exit 1; }

slug() { node -e 'process.stdout.write(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$1"; }

echo "== ① 前置检查 =="
command -v node >/dev/null || { echo "缺少 node" >&2; exit 1; }
[ "$SKIP_BUILD" -eq 1 ] || command -v pnpm >/dev/null || { echo "缺少 pnpm" >&2; exit 1; }
version_ge() {  # $1 >= $2 ?
  node -e 'const p=s=>String(s).split(".").map(Number);const a=p(process.argv[1]),b=p(process.argv[2]);for(let i=0;i<3;i++){const x=a[i]||0,y=b[i]||0;if(x>y)process.exit(0);if(x<y)process.exit(1);}process.exit(0)' "$1" "$2"
}

if command -v claude >/dev/null 2>&1; then
  cv="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  cv="${cv:-0.0.0}"
  if version_ge "$cv" "$MIN_CLAUDE"; then
    echo "claude $cv ✅（要求 ≥ ${MIN_CLAUDE}）"
  else
    echo "⚠️  claude $cv < ${MIN_CLAUDE}：切角色会退化成杀进程冷启动（丢上下文），功能仍可用，建议升级"
  fi
else
  echo "⚠️  未找到 claude 命令——角色系统目前只支持 Claude Code"
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== ② 安装依赖 + build + 认领全局 botmux =="
  (cd "$REPO_ROOT" && pnpm install && pnpm switch:here)
fi

echo "== ③ 角色库 =="
mkdir -p "$ROLES_ROOT"

write_default_role() {   # $1 = appId
  local app_id="$1" root="$ROLES_ROOT/$1" role="$ROLES_ROOT/$1/shared/default"
  mkdir -p "$role/knowledge"
  # 协议：从仓库模板生成，把 <ROLES_ROOT> 换成本机绝对路径
  sed "s#<ROLES_ROOT>#$root#g" "$REPO_ROOT/docs/roles/role-protocol-template.md" > "$root/_role-protocol.md"
  cp "$root/_role-protocol.md" "$role/_role-protocol.md"
  [ -f "$role/.botmux-dir.json" ] || printf '{\n  "name": "默认助理"\n}\n' > "$role/.botmux-dir.json"
  [ -f "$role/CLAUDE.md" ] || cat > "$role/CLAUDE.md" <<'EOF'
# 角色：默认助理

你是这个 bot 的默认助理，未设定特定人设。

通用助理（无固定仓库）；如需在代码仓库工作，用户会指明路径。

@_role-protocol.md
@knowledge/INDEX.md
EOF
  echo "骨架：$role"
}

if [ -n "$IMPORT_TAR" ]; then
  [ -f "$IMPORT_TAR" ] || { echo "找不到 $IMPORT_TAR" >&2; exit 1; }
  STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
  tar -xzf "$IMPORT_TAR" -C "$STAGE"
  SRC_ROOT="$(cat "$STAGE/source-roles-root")"

  cp -R "$STAGE/roles/." "$ROLES_ROOT/"
  echo "角色库已导入 → $ROLES_ROOT"

  # 协议文件里写死的是源机绝对路径，逐个改写成本机路径
  if [ "$SRC_ROOT" != "$ROLES_ROOT" ]; then
    find "$ROLES_ROOT" -type f -name '_role-protocol.md' | while read -r f; do
      node -e '
        const fs=require("fs"); const [f,from,to]=process.argv.slice(1);
        const s=fs.readFileSync(f,"utf8");
        if (s.includes(from)) fs.writeFileSync(f, s.split(from).join(to));
      ' "$f" "$SRC_ROOT" "$ROLES_ROOT"
    done
    echo "协议内的绝对路径已改写：$SRC_ROOT → $ROLES_ROOT"
  fi

  # 人设/知识里可能写着源机的仓库路径（如 /Users/xxx/some-repo）——不能自动改（目标机未必有那个仓库），只提醒
  SRC_HOME="$(dirname "$SRC_ROOT")"
  if [ "$SRC_HOME" != "$HOME" ]; then
    leftover="$(grep -rl "$SRC_HOME" "$ROLES_ROOT" 2>/dev/null | grep -v '_role-protocol.md' || true)"
    if [ -n "$leftover" ]; then
      echo
      echo "⚠️  下列文件仍写着源机路径（$SRC_HOME/...），多为角色人设里指定的工作仓库，请人工确认目标机上的对应路径："
      printf '%s\n' "$leftover" | sed "s#^#    #"
    fi
  fi

  # 记忆桶：按本机路径重算 slug 落位
  if [ -s "$STAGE/manifest.tsv" ]; then
    while IFS="$(printf '\t')" read -r kind app_id rel; do
      [ -n "${rel:-}" ] || continue
      safe="$(printf '%s' "$rel" | tr '/' '@')"
      src="$STAGE/memory/$kind/$safe"
      [ -d "$src" ] || continue
      bucket="$(slug "$ROLES_ROOT/$rel")"
      if [ "$kind" = global ]; then
        dest="$HOME/.claude/projects/$bucket/memory"
      else
        dest="$HOME/.botmux/bots/$app_id/claude/projects/$bucket/memory"
      fi
      mkdir -p "$dest"
      cp -R "$src/." "$dest/"
      echo "记忆：$rel → $dest"
    done < "$STAGE/manifest.tsv"
  fi
else
  IFS=',' read -r -a _bots <<< "$BOTS"
  for app_id in "${_bots[@]}"; do write_default_role "$app_id"; done
fi

if [ "$CONFIGURE" -eq 1 ]; then
  echo "== ④ 配置 bots.json =="
  [ -f "$BOTS_JSON" ] || { echo "找不到 ${BOTS_JSON}——先把 bot 配好再跑本步" >&2; exit 1; }
  cp "$BOTS_JSON" "$BOTS_JSON.bak-role-$(date +%Y%m%d-%H%M%S)"
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    const only=(process.argv[2]||"").split(",").filter(Boolean);
    const bots=JSON.parse(fs.readFileSync(p,"utf8"));
    let n=0;
    for (const b of bots) {
      const id=b.larkAppId; if (!id) continue;
      if (only.length && !only.includes(id)) continue;
      // 绝对路径：`~` 只有 resolveBotDefaultWorkingDir 那条腿会 expandHome；一旦这个值被
      // 复制进 defaultOncall / oncallChats，pin 就直接取字面量 `~`（resolvePinnedWorkingDir
      // 不展开）→ readDirMeta 的 statSync 必然 ENOENT → 卡片脚注丢角色名。写绝对路径规避。
      b.defaultWorkingDir = `${process.env.HOME}/botmux-roles/${id}/shared/default`;
      b.brandLabel = "[{cwdName}]({cwdUrl})";
      if (!b.tuiSlashAllow) b.tuiSlashAllow = ["/compact"];
      n++;
    }
    fs.writeFileSync(p, JSON.stringify(bots, null, 2) + "\n");
    console.log(`已配置 ${n} 个 bot（defaultWorkingDir / brandLabel / tuiSlashAllow），原文件已备份`);
  ' "$BOTS_JSON" "$BOTS"
fi

# cron 刷 token 需要的网络前提：cron 环境不继承 shell 的 proxy 变量。这里按 cron 的空环境探一次，
# 探不通就必须在 crontab 里显式写 http_proxy/https_proxy（外加 no_proxy 放行 loopback，否则
# botmux suspend all 的 IPC 会被代理劫持）。
echo "== 网络自检（模拟 cron 空环境访问 Anthropic）=="
if env -i PATH=/usr/bin:/bin:/opt/homebrew/bin curl -s -o /dev/null -w "" --max-time 12 \
     https://api.anthropic.com/v1/messages 2>/dev/null; then
  echo "  ✅ 空环境可直连 Anthropic —— crontab 不需要配代理"
else
  echo "  ⚠️  空环境连不上 Anthropic（本机大概率靠 shell 里的 proxy 变量上网）。"
  echo "     cron 不继承这些变量 → 刷 token 会静默失败 → 掉线。crontab 里必须加："
  echo "       http_proxy=http://<host>:<port>"
  echo "       https_proxy=http://<host>:<port>"
  echo "       no_proxy=localhost,127.0.0.1,::1     # 放行 loopback，否则 botmux 的 IPC 被代理劫持"
fi

cat <<EOF

== 还剩两步要人工做 ==
1) botmux restart
2) 每个 bot 开一个新话题，跟「默认助理」说句话——这一次冷启动会种下目录信任标记，
   否则第一次切角色可能弹 Claude Code 的信任框卡住会话。

验收清单见 docs/roles/deploy-runbook.md 第 6 节。
EOF
