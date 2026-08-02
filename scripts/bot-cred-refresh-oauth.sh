#!/usr/bin/env bash
# bot-cred-refresh-oauth.sh — 直连 OAuth 端点刷新 ~/.claude/.credentials.json
#
# 与 bot-cred-refresh-inplace.sh（伪过期诱导 claude 刷新）的根本区别：
#   本脚本【不碰 live 文件】，先拿到并校验新凭证，才原子写回。
#   于是"伪过期 / 备份 / 回滚 / 投毒窗口 / .claude.json 缩水守卫"整块消失。
#
# 端点契约（2026-07-29 用垃圾 RT 探针实测，真 RT 未出门）：
#   POST https://api.anthropic.com/v1/oauth/token
#   body: grant_type=refresh_token + client_id + refresh_token（JSON 即可，无需 anthropic-beta 头）
#   RT 死     → 400 {"error":"invalid_grant", ...}                    （扁平 OAuth 形状）
#   请求写错  → 400 {"type":"error","error":{"type":"invalid_request_error"},...}（API 形状）
#   网络失败  → curl 非 0 退出，没有 body
#   ⚠️ 非公开契约，claude 升级可能换掉 → 靠"剩余寿命 < RED_MIN 还没刷成就红警"兜底，不做 fallback。
#
# 铁律（沿用，被外部事实逼出来的，删不得）：
#   · 一账号一个 RT，刷新即轮换；**轮换会立即吊销仍在有效期内的 access token**
#     → 刷成功后必须立刻播种所有消费者副本，并 suspend 逼运行中会话冷启动。慢一秒就有人掉。
#   · keychain 里必须没有 Claude Code-credentials 条目，否则 native 进程走 keychain 分裂。
#   · 单一刷新权威：只有本脚本刷，bot 从不自刷。
#
# 用法：
#   scripts/bot-cred-refresh-oauth.sh                # 到期前 MARGIN_MIN 内才刷
#   FORCE=1 SUSPEND=1 scripts/bot-cred-refresh-oauth.sh   # 手动强刷（推荐带 SUSPEND=1）
#   SEED=0 / HEARTBEAT=0 / ALERT=0 同 inplace 版
# 退出码: 0=成功或本轮无需刷新  1=刷新失败(live 未被改动)  2=前置缺失  3=keychain 有条目  4=熔断
#         5=本轮有告警/心跳要发但 ALERT_APP/ALERT_TO 未配置（内容已写 stderr）
#
# ⚠️ ALERT_APP / ALERT_TO 没有默认值，必须每台机器自己配（crontab 里钉）。
#    历史上这里硬编码过 dev-premchai 的身份，导致任何没配的机器把凭证告警静默发到别人那儿
#    ——发送是成功的，只是发错了人，于是"没收到告警"被误读成"没问题"。
#    现在未配置时：告警内容写 stderr（让 cron 的 MAILTO / 外部监控收得到）+ 退出码 5。

set -uo pipefail

CRED="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
KC_SVC="${CLAUDE_KEYCHAIN_SERVICE:-Claude Code-credentials}"
TOKEN_URL="${CLAUDE_TOKEN_URL:-https://api.anthropic.com/v1/oauth/token}"
CLIENT_ID="${CLAUDE_OAUTH_CLIENT_ID:-9d1c250a-e61b-44d9-88ed-5944d1962f5e}"
BOTMUX_BIN="${BOTMUX_BIN:-$(command -v botmux || echo "$HOME/.botmux/bin/botmux")}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /Users/ksher/.local/node-v24/bin/node)}"
SEED="${SEED:-1}"
SUSPEND="${SUSPEND:-0}"
MARGIN_MIN="${MARGIN_MIN:-120}"      # 剩余 ≤ 此值才刷（120 = 到期前有 4 次 cron 机会）
RED_MIN="${RED_MIN:-30}"             # 剩余 < 此值还没刷成 → 无条件红警（兜端点变更/未知故障）
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"

log(){ printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# ── 只打指纹，绝不打原始 token ──
fp(){ "$NODE_BIN" -e 'try{const o=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth)||{};const a=o.accessToken||"";const l=o.expiresAt?Math.round((Number(o.expiresAt)-Date.now())/60000):"?";console.log((a?require("crypto").createHash("sha256").update(a).digest("hex").slice(0,12):"EMPTY")+" 剩"+l+"m")}catch(e){console.log("READ-ERR")}' "$1"; }
haskeys(){ "$NODE_BIN" -e 'try{const o=(JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth)||{};process.exit((o.accessToken&&o.refreshToken)?0:1)}catch(e){process.exit(1)}' "$1"; }
leftmin(){ "$NODE_BIN" -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;console.log(Math.round((Number(o.expiresAt)-Date.now())/60000))}catch(e){console.log(-99999)}' "$1"; }
expfmt(){ "$NODE_BIN" -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;const d=new Date(Number(o.expiresAt));const p=n=>String(n).padStart(2,"0");console.log(p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()))}catch(e){console.log("?")}' "$1"; }
nextref(){ "$NODE_BIN" -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1])).claudeAiOauth;const m=Number(process.argv[2]||120);let t=Number(o.expiresAt)-m*60000;const now=Date.now();if(t<now)t=now;const s=1800000;t=Math.ceil(t/s)*s;if(t<=now)t+=s;const d=new Date(t);const p=n=>String(n).padStart(2,"0");console.log(p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()))}catch(e){console.log("?")}' "$1" "$2"; }
alive(){ kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }

# ── 告警通道：走 lark-cli bot 身份，完全不依赖 claude 凭证（否则凭证一挂告警跟着哑）──
ALERT_APP="${ALERT_APP:-}"          # ← 无默认值，必须本机配；见文件头说明
ALERT_TO="${ALERT_TO:-}"            # ← 同上
ALERT_MISCFG=0
ALERT_STATE="${ALERT_STATE:-$HOME/.botmux/logs/.cred-fail-count}"
HOSTTAG="${HOSTTAG:-$(hostname -s 2>/dev/null || echo host)}"
HEARTBEAT="${HEARTBEAT:-1}"
mkdir -p "$(dirname "$ALERT_STATE")" 2>/dev/null || true
alert(){
  [ "${ALERT:-1}" = 1 ] || return 0
  # fail-loud：宁可吵，也不要把凭证告警静默发给别人（或静默不发）
  if [ -z "$ALERT_APP" ] || [ -z "$ALERT_TO" ]; then
    ALERT_MISCFG=1
    log "  ❌ ALERT_APP/ALERT_TO 未配置 — 告警未发出（请在 crontab 钉本机 appId 与 owner open_id）"
    printf '%s\n%s\n' \
      "[cred-refresh:告警未送达] 【${HOSTTAG}】ALERT_APP/ALERT_TO 未配置，以下内容无法发出：" \
      "$1" >&2
    return 1
  fi
  if LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
       perl -e 'alarm 30; exec @ARGV' lark-cli im +messages-send \
         --as bot --user-id "$ALERT_TO" --text "$1" >/dev/null 2>&1; then
    log "  ↳ 已告警(飞书)"; return 0
  else
    log "  ⚠️ 告警发送失败(查 ~/.lark-cli-bots/$ALERT_APP)"; return 1
  fi
}
heartbeat(){ [ "${HEARTBEAT:-1}" = 1 ] || return 0; alert "$1"; }
failcount(){ local v; v="$(cat "$ALERT_STATE" 2>/dev/null)"; case "$v" in ''|*[!0-9]*|??????*) v=0;; esac; printf '%s' "$((10#$v))"; }
setcount(){ printf '%s\n' "$1" > "$ALERT_STATE.tmp.$$" 2>/dev/null && mv -f "$ALERT_STATE.tmp.$$" "$ALERT_STATE" 2>/dev/null; }

# ── 前置 ──
[ -x "$NODE_BIN" ] || { log "❌ 找不到 node: $NODE_BIN"; exit 2; }
[ -f "$CRED" ] || { log "❌ 凭证文件不存在: $CRED — 先在 SSH 里 /login"; exit 2; }
if command -v security >/dev/null 2>&1 && security find-generic-password -s "$KC_SVC" >/dev/null 2>&1; then
  log "❌ keychain 条目【存在】→ native 进程会走 keychain 分裂。先删: security delete-generic-password -s \"$KC_SVC\""
  exit 3
fi

# ── 互斥锁（与 inplace 版共用同一把，两版永不重叠）──
LOCKDIR="${CRED_LOCK:-$HOME/.botmux/logs/.cred-refresh.lock}"
LOCKPID="$LOCKDIR/pid"
if [ -d "$LOCKDIR" ]; then
  owner="$(cat "$LOCKPID" 2>/dev/null)"; case "$owner" in ''|*[!0-9]*) owner=0;; esac
  if [ "$owner" -ne 0 ] && ! alive "$owner"; then
    rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null
    rmdir "$LOCKDIR" 2>/dev/null && log "⚠️ 清理陈旧锁(持有者 pid=$owner 已不存在)"
  fi
fi
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  log "⏭️ 另一实例持锁(pid=$(cat "$LOCKPID" 2>/dev/null || echo '?'))，本轮跳过"
  exit 0
fi
printf '%s\n' "$$" > "$LOCKPID" 2>/dev/null || { log "❌ 锁 pid 写入失败，不敢无锁运行"; rmdir "$LOCKDIR" 2>/dev/null; exit 2; }
trap 'rc=$?; if [ "$(cat "$LOCKPID" 2>/dev/null)" = "$$" ]; then rm -f "$LOCKPID" "$LOCKDIR/alerted" 2>/dev/null; rmdir "$LOCKDIR" 2>/dev/null; fi; rm -f "$REQ" "$BODY" 2>/dev/null; if [ "${ALERT_MISCFG:-0}" = 1 ] && [ "$rc" = 0 ]; then exit 5; fi' EXIT

REQ=""; BODY=""
log "起点: $(fp "$CRED")"

# ── 熔断：起点被清空/损坏 = 人工介入信号，不是重试信号 ──
if ! haskeys "$CRED"; then
  n=$(failcount)
  if [ "${n:-0}" -lt 900 ]; then
    alert "🔴【${HOSTTAG}】凭证文件已被清空/损坏，已停止自动刷新
文件: $CRED
需人工处理: SSH 里 claude /login，或 bot-login-doctor --fix" && setcount 900
  else
    [ "$n" -lt 99998 ] && setcount $((n + 1))
    heartbeat "🔴【${HOSTTAG}】凭证心跳: 仍处熔断(已跳过 $((n - 899)) 轮)，等待人工 /login"
  fi
  log "❌ 起点无 token → 拒绝继续（熔断）"
  exit 4
fi

# ── 时机门 ──
FORCE="${FORCE:-0}"; [ "${1:-}" = "--force" ] && FORCE=1
LEFT="$(leftmin "$CRED")"
if [ "$FORCE" != 1 ] && [ "${LEFT:-0}" -gt "$MARGIN_MIN" ] 2>/dev/null; then
  log "剩余 ${LEFT}m > 阈值 ${MARGIN_MIN}m → 无需刷新(no-op)"
  heartbeat "🟢【${HOSTTAG}】凭证心跳: 本轮无需刷新(剩 ${LEFT}m > 阈值 ${MARGIN_MIN}m)
token 到期: $(expfmt "$CRED")
预计下次刷新: $(nextref "$CRED" "$MARGIN_MIN")"
  exit 0
fi
log "剩余 ${LEFT}m ≤ 阈值 ${MARGIN_MIN}m(或 --force) → 执行刷新"

# 剩余寿命红线：不管什么原因，到这一步还剩不到 RED_MIN 分钟，本轮失败一律红警
RED=0; [ "${LEFT:-0}" -lt "$RED_MIN" ] 2>/dev/null && RED=1

# ── 请求体由 node 直接写成 0600 文件：RT 不进 argv、不进环境变量、不进 ps ──
REQ="$(mktemp)"; chmod 600 "$REQ"
"$NODE_BIN" -e '
const fs=require("fs");
const o=JSON.parse(fs.readFileSync(process.argv[1])).claudeAiOauth||{};
if(!o.refreshToken) process.exit(1);
fs.writeFileSync(process.argv[3], JSON.stringify({grant_type:"refresh_token",client_id:process.argv[4],refresh_token:o.refreshToken}));
' "$CRED" x "$REQ" "$CLIENT_ID" || { log "❌ 构造请求体失败(文件里没有 refreshToken?)"; exit 2; }

BODY="$(mktemp)"; chmod 600 "$BODY"
HTTP="$(curl -sS -m "$CURL_TIMEOUT" -o "$BODY" -w '%{http_code}' \
        -X POST "$TOKEN_URL" -H 'Content-Type: application/json' --data "@$REQ" 2>/dev/null)"
CRC=$?
rm -f "$REQ"

# ── 结局一：网络层失败（没有 HTTP body）→ live 一个字节都没动 ──
if [ "$CRC" -ne 0 ]; then
  n=$(failcount); [ "${n:-0}" -ge 900 ] && n=0; n=$((n + 1)); setcount "$n"
  log "⚠️ 网络层失败(curl rc=$CRC) — live 未被改动，30 分钟后重试"
  if [ "$RED" = 1 ] || [ "$n" -ge 2 ]; then
    alert "🔴【${HOSTTAG}】凭证刷新失败 第${n}次：网络层失败(curl rc=$CRC)
live 未被改动，token 到期: $(expfmt "$CRED")（剩 ${LEFT}m）
连续失败或已进红线，请人工看一眼网络/端点"
  else
    heartbeat "🟡【${HOSTTAG}】凭证心跳: 本轮没刷到(网络层失败)，live 完好，30 分钟后重试
token 到期: $(expfmt "$CRED")（剩 ${LEFT}m）"
  fi
  exit 1
fi

# ── 结局二：拿到新凭证 → 校验 → 原子写 ──
# ⚠️ 先把原始响应留档(0600)，再做任何解析：RT 已在服务端轮换，产物丢了就只能 /login。
RAW="$HOME/.botmux/logs/.cred-oauth-last-response.json"
cp "$BODY" "$RAW" 2>/dev/null && chmod 600 "$RAW" 2>/dev/null

if [ "$HTTP" = 200 ]; then
  TMPC="$CRED.new.$$"
  if "$NODE_BIN" -e '
    const fs=require("fs");
    const [credPath, bodyPath, outPath] = [process.argv[1], process.argv[2], process.argv[3]];
    const cur = JSON.parse(fs.readFileSync(credPath));
    const r = JSON.parse(fs.readFileSync(bodyPath));
    if(!r.access_token || !r.expires_in) { console.error("MISSING_FIELDS:"+Object.keys(r).join(",")); process.exit(1); }
    const o = Object.assign({}, cur.claudeAiOauth||{});
    o.accessToken = r.access_token;
    if (r.refresh_token) o.refreshToken = r.refresh_token;
    o.expiresAt = Date.now() + Number(r.expires_in)*1000;
    if (r.refresh_token_expires_in) o.refreshTokenExpiresAt = Date.now() + Number(r.refresh_token_expires_in)*1000;
    if (r.scope) o.scopes = String(r.scope).split(" ");
    if (o.accessToken === (cur.claudeAiOauth||{}).accessToken) { console.error("TOKEN_UNCHANGED"); process.exit(1); }
    const out = Object.assign({}, cur, {claudeAiOauth:o});
    fs.writeFileSync(outPath, JSON.stringify(out));
    fs.chmodSync(outPath, 0o600);
    console.log("rotated_rt="+(r.refresh_token?"yes":"no"));
  ' "$CRED" "$BODY" "$TMPC"; then
    cp -p "$CRED" "$CRED.prev" 2>/dev/null && chmod 600 "$CRED.prev" 2>/dev/null
    mv -f "$TMPC" "$CRED"
    rm -f "$RAW"                      # 已安全落盘，原始响应（含 token）不留
    log "✅ 刷新成功: $(fp "$CRED")"
    PREVFAIL=$(failcount); RECOV=""
    [ "${PREVFAIL:-0}" -ge 900 ] && RECOV="
(此前处于熔断状态，现已恢复)"
    [ "${PREVFAIL:-0}" -gt 0 ] && [ "${PREVFAIL:-0}" -lt 900 ] && RECOV="
(此前连续失败 ${PREVFAIL} 次，现已恢复)"
    setcount 0

    if [ "$SEED" = 1 ]; then
      for d in "$HOME"/.botmux/bots/*/claude/.credentials.json \
               "$HOME"/.cc-connect/claude/.credentials.json \
               "$HOME"/.lark-channel/claude/.credentials.json; do
        [ -e "$d" ] || continue
        lbl="${d#$HOME/}"; lbl="${lbl%/claude/.credentials.json}"; lbl="${lbl#.botmux/bots/}"
        cp "$CRED" "$d.tmp.$$" && chmod 600 "$d.tmp.$$" && mv -f "$d.tmp.$$" "$d" && log "  ↳ seed $lbl"
      done
    fi

    heartbeat "✅【${HOSTTAG}】凭证心跳: 本轮已刷新成功(直连 OAuth 端点)
新 token 到期: $(expfmt "$CRED")
预计下次刷新: $(nextref "$CRED" "$MARGIN_MIN")${RECOV}"

    # 旧 AT 在轮换那一刻就被吊销 → 运行中的会话必须立刻冷启动，慢一秒就有人掉
    if [ "$SUSPEND" = 1 ]; then
      if [ -x "$BOTMUX_BIN" ]; then
        "$BOTMUX_BIN" suspend all >/dev/null 2>&1 \
          && log "  ↳ botmux suspend all 完成" \
          || log "  ↳ botmux suspend all 已执行(返回非0，通常是个别 session_not_active)"
      else
        log "  ⚠️ SUSPEND=1 但找不到 botmux($BOTMUX_BIN)，请手动 'botmux suspend all'"
      fi
    else
      log "  ℹ️ 未 suspend：运行中的会话仍握【已被吊销】的旧 AT，请尽快 'botmux suspend all'"
    fi
    log "完成。上一份凭证留在 $CRED.prev"
    log "  ⚠️ 管不到 GUI 里的 claude / 人手开的独立会话——它们此刻已被吊销，需要自己重启。"
    exit 0
  else
    log "❌ 响应 200 但字段对不上/token 未变 — live 未被改动。原始响应: $RAW"
    rm -f "$TMPC" 2>/dev/null
    n=$(failcount); [ "${n:-0}" -ge 900 ] && n=0; n=$((n + 1)); setcount "$n"
    alert "🔴【${HOSTTAG}】凭证刷新失败 第${n}次：端点回了 200 但字段不认识
⚠️ RT 可能已在服务端轮换，而新凭证【没有】写进文件 —— 需要人工处理
原始响应(含 token，0600): $RAW
live 未被改动，token 到期: $(expfmt "$CRED")（剩 ${LEFT}m）"
    exit 1
  fi
fi

# ── 结局三：服务端明确拒绝 ──
ERRKIND="$("$NODE_BIN" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(r.error&&typeof r.error==="string"?r.error:(r.error&&r.error.type?r.error.type:"unknown"))}catch(e){console.log("unparseable")}' "$BODY")"
HEAD="$(head -c 200 "$BODY" 2>/dev/null | tr -d '\n')"
n=$(failcount); [ "${n:-0}" -ge 900 ] && n=0; n=$((n + 1)); setcount "$n"

if [ "$ERRKIND" = "invalid_grant" ]; then
  log "❌ RT 真死(invalid_grant) — live 未被改动，需人工 /login"
  alert "🔴【${HOSTTAG}】refresh token 已失效(invalid_grant)，自动刷新无法继续
live 文件未被改动（没有回滚、没有清空），但它手上的 RT 已经没用了
需人工处理: SSH 里 claude /login
token 到期: $(expfmt "$CRED")（剩 ${LEFT}m）"
else
  log "❌ 端点拒绝(http=$HTTP kind=$ERRKIND) — live 未被改动。响应: $HEAD"
  alert "🔴【${HOSTTAG}】凭证刷新被端点拒绝 第${n}次
http=$HTTP kind=$ERRKIND
响应: $HEAD
live 未被改动，token 到期: $(expfmt "$CRED")（剩 ${LEFT}m）
⚠️ 若是 invalid_request_error，很可能是端点契约变了（claude 升级），需要人工核对"
fi
rm -f "$RAW" 2>/dev/null      # 失败响应里没有 token，不留
exit 1
