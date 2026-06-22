#!/bin/bash
# Keepalive wrapper: keeps the Next.js dev server AND python data-service running.
# Writes heartbeat so we can verify the loop itself survives across bash calls.
cd /home/z/my-project

KA_LOG="/home/z/my-project/keepalive.log"
HB_FILE="/home/z/my-project/keepalive.heartbeat"

log() { echo "[$(date '+%F %T')] $*" >> "$KA_LOG"; }

start_dev() {
  log "starting bun dev..."
  setsid bash -c 'cd /home/z/my-project && exec bun run dev' > /home/z/my-project/dev-stdout.log 2>&1 < /dev/null &
  disown
}

start_python() {
  log "starting python data-service..."
  setsid bash -c 'cd /home/z/my-project/mini-services/data-service && exec python3 -u main.py' > /home/z/my-project/data-service.log 2>&1 < /dev/null &
  disown
}

log "=== keepalive started (PID $$) ==="

while true; do
  date '+%F %T' > "$HB_FILE"

  # Dev server on 3000
  if ! curl -s --connect-timeout 2 http://127.0.0.1:3000/ -o /dev/null 2>/dev/null; then
    log "dev server down, starting..."
    start_dev
    sleep 8
  fi

  # Python data-service on 3031
  if ! curl -s --connect-timeout 2 http://127.0.0.1:3031/api/health -o /dev/null 2>/dev/null; then
    log "data-service down, starting..."
    start_python
    sleep 5
  fi

  sleep 4
done
