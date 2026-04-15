# Browser takeover stack for Hermes agents

This package adds a human takeover path for Hermes browser sessions running inside Docker containers.

It is designed for the case where an agent is using the native Hermes browser tool through Camoufox, gets stuck on a captcha/login/blocked page, and needs a human to temporarily take over the exact same live browser/tab. The human connects through noVNC, interacts with the live browser, and the agent can continue afterward in the same session.

This package is generalized. It does not assume a specific bot name, container name, domain, or home directory beyond the install examples in this README.

## What this gives you

- Headful Camoufox inside the agent container
- Xvfb + x11vnc so a human can see/control that browser visually
- Host-side noVNC helper that mints temporary takeover links
- Single-use public links with a token in the URL
- Optional Cloudflare tunnel in front of the host helper
- MCP tool so the agent can mint takeover links itself
- Shared-session wrapper so the human and the agent see the same browser context

## Important limitation: this also requires a Hermes patch

This repository alone is not sufficient.

For reliable resume after takeover, Hermes itself needs a small fix in `tools/browser_camofox.py` so when local `tab_id` state is missing, it probes the Camoufox backend for an existing tab and reattaches.

Without that Hermes change:
- the browser can remain alive on the server side
- the human can control the correct live browser through noVNC
- but later Hermes browser tool calls may still fail locally with:
  - `No browser session. Call browser_navigate first.`

Included in this repo:
- `references/hermes-browser-camofox-reattach.patch`

Reference commit used when this package was validated:
- `46ef5c3d`
- message: `fix: reattach to existing camofox tabs when local state is missing`

You must apply an equivalent Hermes patch before expecting takeover/resume to work correctly.

## Architecture

There are two parts:

1. Container-side browser stack
- `container/browser-takeover/start.sh`
- `container/browser-takeover/takeover-wrapper.js`
- starts Xvfb, fluxbox, x11vnc, and the wrapped Camoufox server
- forces all Hermes tasks into one shared browser context so human takeover is useful

2. Host-side helper
- `host/browser-takeover/server.js`
- serves noVNC and temporary takeover links
- bridges WebSocket traffic into `docker exec ... socat TCP:127.0.0.1:<vnc-port>`

## Security model

The takeover helper treats the takeover URL as a high-value bearer secret.

Current behavior:
- public `/takeover/<token>` URL uses a 32-byte random hex token
- opening that page mints a short-lived internal viewer ticket for the WebSocket
- viewer ticket is single-use
- one active viewer only
- when the WebSocket closes, the takeover link is invalidated
- no-store/no-cache headers on the takeover page
- `Referrer-Policy: no-referrer`
- restrictive CSP
- no extra passcode or identity gate by default

This matches a “key in the URL” model, but hardens it so the raw takeover link behaves like a one-time bearer credential instead of a reusable dashboard.

## Files

Container side:
- `container/browser-takeover/start.sh`
- `container/browser-takeover/takeover-wrapper.js`
- `container/browser-takeover/camoufox-server.js` (reference/alternative)
- `mcp/browser_takeover_mcp.py`

Host side:
- `host/browser-takeover/server.js`
- `host/browser-takeover/mint-link.sh`
- `host/launchd/com.hermes.browser-takeover-helper.plist.example`

Patch:
- `container/browser-takeover/references/hermes-browser-camofox-reattach.patch`

## Prerequisites

Host:
- macOS or Linux host that can run Node and Docker CLI
- Docker must be able to `exec` into the agent container
- Node.js available for the host helper
- `socat` available inside the agent container

Container:
- Hermes agent running in Docker
- native Hermes browser tool configured to use Camoufox
- packages available in the container:
  - `xvfb`
  - `x11vnc`
  - `fluxbox` (optional but recommended)
  - `xdotool` (optional but recommended)
  - `socat`
  - `node`
- `@askjo/camoufox-browser` available in the container environment

## Step 1: apply the Hermes patch

Inside the Hermes checkout used by the target agent/container, apply:
- `container/browser-takeover/references/hermes-browser-camofox-reattach.patch`

Then restart the agent/gateway process that imports Hermes Python modules.

Verification:
- browser takeover should preserve the real tab on the server side
- later browser tool calls should reattach to that tab instead of erroring with “No browser session”

## Step 2: install the container-side takeover stack

Copy these files into the agent container, for example under `/root/browser-takeover/`:
- `container/browser-takeover/start.sh`
- `container/browser-takeover/takeover-wrapper.js`

Recommended container path:
- `/root/browser-takeover/`

Recommended env inside the container:
- `BROWSER_TAKEOVER_ENABLE=1`
- `TAKEOVER_ROOT=/root/browser-takeover`
- `CAMOFOX_URL=http://127.0.0.1:9377`
- `TAKEOVER_MINT_URL=http://host.docker.internal:9388/api/mint`
- `TAKEOVER_AGENT=<your-agent-name>`
- optional: `CAPSOLVER_ADDON_PATH=/root/capsolver-firefox-addon`

Example entrypoint logic:

```bash
if [ "${BROWSER_TAKEOVER_ENABLE:-0}" = "1" ] && [ -x "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" ]; then
  echo "[entrypoint] Starting browser takeover stack..."
  "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" || echo "[entrypoint] WARNING: browser takeover stack failed to start"
fi

exec hermes gateway run --replace
```

What `start.sh` does:
- starts Xvfb on `DISPLAY`
- starts fluxbox if present
- starts x11vnc on `VNC_PORT`
- starts wrapped Camoufox on `PORT` (default 9377)
- resizes/raises the Firefox window so noVNC sees the live page clearly

Default container ports/env used by the script:
- `PORT=9377`
- `VNC_PORT=5901`
- `DISPLAY=:99`
- `SCREEN_WIDTH=1440`
- `SCREEN_HEIGHT=900`

## Step 3: install the host-side helper

Copy this directory somewhere on the host:
- `host/browser-takeover/`

Fetch noVNC into the expected vendor path:

```bash
cd /path/to/browser-takeover
mkdir -p vendor
git clone --depth 1 https://github.com/novnc/noVNC.git vendor/noVNC
```

Install host deps:

```bash
cd /path/to/browser-takeover
npm install
```

Required host env:
- `PUBLIC_BASE_URL` — the public or LAN URL you want minted links to use
- either:
  - `TAKEOVER_AGENTS_JSON` for multi-agent setups
  - or single-agent envs: `DEFAULT_AGENT_NAME`, `CONTAINER_NAME`, `VNC_PORT`, `CAMOUFOX_URL`

Single-agent example:

```bash
export PORT=9388
export HOST=0.0.0.0
export PUBLIC_BASE_URL=http://YOUR_HOST_OR_DOMAIN:9388
export DEFAULT_AGENT_NAME=agent
export CONTAINER_NAME=agent-container
export VNC_PORT=5901
export CAMOUFOX_URL=http://127.0.0.1:9377
node server.js
```

Multi-agent example:

```bash
export PORT=9388
export HOST=0.0.0.0
export PUBLIC_BASE_URL=https://takeover.example.com
export DEFAULT_AGENT_NAME=agent-a
export TAKEOVER_AGENTS_JSON='{
  "agent-a": {
    "containerName": "agent-a-container",
    "vncPort": 5901,
    "camoufoxUrl": "http://127.0.0.1:9377"
  },
  "agent-b": {
    "containerName": "agent-b-container",
    "vncPort": 5901,
    "camoufoxUrl": "http://127.0.0.1:9377"
  }
}'
node server.js
```

Health check:

```bash
curl http://127.0.0.1:9388/health
```

Mint manually:

```bash
curl -s -X POST http://127.0.0.1:9388/api/mint \
  -H 'Content-Type: application/json' \
  -d '{"agent":"agent","ttlSeconds":900}'
```

## Step 4: set up the MCP tool inside the agent

Copy:
- `mcp/browser_takeover_mcp.py`

Example agent config snippet:

```yaml
mcp_servers:
  browser_takeover:
    command: /root/.hermes/hermes-agent/venv/bin/python
    args:
      - /root/.hermes/bin/browser_takeover_mcp.py
    env:
      TAKEOVER_AGENT: agent
      TAKEOVER_MINT_URL: http://host.docker.internal:9388/api/mint
      TAKEOVER_DEFAULT_TTL: '900'
    connect_timeout: 15
    timeout: 30
```

What the MCP tool does:
- calls `POST /takeover/pin-all` on the local Camoufox wrapper for compatibility
- asks the host helper to mint a temporary takeover link
- returns the link to the agent/user

## Step 5: optional public exposure through Cloudflare tunnel

If you want public takeover links without opening a raw public port, run Cloudflare Tunnel in front of the host helper.

Quick tunnel example:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9388
```

Then set:
- `PUBLIC_BASE_URL=https://<your-trycloudflare-hostname>`

Important:
- quick tunnel hostnames are ephemeral
- if `cloudflared` restarts, the hostname changes
- update `PUBLIC_BASE_URL` and restart the host helper when that happens

For a stable production hostname, use a named Cloudflare tunnel on your own domain.

## Step 6: optional launchd on macOS

Use:
- `host/launchd/com.hermes.browser-takeover-helper.plist.example`

It is intentionally an example file because absolute paths differ by machine.

Edit these before loading it:
- Node path
- repo path
- log path
- `PUBLIC_BASE_URL`
- `TAKEOVER_AGENTS_JSON` or single-agent envs

Then:

```bash
launchctl unload ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist 2>/dev/null || true
cp /path/to/com.hermes.browser-takeover-helper.plist.example ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist
launchctl load ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist
```

## How the shared-session wrapper works

`takeover-wrapper.js` avoids forking the native Camoufox server and instead monkey-patches module loading/runtime behavior.

Key behavior:
- rewrites all `userId` values to one shared logical user
- blocks `DELETE /sessions/:userId` from destroying the shared browser context
- disables the native cleanup timer that would otherwise delete the session
- makes `POST /tabs` reuse an existing shared tab instead of creating a fresh one
- exposes compatibility endpoints used by older takeover tooling

This is what makes the agent and the human see the same real session instead of merely sharing cookies.

## Verification checklist

A successful install should satisfy all of these:
- the agent can open a page through native Hermes browser tools
- the host helper can mint a takeover link
- opening the takeover link shows the actual live browser, not a blank/fresh browser
- human interaction changes the page the agent later sees
- after human takeover, Hermes browser tools can resume on the same tab
- the takeover page is single-use and invalid after disconnect

## Known pitfalls

- Without the Hermes patch, server-side session preservation is not enough.
- `PUBLIC_BASE_URL` controls what URL gets minted. If it is wrong, the bot will hand out unusable links.
- If you use a Cloudflare quick tunnel, the hostname changes when the tunnel restarts.
- `docker restart` alone does not magically add new env vars unless your entrypoint actually sources the env file used by the agent.
- `docker cp` can change file ownership/mode; fix permissions after copying.
- CapSolver integration reduces manual captcha work but is optional.

## Minimal install summary

Container:
- copy `browser-takeover/start.sh`
- copy `browser-takeover/takeover-wrapper.js`
- set `BROWSER_TAKEOVER_ENABLE=1`
- set `TAKEOVER_ROOT=/root/browser-takeover`
- set `CAMOFOX_URL=http://127.0.0.1:9377`
- apply the Hermes reattach patch

Host:
- copy `host/browser-takeover/`
- run `npm install`
- set `PUBLIC_BASE_URL`
- configure `TAKEOVER_AGENTS_JSON` or single-agent envs
- run `node server.js`

Agent MCP:
- copy `browser_takeover_mcp.py`
- point it at `TAKEOVER_MINT_URL`
- set `TAKEOVER_AGENT`

## License

MIT
