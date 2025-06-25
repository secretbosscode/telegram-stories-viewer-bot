#!/bin/sh
LOG_FILE=${LOG_FILE:-/data/error.log}
# Fail if the main node process is not running
if ! pgrep -f "dist/index.js" > /dev/null; then
  exit 1
fi
# Fail if recent logs show timeout monitor exit
if [ -f "$LOG_FILE" ] && tail -n 20 "$LOG_FILE" | grep -q "TimeoutMonitor"; then
  exit 1
fi
exit 0
