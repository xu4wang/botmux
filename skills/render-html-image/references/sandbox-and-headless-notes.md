# 后台会话 + Seatbelt 沙箱里的无头渲染：实测记录

2026-07-30 在两台部署机上排查"bot 出不了高清图"时的实测数据。写下来是因为这几条**症状全都不像真因**，每一条都让人往错方向走过。

## 1. 后台会话拦的是"完整 Chrome"，不是"渲染"

botmux 由 launchd 开机自启，整棵进程树在 macOS 的 **Background 会话**（`launchctl managername` = `Background`，`SECURITYSESSIONID` 为空），拿不到 WindowServer。

| 二进制 | 结果 |
|---|---|
| `/Applications/Google Chrome.app` + `--headless=new` | **静默挂死**，120s 无输出无退出 |
| puppeteer 缓存里的 Chrome for Testing + `--headless=new` | 同样挂死 90s |
| **`chrome-headless-shell`**（老 headless，Skia 软件光栅） | **正常出图**，秒级 |

日志里的 `CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670` 是**无害警告**：它恰好证明"问过显示器、没问到、然后照样渲染"。别把它当失败。

**曾经的错误结论**：有 bot 据此判定"必须由人在已登录桌面的 Terminal 里手动重启 botmux 服务才能渲染"，并动手改了 launchd plist 加 `LimitLoadToSessionType=Aqua`。那是错的——换二进制即可，且绑 Aqua 会换来"没登录桌面就不自启"的副作用（后来已还原）。

## 2. `ps` 被拒 ≠ profile 是 deny-by-default

Seatbelt 沙箱里：

```
sandbox-exec -f <profile> sh -c 'ps -p $$'   →  Operation not permitted
sandbox-exec -f <profile> sh -c 'top -l 1'   →  Operation not permitted
sandbox-exec -f <profile> sh -c '/bin/echo x; id'  →  正常
```

真因是 **`/bin/ps`、`/usr/bin/top` 是 setuid root**（`-rwsr-xr-x`），Seatbelt 默认不允许沙箱进程 exec setuid/setgid 二进制。**与 profile 里写了什么规则无关**——`(allow default)` 的 profile 一样有这个症状。

同理：**`pgrep sandbox-exec` 查不到也不能排除沙箱**——botmux 是 `spawnBin='sandbox-exec'; spawnArgs=['-f', profile, 真CLI, …]`，`sandbox-exec` 会 exec 成目标进程，进程名就变成 CLI 本身了。

要判断到底有没有被包、profile 长什么样，只有两个可靠办法：

1. daemon 日志里的 `[file-sandbox] wrapping … sandbox-exec -f <profile 路径>`
2. 把那份 `.sb` cat 出来看**第一行**是 `(allow default)` 还是 `(deny default)`

## 3. 真凶：`(deny default)` 的 profile 漏了 iokit ⇒ CHS SIGSEGV

`deny-default` 的 profile 重新放行了 `process*` / `signal` / `mach*` / `ipc*` / `sysctl*` / `file-ioctl`，
**唯独漏了 iokit**。Chrome 打开 IOKit user-client 时被拒，然后段错误（`signal=SIGSEGV`，退出码 **139**）。

两台机器、两个 botmux 版本、两个 Chrome 版本交叉验证，收敛到同一行修复：

| 实验 | 结果 |
|---|---|
| A 机（`allow default`，Chrome v131）原样 | exit 0，出图 |
| A 机 **只加 `(deny iokit*)`**（唯一变量） | **exit 139 SIGSEGV**，1:1 复现 |
| A 机 再加 `(allow iokit-open)` | exit 0，与基线**逐字节相同** |
| B 机（`deny default`，Chrome v148）原样 | exit 139 SIGSEGV |
| B 机 加 `(allow iokit-open)` | exit 0，与非沙箱基线**逐字节相同** |

**`(allow iokit-open)` 一条就够**，`iokit-get-properties` / `iokit-set-properties` 两台都验过不需要（后者能读设备型号、序列号，既然不需要就别放）。

安全面：`iokit-open` 只放行"打开设备 user-client"，**完全不动 `file-read*` / `file-write*` 规则**——读隔离真正保护的密钥文件（`~/.ssh`、`~/.aws`、Keychains、其他 bot 的 creds）可达面一个字节没变。

上游 PR：<https://github.com/deepcoldy/botmux/pull/670>

**前瞻风险**：如果哪天把原本 `(allow default)` 的机器也切成 `(deny default)`，那台所有 read-isolation bot 会**集体 exit 139**，而这个症状极难猜。所以这行应作为策略基线留在仓库里，不要只在单机打补丁。

## 4. 沙箱不影响渲染结果本身

用真实 profile 验过两种配置，产物都与非沙箱**逐字节相同**（SHA-256 一致）：

- read-isolation only
- read-isolation + write-sandbox（最严格：`(deny file-write* (subpath "/"))` + 白名单）

反例也验过，确认沙箱确实在生效：输入放在被 deny 的路径 → `net::ERR_FILE_NOT_FOUND` 硬失败 exit 2；输出写到白名单外（如 `~/Desktop`）→ EPERM 硬失败 exit 2 且不产生文件。

沙箱内可用的运行时：`node v26`（含全局 `WebSocket`）、`python3` + PIL、PATH 含 `/opt/homebrew/bin`、`~/.botmux/skills/store` 可读且脚本可执行位保留。

## 5. 工具自身踩过、已修的两个坑

- **假成功**：导航失败（文件不存在 / 路径被 deny）时 Chrome 照样 fire load 事件、照样能截出一张空白图。不看 `Page.navigate` 的 `errorText` 就会得到"退出码 0 + 空白 PNG"——最难查的一类。现在硬失败 exit 2。
- **底部空白**：`body` 被 `min-height:100vh` / `html,body{height:100%}` 撑成视口高时，量 body 盒子会把视口高度当成内容高度，图底白一截。现在量"子元素并集 + body 的 padding/margin/border"，仅在 body 无子元素时退回量 body 盒子。三种写法（裸 padding / `100vh` / `height:100%`）产物逐字节相同。
