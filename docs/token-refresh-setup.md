# Claude 登录凭证自动刷新：部署指南

给**新机器 / 新 bot 安装时**看的操作手册。目标：让这台机器上所有消费 Claude 凭证的进程（botmux 的 bot、cc-connect、定时任务）长期不掉线，且出问题时**有人被叫醒**。

适用平台：macOS（用了 `security`/`stat -f`/crontab；Linux 需要改这几处）。

---

## 0. 先理解三条外部事实（不理解就一定会踩）

这套方案所有的"绕"，都来自这三条不受我们控制的事实：

1. **一个 Claude 订阅账号只有一个 refresh token（RT），刷新即轮换。** 任一进程刷新成功，其他所有持旧 RT 的进程手里的 RT 当场作废。
2. **轮换会立即吊销仍在有效期内的 access token（AT）。** 实测：21:18:43 轮换，21:18:53 一个名义上还有 72 分钟的 AT 就被拒了。所以刷新后**必须立刻**把新凭证发到每个消费者，并让运行中的会话冷启动——不是"它们会慢慢过期"，是秒级全灭。
3. **Claude Code 刷新失败时会自我登出、清空凭证文件。** 所以"谁去刷"这件事必须唯一，且失败必须有人知道。

由此得到唯一正确的架构：

> **单一刷新权威**：这台机器上**只有 cron 脚本**刷 token，bot / 会话 / GUI **从不自刷**；刷完立刻播种所有副本 + `suspend all` 逼冷启动。

---

## 1. 装之前必须回答的三个问题

### Q1：这台机器和别的机器用的是**同一个 Claude 账号**吗？

**如果是同一个账号，绝对不能两台机器各自跑刷新 cron。**两台机器的 cron 会互相轮换掉对方的 RT，症状是随机时间点全员掉线、日志里满屏 `invalid_grant`。

只有两种正确做法：
- **每台机器一个独立 Claude 账号**（推荐，彼此完全隔离）；或
- **只有一台机器是刷新权威**，其他机器不装刷新 cron，改为从权威机同步凭证文件（scp/rsync，权威机刷完后推）。

装之前先确认，不要"先装上看看"。

### Q2：这台机器上有哪些**凭证消费者**？

凡是持有一份自己的 `.credentials.json` 的进程，都必须在播种清单里。漏一个，它那份副本会老化到过期 → 它自刷 → 轮换 RT → **全员掉线，比不隔离更糟**。

本仓库默认播种这三类：

```
~/.botmux/bots/*/claude/.credentials.json      # 隔离 bot
~/.cc-connect/claude/.credentials.json
~/.lark-channel/claude/.credentials.json
```

**还要点清"管不到的消费者"**：Claude Desktop GUI、人手开的独立 `claude` 会话。它们不在播种清单里，每次刷新的瞬间就会被吊销。要么关掉，要么明确接受"刷新后它们需要自己重启"。

另外注意一个容易看错的点：**某些 bot 会话跑的是默认 `~/.claude`，不是它自己的隔离副本**。判断方法：看它的转写落在哪里——

```bash
ls -lat ~/.claude/projects/*/ | head        # 落在这里 = 用默认目录
ls -lat ~/.botmux/bots/<appId>/claude/projects/*/ | head   # 落在这里 = 真隔离
```

跑默认目录的会话有个特殊风险：RT 一被轮换，**它会直接把中心凭证文件清空**（登出逻辑），而不只是弄坏自己那份。

### Q3：这台机器会不会睡？

机器一睡，cron 就漏跑 → token 过期 → 某个消费者自刷 → 轮换 → 分裂掉线。要求：

```bash
pmset -g | grep -E ' sleep| standby'   # sleep 必须为 0，standby 建议 0
sudo pmset -a sleep 0 standby 0        # 需要时设置（displaysleep/disksleep 无所谓）
```

---

## 2. 安装（约 5 分钟）

### 2.1 前置检查

```bash
# ① keychain 里【必须没有】Claude Code 凭证条目，否则 native 进程会走 keychain 造成分裂
security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
  && echo "❌ 有条目，先在 GUI Terminal 删: security delete-generic-password -s 'Claude Code-credentials'" \
  || echo "✅ keychain 干净"

# ② 已经登录过（文件里有 token）
node -e 'const o=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/.credentials.json")).claudeAiOauth;console.log(o.accessToken?"✅ 有 token, 到期 "+new Date(o.expiresAt).toLocaleString():"❌ 空的，先 claude /login")'

# ③ 端点可达（cron 是瘦环境，必须用空环境测，不能只在交互 shell 里测）
env -i /usr/bin/curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 \
  -X POST https://api.anthropic.com/v1/oauth/token -H 'Content-Type: application/json' \
  --data '{"grant_type":"refresh_token","refresh_token":"PROBE","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}'
# 期望 400（配合 invalid_grant）。若是 403/HTML/超时 → 这台机器 cron 里必须显式配代理，见 2.3
```

`claude /login` 只在 **SSH 会话**里做，不要在 GUI Terminal 里做（避免写进 keychain）。

### 2.2 脚本

需要两个脚本（都在本仓库 `scripts/`）：

| 脚本 | 作用 | cron |
|---|---|---|
| `bot-cred-refresh-oauth.sh` | 刷新权威：直连 OAuth 端点换 token → 播种 → suspend | `*/30 * * * *` |
| `cred-contract-audit.sh` | 被动审计：claude 升级后复查 client_id / 端点路径是否还在 | `15 * * * *` |

> `bot-cred-refresh-inplace.sh` 是**已停用**的老实现（伪过期诱导 claude 刷新），只作回滚备胎，**不要装、不要手动跑**。

**移植到新机器时必须改的地方**：

```
bot-cred-refresh-oauth.sh:  NODE_BIN 的兜底路径、ALERT_APP、ALERT_TO
cred-contract-audit.sh:     NODE_BIN 的兜底路径、ALERT_APP、ALERT_TO
cred-oauth-live-test.sh:    NODE、claude 可执行路径、ALERT_APP、ALERT_TO（一次性演练脚本）
```

`ALERT_APP` = 用来发告警的 bot appId（对应 `~/.lark-cli-bots/<appId>` 配置目录），`ALERT_TO` = 收告警的人 open_id。**告警通道刻意走 lark-cli 的 bot 身份，不依赖 claude 凭证**——否则凭证一挂告警跟着哑，就失去意义。也可以在 crontab 里用全局变量行统一设置（见下）。

### 2.3 crontab

```cron
PATH=/Users/<you>/.local/bin:/Users/<you>/.nvm/versions/node/vXX/bin:/usr/bin:/bin
# 仅当 2.1 的 ③ 空环境测不通时才需要这三行（TUN 模式的机器不需要）
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
all_proxy=socks5h://127.0.0.1:7890
ALERT_APP=cli_xxxxxxxxxxxx
ALERT_TO=ou_xxxxxxxxxxxxxxxx

*/30 * * * * SUSPEND=1 /bin/bash /path/to/botmux/scripts/bot-cred-refresh-oauth.sh >> $HOME/.botmux/logs/cred-oauth.log 2>&1
15  * * * *              /bin/bash /path/to/botmux/scripts/cred-contract-audit.sh   >> $HOME/.botmux/logs/cred-contract-audit.log 2>&1
```

要点：

- **用 crontab 不用 launchd**：crontab 是 Background 会话，与 SSH 一致、免 sudo；LaunchAgent 是 Aqua 会话，有风险。
- **`PATH=` 那行不能省**：cron 环境找不到 `node` / `lark-cli`。写**绝对路径**，不要指望 nvm 初始化。
- **`SUSPEND=1` 不能省**：轮换后旧 AT 立即失效，运行中的会话必须冷启动重读。
- **审计那行放 `:15`**：刷新在 `:00`/`:30`，错开可以避免抢 CPU、也避免两套告警挤在同一分钟。

### 2.4 建立审计基线

```bash
QUIET=1 bash scripts/cred-contract-audit.sh     # 第一次只记录，不发通知
cat ~/.botmux/logs/.cred-contract-state.json    # 应有 version / sha / cid_hits / path_hits / verdict=ok
```

### 2.5 验收（必须真按 cron 的环境跑，别只在交互 shell 里测）

```bash
env -i HOME=$HOME PATH=<和 crontab 里一致> \
  ALERT_APP=cli_xxx ALERT_TO=ou_xxx \
  /bin/bash scripts/bot-cred-refresh-oauth.sh
```

期望输出（此时离到期还远，所以是 no-op）：

```
起点: <指纹> 剩 NNNm
剩余 NNNm > 阈值 120m → 无需刷新(no-op)
  ↳ 已告警(飞书)
```

三件事同时被这一条验证了：`node`/`curl` 在 cron PATH 下能找到、飞书告警通道能发出去、no-op 路径秒退。**看到 `⚠️ 告警发送失败` 必须解决再上线**——否则等于装了个哑巴监控。

---

## 3. 首次真刷新：**必须在 claude 会话外做**

这是最容易翻车的一步。**不要在任何 claude/agent 会话里发起真刷新**：轮换会立即吊销这个会话自己手上的 AT，它下一次请求就 401；如果这个会话跑在默认 `~/.claude` 上，它还会顺手把中心凭证文件**清空**。

正确姿势——在独立 tmux / 直接 SSH shell 里跑：

```bash
FORCE=1 SUSPEND=1 bash scripts/bot-cred-refresh-oauth.sh
```

或者用一次性演练脚本（它把顺序固定成：刷新 → 播种 → 用新 AT 自检 → 发报告 → 最后才 suspend）：

```bash
tmux new-session -d -s credtest 'bash scripts/cred-oauth-live-test.sh'
tail -f ~/.botmux/logs/cred-oauth-live-test.log
```

刷完自检（四份指纹必须完全一致）：

```bash
for f in ~/.claude/.credentials.json ~/.botmux/bots/*/claude/.credentials.json; do
  printf '%-60s ' "$f"
  node -e 'const c=require("crypto"),fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1])).claudeAiOauth;console.log(c.createHash("sha256").update(o.accessToken).digest("hex").slice(0,12), new Date(o.expiresAt).toLocaleString())' "$f"
done
```

---

## 4. 告警语义：看到哪条该做什么

| 长相 | 含义 | 该做什么 |
|---|---|---|
| 🟢 `无需刷新(剩 NNNm > 阈值)` | 常规心跳，一切正常 | 什么都不用做。**心跳消失本身是故障信号**（cron 没跑 / 机器睡了） |
| ✅ `本轮已刷新成功` | 真刷新成功，已播种 + suspend | 瞄一眼各 bot 是否正常接消息即可 |
| 🟡 `本轮没刷到(网络层失败)` | 请求没出去，**live 凭证一字未动** | 不用动。30 分钟后自动重试；连续 2 次会升红 |
| 🔴 `refresh token 已失效(invalid_grant)` | RT 真死（多半是别处刷过 / 多机同账号） | **SSH 里 `claude /login`**，然后 `FORCE=1 SUSPEND=1` 手刷一次。顺便查是谁在抢刷 |
| 🔴 `端点回了 200 但字段不认识` | 契约变了，且**新凭证没写进文件** | 看告警里指的 0600 原始响应文件，手工把 token 落盘或直接 `/login`；然后修脚本常量 |
| 🔴 `凭证文件已被清空/损坏，已停止自动刷新` | 熔断：有进程把文件清空了 | `claude /login` 或 `bot-login-doctor --fix`；查是哪个消费者在自刷 |
| 🔴 `契约审计: OAuth 常量对不上了` | claude 升级换了 client_id 或端点路径 | 按告警里给的候选值更新 `CLIENT_ID` / `TOKEN_URL`，再手刷一次验证 |
| 🟦 `契约审计: claude 已变更，但常量仍在` | claude 升级了，契约没变 | 不用做事，知道就行 |

失败计数在 `~/.botmux/logs/.cred-fail-count`：`0` = 正常，`≥900` = 熔断态。

---

## 5. 严禁清单（每一条都对应一次真实事故）

1. **不要在 claude / agent 会话里发起真刷新。** 会话自己的 AT 当场被吊销；跑默认目录的会话还会清空中心凭证文件。
2. **不要用"把凭证复制到临时目录跑一下"来诊断。** 副本刷新 = 真刷新，服务端不认识"副本"这个概念：一刷就轮换掉共享 RT，全机连锁清空。要复现，用**垃圾 refresh_token 探针**（真 RT 永不出门）。
3. **不要让第二个进程也去刷。** 包括：老的 `bot-cred-refresh-inplace.sh`、别的机器上同账号的 cron、手工 `claude /login` 之后忘记播种。
4. **不要漏掉任何消费者。** 播种清单 = 所有持有自己 `.credentials.json` 的进程。
5. **不要只在交互 shell 里验证 cron。** 交互 shell 有 `~/.zshrc` 的 PATH 和代理，cron 没有。
6. **不要在 GUI Terminal 里 `claude /login`。** 会重建 keychain 条目，然后 native 进程走 keychain 分裂。

---

## 6. 附录

### 6.1 OAuth 刷新端点契约（2026-07-29 实测）

```
POST https://api.anthropic.com/v1/oauth/token
Content-Type: application/json          # 不需要 anthropic-beta 头
{"grant_type":"refresh_token","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","refresh_token":"…"}
```

成功响应用到的字段：`access_token`、`expires_in`（28800 = 8 小时）、`refresh_token`（**会返回，即每次刷新都轮换**）、`refresh_token_expires_in`。端点不返回的本地字段（`subscriptionType`、`rateLimitTier`、`scopes`）一律**保留原值**——脚本是"读旧文件 → 只覆盖 token 相关字段 → 整体写回"，不是重建文件。

错误形状（这是选这个方案的最大收益：三种失败在协议层就能分开）：

| 结局 | 长相 |
|---|---|
| 网络层失败 | curl 非 0 退出，**没有 HTTP body** |
| RT 真死 | `400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}` |
| 请求/契约不对 | `400 {"type":"error","error":{"type":"invalid_request_error"},"request_id":…}` |

`client_id` 是从 claude 二进制里扒出来的**非公开契约**（换成假 UUID 会回 `Client with id … not found`，所以它确实被校验）。claude 升级可能换掉它——这就是 `cred-contract-audit.sh` 存在的原因。

### 6.2 文件清单

| 用途 | 路径 |
|---|---|
| 主凭证 | `~/.claude/.credentials.json` |
| 上一份凭证（刷新前自动留） | `~/.claude/.credentials.json.prev` |
| 刷新日志 | `~/.botmux/logs/cred-oauth.log` |
| 审计日志 / 状态 | `~/.botmux/logs/cred-contract-audit.log`、`.cred-contract-state.json` |
| 失败计数 / 熔断标志 | `~/.botmux/logs/.cred-fail-count` |
| 互斥锁 | `~/.botmux/logs/.cred-refresh.lock` |

### 6.3 可调参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARGIN_MIN` | 120 | 剩余寿命 ≤ 此值才刷。cron 每 30 分钟一轮 → 到期前有 4 次机会 |
| `RED_MIN` | 30 | 剩余寿命红线：低于此值本轮失败一律红警（建议按你的响应速度调到 45~60） |
| `CURL_TIMEOUT` | 30 | 单次请求超时（正常一次刷新约 1 秒） |
| `SEED` / `SUSPEND` | 1 / 0 | cron 里必须 `SUSPEND=1` |
| `HEARTBEAT` / `ALERT` | 1 / 1 | `HEARTBEAT=0` 只关常规心跳，真故障仍会告警 |

### 6.4 回滚

新方案出问题时，把 crontab 那一行指回老脚本即可（老脚本原地保留，头部有 DEPRECATED 说明）。老方案的已知代价：伪过期期间存在投毒窗口、失败分支会把死 RT 回滚复活、三种失败结局分不开。**只在紧急时用，用完尽快回来。**

### 6.5 还没做的监控（欢迎补上）

- **契约探针**：每轮 no-op 时用垃圾 RT 打一次端点，断言仍返回 `invalid_grant`；结果并进心跳文本（这样监控自己活着也可见）。能在真刷新之前发现端点/字段/client_id 漂移。
- **刷新后自检**：真刷成功后用新 AT 打一次最小 `/v1/messages`，确认新 token 真被接受（能抓到"形状没变但语义变了"）。
