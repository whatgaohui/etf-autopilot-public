#!/bin/bash
# All-in-one verification: start services + run agent-browser e2e check.
# Must run as a SINGLE Bash call (background processes don't survive across calls).
set +e
cd /home/z/my-project

PYLOG=/home/z/my-project/data-service.log
DEVLOG=/home/z/my-project/dev-stdout.log
SHOTS=/home/z/my-project/screenshots
mkdir -p "$SHOTS"

echo "=== [1/8] Starting python data-service (port 3031) ==="
setsid bash -c 'cd /home/z/my-project/mini-services/data-service && exec python3 -u main.py' > "$PYLOG" 2>&1 < /dev/null &
PYPID=$!
echo "python PID $PYPID"

echo "=== [2/8] Starting Next.js dev server (port 3000) ==="
setsid bash -c 'cd /home/z/my-project && exec bun run dev' > "$DEVLOG" 2>&1 < /dev/null &
DEVPID=$!
echo "dev PID $DEVPID"

echo "=== [3/8] Waiting for dev server ready ==="
for i in $(seq 1 40); do
  if curl -s --connect-timeout 1 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
    echo "dev server ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== [4/8] Waiting for python data-service ready ==="
for i in $(seq 1 20); do
  if curl -s --connect-timeout 1 -o /dev/null http://127.0.0.1:3031/api/health 2>/dev/null; then
    echo "data-service ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== [5/8] Quick API smoke tests ==="
echo -n "GET /api/etf -> "; curl -s -m 8 http://127.0.0.1:3000/api/etf -o /tmp/etf.json -w "HTTP %{http_code}\n"; echo "  body head: $(head -c 200 /tmp/etf.json)"
echo -n "GET /api/data?type=summary -> "; curl -s -m 12 http://127.0.0.1:3000/api/data?type=summary -o /tmp/data.json -w "HTTP %{http_code}\n"; echo "  body head: $(head -c 200 /tmp/data.json)"
echo -n "GET /api/holding -> "; curl -s -m 8 http://127.0.0.1:3000/api/holding -o /tmp/hold.json -w "HTTP %{http_code}\n"; echo "  body head: $(head -c 200 /tmp/hold.json)"

echo "=== [6/8] agent-browser: open homepage ==="
agent-browser open http://127.0.0.1:3000/ 2>&1 | head -5
agent-browser wait --load networkidle 2>&1 | head -3
agent-browser wait 1500 2>&1 | head -1

echo "--- page title ---"
agent-browser get title 2>&1 | head -3
echo "--- page url ---"
agent-browser get url 2>&1 | head -3

echo "=== [7/8] Snapshot homepage (interactive elements) ==="
agent-browser snapshot -i 2>&1 | head -60 > /tmp/snap_home.txt
cat /tmp/snap_home.txt

echo "--- homepage screenshot ---"
agent-browser screenshot "$SHOTS/01-home.png" 2>&1 | head -2

echo "--- page errors ---"
agent-browser errors 2>&1 | head -20 > /tmp/errs_home.txt
cat /tmp/errs_home.txt
echo "--- console (last 15) ---"
agent-browser console 2>&1 | tail -15 > /tmp/cons_home.txt
cat /tmp/cons_home.txt

echo "=== [8/8] Interact: switch to 趋势 (Trends) tab ==="
agent-browser find text "趋势" click 2>&1 | head -3
agent-browser wait 2500 2>&1 | head -1
agent-browser snapshot -i 2>&1 | head -40 > /tmp/snap_trends.txt
cat /tmp/snap_trends.txt
agent-browser screenshot "$SHOTS/02-trends.png" 2>&1 | head -2

echo "--- interact: switch to 设置 (Settings) tab ---"
agent-browser find text "设置" click 2>&1 | head -3
agent-browser wait 2500 2>&1 | head -1
agent-browser snapshot -i 2>&1 | head -40 > /tmp/snap_settings.txt
cat /tmp/snap_settings.txt
agent-browser screenshot "$SHOTS/03-settings.png" 2>&1 | head -2

echo "--- final errors check ---"
agent-browser errors 2>&1 | head -20

echo "=== Screenshots saved ==="
ls -la "$SHOTS/"

echo "=== dev.log tail ==="
tail -12 /home/z/my-project/dev.log 2>/dev/null || tail -12 "$DEVLOG"

echo "=== DONE ==="
# Cleanup browser session (leave services running for the remainder of this call's life)
agent-browser close 2>&1 | head -1
true
