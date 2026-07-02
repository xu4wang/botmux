# 读隔离 v2:BOTMUX_HOME per-bot 数据模型(设计草案)

> 目标:把「按 bot 本地读隔离」从**枚举黑名单**升级为**默认拒绝的白名单**,一次性根治 v1 暴露出的洞。
> 状态:**设计草案,待评审**。v1(整体 Seatbelt 外包 + codex review 修复)已上线;本文是下一步。

## 1. 背景:v1 及其暴露的洞

v1 现状(已上线,commit `76c0f147`):
- claude/codex 都用**整体 Seatbelt 外包**(`sandbox-exec` 包整个进程),堵住了 claude 内置沙箱的**联网命令逃逸口**。
- 隔离用**黑名单**:`buildReadDenyPaths` 枚举要 deny 的路径(bots.json / 其他 bot lark-cli / 系统凭证 / `~/.claude/projects` / `~/.codex/sessions`),claude 再 allow 回自己 cwd 的 project 目录(resume+memory)。

v1 暴露的洞:
- **F1(高危,已确认可利用)**:claude 的 carve-out **按 cwd** 放行 `~/.claude/projects/<cwd-hash>`。而 `/cd`/`/repo` **无权限门、允许任意目录** → 用户 `/cd ~/austin` 后让 agent 读该目录的 transcript/memory → **跨 bot 读**。
- **codex 常驻泄漏**:`~/.codex/sessions`(所有 codex bot 共享、按日期存)**没被 deny**(留着好 resume)→ 任何 codex bot 随时能读全部 codex bot 的对话。
- **~/.claude.json 泄漏**:外包下主进程要读它 → agent 也能读 → 泄漏别的 project 的 `lastSessionFirstPrompt`。
- **黑名单本身脆弱**:漏枚举一个敏感路径 = 泄漏(fail-open 方向)。

根因统一:**per-bot 私有数据散落在"全局共享、按文件名/ cwd 区分"的目录里**,再靠枚举去挡——挡不干净。

## 2. 威胁模型(不变)

驱动 bot A 的**半信任**飞书用户,不得读到:
- bot B 的**会话数据**:transcript、memory、CLI config、botmux session 元数据;
- **凭证**:bots.json(全部 bot 密钥)、各 bot 的 lark secret、用户的系统凭证(ssh/aws/…)。

代码(用户的 repo)**不是**隔离对象——bot 本就该能读写它在干活的 repo。

## 3. 核心思路:默认拒绝 + per-bot 数据归拢

1. **所有 per-bot 私有数据搬进 `BOTMUX_HOME/<botAppId>/`(=BOT_HOME)**。
2. Seatbelt:`allow default` → `deny BOTMUX_HOME` → `allow 自己 BOT_HOME`。
3. **代码/repo(BOTMUX_HOME 外)保持开放** → bot 能漫游干活,无 jail 副作用。
4. **系统凭证(BOTMUX_HOME 外)**用一份固定小黑名单挡住。

关键分工:**数据**(多、增长)走白名单(默认拒绝,漏不了);**凭证**(固定一小撮)走黑名单。各用擅长的。

## 4. 目标目录布局

以 `BOTMUX_HOME = ~/.botmux` 为例(bots.json/data 本就在里面,天然被覆盖):

```
~/.botmux/
  bots.json                      # 共享凭证 → 在 BOTMUX_HOME 下、不在任何 BOT_HOME 下 → 默认 deny ✅
  bots/
    <appId-A>/                   # = BOT_HOME (allow 自己)
      claude/                    # CLAUDE_CONFIG_DIR:.claude.json / projects / sessions / statsig / todos / .credentials.json(symlink)
      codex/                     # CODEX_HOME:config / sessions / auth.json(symlink)
      session/                   # 本 bot 的 botmux 元数据:sessions.json / frozen-cards / turn-sends / …
      .send-cred                 # botmux send 凭证
      skills/                    # 本 bot 的 skill 安装位(若需)
    <appId-B>/                   # 别的 bot → deny ✅
  data/                          # 旧的共享 data:迁移后清空;残留一律 deny
```

- claude transcript/memory 落在 `bots/<A>/claude/projects/<cwd-hash>/…` → **与 cwd 无关地属于 A**;A `/cd` 到任何 repo,transcript 仍写进 A 自己的目录,**读不到 B**。
- codex sessions 落在 `bots/<A>/codex/sessions/…` → 不再全局共享。

## 5. Seatbelt profile(读)

```
(version 1)
(allow default)
(deny  file-read* (subpath "<BOTMUX_HOME>"))          ; 所有 bot 私有数据 + bots.json
(allow file-read* (subpath "<BOT_HOME>"))             ; 只放行自己的
; ---- 系统凭证黑名单(BOTMUX_HOME 之外,固定一小撮)----
(deny  file-read* (subpath "<home>/.ssh"))
(deny  file-read* (subpath "<home>/.aws"))
(deny  file-read* (subpath "<home>/.config/gh"))
(deny  file-read* (subpath "<home>/.config/glab-cli"))
(deny  file-read* (subpath "<home>/.git-credentials"))
(deny  file-read* (subpath "<home>/.npmrc"))
(deny  file-read* (subpath "<home>/.docker/config.json"))
(deny  file-read* (subpath "<home>/.kube"))
```

- 所有路径**先 realpath**(Seatbelt 匹配真实路径;symlink 攻击因此无效——A 在自己 BOT_HOME 里建软链指向 B,访问时解析成 B 的真实路径 → 命中 `deny BOTMUX_HOME`、不命中 `allow BOT_HOME` → 拒绝)。
- 共享账号凭证(claude/codex 同一账号)symlink 进各 BOT_HOME,realpath 落在 BOTMUX_HOME 外 → 默认可读。即"账号密钥所有 bot 可读"——同一账号,不算跨 bot 泄漏,可接受。

## 6. 读 vs 写(必须拆开)

- 本特性 = **读隔离**(只 `deny file-read*`)。上面是读模型。
- **写**是另一根轴。**不能真"BOTMUX_HOME 外完全放开写"**——否则 agent 能写 `~/.zshrc`、git hooks、`~/.config` 自启动、crontab/launchd 做**持久化/提权**。
- 建议:写至少 deny 掉 home 下的**持久化/提权向量**(shell rc、自启动、`~/.ssh`、`~/.botmux` 别的 bot),放行:当前 repo(工作目录)、自己 BOT_HOME、临时目录。**单独一个阶段做**。

## 7. 代码改动点

- **claude adapter**:`dataDir`/config 变 per-bot(`CLAUDE_CONFIG_DIR=<BOT_HOME>/claude`);`readIsolationAllowPaths`/`readIsolationTranscriptRoots` 从"cwd project 目录"改成"自己 BOT_HOME";folder-trust(`ensureClaudeFolderTrust`)写进 per-bot `.claude.json`。
- **codex adapter**:`CODEX_HOME=<BOT_HOME>/codex`。
- **worker**:算 `BOTMUX_HOME`/`BOT_HOME`;profile = `allow default + deny BOTMUX_HOME + allow BOT_HOME + 系统凭证 deny`;全 realpath。`claudeDataDir` 变 per-bot。
- **botmux 数据层**:per-bot session/cred/元数据搬进 `<BOT_HOME>/session`;`sendCredFilePath`、session store、send/history 读写路径跟着改。
- **auth**:symlink 共享 claude/codex 凭证进各 BOT_HOME 的 config 目录。
- **skills**:装进 per-bot config 目录(否则 jail 后读不到)。
- `buildReadDenyPaths` 大幅瘦身 → 只剩系统凭证小清单;`readIsolationStrict` 顺带在外包路径实现(= 本模型)。

## 8. 迁移

1. 为每个隔离 bot 建 `~/.botmux/bots/<appId>/{claude,codex,session}`。
2. 搬历史数据:
   - claude:把该 bot 各 cwd 的 `~/.claude/projects/<cwd-hash>` **(含 memory!)** 拷进 `<BOT_HOME>/claude/projects/`。**memory 必须迁移**(用户在意)。
   - codex:**旧 `~/.codex/sessions` 按日期存、无 bot 标签,无法干净按 bot 拆**。三选一:
     - (a) 全新开始,旧 codex 历史不迁(旧的整目录 deny,resume 断)。
     - (b) 把旧共享历史整份拷进每个 BOT_HOME(每 bot 都看到迁移前的旧历史 = 一次性把旧历史摊给所有 bot,可接受?)。
     - (c) 旧目录整体 deny、往后新 session 进 per-bot——**推荐 (c)**:代价是迁移前的 codex 会话 resume 断一次。
   - botmux:`sessions-<appId>.json`、frozen-cards 等按 bot 归拢。
3. symlink 凭证。
4. per-bot `.claude.json` 预置 folder-trust。
5. 部署 + 逐项验证(跨读 EPERM / 自己 memory 可读 / resume / send / /cd 到别 repo 读不到别 bot)。

## 9. 分阶段

- **Phase 0(已完成/已上线)**:整体 Seatbelt 外包 + codex review 修复(`76c0f147`)。
  - **可选临时补丁**:在 Phase 1 落地前,给 `/cd`/`/repo` 加 owner-only 门 + 隔离下禁止 cd 到别 bot 的 cwd,先把 F1 临时收一下。
- **Phase 1**:per-bot CLI config 重定向(CLAUDE_CONFIG_DIR/CODEX_HOME → BOT_HOME)+ BOTMUX_HOME 读模型。**修 F1 / codex 共享 sessions / ~/.claude.json**。
- **Phase 2**:botmux per-bot session/cred 数据搬进 BOT_HOME;黑名单瘦身到只剩系统凭证。
- **Phase 3(可选)**:写隔离(持久化/提权向量)。

## 10. 待定问题

1. `BOTMUX_HOME` 用 `~/.botmux`(bots.json 天然被覆盖)还是新目录?
2. codex 历史迁移选 (a)/(b)/(c)?(推荐 c)
3. Phase 1 落地前,要不要先上「/cd 临时补丁」把 F1 收一下?
4. memory 迁移的确认(必做)。

## 11. 净收益

补上 §3/§6 的前提后,本模型:
- 一次干掉 **F1(/cd 跨读)/ codex 共享 sessions / ~/.claude.json 泄漏**;
- 把**易漏的枚举黑名单**换成**默认拒绝白名单**(数据侧);
- 保留代码漫游(无 jail 副作用);
- symlink 攻击天然无效(realpath 匹配)。

代价:**数据布局迁移级**改动 + 迁移现有数据,需分阶段。
