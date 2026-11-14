#!/usr/bin/env bash
set -Eeuo pipefail

: "${PORT:=10000}"
: "${INTERNAL_BRIDGE_TOKEN:?Set INTERNAL_BRIDGE_TOKEN in the Render environment}"
: "${ADDON_PATH_SECRET:?Set ADDON_PATH_SECRET in the Render environment}"
: "${MEDIA_URL_SECRET:?Set MEDIA_URL_SECRET in the Render environment}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in the Render environment}"

export PORT
export DISPLAY="${DISPLAY:-:99}"
export TS_DEBUG_VISIBLE=1
mkdir -p "${MORNYE_DATA_DIR:-/tmp/mornye-data}" "${MORNYE_DOWNLOAD_DIR:-/tmp/mornye-downloads}" /tmp/bitchord-mornye

# Mornye's Turnstile solver launches a real Chromium browser when Zarz asks
# for verification. Give it a virtual X display; no VNC port is exposed.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset >/tmp/bitchord-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
fluxbox -display :99 >/tmp/bitchord-fluxbox.log 2>&1 &
FLUXBOX_PID=$!

python -m uvicorn mornye_bridge:app --host 127.0.0.1 --port 8765 --log-level warning &
BRIDGE_PID=$!

node src/server.js &
NODE_PID=$!

cleanup() {
  kill "$NODE_PID" "$BRIDGE_PID" "$XVFB_PID" "$FLUXBOX_PID" 2>/dev/null || true
  wait "$NODE_PID" "$BRIDGE_PID" "$XVFB_PID" "$FLUXBOX_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# If either server exits, stop the other one so Render restarts a healthy pair.
set +e
wait -n "$NODE_PID" "$BRIDGE_PID" "$XVFB_PID"
STATUS=$?
set -e
exit "$STATUS"
