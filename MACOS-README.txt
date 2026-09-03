Codex Radar macOS 版（Apple Silicon）
====================================

使用方法
--------
1. 完整解压 Codex-Radar-macOS-Apple-Silicon.zip。
2. 确保 ChatGPT.app 已放在“应用程序”文件夹并已登录 Codex。
3. 双击“Codex Radar.app”。它会打开 http://127.0.0.1:3838/。
4. 应用运行期间会持续监控；可以关闭浏览器页面，但不要退出应用。
5. 第一次运行建议点击页面顶部的“测试强提醒”。

停止方法
--------
- 从 Dock 退出 Codex Radar；或
- 双击同目录的“Stop Codex Radar.command”。

如果当前已有另一个 Radar 占用 3838 端口，请先停止旧实例再启动本应用。

功能
----
- 查看当前 Codex 任务、最近完成结果和账户用量。
- 任务完成后显示 macOS 通知，连续约 24 秒重复播放 Sosumi 铃声并中文播报。
- 运行期间阻止 Mac 因空闲自动睡眠；不保持屏幕常亮，也不修改永久系统设置。
- 不会自动修改系统音量。

注意
----
这是本地构建并使用 ad-hoc 签名的应用，不是 Apple Developer ID 公证版本。若 macOS
首次提示无法验证开发者，可以在 Finder 中右键应用并选择“打开”，然后由你确认运行。

系统静音、音量太低、输出设备断开、合盖、关机或深度睡眠时，提醒仍可能听不到。

本包针对 Apple Silicon（M1/M2/M3/M4/M5 系列）构建，不支持 Intel Mac。
