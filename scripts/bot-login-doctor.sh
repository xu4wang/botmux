#!/usr/bin/env bash
# bot-login-doctor —— 诊断并修复 botmux/cc-connect 的 claude 凭证掉登录问题
#   用法:  bot-login-doctor.sh          # 只诊断 + 打印建议
#          bot-login-doctor.sh --fix     # 诊断 + 自动执行安全修复(suspend 重播种 / 重启 cc-connect)
#          bot-login-doctor.sh --help    # 打印本说明
#
# 【可配置项 —— 环境变量覆盖,否则自动探测】
#   CLAUDE_CREDENTIALS       默认 $HOME/.claude/.credentials.json
#   CLAUDE_KEYCHAIN_SERVICE  默认 "Claude Code-credentials"
#   CC_CONNECT_LABEL         默认从 launchctl 探测含 cc-connect 的 label;探测不到则跳过 cc-connect 步骤
#   CLAUDE_BIN / BOTMUX_BIN  默认取 PATH 上的 claude / botmux
#   平台:keychain 相关逻辑仅 macOS 生效;非 macOS(无 `security`)自动视为"单一文件源"跳过。
#
# ══════════════════════════════════════════════════════════════════════════════
# 原理(2026-07 深挖实证。也见记忆 claude-cred-keychain-file-split)
# ══════════════════════════════════════════════════════════════════════════════
#
# 【1. Claude Code 在 macOS 有两套凭证存储】
#   ▸ keychain 条目 "Claude Code-credentials"(acct=当前用户):
#       跑在 Aqua(GUI 登录)会话里的 native claude 优先读它,也能写回自我刷新。
#   ▸ 文件 ~/.claude/.credentials.json:
#       非 Aqua(SSH/Background)上下文、或设了 CLAUDE_CONFIG_DIR 时读它。
#   两套存储各写各的、不互相镜像 —— 一旦并存就可能分裂。
#   (Linux 上根本没 keychain,claude 一直只用文件 → 无此问题。)
#
# 【2. 会话决定 claude 读哪套 / 各操作在 SSH 下能不能做】
#   ▸ botmux daemon(launchd gui/<uid> 域)和 cc-connect 都在 Aqua → 它们的 claude
#     默认读 keychain;删掉 keychain 条目后回退读文件。
#   ▸ 本脚本跑在 SSH(非 Aqua)会话,对 keychain 只有部分权限:
#       ① 查存在/元数据 find(不带 -w) → ✅ 能(属性在可搜索索引里,免解密/交互)
#       ② 读密钥内容    find -w        → ❌ exit 36(errSecInteractionNotAllowed)
#       ③ 增/删/改      add / delete   → ❌ exit 36(要用户交互授权)
#     所以脚本能【查出】keychain 复活、但【删不了】——删要去 Mac 的 GUI Terminal。
#   ▸ 同理:在 SSH 里跑 /login 只写文件、写不进 keychain。
#
# 【3. 隔离 bot 为什么反而稳】
#   隔离 bot 经 CLAUDE_CONFIG_DIR 重定向读自己的 per-bot 文件拷贝
#   ~/.botmux/bots/<appId>/claude/.credentials.json(Seatbelt 挡了它读 keychain);
#   provisioning 每次冷启动跑 freshestClaudeCred() 从 ~/.claude/.credentials.json
#   重新播种这份拷贝。所以隔离 bot 始终走"文件"这条、天然避开 keychain。
#
# 【4. 事故模式(经典)】
#   在 SSH 里 /login → 只更新文件、keychain 停在旧 token → 读 keychain 的 native bot
#   (非隔离 + cc-connect)集体 "Not logged in";读文件的隔离 bot 却全部正常。
#
# 【5. 为什么"修 keychain"治标不治本 → 已改为删 keychain 收敛到单一文件源】
#   refresh token 会随刷新【轮换】(实测:刷新前后 refresh 指纹变了)。两套存储抢同一
#   账号时,谁先刷新就把 refresh token 轮换掉,另一套攥旧 RT 下次刷新即 401。所以
#   GUI 里 security -U 把好 token 灌回 keychain 只能撑一个刷新周期就复发。
#   根治 = 【GUI 里删掉 keychain 条目】→ 只剩文件一套存储、无轮换竞争;native claude
#   回退读文件(自带活 RT、自愈)。副作用是正面的:此后 SSH /login 也能触达所有 bot。
#   ⚠️ 铁律:CC CLI 登录只在 SSH,别在 GUI /login —— 否则 keychain 条目会复活、分裂重现。
#
# 【6. 残留风险】
#   文件源 + N 份隔离拷贝在 RT 轮换下仍有窄竞争窗口(某隔离 bot 连续跑过 token 寿命
#   ~8h、中途没冷启动重播种 → 独立刷新把文件源 RT 也轮换废 → 大面积掉登录)。概率低。
#   要彻底消除 → 给 bot 用 ANTHROPIC_API_KEY(不刷新不轮换;代价:按量计费不吃订阅)。
#
# ══════════════════════════════════════════════════════════════════════════════
# 决策树(据此路由,退出码见各分支)
# ══════════════════════════════════════════════════════════════════════════════
#   不变量优先:先保证"单一文件源"—— keychain 条目必须不存在,存在就是分裂源、最高优先级。
#   ① keychain 条目存在       → 【退出码 3】先去 GUI 删(SSH 删不了),与文件好坏无关;删后重跑
#   ② 无 keychain + 文件源失效 → 【退出码 2】SSH /login(交互),再 --fix 重播种
#   ③ 无 keychain + 文件源 OK  → 【退出码 0】掉登录的 bot 只需重播种;--fix 自动做:
#                                 botmux suspend all + 重启 cc-connect + 清孤儿子 claude
# ══════════════════════════════════════════════════════════════════════════════
set -u

# ── 可配置 / 自动探测 ──
CRED="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
KC_SVC="${CLAUDE_KEYCHAIN_SERVICE:-Claude Code-credentials}"
UID_N="$(id -u)"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
BOTMUX_BIN="${BOTMUX_BIN:-$(command -v botmux || echo "$HOME/.botmux/bin/botmux")}"
HAS_SECURITY=0; command -v security >/dev/null 2>&1 && HAS_SECURITY=1   # macOS keychain 工具
CC_LABEL="${CC_CONNECT_LABEL:-$(launchctl list 2>/dev/null | grep -i cc-connect | awk '{print $3}' | head -1)}"

APPLY=0
case "${1:-}" in
  --fix)     APPLY=1 ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  "")        ;;
  *)         printf '未知参数: %s(用 --fix 或 --help)\n' "$1"; exit 64 ;;
esac
[ -z "$CLAUDE_BIN" ] && { printf '❌ 找不到 claude 命令(设 CLAUDE_BIN 或装 claude)\n'; exit 69; }

hr() { printf '────────────────────────────────────────\n'; }
run_timed() { perl -e 'alarm shift; exec @ARGV' "$@"; }   # macOS 无 timeout,用 perl alarm 防挂死

hr
printf 'botmux 凭证诊断  %s   (模式: %s)\n' "$(date '+%m-%d %H:%M:%S')" "$([ $APPLY = 1 ] && echo 修复 || echo 只诊断)"
printf '  文件源:     %s\n' "$CRED"
printf '  keychain:   %s\n' "$([ $HAS_SECURITY = 1 ] && echo "$KC_SVC" || echo '(非 macOS,无 keychain)')"
printf '  cc-connect: %s\n' "${CC_LABEL:-（未检测到,跳过）}"
hr

# ── 1. 文件源存在? ──
if [ ! -f "$CRED" ]; then
  printf '❌ 文件源不存在: %s\n' "$CRED"
  printf '   → 运行  %s  然后 /login,再重跑本脚本 --fix\n' "$CLAUDE_BIN"
  exit 2
fi
EXP=$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;console.log(Math.round((Number(o.expiresAt)-Date.now())/60000))}catch(e){console.log("ERR")}' "$CRED" 2>/dev/null)
printf '文件源 access token 剩余: %s 分钟\n' "$EXP"

# ── 2. 【第一道闸】keychain 不变量:条目必须不存在 ──
# 只要条目在,native bot(非隔离/cc-connect)就读它、迟早随 refresh 轮换分裂 —— 与文件好坏无关,
# 所以先于花 API 的功能测试处理。用 find(不带 -w)只查存在:SSH 查得到但删不了(见 header【2】)。
# GUI(Aqua)会话下能读出 keychain(可能弹授权框)→ 走【安全恢复】:合并最新 token→删→suspend。
# ⚠️ 绝不盲删:keychain 重现时好 token 常在 keychain、文件陈旧,直接删会让全员回退陈旧文件→全掉。
if [ "$HAS_SECURITY" = 1 ] && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
  printf '⚠️  keychain 条目【存在】—— 有人 GUI 登录 / bot 自刷,分裂源\n'
  KCRAW="$(security find-generic-password -s "$KC_SVC" -w 2>/dev/null)"
  if [ -n "$KCRAW" ] && printf '%s' "$KCRAW" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{Number(JSON.parse(s).claudeAiOauth.expiresAt);process.exit(0)}catch(e){process.exit(1)}})'; then
    # ── 能读出(GUI 授权)→ 安全恢复:比新鲜度,合并最新到文件,再删,再 suspend ──
    KCEXP=$(printf '%s' "$KCRAW" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{console.log(Number(JSON.parse(s).claudeAiOauth.expiresAt)||0)}catch(e){console.log(0)}})')
    FILEEXP=$(node -e 'try{console.log(Number(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth.expiresAt)||0)}catch(e){console.log(0)}' "$CRED")
    if [ "${KCEXP:-0}" -gt "${FILEEXP:-0}" ]; then NEWER=kc; printf '   ✅ 能读出 keychain;keychain 更新、文件陈旧 → 需先把 keychain 合并进文件\n'
    else NEWER=file; printf '   ✅ 能读出 keychain;文件已是最新 → 直接删 keychain 即可\n'; fi
    hr
    printf '诊断: 【keychain 重现,GUI 安全恢复:合并最新 token → 删 keychain → suspend all】\n'
    if [ "$APPLY" = 1 ]; then
      if [ "$NEWER" = kc ]; then
        printf '%s' "$KCRAW" > "$CRED.tmp.$$" && chmod 600 "$CRED.tmp.$$" && mv -f "$CRED.tmp.$$" "$CRED" && printf '  ↳ keychain 最新 token 已写入共享文件\n'
      fi
      for d in "$HOME"/.botmux/bots/*/claude/.credentials.json; do [ -e "$d" ] && cp "$CRED" "$d.tmp.$$" && chmod 600 "$d.tmp.$$" && mv -f "$d.tmp.$$" "$d" && printf '  ↳ 播种 %s\n' "$(echo "$d"|sed -E 's#.*/cli_([^/]+)/.*#cli_\1#')"; done
      if security delete-generic-password -s "$KC_SVC" >/dev/null 2>&1; then printf '  ✅ keychain 已删(收敛回单一文件源)\n'; else printf '  ⚠️ keychain 删除失败(授权框未点允许?);文件已合并,可手动删后再 suspend\n'; fi
      "$BOTMUX_BIN" suspend all >/dev/null 2>&1 && printf '  ↳ suspend all 完成\n'
      CC=$(launchctl list 2>/dev/null | grep -i cc-connect | awk '{print $3}' | head -1)
      [ -n "$CC" ] && launchctl kickstart -k "gui/$UID_N/$CC" >/dev/null 2>&1 && printf '  ↳ cc-connect 重启\n'
      printf '✅ 恢复完成。飞书确认各 bot。\n'
      exit 0
    else
      printf '  → 跑 --fix 执行:合并最新 token 到文件 + 删 keychain + suspend all(此会话能读出,可自动)\n'
      exit 3
    fi
  else
    # ── 读不出(SSH/未授权)→ 只能人工 GUI 处理 ──
    hr
    printf '诊断: 【keychain 重现,但当前会话读不出它(SSH/未授权,claude-only ACL)】\n'
    printf '  ⚠️ 别在 SSH 盲删:keychain 可能握最新 token、文件陈旧,盲删→全员回退陈旧文件→全掉。\n'
    printf '  请在 *GUI Terminal* 里跑:  bot-login-doctor --fix\n'
    printf '  (GUI 下会:读 keychain→取最新 token 合并进文件→删 keychain→suspend all)\n'
    exit 3
  fi
fi
printf '%s\n' "$([ "$HAS_SECURITY" = 1 ] && echo '✅ keychain 无条目(单一文件源不变量 OK)' || echo 'ℹ️  非 macOS,无 keychain(天然单一文件源)')"

# ── 3. 功能测试:SSH 里 claude 能否用文件登录(SSH 读不了 keychain = 纯测文件源)──
printf '功能测试 (claude -p, 纯文件路径)…\n'
FTEST=$(run_timed 60 "$CLAUDE_BIN" -p "reply with exactly: OK" </dev/null 2>&1 | head -3)
if printf '%s' "$FTEST" | grep -qx "OK"; then
  FILE_OK=1; printf '✅ 文件源有效(claude 从文件登录成功)\n'
else
  FILE_OK=0; printf '❌ 文件源失效 —— claude 用它登录失败:\n'; printf '   %s\n' "$FTEST"
fi

# ── 4. 各活跃 bot 屏幕状态(参考)──
# 只看当前屏幕最后几行(提示符区):掉登录时那条是最后内容;正常时最后是状态栏。
# 抓整屏会误报旧滚动历史里的 "Not logged in"。
DOWN=""
for s in $(tmux ls 2>/dev/null | grep -oE '^bmx-[a-f0-9]+'); do
  if tmux capture-pane -p -t "$s" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -6 | grep -qiE "Not logged in|Please run /login|Invalid.*credential"; then DOWN="$DOWN $s"; fi
done
[ -n "$DOWN" ] && printf '⚠️  当前屏幕仍显示掉登录的 bot pane:%s\n' "$DOWN" || printf '各活跃 bot pane 当前屏幕无掉登录字样\n'

hr
# ══ 决策 + 修复(此处 keychain 已确保不存在)══
if [ "$FILE_OK" = 0 ]; then
  printf '诊断: 【文件源本身失效】(refresh token 被轮换孤立 / 过期)。\n'
  printf '修复(需交互,脚本代跑不了 /login):\n'
  printf '  1) %s          # 进去 /login,浏览器授权\n' "$CLAUDE_BIN"
  printf '  2) 重跑本脚本 --fix   # 让全员从新文件重播种\n'
  exit 2
fi

# keychain 不存在 + 文件源 OK → 掉登录的 bot 只需从文件重新播种
printf '诊断: 【只需重播种】单一文件源、健康。\n'
if [ "$APPLY" = 1 ]; then
  printf '→ botmux suspend all(全员下条消息冷启动、从文件重播种)…\n'
  "$BOTMUX_BIN" suspend all 2>&1 | tail -3
  if [ -n "$CC_LABEL" ]; then
    printf '→ 重启 cc-connect (%s)…\n' "$CC_LABEL"
    launchctl kickstart -k "gui/$UID_N/$CC_LABEL" 2>&1 | head -2
    # 清理可能残留的孤儿子 claude(下条消息会 --resume 重启,不丢会话)
    for p in $(pgrep -f "claude --output-format stream-json" 2>/dev/null); do
      [ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = "1" ] && kill "$p" 2>/dev/null && printf '   清理孤儿 claude pid=%s\n' "$p"
    done
  else
    printf 'ℹ️  未检测到 cc-connect,跳过其重启\n'
  fi
  printf '✅ 完成。在飞书里戳一下各 bot 确认恢复。\n'
else
  printf '→ 跑本脚本 --fix 自动修复,或手动:\n'
  printf '    botmux suspend all\n'
  [ -n "$CC_LABEL" ] && printf '    launchctl kickstart -k gui/%s/%s\n' "$UID_N" "$CC_LABEL"
fi
