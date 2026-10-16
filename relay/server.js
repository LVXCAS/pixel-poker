#!/usr/bin/env node
/*
 * PIXEL HOLD'EM — WebSocket relay for networks that block WebRTC (school Wi-Fi).
 * Run behind a Cloudflare quick tunnel (see relay/start.sh). Node 18+, dependency: ws.
 *
 * PROTOCOL (all frames are JSON text; max 64KB each)
 *   Host:   wss://<relay>/?role=host&room=CODE
 *   Client: wss://<relay>/?role=client&room=CODE&id=CLIENTID
 *     CODE     = 5 chars from PP.Net.CODE_ALPHABET (ABCDEFGHJKMNPQRSTUVWXYZ23456789)
 *     CLIENTID = 6-40 chars [A-Za-z0-9_-], chosen randomly by the client
 *
 *   relay -> any    {t:'ready'}                 registration accepted (sent once, first)
 *   host  -> relay  {to:CLIENTID, d:payload}    deliver payload to that one client
 *   host  -> relay  {kick:CLIENTID}             close that client
 *   relay -> host   {t:'join',  id:CLIENTID}
 *   relay -> host   {t:'leave', id:CLIENTID}
 *   relay -> host   {t:'msg', from:CLIENTID, d:payload}   `from` is stamped by the relay
 *   client-> relay  {d:payload}                 always goes to the room's host only
 *   relay -> client {d:payload}
 *
 *   There is no broadcast: a client's traffic only ever reaches the host (hole-card privacy).
 *   A client reconnecting with the same id replaces its old socket; the host gets a fresh join
 *   (no leave for the replaced socket), which its core treats as a reconnect.
 *
 * CLOSE CODES
 *   4400 bad request    4404 room not found     4409 room taken (host already registered)
 *   4410 host left      1009 message too big    4429 rate limited (after sustained flooding;
 *   4503 relay/room full    4000 replaced          over-rate messages are dropped first)
 *
 * LIMITS: 64KB/message, 10 clients/room, 200 rooms, token-bucket rate limit per socket,
 * ws ping every 15s (dead sockets dropped). GET /health -> "ok". PORT env (default 8787).
 * Message contents are never logged.
 */
'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS_PER_ROOM = 10;
const MAX_ROOMS = 200;
const HEARTBEAT_MS = 15000;
const RATE = Object.freeze({
  host: { burst: 200, perSec: 100 }, // the host fans state out to every client
  client: { burst: 50, perSec: 25 },
});
const CLOSE = Object.freeze({
  REPLACED: 4000, BAD_REQUEST: 4400, NOT_FOUND: 4404, TAKEN: 4409, HOST_LEFT: 4410,
  RATE_LIMITED: 4429, FULL: 4503, // oversize frames: ws closes with 1009 (maxPayload)
});
const RATE_STRIKES_BEFORE_CLOSE = 100;

/* ---------------------------------------------------------------- helpers */

function send(ws, frame) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function closeWith(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch (err) {
    ws.terminate();
  }
}

function parseFrame(data, isBinary) {
  if (isBinary) return null;
  try {
    const f = JSON.parse(data.toString('utf8'));
    return f && typeof f === 'object' && !Array.isArray(f) ? f : null;
  } catch (err) {
    return null;
  }
}

function makeBucket(kind, now) {
  const cfg = RATE[kind];
  return { tokens: cfg.burst, at: now, cfg, strikes: 0 };
}

/** Token bucket. Returns false when the message must be dropped. */
function take(bucket, now) {
  const { cfg } = bucket;
  bucket.tokens = Math.min(cfg.burst, bucket.tokens + ((now - bucket.at) / 1000) * cfg.perSec);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function parseQuery(reqUrl) {
  try {
    const u = new URL(reqUrl, 'http://relay.invalid');
    const role = u.searchParams.get('role');
    const room = u.searchParams.get('room') || '';
    const id = u.searchParams.get('id') || '';
    if (!CODE_RE.test(room)) return null;
    if (role === 'host') return { role, room };
    if (role === 'client' && ID_RE.test(id)) return { role, room, id };
    return null;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ relay */

function createRelay(options) {
  const o = options || {};
  const now = o.now || (() => Date.now());
  const rooms = new Map(); // code -> { host: ws, clients: Map<id, ws> }

  function onConnection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* close follows */ });
    const q = parseQuery(req.url || '');
    if (!q) return closeWith(ws, CLOSE.BAD_REQUEST, 'bad request');
    ws.bucket = makeBucket(q.role, now());
    if (q.role === 'host') return acceptHost(ws, q.room);
    return acceptClient(ws, q.room, q.id);
  }

  function rateOk(ws) {
    if (take(ws.bucket, now())) return true;
    ws.bucket.strikes += 1;
    if (ws.bucket.strikes >= RATE_STRIKES_BEFORE_CLOSE) closeWith(ws, CLOSE.RATE_LIMITED, 'rate limited');
    return false;
  }

  function acceptHost(ws, code) {
    if (rooms.has(code)) return closeWith(ws, CLOSE.TAKEN, 'room taken');
    if (rooms.size >= MAX_ROOMS) return closeWith(ws, CLOSE.FULL, 'relay full');
    const room = { host: ws, clients: new Map() };
    rooms.set(code, room);
    ws.on('message', (data, isBinary) => {
      if (rateOk(ws)) onHostFrame(room, parseFrame(data, isBinary));
    });
    ws.on('close', () => closeRoom(code, room));
    send(ws, { t: 'ready' });
  }

  function onHostFrame(room, f) {
    if (!f) return;
    if (typeof f.kick === 'string') {
      const target = room.clients.get(f.kick);
      if (target) closeWith(target, 1000, 'kicked');
      return;
    }
    if (typeof f.to !== 'string' || !('d' in f)) return;
    const target = room.clients.get(f.to);
    if (target) send(target, { d: f.d });
  }

  function closeRoom(code, room) {
    if (rooms.get(code) === room) rooms.delete(code);
    room.clients.forEach((c) => closeWith(c, CLOSE.HOST_LEFT, 'host left'));
    room.clients.clear();
  }

  function acceptClient(ws, code, id) {
    const room = rooms.get(code);
    if (!room) return closeWith(ws, CLOSE.NOT_FOUND, 'room not found');
    const old = room.clients.get(id);
    if (!old && room.clients.size >= MAX_CLIENTS_PER_ROOM) return closeWith(ws, CLOSE.FULL, 'room full');
    room.clients.set(id, ws);
    if (old) closeWith(old, CLOSE.REPLACED, 'replaced');
    ws.on('message', (data, isBinary) => {
      if (!rateOk(ws)) return;
      const f = parseFrame(data, isBinary);
      if (f && 'd' in f && room.clients.get(id) === ws) send(room.host, { t: 'msg', from: id, d: f.d });
    });
    ws.on('close', () => {
      if (room.clients.get(id) !== ws) return; // replaced, or the room already closed
      room.clients.delete(id);
      send(room.host, { t: 'leave', id });
    });
    send(room.host, { t: 'join', id });
    send(ws, { t: 'ready' });
  }

  return { onConnection, rooms };
}

/* ----------------------------------------------------------------- server */

function onHttp(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function startHeartbeat(wss) {
  return setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (err) { ws.terminate(); }
    });
  }, HEARTBEAT_MS);
}

function start(port) {
  const server = http.createServer(onHttp);
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const relay = createRelay();
  wss.on('connection', relay.onConnection);
  const beat = startHeartbeat(wss);
  wss.on('close', () => clearInterval(beat));
  server.listen(port, () => {
    process.stdout.write('pixel-poker relay listening on :' + server.address().port + '\n');
  });
  const stop = () => {
    clearInterval(beat);
    wss.clients.forEach((ws) => ws.terminate());
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { server, wss, relay };
}

if (require.main === module) start(PORT);

module.exports = { start, createRelay, parseQuery, CLOSE, MAX_MESSAGE_BYTES };
