---
name: render-html-image
description: 把 HTML / 网页渲染成高清 PNG（2x Retina，自动贴合内容尺寸）。当需要出图、截图、导出成图片，或要把原型图/示意图/报表/看板/表格变成图片发给用户时使用；也覆盖「这个页面截个图」「做张高清图」「render this page」「screenshot」。在 macOS 后台会话 + Seatbelt 沙箱里可用。不负责幻灯片（走 lark-slides）、不负责图表数据计算。
version: 1.0.0
tags: [render, screenshot, html, image, sandbox]
---

# render-html-image — 后台会话 / 沙箱里出高清图

botmux 的 bot 通常跑在 macOS **后台会话**（`launchctl managername` = `Background`）里，read-isolation bot 还额外套着 **Seatbelt 沙箱**。这两件事各自会毁掉一种常见做法，所以**别**这么干：

- ❌ **别用完整 Chrome / `--headless=new` / `open -a "Google Chrome"`**：后台会话拿不到 WindowServer，进程**静默挂死**——不是报错，是卡住直到超时。实测 `/Applications/Google Chrome.app` 和 Chrome for Testing 都是这样。
- ❌ **别装/用 puppeteer、playwright 的 `chromium.launch()`**：多一层依赖，且 playwright 的浏览器缓存在部署机上常是空的。
- ❌ **别用 matplotlib / PIL / 手写 SVG 去"模拟"网页外观**：糊、字体不对、返工没完。

✅ 用本 skill 自带的 `scripts/render-html`：零依赖单文件 Node 脚本，用内置 `child_process` + 全局 `WebSocket`（Node ≥ 22）**直接讲 CDP** 驱动 `chrome-headless-shell`（Skia 软件光栅，不需要图形会话）。**不经过 puppeteer/playwright**，只是复用它缓存目录里的那个二进制。

## 拿到脚本路径

```bash
SKILL_DIR=$(botmux skills inspect render-html-image | python3 -c 'import json,sys;print(json.load(sys.stdin)["rootDir"])')
RENDER="$SKILL_DIR/scripts/render-html"
```

拿不到就退回默认落点：`~/.botmux/skills/store/render-html-image/scripts/render-html`
（若部署机另外把它装进了 `PATH`，直接 `render-html` 也行。）

## 用法

```bash
"$RENDER" <file.html|http(s)://...> -o out.png [-w 1440] [-s 2] [--clip .card]
```

成功时 stdout 打印一行 JSON（`{ok, out, cssWidth, cssHeight, pxWidth, pxHeight, scale, bytes, chrome}`）、退出码 0；
失败退出码非 0 并在 stderr 说明原因。**务必看退出码或那行 JSON，别假设出图成功了。**

| 选项 | 作用 |
|---|---|
| `-o <path>` | 输出 PNG（必填） |
| `-w <px>` | 视口 CSS 宽度，默认 1440。**内容更宽时自动扩宽**，宽表格不会被裁 |
| `-h <px>` | 固定 CSS 高度；不给就按内容真实高度（推荐） |
| `-s <n>` | 设备像素比，默认 2（2x Retina）。要 3x 传 `-s 3`。它只提采样密度、不改 CSS 布局 |
| `--clip <css选择器>` | 只截某个元素，例如 `--clip .card` |
| `--wait <ms>` | 字体/布局稳定后额外等待，默认 200 |
| `--timeout <ms>` | 单次渲染总超时，默认 30000 |
| `--no-fit-width` | 关掉"内容更宽自动扩宽" |
| `--chrome <path>` | 指定 chrome-headless-shell 二进制 |

宽高都会量**真实内容尺寸**，所以：**不需要人肉猜 window-size，也不需要事后裁白边**。
`body{min-height:100vh}` / `html,body{height:100%}` 这类写法同样按内容高度出图（量的是子元素并集 + body 的 padding，不是被视口撑起来的 body 盒子），**不用靠 `--clip` 绕底部空白**。真要固定视口高度就显式传 `-h`。

## 沙箱里的两条硬约束

1. **输入 HTML 和输出 PNG 都要放在本 bot 读得到 / 写得到的路径**。稳妥的几个：
   - 当前工作目录（角色目录）下
   - `/tmp`、`$TMPDIR`
   - 本 bot 自己的附件目录 `~/.botmux/data/attachments/<本 bot 的 appId>/`（只有自己那个 appId 的目录可读）

   ⚠️ 别的 bot 的目录、`~/.claude`、`~/.botmux/logs`、`~/.botmux/bots.json` 都被 deny，放那里会得到
   `导航失败 net::ERR_FILE_NOT_FOUND`。

2. **HTML 要自包含**：CSS 内联、字体用系统字体（`"PingFang SC","Microsoft YaHei",sans-serif`）、图片用 data URI。
   沙箱和后台会话都不保证外网可达，外链 CSS/字体/图片会渲染成 fallback 样式。

## 发给用户

```bash
botmux send --mention-back --images /tmp/out.png <<'EOF'
说明文字
EOF
```

多张图**每张都要重复一次 `--images`**：`--images a.png --images b.png`。
写成 `--images a.png b.png` 只会发出 a.png，b.png 被静默丢弃且退出码仍是 0。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `导航失败 net::ERR_FILE_NOT_FOUND` | 输入路径被沙箱 deny 或不存在 → 挪到上面允许的目录 |
| **`signal=SIGSEGV` / 退出码 139** | Seatbelt profile 是 `(deny default)` 且没放行 iokit。`head -1 <你的 .sb>` 确认；需要 botmux 侧加一条 `(allow iokit-open)`（见 `references/sandbox-and-headless-notes.md`）。**这不是本工具能绕过的**，找维护同事 |
| `找不到 chrome-headless-shell` | 按提示装：`npx --yes @puppeteer/browsers install chrome-headless-shell@stable`（装到 `~/.cache/puppeteer`，沙箱内可读可写） |
| 日志里 `CVDisplayLinkCreateWithCGDisplay failed -6670` | **无害警告**，不是失败。只说明没有显示器可问，出图不受影响 |
| 中文变方框 / 字体不对 | HTML 用了外链字体 → 改系统字体；或加大 `--wait` |
| 命令卡住不返回 | 十有八九是误用了完整 Chrome 而不是本脚本 |

背景与实测数据（为什么是这些结论）见 `references/sandbox-and-headless-notes.md`。
