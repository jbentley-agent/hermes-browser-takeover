#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install the MCP-based Hermes browser takeover stack into a Dockerized agent.

Usage:
  scripts/install-agent-browser-takeover.sh \
    --container <docker-container-name> \
    --agent <agent-name> \
    --public-base-url <http://host:9388|https://takeover.example.com> \
    [--helper-port 9388] \
    [--vnc-port 5901] \
    [--takeover-root /root/browser-takeover] \
    [--capsolver-addon-path /root/capsolver-firefox-addon]

What it does:
- installs host helper deps in this repo clone
- fetches noVNC into host/browser-takeover/vendor/noVNC
- copies the container takeover runtime into the target container
- installs required container packages and npm deps
- applies the Hermes reattach patch inside the container if needed
- updates /root/.hermes/.env and /root/.hermes/config.yaml in the container
- patches /root/entrypoint.sh to start the takeover stack before Hermes gateway
- renders a host launchd plist and env file under host/generated/

This script does NOT restart or destroy the target container.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

CONTAINER=""
AGENT=""
PUBLIC_BASE_URL=""
HELPER_PORT="9388"
VNC_PORT="5901"
TAKEOVER_ROOT="/root/browser-takeover"
CAPSOLVER_ADDON_PATH="/root/capsolver-firefox-addon"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container)
      CONTAINER="$2"
      shift 2
      ;;
    --agent)
      AGENT="$2"
      shift 2
      ;;
    --public-base-url)
      PUBLIC_BASE_URL="$2"
      shift 2
      ;;
    --helper-port)
      HELPER_PORT="$2"
      shift 2
      ;;
    --vnc-port)
      VNC_PORT="$2"
      shift 2
      ;;
    --takeover-root)
      TAKEOVER_ROOT="$2"
      shift 2
      ;;
    --capsolver-addon-path)
      CAPSOLVER_ADDON_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$CONTAINER" || -z "$AGENT" || -z "$PUBLIC_BASE_URL" ]]; then
  usage
  exit 1
fi

require_cmd docker
require_cmd git
require_cmd python3
require_cmd node
require_cmd npm

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_HELPER_DIR="$REPO_ROOT/host/browser-takeover"
CONTAINER_STACK_DIR="$REPO_ROOT/container/browser-takeover"
MCP_SCRIPT="$REPO_ROOT/mcp/browser_takeover_mcp.py"
PATCH_FILE="$REPO_ROOT/patches/hermes-browser-camofox-reattach.patch"
GENERATED_DIR="$REPO_ROOT/host/generated"
NODE_PATH="$(command -v node)"
CAMOFOX_URL="http://127.0.0.1:9377"
MINT_URL="http://host.docker.internal:${HELPER_PORT}/api/mint"
LAUNCHD_FILE="$GENERATED_DIR/com.hermes.browser-takeover-helper.${AGENT}.plist"
HOST_ENV_FILE="$GENERATED_DIR/browser-takeover-helper.${AGENT}.env"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container not found: $CONTAINER" >&2
  exit 1
fi

mkdir -p "$GENERATED_DIR"

echo "[1/8] Preparing host helper in repo clone..."
mkdir -p "$HOST_HELPER_DIR/vendor"
if [[ ! -d "$HOST_HELPER_DIR/vendor/noVNC/.git" ]]; then
  git clone --depth 1 https://github.com/novnc/noVNC.git "$HOST_HELPER_DIR/vendor/noVNC"
else
  git -C "$HOST_HELPER_DIR/vendor/noVNC" fetch origin >/dev/null 2>&1 || true
fi
npm --prefix "$HOST_HELPER_DIR" install
chmod +x "$HOST_HELPER_DIR/mint-link.sh"

echo "[2/8] Rendering host helper env + launchd files..."
cat > "$HOST_ENV_FILE" <<EOF
PORT=$HELPER_PORT
HOST=0.0.0.0
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
DEFAULT_AGENT_NAME=$AGENT
CONTAINER_NAME=$CONTAINER
VNC_PORT=$VNC_PORT
CAMOUFOX_URL=$CAMOFOX_URL
DEFAULT_TTL_SECONDS=900
MAX_TTL_SECONDS=3600
VIEWER_TICKET_TTL_MS=120000
EOF

cat > "$LAUNCHD_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hermes.browser-takeover-helper.$AGENT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$HOST_HELPER_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOST_HELPER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key>
    <string>$HELPER_PORT</string>
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>PUBLIC_BASE_URL</key>
    <string>$PUBLIC_BASE_URL</string>
    <key>DEFAULT_AGENT_NAME</key>
    <string>$AGENT</string>
    <key>CONTAINER_NAME</key>
    <string>$CONTAINER</string>
    <key>VNC_PORT</key>
    <string>$VNC_PORT</string>
    <key>CAMOUFOX_URL</key>
    <string>$CAMOFOX_URL</string>
    <key>DEFAULT_TTL_SECONDS</key>
    <string>900</string>
    <key>MAX_TTL_SECONDS</key>
    <string>3600</string>
    <key>VIEWER_TICKET_TTL_MS</key>
    <string>120000</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/browser-takeover-helper.$AGENT.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/browser-takeover-helper.$AGENT.log</string>
</dict>
</plist>
EOF

echo "[3/8] Installing required packages in container..."
docker exec "$CONTAINER" sh -lc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y xvfb fluxbox x11vnc xdotool imagemagick socat x11-utils curl >/tmp/browser-takeover-apt.log 2>&1 || {
    cat /tmp/browser-takeover-apt.log
    exit 1
  }
'

echo "[4/8] Copying takeover runtime into container..."
docker exec "$CONTAINER" sh -lc "mkdir -p '$TAKEOVER_ROOT' /root/.hermes/bin /tmp/browser-takeover-patch"
docker cp "$CONTAINER_STACK_DIR/." "$CONTAINER:$TAKEOVER_ROOT"
docker cp "$MCP_SCRIPT" "$CONTAINER:/root/.hermes/bin/browser_takeover_mcp.py"
docker cp "$PATCH_FILE" "$CONTAINER:/tmp/browser-takeover-patch/hermes-browser-camofox-reattach.patch"
docker exec "$CONTAINER" sh -lc "chmod +x '$TAKEOVER_ROOT/start.sh' /root/.hermes/bin/browser_takeover_mcp.py"

echo "[5/8] Installing container npm deps + browser runtime deps..."
docker exec "$CONTAINER" sh -lc "cd '$TAKEOVER_ROOT' && npm install"
docker exec "$CONTAINER" sh -lc 'cd /root/.hermes/hermes-agent && npx playwright install-deps firefox >/tmp/browser-takeover-firefox-deps.log 2>&1 || true'

echo "[6/8] Applying Hermes reattach patch if needed..."
docker exec -i "$CONTAINER" /root/.hermes/hermes-agent/venv/bin/python - <<'PY'
from pathlib import Path
import subprocess
file_path = Path('/root/.hermes/hermes-agent/tools/browser_camofox.py')
if not file_path.exists():
    raise SystemExit(
        'Hermes checkout is missing tools/browser_camofox.py. Update the container to a Camofox-capable Hermes revision before applying the takeover patch.'
    )
text = file_path.read_text()
if 'Auto-reattached to existing tab' in text:
    print('Patch already present; skipping apply')
else:
    subprocess.run([
        'git', '-C', '/root/.hermes/hermes-agent', 'apply',
        '/tmp/browser-takeover-patch/hermes-browser-camofox-reattach.patch'
    ], check=True)
    print('Applied Hermes patch')
PY

echo "[7/8] Updating container .env, config.yaml, and entrypoint..."
docker exec \
  -i \
  -e HERMES_TAKEOVER_ROOT="$TAKEOVER_ROOT" \
  -e HERMES_CAMOFOX_URL="$CAMOFOX_URL" \
  -e HERMES_TAKEOVER_MINT_URL="$MINT_URL" \
  -e HERMES_TAKEOVER_AGENT="$AGENT" \
  -e HERMES_VNC_PORT="$VNC_PORT" \
  -e HERMES_CAPSOLVER_ADDON_PATH="$CAPSOLVER_ADDON_PATH" \
  "$CONTAINER" /root/.hermes/hermes-agent/venv/bin/python - <<'PY'
from pathlib import Path
import os
import yaml

env_path = Path('/root/.hermes/.env')
env_lines = env_path.read_text().splitlines() if env_path.exists() else []
updates = {
    'BROWSER_TAKEOVER_ENABLE': '1',
    'TAKEOVER_ROOT': os.environ['HERMES_TAKEOVER_ROOT'],
    'CAMOFOX_URL': os.environ['HERMES_CAMOFOX_URL'],
    'TAKEOVER_MINT_URL': os.environ['HERMES_TAKEOVER_MINT_URL'],
    'TAKEOVER_AGENT': os.environ['HERMES_TAKEOVER_AGENT'],
    'DISPLAY': ':99',
    'PORT': '9377',
    'VNC_PORT': os.environ['HERMES_VNC_PORT'],
    'SCREEN_WIDTH': '1440',
    'SCREEN_HEIGHT': '900',
    'CAPSOLVER_ADDON_PATH': os.environ['HERMES_CAPSOLVER_ADDON_PATH'],
}
seen = set()
out = []
for line in env_lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key = line.split('=', 1)[0]
        if key in updates:
            out.append(f'{key}={updates[key]}')
            seen.add(key)
            continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')
env_path.parent.mkdir(parents=True, exist_ok=True)
env_path.write_text('\n'.join(out).rstrip() + '\n')

config_path = Path('/root/.hermes/config.yaml')
config = {}
if config_path.exists() and config_path.read_text().strip():
    config = yaml.safe_load(config_path.read_text()) or {}
config.setdefault('mcp_servers', {})
config['mcp_servers']['browser_takeover'] = {
    'command': '/root/.hermes/hermes-agent/venv/bin/python',
    'args': ['/root/.hermes/bin/browser_takeover_mcp.py'],
    'env': {
        'TAKEOVER_AGENT': os.environ['HERMES_TAKEOVER_AGENT'],
        'TAKEOVER_MINT_URL': os.environ['HERMES_TAKEOVER_MINT_URL'],
        'TAKEOVER_DEFAULT_TTL': '900',
        'CAMOFOX_URL': os.environ['HERMES_CAMOFOX_URL'],
    },
    'connect_timeout': 15,
    'timeout': 30,
}
config_path.write_text(yaml.safe_dump(config, sort_keys=False))

entrypoint_path = Path('/root/entrypoint.sh')
if entrypoint_path.exists():
    text = entrypoint_path.read_text()
    source_marker = 'source /root/.hermes/.env'
    source_block = '# Source .env for any runtime-added variables\nif [ -f /root/.hermes/.env ]; then\n  set -a\n  source /root/.hermes/.env\n  set +a\nfi\n'
    if source_marker not in text:
        if text.startswith('#!/bin/bash\n'):
            text = text.replace('#!/bin/bash\n', '#!/bin/bash\n' + source_block + '\n', 1)
        else:
            text = source_block + '\n' + text
    marker = '[entrypoint] Starting browser takeover stack...'
    if marker not in text:
        snippet = '\nif [ "${BROWSER_TAKEOVER_ENABLE:-0}" = "1" ] && [ -x "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" ]; then\n  echo "[entrypoint] Starting browser takeover stack..."\n  "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" || echo "[entrypoint] WARNING: browser takeover stack failed to start"\nfi\n'
        if '\nexec hermes gateway run --replace' in text:
            text = text.replace('\nexec hermes gateway run --replace', snippet + '\nexec hermes gateway run --replace')
        else:
            text = text.rstrip() + snippet + '\n'
    entrypoint_path.write_text(text)
    entrypoint_path.chmod(0o755)
else:
    print('WARNING: /root/entrypoint.sh not found; update your startup path manually')
PY

echo "[8/8] Starting the takeover stack once for validation..."
docker exec "$CONTAINER" sh -lc "'$TAKEOVER_ROOT/start.sh'"
docker exec "$CONTAINER" sh -lc 'curl -fsS http://127.0.0.1:9377/health && echo && curl -fsS http://127.0.0.1:9377/takeover/status'

cat <<EOF

Install complete.

Rendered host helper files:
- $HOST_ENV_FILE
- $LAUNCHD_FILE

To start the host helper manually from this repo clone:
  cd "$HOST_HELPER_DIR"
  set -a; source "$HOST_ENV_FILE"; set +a
  node server.js

To install the generated launchd plist on macOS:
  cp "$LAUNCHD_FILE" ~/Library/LaunchAgents/
  launchctl unload ~/Library/LaunchAgents/$(basename "$LAUNCHD_FILE") 2>/dev/null || true
  launchctl load ~/Library/LaunchAgents/$(basename "$LAUNCHD_FILE")

Container changes were applied in-place, but you still need to restart the target container's normal gateway process before expecting persistent MCP availability across restarts.
This script intentionally did not restart or destroy the container.
EOF
