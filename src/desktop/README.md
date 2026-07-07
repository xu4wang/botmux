# Botmux Desktop 本地源码安装

Botmux Desktop 目前没有 Apple Developer ID 签名和公证包，所以暂不提供可直接分发给他人的安装包。想体验 App 的用户需要下载源码，在自己的机器上本地构建和安装。

## 要求

- macOS
- Node.js 22 或更高版本
- pnpm
- 已下载本仓库源码

如果没有 pnpm，可以先执行：

```bash
corepack enable
```

## 安装

在仓库根目录执行：

```bash
bash src/desktop/install-local.sh
```

脚本会执行这些步骤：

1. 安装依赖（如 `node_modules` 缺失）。
2. 构建 CLI、dashboard 和 Desktop bundle。
3. 执行 `pnpm link --global`，并同步 `~/.botmux/bin/botmux`，让全局 `botmux` 指向这份源码。
4. 解析源码版本号，并使用 electron-builder 生成本机 `Botmux.app`。
5. 退出正在运行的 Botmux App。
6. 安装到 `/Applications/Botmux.app`。
7. 使用本机 ad-hoc 签名并移除 quarantine。
8. 默认打开 App。

常用参数：

```bash
bash src/desktop/install-local.sh --no-open
bash src/desktop/install-local.sh --skip-build
bash src/desktop/install-local.sh --skip-deps
bash src/desktop/install-local.sh --skip-link
bash src/desktop/install-local.sh --app-path /Applications/Botmux.app
```

`--skip-build` 适合已经运行过 `pnpm build && pnpm desktop:bundle && pnpm exec electron-builder --mac dir --config electron-builder.yml -c.extraMetadata.version=<version>` 的开发场景。

如果源码不是 git checkout，脚本无法通过 tag 推导版本号，可以显式传入：

```bash
BOTMUX_DESKTOP_VERSION=2.103.0 bash src/desktop/install-local.sh
```

## 更新

拉取最新源码后重新执行：

```bash
git pull
bash src/desktop/install-local.sh
```

因为 App 始终依赖全局 `botmux` CLI，脚本会重新 `pnpm link --global` 并同步 `~/.botmux/bin/botmux`，保证 App 和 CLI 指向同一份源码。

## 验证

安装后可以运行：

```bash
pnpm desktop:smoke --skip-dashboard
```

如果已经用当前源码启动了 botmux runtime，也可以运行完整检查：

```bash
pnpm desktop:smoke
```

## 说明

这个安装方式只适合本机体验和开发。它不会产出可给别人直接安装的公证包；其他用户也需要下载源码并在自己的机器上执行安装脚本。
