#!/usr/bin/env bash
# Idempotent: starts watchdog if not running. Safe to call anytime.
# Watchdog itself handles starting/restarting the server.
set -u

WATCHDOG=/home/user/workspace/sentiment-app/watchdog.sh

if pgrep -f 'watchdog.sh' > /dev/null; then
  echo "watchdog already running: pid=$(pgrep -f 'watchdog.sh' | head -1)"
  exit 0
fi

# Detach completely so it survives bash exit
setsid bash "$WATCHDOG" < /dev/null > /dev/null 2>&1 &
sleep 2

if pgrep -f 'watchdog.sh' > /dev/null; then
  echo "watchdog started: pid=$(pgrep -f 'watchdog.sh' | head -1)"
else
  echo "FAILED to start watchdog"
  exit 1
fi
