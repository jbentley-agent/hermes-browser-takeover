#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export PORT="${PORT:-9377}"
export VNC_PORT="${VNC_PORT:-5901}"
export SCREEN_WIDTH="${SCREEN_WIDTH:-1440}"
export SCREEN_HEIGHT="${SCREEN_HEIGHT:-900}"
export SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
export SCREEN_AVAIL_HEIGHT="${SCREEN_AVAIL_HEIGHT:-$((SCREEN_HEIGHT - 32))}"
export TAKEOVER_ROOT="${TAKEOVER_ROOT:-/root/browser-takeover}"
export HOME="${HOME:-/root}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/browser-takeover-xdg-runtime}"
export MOZ_WEBRENDER="${MOZ_WEBRENDER:-0}"
export MOZ_X11_EGL="${MOZ_X11_EGL:-0}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export TAKEOVER_TMP_DIR="${TAKEOVER_TMP_DIR:-/tmp/browser-takeover}"

mkdir -p "$XDG_RUNTIME_DIR" "$TAKEOVER_TMP_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  rm -f "/tmp/.X${DISPLAY#:}-lock"
  rm -f "/tmp/.X11-unix/X${DISPLAY#:}"
  nohup Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac +extension RANDR > "$TAKEOVER_TMP_DIR/xvfb.log" 2>&1 &
fi

for _ in $(seq 1 20); do
  if DISPLAY="$DISPLAY" xdpyinfo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
DISPLAY="$DISPLAY" xdpyinfo >/dev/null 2>&1

if command -v fluxbox >/dev/null 2>&1; then
  if ! pgrep -f "fluxbox" >/dev/null 2>&1; then
    nohup fluxbox > "$TAKEOVER_TMP_DIR/fluxbox.log" 2>&1 &
    sleep 1
  fi
  pkill -f '^xmessage ' >/dev/null 2>&1 || true
fi

if ! pgrep -f "x11vnc.*${DISPLAY}.*${VNC_PORT}" >/dev/null 2>&1; then
  nohup x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -forever -shared -noxdamage -nopw -listen 0.0.0.0 > "$TAKEOVER_TMP_DIR/x11vnc.log" 2>&1 &
  sleep 2
fi

cd "$TAKEOVER_ROOT"
if ! pgrep -f "takeover-wrapper.js" >/dev/null 2>&1; then
  nohup node "$TAKEOVER_ROOT/takeover-wrapper.js" > "$TAKEOVER_TMP_DIR/camoufox.log" 2>&1 &
fi

if command -v xdotool >/dev/null 2>&1; then
  nohup bash -lc '
    for _ in $(seq 1 60); do
      wids=$(DISPLAY="$DISPLAY" xdotool search --name Firefox 2>/dev/null || true)
      if [ -n "$wids" ]; then
        for wid in $wids; do
          DISPLAY="$DISPLAY" xdotool windowmove "$wid" 0 0 || true
          DISPLAY="$DISPLAY" xdotool windowsize "$wid" "$SCREEN_WIDTH" "$SCREEN_HEIGHT" || true
          DISPLAY="$DISPLAY" xdotool windowactivate "$wid" || true
          DISPLAY="$DISPLAY" xdotool windowraise "$wid" || true
        done
        exit 0
      fi
      sleep 1
    done
  ' > "$TAKEOVER_TMP_DIR/window-resize.log" 2>&1 &
fi

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" > "$TAKEOVER_TMP_DIR/health.json" 2>/dev/null; then
    exit 0
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${PORT}/health" > "$TAKEOVER_TMP_DIR/health.json"
