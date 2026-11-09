#!/bin/sh
# Serves the demo locally and opens it in a chrome-less Chrome window sized for a 1920x1080 recording.
# Usage: ./start-demo.sh            (normal pace)
#        ./start-demo.sh speed=0.8  (slower pipeline; any query string is passed through)
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-8765}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
sleep 0.5
google-chrome --app="http://127.0.0.1:$PORT/index.html${1:+?$1}" --window-size=1920,1080 --window-position=0,0 \
  --user-data-dir="${TMPDIR:-/tmp}/vox-demo-chrome" --no-first-run >/dev/null 2>&1
