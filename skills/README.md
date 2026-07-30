# skills/ — 本地自管 Skill 的统一 git 目录

这里放**我们自己写、需要在部署机上用**的 botmux Skill。目的是让 skill 跟代码一样有版本、有 review、能在任意机器上一条命令装好，而不是散落在各台机器的 `~/.botmux/bots/<appId>/claude/skills/` 里靠人肉复制。

装到机器上走 botmux 自带的 skill registry（见 `docs/setup/skills.md`），**不写入任何 CLI 的全局 skill 目录**。

## 目录约定

```text
skills/
  README.md                     # 本文件：约定与流程
  <skill-name>/                 # 一个 skill = 一个目录，名字用 kebab-case
    SKILL.md                    # 必需。frontmatter: name / description / version / tags
    scripts/                    # 可选。skill 自带的可执行工具（exec 位会被 registry 保留）
    references/                 # 可选。按需加载的长文档、实测记录、排错手册
    assets/                     # 可选。模板、样例 HTML、图片
```

命名规则：

- 目录名 = `SKILL.md` frontmatter 里的 `name`，kebab-case，见名知意（`render-html-image` 而不是 `render`）。
- `description` 是**唯一的召回入口**，必须把触发词写全（中英文都写：出图/截图/render/screenshot…），并写清**不负责什么**，否则 agent 该用的时候想不起来、不该用的时候乱用。

## 硬性要求（review 时按这几条看）

1. **自带工具优先放 `scripts/`**，不要求部署机预先把二进制装进 `PATH`。registry 会保留可执行位，`rootDir/scripts/xxx` 直接可跑——这样"装 skill"就是唯一一步。
2. **必须在 Seatbelt 沙箱里能跑**。至少验证一次：用某个 read-isolation bot 的真实 profile
   `sandbox-exec -f <那份.sb> <你的脚本> …`，产物应与非沙箱一致。
3. **失败要响**。工具遇到环境问题必须非 0 退出并打印可操作的原因，禁止"退出码 0 + 空产物"。
4. **不放任何凭证/密钥/内网地址**，不硬编码某台机器的用户名或绝对路径（`~` / 运行时探测代替）。
5. **SKILL.md 里写反面清单**。把"别用什么、为什么"写清楚比只写正确用法有用——agent 最容易踩的是那些"看起来能用其实静默挂死"的路。

## 装 / 升 / 卸

在部署机上（任选一种源）：

```bash
# ① 本机已有 checkout
botmux skills install ./skills/render-html-image

# ② 直接从 git（推荐给没有 checkout 的机器）
botmux skills install github:xu4wang/botmux --path skills/render-html-image --ref ops/local

# 开发态：registry 只记原目录，改完立即生效
botmux skills install ./skills/render-html-image --link

botmux skills list
botmux skills inspect render-html-image     # 输出 JSON，rootDir 就是落地目录
botmux skills update render-html-image
botmux skills remove render-html-image
botmux skills doctor
```

## 让某个 bot 优先看到它

装进 registry 只是"机器上有"，还要在 `bots.json` 里给该 bot 声明优先披露（也可以用 `/botconfig set skills`）：

```json
{
  "skills": { "include": ["skill:render-html-image"] }
}
```

语义是**优先披露**而非独占隔离：CLI 自己原生的 skill 发现照旧。改完该 bot **开新会话**才生效（现存会话不热加载）——这也天然是灰度开关。

## 加一个新 skill 的流程

1. 在本目录建 `<skill-name>/`，按上面的结构写 `SKILL.md`（+ `scripts/` / `references/`）。
2. 本机验：`botmux skills install ./skills/<name> --link` → 在沙箱 profile 下实跑一次 → 确认失败路径也会响。
3. 提 PR 到 `ops/local`，review 按上面五条硬性要求。
4. 合并后各机器 `botmux skills install github:… --ref ops/local`（或随 deploy/all 重建），再按需给 bot 加 `skills.include`。
