'use strict';

/**
 * Render-ready static game + WebSocket relay.
 * Security: Helmet headers/CSP, HTTP rate limiting, strict WebSocket schema,
 * payload limit, message rate limit, connection cap, Origin allowlist, bounds checks.
 * No SQL database is used by this server, so there are no SQL query endpoints to inject.
 * If persistence is added later, use parameterized queries only; never concatenate SQL.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.disable('x-powered-by');
// Render terminates TLS in its proxy; trust the first proxy hop for client IP/rate limits.
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const MAX_PLAYERS = clampInt(process.env.MAX_PLAYERS, 2, 200, 80);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '16kb', strict: true }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }
}));

const publicDir = path.join(__dirname, 'public');
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.use(express.static(publicDir, {
  index: 'index.html',
  dotfiles: 'deny',
  fallthrough: false,
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  const status = Number(err.statusCode || err.status) || 500;
  res.status(status >= 400 && status < 600 ? status : 500)
    .json({ error: status === 404 ? 'Not found' : '요청을 처리할 수 없습니다.' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`RPG server listening on ${HOST}:${PORT}`);
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024,
  perMessageDeflate: false
});
const players = new Map();
const socketsByIp = new Map();
const HEARTBEAT_MS = 30000;
const MIN_MESSAGE_INTERVAL_MS = 80;
const MAX_COORD = 230;

function getClientIp(req) {
  // Render terminates incoming HTTPS at its proxy. Use its forwarded client address.
  // In production, requests should only reach this process through Render's proxy.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function isAllowedOrigin(origin, req) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    const host = req.headers.host;
    const sameHost = u.host === host;
    const secureExpected = Boolean(req.socket.encrypted) ||
      String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return sameHost && (u.protocol === (secureExpected ? 'https:' : 'http:'));
  } catch {
    return false;
  }
}
function safeName(id) {
  return `플레이어-${id.slice(0, 4).toUpperCase()}`;
}
function finiteInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, z: p.z, y: p.y, face: p.face };
}
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(data, except) {
  const raw = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      try { client.send(raw); } catch { /* connection is closing */ }
    }
  }
}
function cleanup(ws) {
  if (ws._cleaned) return;
  ws._cleaned = true;
  clearInterval(ws._heartbeat);
  const p = ws._player;
  if (p) {
    players.delete(p.id);
    broadcast({ type: 'leave', id: p.id });
  }
  const ip = ws._clientIp;
  if (ip) {
    const n = Math.max(0, (socketsByIp.get(ip) || 1) - 1);
    if (n) socketsByIp.set(ip, n); else socketsByIp.delete(ip);
  }
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/ws' || !isAllowedOrigin(req.headers.origin, req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const ip = getClientIp(req);
  if ((socketsByIp.get(ip) || 0) >= 4 || players.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws._clientIp = ip;
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws._lastMessageAt = 0;
  const id = crypto.randomUUID();
  const player = { id, name: safeName(id), x: 0, z: 8, y: 0, face: 0 };
  ws._player = player;
  players.set(id, player);

  send(ws, { type: 'welcome', id, players: [...players.values()].filter(p => p.id !== id).map(publicPlayer) });
  broadcast({ type: 'join', player: publicPlayer(player) }, ws);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > 1024) { ws.close(1003, 'Invalid message'); return; }
    const now = Date.now();
    if (now - ws._lastMessageAt < MIN_MESSAGE_INTERVAL_MS) {
      ws._strikes = (ws._strikes || 0) + 1;
      if (ws._strikes >= 4) ws.close(1008, 'Rate limit');
      return;
    }
    ws._lastMessageAt = now;

    let msg;
    try { msg = JSON.parse(data.toString('utf8')); }
    catch { ws.close(1007, 'Invalid JSON'); return; }

    // Strict allowlist schema: ignore unknown fields, HTML, chat text, commands, and client IDs.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.type !== 'move' ||
        !finiteInRange(msg.x, -MAX_COORD, MAX_COORD) ||
        !finiteInRange(msg.z, -MAX_COORD, MAX_COORD) ||
        !finiteInRange(msg.y, 0, 40) ||
        !finiteInRange(msg.face, -100, 100)) {
      ws._strikes = (ws._strikes || 0) + 1;
      if (ws._strikes >= 3) ws.close(1008, 'Invalid state');
      return;
    }
    // Store only validated numeric values. No client-provided identity is trusted.
    player.x = msg.x; player.z = msg.z; player.y = msg.y; player.face = msg.face;
    broadcast({ type: 'state', player: publicPlayer(player) }, ws);
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
  ws._heartbeat = setInterval(() => {
    if (!ws.isAlive) { ws.terminate(); cleanup(ws); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); cleanup(ws); }
  }, HEARTBEAT_MS);
});

server.on('close', () => {
  clearInterval(wss._heartbeat);
  for (const ws of wss.clients) ws.terminate();
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
