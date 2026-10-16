#!/usr/bin/env node
/* Integration tests for relay/server.js: spawns the real server on a random port and talks to it
 * with `ws` (from relay/node_modules). Run: node tests/relay-server.js  (needs: cd relay && npm i) */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const http = require('node:http');

const RELAY_DIR = path.resolve(__dirname, '..', 'relay');
const WebSocket = require(path.join(RELAY_DIR, 'node_modules', 'ws'));
const WAIT_MS = 3000;

const tests = [];
const t = (name, fn) => tests.push({ name, fn });

function startServer() {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [path.join(RELAY_DIR, 'server.js')], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), WAIT_MS);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('listening')) {
        clearTimeout(timer);
        resolve({ child, port });
      }
    });
    child.on('exit', (code) => reject(new Error('relay exited ' + code)));
  });
}

/** Socket with a frame inbox and close info. */
function open(port, query) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/?' + query);
  const sock = { ws, frames: [], closed: null };
  ws.on('message', (data) => sock.frames.push(JSON.parse(String(data))));
  ws.on('close', (code) => { sock.closed = code; });
  ws.on('error', () => {});
  sock.send = (frame) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  return sock;
}

async function until(pred, what) {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for ' + what);
}

const ready = (s) => until(() => s.frames.some((f) => f.t === 'ready'), 'ready');
const closedWith = async (s, code) => {
  await until(() => s.closed !== null, 'close');
  assert.equal(s.closed, code);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let room = 0;
const nextRoom = () => ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE', 'FFFFF', 'GGGGG', 'HHHHH', 'JJJJJ', 'KKKKK'][room++];

async function hostWithClients(port, code, ids) {
  const host = open(port, 'role=host&room=' + code);
  await ready(host);
  const clients = [];
  for (const id of ids) {
    const c = open(port, 'role=client&room=' + code + '&id=' + id);
    await ready(c);
    clients.push(c);
  }
  await until(() => host.frames.filter((f) => f.t === 'join').length === ids.length, 'joins');
  return { host, clients };
}

t('GET /health returns ok', async (port) => {
  const body = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + '/health', (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve(res.statusCode + ' ' + s));
    }).on('error', reject);
  });
  assert.equal(body, '200 ok');
});

t('routes host->client by id and client->host with from; no client sees another client', async (port) => {
  const { host, clients: [a, b] } = await hostWithClients(port, nextRoom(), ['clientAAA', 'clientBBB']);
  assert.deepEqual(host.frames.filter((f) => f.t === 'join').map((f) => f.id), ['clientAAA', 'clientBBB']);
  host.send({ to: 'clientAAA', d: { t: 'hole', cards: ['As', 'Kd'] } });
  host.send({ to: 'clientBBB', d: { t: 'hole', cards: ['7c', '2h'] } });
  a.send({ d: { t: 'act', who: 'a' } });
  b.send({ d: { t: 'act', who: 'b' } });
  await until(() => host.frames.filter((f) => f.t === 'msg').length === 2, 'client msgs');
  await until(() => a.frames.length === 2 && b.frames.length === 2, 'host msgs');
  await pause(100);
  assert.deepEqual(a.frames, [{ t: 'ready' }, { d: { t: 'hole', cards: ['As', 'Kd'] } }]);
  assert.deepEqual(b.frames, [{ t: 'ready' }, { d: { t: 'hole', cards: ['7c', '2h'] } }]);
  const msgs = host.frames.filter((f) => f.t === 'msg').map((f) => [f.from, f.d.who]).sort();
  assert.deepEqual(msgs, [['clientAAA', 'a'], ['clientBBB', 'b']]);
});

t('a client-supplied from / to is ignored: relay stamps the real sender, never routes client->client', async (port) => {
  const { host, clients: [a, b] } = await hostWithClients(port, nextRoom(), ['clientAAA', 'clientBBB']);
  a.send({ from: 'clientBBB', to: 'clientBBB', d: { t: 'chat', text: 'spoof' } });
  await until(() => host.frames.some((f) => f.t === 'msg'), 'spoofed msg');
  await pause(100);
  const msg = host.frames.find((f) => f.t === 'msg');
  assert.equal(msg.from, 'clientAAA');
  assert.deepEqual(Object.keys(msg).sort(), ['d', 'from', 't']);
  assert.equal(b.frames.length, 1); // only its own ready
});

t('oversize message (>64KB) closes the sender with 1009', async (port) => {
  const { host, clients: [a] } = await hostWithClients(port, nextRoom(), ['clientAAA']);
  a.send({ d: 'x'.repeat(70 * 1024) });
  await closedWith(a, 1009);
  await until(() => host.frames.some((f) => f.t === 'leave'), 'leave');
  assert.equal(host.frames.some((f) => f.t === 'msg'), false);
});

t('client for an unknown room is closed with 4404', async (port) => {
  const c = open(port, 'role=client&room=ZZZZZ&id=clientAAA');
  await closedWith(c, 4404);
  assert.deepEqual(c.frames, []);
});

t('second host for the same room is closed with 4409; first host unaffected', async (port) => {
  const code = nextRoom();
  const h1 = open(port, 'role=host&room=' + code);
  await ready(h1);
  const h2 = open(port, 'role=host&room=' + code);
  await closedWith(h2, 4409);
  assert.equal(h1.closed, null);
});

t('bad requests are closed with 4400 (bad code alphabet, missing id, unknown role)', async (port) => {
  for (const q of ['role=host&room=AAAA0', 'role=client&room=AAAAA', 'role=admin&room=AAAAA', 'role=client&room=AAAAA&id=a%20b']) {
    const s = open(port, q);
    await closedWith(s, 4400);
  }
});

t('host leaving closes every client with 4410 and frees the code', async (port) => {
  const code = nextRoom();
  const { host, clients: [a, b] } = await hostWithClients(port, code, ['clientAAA', 'clientBBB']);
  host.ws.close();
  await closedWith(a, 4410);
  await closedWith(b, 4410);
  const again = open(port, 'role=host&room=' + code);
  await ready(again);
});

t('client leave notifies the host; host kick closes the client', async (port) => {
  const { host, clients: [a, b] } = await hostWithClients(port, nextRoom(), ['clientAAA', 'clientBBB']);
  a.ws.close();
  await until(() => host.frames.some((f) => f.t === 'leave' && f.id === 'clientAAA'), 'leave A');
  host.send({ kick: 'clientBBB' });
  await closedWith(b, 1000);
  await until(() => host.frames.some((f) => f.t === 'leave' && f.id === 'clientBBB'), 'leave B');
});

t('same client id reconnecting replaces the old socket (4000) without a leave', async (port) => {
  const code = nextRoom();
  const { host, clients: [a] } = await hostWithClients(port, code, ['clientAAA']);
  const a2 = open(port, 'role=client&room=' + code + '&id=clientAAA');
  await ready(a2);
  await closedWith(a, 4000);
  await pause(100);
  assert.equal(host.frames.filter((f) => f.t === 'join').length, 2);
  assert.equal(host.frames.some((f) => f.t === 'leave'), false);
  host.send({ to: 'clientAAA', d: 1 });
  await until(() => a2.frames.some((f) => f.d === 1), 'routed to new socket');
});

t('room holds at most 10 clients', async (port) => {
  const code = nextRoom();
  const ids = Array.from({ length: 10 }, (_, i) => 'client' + String(i).padStart(3, '0'));
  await hostWithClients(port, code, ids);
  const extra = open(port, 'role=client&room=' + code + '&id=clientXYZ');
  await closedWith(extra, 4503);
});

t('flooding client gets over-rate messages dropped', async (port) => {
  const { host, clients: [a] } = await hostWithClients(port, nextRoom(), ['clientAAA']);
  for (let i = 0; i < 80; i++) a.send({ d: i });
  await pause(300);
  const got = host.frames.filter((f) => f.t === 'msg').length;
  assert.ok(got >= 50 && got < 80, 'delivered ' + got);
});

async function main() {
  const { child, port } = await startServer();
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test.fn(port);
      passed++;
      process.stdout.write('  PASS ' + test.name + '\n');
    } catch (err) {
      failed++;
      process.stdout.write('  FAIL ' + test.name + '\n    ' + (err && err.stack) + '\n');
    }
  }
  child.kill('SIGTERM');
  process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write('harness error: ' + (err && err.stack) + '\n');
  process.exit(1);
});
