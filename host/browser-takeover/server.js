const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9388);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const DEFAULT_TTL_SECONDS = Number(process.env.DEFAULT_TTL_SECONDS || 900);
const MAX_TTL_SECONDS = Number(process.env.MAX_TTL_SECONDS || 3600);
const VIEWER_TICKET_TTL_MS = Number(process.env.VIEWER_TICKET_TTL_MS || 2 * 60 * 1000);
const DEFAULT_AGENT_NAME = process.env.DEFAULT_AGENT_NAME || process.env.TAKEOVER_AGENT || 'agent';
const SERVICE_NAME = process.env.SERVICE_NAME || 'browser-takeover-helper';
const NOVNC_ROOT = path.join(__dirname, 'vendor', 'noVNC');

function parseAgents() {
  const raw = process.env.TAKEOVER_AGENTS_JSON || '';
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TAKEOVER_AGENTS_JSON must be a JSON object keyed by agent name');
    }
    const agents = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') {
        throw new Error(`Agent ${name} must map to an object`);
      }
      agents[name] = {
        containerName: String(value.containerName || value.container || name),
        vncPort: Number(value.vncPort || value.port || 5901),
        camoufoxUrl: String(value.camoufoxUrl || value.browserUrl || ''),
      };
    }
    return agents;
  }

  return {
    [DEFAULT_AGENT_NAME]: {
      containerName: process.env.CONTAINER_NAME || DEFAULT_AGENT_NAME,
      vncPort: Number(process.env.VNC_PORT || 5901),
      camoufoxUrl: process.env.CAMOUFOX_URL || '',
    },
  };
}

const AGENTS = parseAgents();
const tokens = new Map();
const wsTickets = new Map();

function now() {
  return Date.now();
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function cleanupExpiredTokens() {
  const t = now();
  for (const [token, session] of tokens.entries()) {
    if (session.expiresAt <= t) {
      if (session.wsTicket) wsTickets.delete(session.wsTicket);
      tokens.delete(token);
    }
  }
  for (const [ticket, data] of wsTickets.entries()) {
    if (data.expiresAt <= t) wsTickets.delete(ticket);
  }
}

function buildTakeoverUrl(token) {
  return `${PUBLIC_BASE_URL}/takeover/${token}`;
}

function getTokenSession(token) {
  cleanupExpiredTokens();
  const session = tokens.get(token);
  if (!session) return null;
  if (session.expiresAt <= now()) {
    if (session.wsTicket) wsTickets.delete(session.wsTicket);
    tokens.delete(token);
    return null;
  }
  return session;
}

function issueViewerTicket(session) {
  cleanupExpiredTokens();
  if (session.activeConnection || session.consumedAt) {
    const error = new Error('Takeover link already used. Mint a fresh link.');
    error.statusCode = 410;
    throw error;
  }

  const t = now();
  if (session.wsTicket && session.wsTicketExpiresAt > t) {
    return session.wsTicket;
  }

  if (session.wsTicket) wsTickets.delete(session.wsTicket);

  const ticket = randomSecret(32);
  session.wsTicket = ticket;
  session.wsTicketExpiresAt = t + VIEWER_TICKET_TTL_MS;
  wsTickets.set(ticket, {
    token: session.token,
    expiresAt: session.wsTicketExpiresAt,
  });
  return ticket;
}

function getSessionByViewerTicket(ticket) {
  cleanupExpiredTokens();
  const ticketData = wsTickets.get(ticket);
  if (!ticketData || ticketData.expiresAt <= now()) {
    if (ticketData) wsTickets.delete(ticket);
    return null;
  }
  const session = tokens.get(ticketData.token);
  if (!session || session.expiresAt <= now()) {
    wsTickets.delete(ticket);
    return null;
  }
  if (session.wsTicket !== ticket) {
    wsTickets.delete(ticket);
    return null;
  }
  return session;
}

function mintToken(agentName, ttlSeconds) {
  const agent = AGENTS[agentName];
  if (!agent) {
    const error = new Error(`Unknown agent: ${agentName}`);
    error.statusCode = 404;
    throw error;
  }
  const token = randomSecret(32);
  const ttl = Math.max(30, Math.min(ttlSeconds || DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS));
  const expiresAt = now() + ttl * 1000;
  const session = {
    token,
    agentName,
    containerName: agent.containerName,
    targetPort: agent.vncPort,
    expiresAt,
    createdAt: now(),
    camoufoxUrl: agent.camoufoxUrl,
    activeConnection: false,
    consumedAt: null,
    wsTicket: null,
    wsTicketExpiresAt: 0,
  };
  tokens.set(token, session);
  return session;
}

function renderTakeoverPage(session, viewerTicket) {
  const noVncPath = `/novnc/vnc_lite.html?autoconnect=true&resize=scale&reconnect=false&path=websockify/${viewerTicket}`;
  const browserInfo = session.camoufoxUrl ? `<span class="pill">Browser: ${session.camoufoxUrl}</span>` : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${session.agentName} browser takeover</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <style>
    html, body { height: 100%; margin: 0; background: #111827; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    #topbar { display: flex; gap: 16px; align-items: center; padding: 10px 14px; background: #030712; border-bottom: 1px solid #1f2937; flex-wrap: wrap; }
    #screen { width: 100%; height: calc(100% - 53px); border: 0; display: block; }
    .pill { padding: 4px 8px; border-radius: 999px; background: #1f2937; font-size: 12px; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div id="topbar">
    <strong>${session.agentName} live browser</strong>
    <span class="pill">expires ${new Date(session.expiresAt).toLocaleString()}</span>
    ${browserInfo}
    <span class="pill">single-use link</span>
    <span class="pill">one active viewer</span>
  </div>
  <iframe id="screen" src="${noVncPath}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/novnc', express.static(NOVNC_ROOT, { extensions: ['html'] }));

app.get('/health', (req, res) => {
  cleanupExpiredTokens();
  res.json({ status: 'ok', service: SERVICE_NAME, tokens: tokens.size, publicBaseUrl: PUBLIC_BASE_URL, agents: Object.keys(AGENTS) });
});

app.get('/api/status', (req, res) => {
  try {
    const payload = Object.fromEntries(Object.entries(AGENTS).map(([name, agent]) => [name, {
      containerName: agent.containerName,
      vncPort: agent.vncPort,
      camoufoxUrl: agent.camoufoxUrl,
    }]));
    res.json({ status: 'ok', agents: payload });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/mint', (req, res) => {
  try {
    const agentName = req.body.agent || DEFAULT_AGENT_NAME;
    const ttlSeconds = Number(req.body.ttlSeconds || DEFAULT_TTL_SECONDS);
    const session = mintToken(agentName, ttlSeconds);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      agent: session.agentName,
      token: session.token,
      url: buildTakeoverUrl(session.token),
      expiresAt: new Date(session.expiresAt).toISOString(),
      target: `${session.containerName}:127.0.0.1:${session.targetPort}`,
      camoufoxUrl: session.camoufoxUrl,
      ttlSeconds,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

app.get('/takeover/:token', (req, res) => {
  try {
    const session = getTokenSession(req.params.token);
    if (!session) {
      res.status(404).type('text/plain').send('Takeover link is missing or expired.');
      return;
    }
    const viewerTicket = issueViewerTicket(session);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.type('html').send(renderTakeoverPage(session, viewerTicket));
  } catch (error) {
    res.status(error.statusCode || 500).type('text/plain').send(error.message || 'Takeover link unavailable.');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const session = req.takeoverSession;
  const upstream = spawn('docker', ['exec', '-i', session.containerName, 'socat', 'STDIO', `TCP:127.0.0.1:${session.targetPort}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  upstream.stdout.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
  });

  upstream.stderr.on('data', (chunk) => {
    console.error(`Upstream VNC stderr for ${session.agentName}: ${chunk.toString().trim()}`);
  });

  upstream.on('error', (error) => {
    console.error(`Upstream VNC error for ${session.agentName}:`, error.message);
    ws.close();
  });

  upstream.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('message', (message, isBinary) => {
    if (upstream.stdin.writable) upstream.stdin.write(message, isBinary ? undefined : 'utf8');
  });

  ws.on('close', () => {
    session.activeConnection = false;
    if (session.wsTicket) wsTickets.delete(session.wsTicket);
    tokens.delete(session.token);
    upstream.kill();
  });

  ws.on('error', () => {
    session.activeConnection = false;
    if (session.wsTicket) wsTickets.delete(session.wsTicket);
    tokens.delete(session.token);
    upstream.kill();
  });
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/websockify\/([a-f0-9]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const session = getSessionByViewerTicket(match[1]);
    if (!session || session.activeConnection || session.consumedAt) {
      socket.destroy();
      return;
    }
    wsTickets.delete(match[1]);
    session.wsTicket = null;
    session.wsTicketExpiresAt = 0;
    session.activeConnection = true;
    session.consumedAt = now();
    req.takeoverSession = session;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch (_) {
    socket.destroy();
  }
});

setInterval(cleanupExpiredTokens, 30000).unref();

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE_NAME} listening on ${HOST}:${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`Registered agents: ${Object.keys(AGENTS).join(', ')}`);
});
