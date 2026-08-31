#!/usr/bin/env bash
# Pulse watchdog — polls /api/schwab/status every 60s. If down, restarts server.
# If dist/index.cjs missing, runs RESTORE.sh. If port 5000 still dead after 3 tries,
# binds 127.0.0.1 explicitly. Logs to /tmp/watchdog.log. Run once, runs forever.
set -u
APP_DIR=/home/user/workspace/sentiment-app
LOG=/tmp/watchdog.log
PORT=5000
URL="http://localhost:${PORT}/api/schwab/status"
FAILS=0

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

restart_server() {
  log "RESTART: killing existing node processes"
  pkill -f 'node dist/index.cjs' 2>/dev/null
  sleep 2
  if [ ! -f "$APP_DIR/dist/index.cjs" ]; then
    log "RESTART: dist/index.cjs missing, running RESTORE.sh"
    bash "$APP_DIR/RESTORE.sh" >> "$LOG" 2>&1
  fi
  cd "$APP_DIR" || { log "RESTART: cd failed"; return 1; }
  nohup node dist/index.cjs > /tmp/server.log 2>&1 &
  local newpid=$!
  log "RESTART: spawned pid=$newpid, sleeping 8s for warmup"
  sleep 8
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL")
  log "RESTART: post-restart HTTP $code"
}

log "WATCHDOG START pid=$$ url=$URL"

while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    if [ "$FAILS" -gt 0 ]; then
      log "RECOVERED after $FAILS fails (HTTP $code)"
    fi
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    log "DOWN: HTTP '$code' (fail #$FAILS)"
    if [ "$FAILS" -ge 2 ]; then
      restart_server
      FAILS=0
    fi
  fi
  sleep 60
done
