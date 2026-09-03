#!/bin/zsh

# Double-click this file in Finder to start the local dashboard.
set -e

APP_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  for candidate in \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/node/bin/node"; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "找不到 Node.js。请安装 Node.js，或确认 ChatGPT.app 已安装。"
  read -r "?按回车退出…"
  exit 1
fi

if [[ -x "/usr/bin/caffeinate" ]]; then
  # Keep the Mac awake only while Radar is running.  -i prevents idle system
  # sleep; it does not keep the display on and makes no persistent changes.
  export CODEX_RADAR_CAFFEINATED=1
  exec "/usr/bin/caffeinate" -i "$NODE_BIN" "$APP_DIR/server.js" "$@"
fi

exec "$NODE_BIN" "$APP_DIR/server.js" "$@"
