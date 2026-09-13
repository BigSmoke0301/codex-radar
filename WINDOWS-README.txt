Codex Radar Windows 版
======================

使用方法
--------
1. 请先在 Windows 上安装并登录 Codex / ChatGPT 桌面端。
2. 解压整个 Codex-Radar-Windows 文件夹；不要只单独复制 exe。
3. 双击 CodexRadar.exe。程序会自动打开 http://127.0.0.1:3838/ 。
4. 保持黑色程序窗口运行；可以最小化，但关闭窗口会停止监控和提醒。
5. 第一次运行建议点击页面顶部的“测试强提醒”，检查系统音量、通知与中文语音。

24 小时常驻（推荐）
-------------------
双击“安装24小时常驻.cmd”。它会为当前 Windows 用户创建计划任务：
- 登录后自动启动；
- 进程退出后约 10 秒自动拉起；
- 后台运行，不重复打开浏览器；
- 自动强提醒持续 60 秒；
- 补报服务重启或短暂离线期间完成的任务。

永久关闭请双击“关闭24小时常驻.cmd”。

Windows 版功能
--------------
- 监控当前 Codex 任务、最近完成结果和账户用量。
- 任务完成后显示 Windows 通知，并连续约 24 秒重复播放高响度 alarm.wav。
- 使用 Windows 中文语音反复播报“Codex 任务完成了，请查看结果”。
- 运行期间阻止 Windows 因空闲自动睡眠；不会强制保持屏幕常亮，也不会修改永久电源设置。
- tools/sqlite3.exe 来自 SQLite 官方 Windows x64 工具包，用于只读查询本机 Codex 任务状态。

常见问题
--------
- 找不到 Codex：确认 ChatGPT/Codex 已安装并登录。也可以先在命令提示符执行：
    set CODEX_BIN=C:\\你的路径\\codex.exe
    CodexRadar.exe
- 端口 3838 被占用：先关闭另一个 Radar 实例，或执行：
    CodexRadar.exe --port 3839
- 不要声音：CodexRadar.exe --no-sound
- 不要通知横幅：CodexRadar.exe --no-notify
- 调整自动强提醒秒数（5 到 60 秒）：CodexRadar.exe --alarm-seconds 40

提醒限制
--------
“24 小时”要求电脑已开机并登录且没有进入真正睡眠。系统静音、音量太低、蓝牙/耳机断开、
电脑合盖、关机、注销、休眠策略或缺少中文语音包时，
仍可能听不到提醒。Radar 不会擅自修改系统音量。

隐私
----
服务只监听 127.0.0.1。它通过本机 Codex app-server 获取任务与用量，并只读查询
%USERPROFILE%\\.codex\\thread_history_1.sqlite；不会读取浏览器 cookie 或输出认证 token。
