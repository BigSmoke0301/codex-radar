#!/bin/zsh

LABEL="com.local.codex-radar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

/bin/launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
/bin/launchctl disable "gui/$UID/$LABEL" 2>/dev/null || true
/bin/rm -f "$PLIST"
/usr/bin/pkill -x CodexRadar 2>/dev/null || true

echo "Codex Radar 24 小时常驻已关闭；已安装的应用与监控历史仍保留。"
read -r "?按回车关闭窗口…"
