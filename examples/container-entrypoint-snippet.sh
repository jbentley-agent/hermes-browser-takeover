if [ "${BROWSER_TAKEOVER_ENABLE:-0}" = "1" ] && [ -x "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" ]; then
  echo "[entrypoint] Starting browser takeover stack..."
  "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" || echo "[entrypoint] WARNING: browser takeover stack failed to start"
fi

exec hermes gateway run --replace
