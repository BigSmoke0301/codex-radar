#!/bin/zsh

set -euo pipefail

LABEL="com.local.codex-radar"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Codex Radar"
TARGET_APP="$HOME/Applications/Codex Radar.app"
RUNTIME_DIR="$HOME/.codex-radar-runtime"

xml_escape() {
  print -r -- "$1" | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

if [[ -d "$SCRIPT_DIR/Codex Radar.app" ]]; then
  /bin/mkdir -p "$HOME/Applications"
  /usr/bin/ditto "$SCRIPT_DIR/Codex Radar.app" "$TARGET_APP"
  EXECUTABLE="$TARGET_APP/Contents/MacOS/CodexRadar"
  WORKING_DIR="$TARGET_APP/Contents/Resources"
  PROGRAM_ARGUMENTS=("$EXECUTABLE" "--no-open" "--alarm-seconds" "60")
elif [[ -f "$SOURCE_DIR/server.js" && -x "$SOURCE_DIR/start.command" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  for candidate in \
    "$HOME/.local/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [[ -z "$NODE_BIN" && -x "$candidate" ]]; then
      NODE_BIN="$candidate"
    fi
  done
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "找不到 Node.js，无法安装源码常驻模式。"
    read -r "?按回车退出…"
    exit 1
  fi
  /bin/mkdir -p "$RUNTIME_DIR"
  /usr/bin/ditto "$SOURCE_DIR/server.js" "$RUNTIME_DIR/server.js"
  /usr/bin/ditto "$SOURCE_DIR/public" "$RUNTIME_DIR/public"
  EXECUTABLE="$NODE_BIN"
  WORKING_DIR="$RUNTIME_DIR"
  PROGRAM_ARGUMENTS=("$EXECUTABLE" "$RUNTIME_DIR/server.js" "--no-open" "--alarm-seconds" "60")
else
  echo "找不到 Codex Radar.app 或源码启动文件。请完整解压后再运行。"
  read -r "?按回车退出…"
  exit 1
fi

/bin/mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Stop a previous resident job and any manually started copy before enabling
# KeepAlive, otherwise the two copies would compete for port 3838.
/bin/launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
/usr/bin/pkill -x CodexRadar 2>/dev/null || true
if [[ -f "$SOURCE_DIR/server.js" ]]; then
  /usr/bin/pkill -f "$SOURCE_DIR/server.js" 2>/dev/null || true
fi
for _ in {1..20}; do
  if ! /bin/launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 0.5
done
if /bin/launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  /bin/launchctl kill SIGKILL "gui/$UID/$LABEL" 2>/dev/null || true
  /bin/sleep 1
  /bin/launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
fi

WORKING_DIR_XML="$(xml_escape "$WORKING_DIR")"
STDOUT_XML="$(xml_escape "$LOG_DIR/radar.log")"
STDERR_XML="$(xml_escape "$LOG_DIR/radar-error.log")"
PROGRAM_ARGUMENTS_XML=""
for argument in "${PROGRAM_ARGUMENTS[@]}"; do
  PROGRAM_ARGUMENTS_XML+="    <string>$(xml_escape "$argument")</string>"$'\n'
done

/bin/cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$PROGRAM_ARGUMENTS_XML  </array>
  <key>WorkingDirectory</key>
  <string>$WORKING_DIR_XML</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$STDOUT_XML</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_XML</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "$PLIST"
/bin/chmod 600 "$PLIST"
/bin/launchctl enable "gui/$UID/$LABEL"
/bin/launchctl bootstrap "gui/$UID" "$PLIST"
/bin/launchctl kickstart -k "gui/$UID/$LABEL"

echo "Codex Radar 24 小时常驻已启用。"
echo "- 登录后自动启动"
echo "- 异常退出后约 10 秒自动重启"
echo "- 自动强提醒时长：60 秒"
echo "- 日志：$LOG_DIR"
echo ""
echo "注意：关机、退出登录或合盖进入深度睡眠时，软件无法继续监控。"
read -r "?按回车关闭窗口…"
