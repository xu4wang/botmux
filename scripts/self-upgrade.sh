#!/usr/bin/env bash
# botmux daemon 自升级（macOS；bot 自己跑也安全）：跟随部署分支 → build → restart，全程脱离进程树。
#
#   ./scripts/self-upgrade.sh
#
# 为什么要脱离进程树：`botmux restart` 先 `pm2 delete` 掉所有 bot 再 `pm2 start`，跑这个脚本的
# bot 会话本身就是一个 worker —— 前台直接 restart 会把自己杀在 delete 与 start 之间，daemon
# 全灭且没人能救。所以把「pull+build+restart」甩进一个独立 session 执行，会话被杀了它照样跑完。
#
# 为什么用 python：macOS **没有 `setsid` 命令**（那是 Linux 的），但 python3 是 mac 自带的，
# `os.setsid()` 是同一个 POSIX 系统调用 —— 用它新建 session、脱离原进程组，daemon 杀 worker
# 波及不到。
#
# checkout 路径不写死：从全局 botmux wrapper（`~/.botmux/bin/botmux` → `exec node "<ck>/dist/cli.js"`）
# 反推，各机器自适应。
set -euo pipefail

resolve_checkout() {
  sed -n 's#^exec node "\(.*\)/dist/cli.js".*#\1#p' "$(command -v botmux)" 2>/dev/null
}

# ── 阶段 ②：已被 re-spawn 进独立 session，执行真正的升级（输出全进日志，因为发起方会话已断）──
if [ "${BOTMUX_SELF_UPGRADE_DETACHED:-}" = "1" ]; then
  CK="$(resolve_checkout)"
  LOG="${HOME}/.botmux/logs/self-upgrade.log"
  {
    echo "=== 自升级开始 checkout=${CK} ==="
    cd "$CK"
    # 部署分支是「产物」不是「源」：deploy/all 按公式（上游 master + 仍开着的 PR + ops/local）
    # 重建后 force-push，`git pull --ff-only` 必然失败。机器只「跟随」不「合并」——硬重置。
    #
    # 不用 `@{u}`：tracking 可能被配错（本机就出现过 deploy/all 的 upstream 指向 origin/master），
    # 那样一 reset 就把部署分支拉成了上游主线、丢掉所有未合入的 PR。改成按「同名分支」取，自洽。
    BR="$(git rev-parse --abbrev-ref HEAD)"
    RMT="$(git config --get "branch.${BR}.remote" || echo origin)"
    echo "--- 跟随 ${RMT}/${BR}（硬重置，本地提交会被丢弃）"
    # && 链：任一步失败即停，绝不半途 restart（daemon 会继续跑旧代码，安全）
    git fetch "$RMT" "$BR" \
      && git reset --hard FETCH_HEAD \
      && npx pnpm@9 switch:here \
      && botmux restart \
      && botmux autostart \
      && botmux status
    echo "=== 自升级结束（exit=$?）==="
  } >> "$LOG" 2>&1
  exit 0
fi

# ── 阶段 ①：前台入口。先做安全检查，通过后把自己甩进独立 session ──
CK="$(resolve_checkout)"
[ -n "$CK" ] && [ -d "${CK}/.git" ] || {
  echo "❌ 反推不到 checkout —— 全局 botmux 不是源码版 wrapper？（先做 npm→源码版切换）" >&2
  exit 1
}
cd "$CK"

# 本地改动检查：阶段 ② 会 `reset --hard`，任何本地提交/改动都会被抹掉——所以这道闸是唯一防线。
# 只有未提交的 brand-template 改动能自动丢（正式修复是它的超集）；
# 动了别的文件 → 停下来让人判断，绝不擅自 checkout。
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  OTHER="$(printf '%s\n' "$DIRTY" | grep -vE 'brand-template' || true)"
  if [ -n "$OTHER" ]; then
    echo "🛑 有本地改动（不止 brand-template），拒绝自动升级，请人工处理：" >&2
    printf '%s\n' "$DIRTY" >&2
    exit 2
  fi
  echo "丢弃本地 brand-template 改动（正式修复是超集）"
  # 只丢 brand-template 相关（别的文件已在上面 exit 2 挡掉）；用 -- 明确边界，其一不存在也不报错
  git checkout -- src/im/lark/brand-template.ts test/brand-template.test.ts 2>/dev/null || true
fi

LOG="${HOME}/.botmux/logs/self-upgrade.log"
SELF="${CK}/scripts/self-upgrade.sh"
echo "✅ 检查通过。升级已甩进独立 session —— 本会话马上会断（这是预期），进度看：${LOG}"
# env 前缀设标记变量；python os.setsid 脱离进程组；输入输出全断开（否则会话一断它也跟着收 EOF）
nohup env BOTMUX_SELF_UPGRADE_DETACHED=1 BOTMUX_SELF_UPGRADE_SCRIPT="$SELF" python3 -c \
  "import os,subprocess; os.setsid(); subprocess.run(['bash', os.environ['BOTMUX_SELF_UPGRADE_SCRIPT']])" \
  >/dev/null 2>&1 </dev/null &
