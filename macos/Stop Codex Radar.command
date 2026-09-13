#!/bin/zsh

/bin/launchctl bootout "gui/$UID/com.local.codex-radar" 2>/dev/null || true
/usr/bin/pkill -x CodexRadar 2>/dev/null || true
echo "Codex Radar 已停止。本次登录期间不会自动重启；永久关闭请运行 Uninstall 24小时常驻.command。"
read -r "?按回车关闭窗口…"
