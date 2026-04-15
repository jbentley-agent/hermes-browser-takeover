# Hermes Browser Takeover

Human takeover for Hermes browser sessions running in Docker.

This repo lets a human temporarily control the exact live browser session that a Hermes agent is using through the native Camoufox browser backend, then hand control back to the agent in the same real tab.

It includes:
- a host-side noVNC takeover helper that mints temporary links
- a container-side wrapped Camoufox launcher that preserves a shared live browser session
- an MCP server script that lets the agent mint takeover links for itself
- a Hermes patch required for reliable reattach after takeover
- macOS launchd example files and config snippets

This repo is designed so another agent can be told:
- "Clone this repo and set it up exactly as directed in the README"

If the agent follows the steps below, it should be able to:
- install the host helper
- install the container-side browser takeover stack
- register the MCP server in Hermes config
- apply the Hermes patch
- verify that takeover and resume work end-to-end

## What problem this solves

Without this stack, a Hermes agent that hits a login wall, captcha, bot check, or other blocked browser flow often cannot recover cleanly. Standard remote browser viewing is not enough if the human ends up in a different browser session than the agent.

This repo solves that by making the agent and the human share the same live browser context and tab.

## Critical requirement

This solution requires both:
1. the browser takeover wrapper in this repo
2. the Hermes patch in `patches/hermes-browser-camofox-reattach.patch`

Do not skip the Hermes patch.

Without the patch, the human may still control the correct browser visually, but Hermes can later fail locally with:
- `No browser session. Call browser_navigate first.`

## Repository layout

- `host/browser-takeover/`
  - host-side Node service that serves noVNC takeover pages and proxies WebSocket traffic into the container's VNC server
- `host/launchd/com.hermes.browser-takeover-helper.plist.example`
  - launchd example for macOS hosts
- `container/browser-takeover/`
  - wrapped Camoufox launcher plus Xvfb/x11vnc startup script
- `mcp/browser_takeover_mcp.py`
  - MCP server script that mints takeover links
- `patches/hermes-browser-camofox-reattach.patch`
  - required Hermes patch
- `examples/`
  - copy-pasteable environment and config examples

## Architecture

There are three moving parts.

### 1. Container-side browser stack

Inside the agent container, this repo starts:
- Xvfb
- fluxbox if available
- x11vnc
- a wrapped `@askjo/camoufox-browser` server

The wrapper does the important takeover work:
- rewrites all browser `userId`s to one shared logical session
- blocks session deletion from destroying the shared live browser
- disables cleanup behavior that would otherwise wipe the session
- reuses an existing tab instead of always creating a fresh one

That is what makes the human and the agent see the same real session.

### 2. Host-side takeover helper

On the Docker host, the Node helper:
- serves temporary takeover pages
- serves noVNC static assets
- mints single-use takeover links
- proxies WebSocket traffic into `docker exec ... socat TCP:127.0.0.1:<vnc-port>`

### 3. Hermes MCP server

Inside the agent environment, the MCP server:
- calls the wrapper's compatibility endpoint to pin active browser sessions
- asks the host helper to mint a takeover link
- returns that link to Hermes so the user can take over

## Security model

The takeover link is treated as a bearer secret.

Current behavior:
- takeover URL contains a 32-byte random token encoded as 64 hex characters
- opening that URL mints a short-lived internal viewer ticket
- the viewer ticket is single-use
- only one active viewer is allowed
- on disconnect, the takeover session is invalidated
- noVNC reconnect is disabled
- the page uses no-store cache headers and `Referrer-Policy: no-referrer`
- restrictive CSP headers are set

This intentionally keeps the simple "key in the URL" model while making the link much harder to reuse accidentally.

## Prerequisites

### Host requirements

- macOS or Linux host
- Docker CLI available on the host
- host can run `docker exec` into the target agent container
- Node.js available on the host
- internet access to fetch noVNC

### Container requirements

The agent container must have:
- Hermes installed and working
- native Camoufox browser support available
- `node`
- `xvfb`
- `x11vnc`
- `socat`
- `curl`
- optionally `fluxbox`
- optionally `xdotool`
- optionally the CapSolver Firefox addon directory

## Install overview

Do these in order:
1. clone this repo onto the Docker host
2. fetch noVNC into the host helper directory
3. install host helper dependencies
4. copy the container takeover files into the agent container or mount them in
5. apply the Hermes patch in the Hermes checkout used by that agent
6. configure the agent/container entrypoint to start the takeover stack
7. install the MCP server script and register it in Hermes config
8. start the host helper
9. verify the full takeover flow

## Step 1: clone this repo

Example:

```bash
git clone https://github.com/jbentley-agent/hermes-browser-takeover.git
cd hermes-browser-takeover
```

If this repo is private, use whatever authenticated clone method your environment already supports.

## Step 2: fetch noVNC

The host helper expects noVNC at `host/browser-takeover/vendor/noVNC`.

```bash
cd host/browser-takeover
mkdir -p vendor
git clone --depth 1 https://github.com/novnc/noVNC.git vendor/noVNC
```

Do not skip this. The host helper serves the noVNC client from that path.

## Step 3: install host helper dependencies

```bash
cd host/browser-takeover
npm install
chmod +x mint-link.sh
```

## Step 4: configure and start the host helper

You can either use simple single-agent environment variables or `TAKEOVER_AGENTS_JSON` for multi-agent installs.

### Single-agent example

Use `examples/host.env.single-agent.example` as the template.

```bash
cd host/browser-takeover
export PORT=9388
export HOST=0.0.0.0
export PUBLIC_BASE_URL=http://YOUR_HOST_OR_DOMAIN:9388
export DEFAULT_AGENT_NAME=agent
export CONTAINER_NAME=agent-container
export VNC_PORT=5901
export CAMOUFOX_URL=http://127.0.0.1:9377
node server.js
```

### Multi-agent example

Use `examples/host.env.multi-agent.example` as the template.

```bash
cd host/browser-takeover
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

### Host helper verification

```bash
curl http://127.0.0.1:9388/health
```

Expected shape:
- `status: ok`
- `tokens: 0` or more
- `agents: [...]`

### Manual mint test

```bash
curl -s -X POST http://127.0.0.1:9388/api/mint \
  -H 'Content-Type: application/json' \
  -d '{"agent":"agent","ttlSeconds":900}'
```

Expected result includes:
- `url`
- `token`
- `expiresAt`

## Step 5: install the container-side takeover stack

Copy the contents of `container/browser-takeover/` into the target agent container.

Recommended path inside the container:
- `/root/browser-takeover/`

Example:

```bash
docker cp container/browser-takeover/. agent-container:/root/browser-takeover/
docker exec agent-container chmod +x /root/browser-takeover/start.sh
```

If your Docker environment preserves host UID/GID on copy, fix permissions afterward as needed.

### Container environment variables

Use `examples/container.env.example` as the template.

Recommended values inside the container:
- `BROWSER_TAKEOVER_ENABLE=1`
- `TAKEOVER_ROOT=/root/browser-takeover`
- `CAMOFOX_URL=http://127.0.0.1:9377`
- `TAKEOVER_MINT_URL=http://host.docker.internal:9388/api/mint`
- `TAKEOVER_AGENT=agent`
- optional `CAPSOLVER_ADDON_PATH=/root/capsolver-firefox-addon`
- optional `DISPLAY=:99`
- optional `PORT=9377`
- optional `VNC_PORT=5901`

### Entrypoint integration

Your container entrypoint must start the takeover stack before the Hermes gateway.

Use `examples/container-entrypoint-snippet.sh`.

Minimal pattern:

```bash
if [ "${BROWSER_TAKEOVER_ENABLE:-0}" = "1" ] && [ -x "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" ]; then
  echo "[entrypoint] Starting browser takeover stack..."
  "${TAKEOVER_ROOT:-/root/browser-takeover}/start.sh" || echo "[entrypoint] WARNING: browser takeover stack failed to start"
fi

exec hermes gateway run --replace
```

### What `start.sh` does

- starts Xvfb on `DISPLAY`
- starts fluxbox if available
- starts x11vnc on `VNC_PORT`
- starts the wrapped Camoufox server on `PORT` default `9377`
- resizes and raises the Firefox window so noVNC shows the live page clearly

## Step 6: apply the Hermes patch

You must patch the Hermes checkout used by the target agent.

Patch file:
- `patches/hermes-browser-camofox-reattach.patch`

Purpose of the patch:
- if local Python session state lost its `tab_id`, Hermes probes the Camoufox backend for an existing tab and reattaches instead of failing immediately

### Generic patch workflow

Inside the Hermes source checkout used by the agent:

```bash
git apply /ABSOLUTE/PATH/TO/hermes-browser-takeover/patches/hermes-browser-camofox-reattach.patch
```

If the patch does not apply cleanly because Hermes has drifted:
- open the patch file
- apply the equivalent logic manually to `tools/browser_camofox.py`
- make sure the associated test case or equivalent behavior is present

### Restart requirement

After applying the patch, restart the Hermes process that imports that code.

If the agent runs Hermes in Docker, that usually means restarting the agent container or restarting the gateway process inside the container.

## Step 7: install and register the MCP server

Copy `mcp/browser_takeover_mcp.py` into the agent environment.

Recommended destination inside the container:
- `/root/.hermes/bin/browser_takeover_mcp.py`

Example:

```bash
docker exec agent-container mkdir -p /root/.hermes/bin
docker cp mcp/browser_takeover_mcp.py agent-container:/root/.hermes/bin/browser_takeover_mcp.py
docker exec agent-container chmod +x /root/.hermes/bin/browser_takeover_mcp.py
```

Now register the MCP server in Hermes config.

Use `examples/hermes-config.browser-takeover.yaml` as the template.

Example config snippet:

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
      CAMOFOX_URL: http://127.0.0.1:9377
    connect_timeout: 15
    timeout: 30
```

Important:
- `TAKEOVER_AGENT` must match the agent name expected by the host helper
- `TAKEOVER_MINT_URL` must be reachable from inside the container
- `CAMOFOX_URL` should point at the wrapped local Camoufox service inside the container

### What the MCP server exposes

It provides a tool named:
- `takeover_link`

That tool:
- pins active browser sessions through the local wrapper compatibility endpoint
- requests a mint from the host helper
- returns the takeover URL, TTL, and expiry information

## Step 8: optional Cloudflare tunnel

If you want a public URL without exposing the raw helper port directly, put Cloudflare Tunnel in front of the host helper.

Quick tunnel example:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9388
```

Then update and restart the host helper with:
- `PUBLIC_BASE_URL=https://YOUR-TRYCLOUDFLARE-HOSTNAME`

Notes:
- quick tunnel hostnames are ephemeral
- if the tunnel restarts, the hostname changes
- named tunnels on your own domain are better for stable setups

## Step 9: optional macOS launchd setup

Use:
- `host/launchd/com.hermes.browser-takeover-helper.plist.example`

Edit all placeholder values before loading it:
- Node path
- repo path
- log path
- `PUBLIC_BASE_URL`
- `DEFAULT_AGENT_NAME`
- `TAKEOVER_AGENTS_JSON` or the single-agent variables

Then install it:

```bash
cp host/launchd/com.hermes.browser-takeover-helper.plist.example ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist
launchctl unload ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.hermes.browser-takeover-helper.plist
```

## End-to-end verification checklist

A correct install should pass all of these.

### Basic health checks

- host helper `/health` returns `status: ok`
- noVNC exists under `host/browser-takeover/vendor/noVNC`
- inside the container, `start.sh` launches Xvfb, x11vnc, and the wrapper successfully
- wrapped Camoufox responds on `http://127.0.0.1:9377/health`

### Functional checks

1. Have the agent navigate to a real page with the Hermes browser tool.
2. Call the MCP `takeover_link` tool.
3. Open the minted URL.
4. Confirm the human sees the live browser page the agent was actually using.
5. Interact with the page as the human.
6. Return control to the agent.
7. Confirm Hermes browser calls resume in the same live tab.

### Security checks

- the takeover page is single-use
- disconnecting invalidates the session
- reopening the same link fails
- no extra viewer can connect simultaneously

## Common failure modes

### `No browser session. Call browser_navigate first.`

Likely causes:
- Hermes patch not applied
- Hermes process not restarted after patching
- wrong Hermes checkout was patched

### Minted URL points to the wrong host

Cause:
- `PUBLIC_BASE_URL` is wrong

Fix:
- correct `PUBLIC_BASE_URL`
- restart the host helper

### Host helper can mint links but noVNC page does not work

Likely causes:
- noVNC was not cloned into `host/browser-takeover/vendor/noVNC`
- container name or VNC port is wrong
- `docker exec` from the host cannot reach the target container
- `socat` is missing inside the container

### Human sees a fresh browser instead of the agent's page

Likely causes:
- wrapper not actually being used
- Hermes is still pointing at a different browser backend
- container entrypoint did not start `start.sh`
- `CAMOFOX_URL` points at the wrong service

### New env vars were added but the container still behaves the old way

Cause:
- your entrypoint may not be sourcing the env file used by the agent process

Fix:
- ensure the startup path actually exports the new environment before launching Hermes

### `docker cp` left the script non-executable or with odd ownership

Fix:
- run `chmod +x` on scripts after copying
- fix ownership or mode inside the container if needed

## Suggested handoff prompt for another agent

If you want another Hermes agent to install this repo, give it a prompt like this:

```text
Clone the browser takeover repo, then follow its README exactly. Do the full install: fetch noVNC, install the host helper, copy the container takeover files into the target agent container, apply the Hermes patch to the Hermes checkout used by that agent, register the MCP server in Hermes config, restart the affected processes, and verify takeover works end-to-end. Do not skip verification.
```

## Notes for maintainers

- `container/browser-takeover/takeover-wrapper.js` is intentionally a wrapper around native `@askjo/camoufox-browser`, not a forked server implementation
- the wrapper preserves a shared live session by rewriting all `userId` values to a common logical user
- the MCP server currently exposes one tool, `takeover_link`
- the host helper expects noVNC to be fetched externally and does not vendor noVNC in this repo

