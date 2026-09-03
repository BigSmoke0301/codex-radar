#!/bin/zsh

/usr/bin/pkill -x CodexRadar 2>/dev/null || true
echo "Codex Radar 已停止。"
read -r "?按回车关闭窗口…"
