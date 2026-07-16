#!/usr/bin/env bash
# 导出角色库 + 各角色的记忆桶，打成一个 tar.gz，供 role-deploy.sh 在另一台机器导入。
#
#   ./scripts/role-export.sh [输出文件]        默认 ~/botmux-role-export.tar.gz
#
# 记忆桶按「工作目录绝对路径 slug」分桶（非字母数字全部换成 -），所以换机器（home 路径变了）
# 必须重算目录名——重算在导入侧做，本脚本只按角色相对路径打包。
set -euo pipefail

ROLES_ROOT="${ROLES_ROOT:-$HOME/botmux-roles}"
OUT="${1:-$HOME/botmux-role-export.tar.gz}"

[ -d "$ROLES_ROOT" ] || { echo "找不到角色库：$ROLES_ROOT" >&2; exit 1; }
command -v node >/dev/null || { echo "需要 node" >&2; exit 1; }

slug() { node -e 'process.stdout.write(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$1"; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/roles" "$STAGE/memory"

cp -R "$ROLES_ROOT/." "$STAGE/roles/"
printf '%s\n' "$ROLES_ROOT" > "$STAGE/source-roles-root"
: > "$STAGE/manifest.tsv"

# 角色目录 = 含 CLAUDE.md 的目录
find "$ROLES_ROOT" -type f -name CLAUDE.md | while read -r claude_md; do
  role_dir="$(dirname "$claude_md")"
  rel="${role_dir#"$ROLES_ROOT"/}"          # 如 cli_xxx/shared/default
  app_id="${rel%%/*}"
  bucket="$(slug "$role_dir")"
  safe="$(printf '%s' "$rel" | tr '/' '@')"

  for kind in global isolated; do
    if [ "$kind" = global ]; then
      mem="$HOME/.claude/projects/$bucket/memory"
    else
      mem="$HOME/.botmux/bots/$app_id/claude/projects/$bucket/memory"
    fi
    [ -d "$mem" ] || continue
    mkdir -p "$STAGE/memory/$kind/$safe"
    cp -R "$mem/." "$STAGE/memory/$kind/$safe/"
    printf '%s\t%s\t%s\n' "$kind" "$app_id" "$rel" >> "$STAGE/manifest.tsv"
    echo "记忆：$rel  ($kind)"
  done
done

tar -czf "$OUT" -C "$STAGE" .
echo
echo "已导出：$OUT"
echo "角色目录 $(find "$STAGE/roles" -type f -name CLAUDE.md | wc -l | tr -d ' ') 个，带记忆的 $(wc -l < "$STAGE/manifest.tsv" | tr -d ' ') 个"
echo "把它拷到目标机，然后跑：./scripts/role-deploy.sh --import <该文件>"
