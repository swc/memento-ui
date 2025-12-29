#!/bin/bash

# start-monitor.sh
# run monitor server pointing at loom-memento

set -euo pipefail

echo "[memento-ui] Using .memento-root file for workspace"
cd "$(dirname "$0")"

LOG_FILE="${LOG_FILE:-$HOME/.memento-ui-monitor.log}"
if [ -f .monitor.pid ]; then
  OLD_PID=$(cat .monitor.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[memento-ui] Stopping existing monitor (PID=$OLD_PID)"
    kill "$OLD_PID"
    sleep 0.5
  fi
fi
nohup node server.js >"$LOG_FILE" 2>&1 &
echo $! > .monitor.pid
echo "[memento-ui] Monitor started (PID=$(cat .monitor.pid)); tail logs with: tail -f $LOG_FILE"
