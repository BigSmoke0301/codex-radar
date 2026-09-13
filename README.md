# Codex Radar

一个只在本机运行的 Codex 任务与用量仪表盘。支持 macOS 源码启动和 Windows x64 独立可执行包，启动后会自动在浏览器打开中文界面。

## 能看到什么

- 当前运行中的任务数量、标题、工作目录、模型提供方、开始/最近更新时间和状态。
- 超过默认 30 分钟没有 turn/item 更新的记录会从运行数量中剔除，单独放在“需要核对”并标记“可能已失联”。可用 `CODEX_RADAR_STALE_AFTER_SECONDS` 调整阈值。
- 当前动作摘要：优先使用 app-server 的 `thread/read` / `thread/items/list` 返回的 plan、agentMessage、命令、工具调用和协作项。
- 最近已完成、失败或中断的任务。
- 运行中的任务转为完成、失败或中断时，默认同时弹出本地通知横幅，并启动约 24 秒的“强提醒”。macOS 重复播放 `Sosumi.aiff` 并用 `/usr/bin/say` 中文播报；Windows 重复播放随包附带的高响度 WAV，并通过 `System.Speech` 中文播报。首次扫描已有的已结束任务不会提醒，同一终态不会重复提醒。
- 监控基线与已提醒记录会保存在 `~/.codex-radar/monitor-state.json`（Windows 为用户主目录下同名文件夹）。服务异常重启后不会重复提醒，并能补报停机或两次轮询间刚完成的任务。
- 顶部“测试强提醒”按钮会用较短（默认约 6 秒）的通知、铃声和中文播报测试提醒；旁边的“停止提醒”可以立即终止当前的强提醒。
- `account/read` 与 `account/rateLimits/read` 的方案、主/次窗口使用百分比、剩余百分比、窗口时长、重置倒计时和 Credits。
- 连接状态、最后更新时间、手动刷新、3 秒自动刷新和浅色/深色主题。

## 启动

### Windows

下载并完整解压 `Codex-Radar-Windows.zip`，双击 `CodexRadar.exe`。它已包含 Node 运行时、页面资源、高响度 WAV 与官方 `sqlite3.exe`，Windows 端无需另外安装 Node。请保持程序窗口运行（可以最小化）；关闭窗口会停止监控。运行期间会阻止 Windows 因空闲自动睡眠，但不保持屏幕常亮，也不修改永久电源设置。

要让它登录后自动运行且异常退出自动拉起，双击包内的 `安装24小时常驻.cmd`。常驻模式在后台启动，不会每次弹出浏览器，并把自动强提醒延长到 60 秒。用 `关闭24小时常驻.cmd` 可永久关闭常驻任务。

### macOS

在 Finder 中双击：

```text
codex-radar/start.command
```

通过 `start.command` 启动时，如果系统提供 `/usr/bin/caffeinate`，Radar 会以 `caffeinate -i` 运行，仅在 Radar 进程存活期间防止 Mac 因空闲自动休眠；退出终端或 Radar 后会自动恢复，不会永久修改系统设置。若找不到 `caffeinate`，会直接启动 Node.js。它不保持屏幕常亮（不使用 `-d`），合盖、关机或系统静音时仍无法保证提醒叫醒你。

macOS 压缩包内可双击 `Install 24小时常驻.command`：它会把应用复制到 `~/Applications`，安装当前用户的 LaunchAgent，登录后自动启动，并在异常退出后约 10 秒重启。`Uninstall 24小时常驻.command` 会永久关闭常驻任务。源码目录也可以直接运行同名安装脚本。

也可以在终端运行：

```bash
cd "/Users/a1/Documents/ChatGPT/个人项目/codex-radar"
node server.js
```

常用参数：

```bash
node server.js --port 3838
node server.js --port 3838 --no-open
node server.js --host 127.0.0.1 --no-notify
node server.js --port 3838 --no-sound
node server.js --port 3838 --alarm-seconds 30
```

也支持环境变量 `CODEX_RADAR_PORT`、`CODEX_RADAR_HOST`、`CODEX_RADAR_REFRESH_MS`、`CODEX_RADAR_ALARM_SECONDS`、`CODEX_RADAR_NO_NOTIFY=1`、`CODEX_RADAR_NO_SOUND=1`、`CODEX_RADAR_DB` 和 `CODEX_RADAR_STATE_FILE`。`CODEX_RADAR_ALARM_SECONDS` 控制自动任务强提醒时长，默认 24 秒，并限制在 5–60 秒；端口传 `0` 可让系统分配临时端口，适合测试。

“24 小时常驻”指电脑已开机并登录用户、没有进入真正睡眠时持续工作。关机、注销、合盖睡眠、系统静音、音量太低或音频输出设备断开时，任何本地软件都无法保证提醒；安装脚本不会擅自修改系统音量或系统安全策略。

提醒通道彼此独立：`--no-notify` / `CODEX_RADAR_NO_NOTIFY=1` 只关闭通知横幅，声音和语音仍保持开启（除非另行指定 `--no-sound`）；`--no-sound` / `CODEX_RADAR_NO_SOUND=1` 会独立关闭所有铃声和语音。系统命令失败不会中断任务监控，强提醒到时会自动停止，不会无限循环。

服务默认只绑定 `127.0.0.1`。测试强提醒接口是 localhost-only 的 `POST /api/test-alert`（可选 `durationSeconds` 查询参数，服务端仍会限制在 5–60 秒）；停止接口是 localhost-only 的 `POST /api/stop-alert`。两个接口的非 POST 请求会返回 JSON `405`，非本机请求会返回 JSON `403`；页面按钮使用的就是这两个接口。

`start.command` 优先使用系统 `node`；找不到时会回退到 ChatGPT 自带的 `cua_node/bin/node`。服务端优先使用 `CODEX_BIN`。macOS 会寻找 ChatGPT 应用资源和 PATH 中的 `codex`；Windows 会寻找同目录、`%USERPROFILE%\\.codex\\bin`、常见 ChatGPT 安装目录、WindowsApps 与 PATH 中的 `codex.exe` / `codex.cmd`。

## 数据与隐私

服务端直接 spawn 本机 Codex。macOS 的典型命令是：

```text
/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://
```

通过 JSONL/JSON-RPC 完成 `initialize`，再读取 `thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`account/read` 和 `account/rateLimits/read`。服务端不抓浏览器页面、不读取浏览器 storage/cookie、不读取或打印 auth token；app-server 的 stderr 诊断也不会转发到页面。

macOS 提醒使用系统自带的 `osascript`、`afplay` 和 `say`；Windows 使用 PowerShell、`System.Media.SoundPlayer`、`System.Speech` 与 Toast API。两端都不会修改系统音量。强提醒最多同时维护一个会话，并记录、清理它启动的子进程和定时器；服务停止、手动停止或下一次新提醒到来时都会清理。请注意：系统静音、音量很低、输出设备断开、合盖、关机或通知/语音权限设置仍可能让提醒听不见。

独立启动的 app-server 只知道自己的内存 loaded-thread 集合，因而可能把桌面里正在跑的线程报告为 `notLoaded`。为了识别这一情况，Radar 只读查询 `~/.codex/thread_history_1.sqlite` 的 `thread_turns` 和 `thread_items` 两张表，并且仅查询 app-server 已返回的 thread ID。最新 turn 为 `inProgress` 时以它为准，最新 item 只用于生成短摘要；原始 JSON 会经过脱敏和长度限制后才进入页面。超过一段时间没有任何 turn/item 更新的 inProgress 会标记为“可能已失联”，避免把陈旧记录误报成健康运行。

如果 app-server 或用量接口不可用，界面会明确显示“暂不可用”，并提供官方页面：<https://chatgpt.com/codex/settings/usage>。不会用任务数量或其他指标伪造用量估算。

每次刷新会先批量取线程和 SQLite 投影；已有最新 turn/items 的历史线程不会再发 detail 请求。只有最多 12 条活跃线程会请求完整 `thread/read`，其余缺少本地详情的线程也受总数上限保护，因此 3 秒轮询不会对所有历史线程做无界 fan-out。

## 测试与 smoke test

本项目零 npm 依赖，测试只用 Node 内置 `node:test`：

```bash
npm test
```

真实本机 smoke test：

```bash
npm run smoke
```

Windows x64 打包：

```bash
npm install
npm run build:windows
```

构建使用 Node SEA + `postject`，输出目录为 `dist/Codex-Radar-Windows`。`vendor/windows/node.exe` 来自 Node.js 官方 v22.23.2 Windows x64 包并按官方 SHA-256 校验；`vendor/windows/sqlite3.exe` 来自 SQLite 官方 3.53.4 Windows x64 包并按官方 SHA3-256 校验。

macOS Apple Silicon 打包：

```bash
npm install
npm run build:macos
```

输出为 `dist/Codex-Radar-macOS-Apple-Silicon.zip`，其中包含 ad-hoc 签名并完成严格校验的 `Codex Radar.app`、停止脚本和中文说明。

它会通过同一套 JSONL app-server 客户端请求 `initialize`、`thread/list`、`account/read` 和 `account/rateLimits/read`，只输出数量、方案和窗口字段，不输出邮箱、token 或原始响应。

协议类型曾用以下命令由当前安装的 Codex 生成并核对：

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-ts --out /tmp/codex-radar-protocol --experimental
```
