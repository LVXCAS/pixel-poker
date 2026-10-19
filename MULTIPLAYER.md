# PIXEL HOLD'EM — Multiplayer Contract (binding for all multiplayer builders)

Peer-to-peer No-Limit Hold'em for friends. **PLAY CHIPS ONLY** — no real money, wallets, crypto, deposits,
payouts in currency, or anything purchasable, ever. "Points" in tournaments are bragging rights only.

- Transport: WebRTC data channels via **PeerJS 1.5.4**, signaling on the free PeerJS cloud server.
- Authority: the **host's browser** runs the real `PP.Engine`. Clients are renderers + input devices.
- Hosting: static, GitHub Pages `https://lvxcas.github.io/pixel-poker/`. Must still run from `file://`.
- Everything in CONTRACT.md still holds: classic IIFE scripts on `globalThis.PP`, no build step, no ES modules,
  logic modules DOM-free and testable in the `tests/run.js` vm harness.

---------------------------------------------------------------------------------------------------------

## 0. Ownership, concurrency rule, file map

**Do NOT edit** (a readability workflow owns them right now): `css/style.css`, `css/tutorial.css`, `js/ui.js`,
`js/art.js`, `js/main.js`, `js/tutorial.js`, `index.html`. Integration into those happens later (section 9).

| Builder | Creates / edits | Tests |
|---|---|---|
| **B1 — Net + Room** | `js/net.js`, `js/remote-engine.js`, `js/room.js`; edits `tests/run.js` (ONLY B1 touches it) | `tests/net.test.js`, `tests/remote-engine.test.js`, `tests/room.test.js` |
| **B2 — Tournament + Engine API** | `js/tournament.js`; **additive** edits to `js/engine.js` (section 6.1 only) | `tests/tournament.test.js`, `tests/engine-mp.test.js` |
| **B3 — Lobby UI** | `js/lobby.js`, `css/multiplayer.css`, `mp-dev.html` (standalone dev/QA page) | browser QA via `mp-dev.html` (+ pure helpers tested in `tests/lobby.test.js` if any are DOM-free) |

Dependencies between builders are by THIS document only. Code against the interfaces here; guard optional
deps (`if (PP.Tournament) …`). Do not change an interface here without updating this file.

`tests/run.js` change (B1, once, all names at once — missing files are already skipped by the harness):
```js
const LOGIC_MODULES = ['cards.js', 'evaluator.js', 'equity.js', 'engine.js', 'bots.js', 'coach.js',
  'tournament.js', 'net.js', 'remote-engine.js', 'room.js'];
```
The vm sandbox has `setTimeout/clearTimeout/setImmediate/queueMicrotask/crypto/performance` but **no
`setInterval`, `document`, `window`, `localStorage`**. Modules must not need them at load time or in tests:
use `setTimeout` chains and the injectable clock (section 2.6). `net.js`, `remote-engine.js`, `room.js`,
`tournament.js` are DOM-free; only `lobby.js` touches the DOM.

Script load order after integration:
`cards, evaluator, equity, engine, bots, coach, tournament, net, remote-engine, room, art, ui, main, tutorial, lobby`.
PeerJS is NOT a script tag: `PP.Net` lazy-loads it on first online use, so single-player stays fully offline.

---------------------------------------------------------------------------------------------------------

## 1. What main.js / ui.js actually use from PP.Engine (the surface RemoteEngine must mirror)

Audited from `js/main.js` (ui.js never touches the engine; it only receives views/ids):

| Member | Used by main.js for | RemoteEngine must |
|---|---|---|
| `new PP.Engine({...})` | createGame / createCustomGame | n/a (Room builds it) |
| `engine.actionProvider = (player, view, legal) => Promise<action>` | hero → `UI.requestHumanAction`, bots → `bot.decide` | call it when host sends `act`; send result back |
| `engine.on(name, fn)` for `handStart, blinds, deal, turn, action, street, showdown, potAwarded` | all table animation; listeners call `viewOf(g)` = `engine.publicView(HERO_ID)` **inside** the listener | emit same names + payload shapes, awaiting listeners in order; `publicView()` must return the view that belongs to the event being dispatched |
| `engine.publicView(HERO_ID)` | every render | return latest snapshot (already per-recipient) |
| `engine.playHand()` | single-player game loop | provided for tests/convenience; **net games do not call it from main.js** — the HostRoom drives hands |
| `engine.isGameOver()` | after each hand | mirror (from host `end` / hero eliminated) |
| `engine.addChips(id, n)` | rebuy | return `false` (host-only); use `room.requestRebuy()` |
| `engine.players` → `.map(p => ({id, name, seat, stack}))` | `UI.buildTable` | array derived from latest view players |
| `handEnd`, `gameOver` events | not bound by main.js today | emitted anyway (integration binds `handEnd`) |

Hard-coded assumptions in main.js the design works around:
1. `HERO_ID = 'hero'` is a constant. → **ID alias** (section 3.2): on the host, the host's seat id IS `'hero'`;
   on a client, RemoteEngine swaps the client's own wire id with `'hero'`, so `publicView('hero')` / `p.id === HERO_ID`
   just work.
2. `provideAction` routes `player.isHuman` to the hero UI. → HostRoom owns `engine.actionProvider` and only
   forwards the host seat and bot seats to main.js (`room.setLocalActionProvider`); remote seats never reach it.
3. `Engine.isGameOver()` ends the game when the first human busts. → additive engine option
   `endWhenHumanBusts: false` (section 6.1) used by HostRoom.
4. Engine awaits listeners. On the host, main.js listeners must only do **bounded** waits (animation pacing);
   **never await a modal inside an engine listener in a net game** — it would freeze every player.
5. `handEnd.record` contains ALL hole cards. → HostRoom sanitizes per recipient (section 4.3).

---------------------------------------------------------------------------------------------------------

## 2. PP.Net — transport (`js/net.js`, B1)

### 2.1 Constants & room codes
```js
PP.Net.VERSION          = 1;
PP.Net.CODE_ALPHABET    = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars: no I L O 0 1
PP.Net.CODE_LENGTH      = 5;
PP.Net.PEER_PREFIX      = 'pxhe-';
PP.Net.PEERJS_URL       = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
PP.Net.PEERJS_SRI       = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR'; // verified 2026-10-14
PP.Net.INVITE_BASE      = 'https://lvxcas.github.io/pixel-poker/';
PP.Net.MAX_INBOUND_HOST   = 2048;    // bytes of JSON a host accepts from a client message
PP.Net.MAX_INBOUND_CLIENT = 65536;   // bytes of JSON a client accepts from the host
PP.Net.PING_MS = 5000; PP.Net.AWAY_MS = 12000; PP.Net.DROP_MS = 30000;
PP.Net.OPEN_TIMEOUT_MS = 10000;      // signaling server must answer within this
PP.Net.CONNECT_TIMEOUT_MS = 15000;   // data channel must open within this (else network-blocked)
PP.Net.RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000];

PP.Net.makeCode(rng = PP.Cards.rng) -> 'K7QXM'
PP.Net.normalizeCode(input) -> 'K7QXM' | null    // trim, uppercase, strip spaces/dashes; null unless 5 chars all in alphabet
PP.Net.peerIdFor(code) -> 'pxhe-K7QXM'
PP.Net.inviteUrl(code, location?) -> string
   // http(s) origin that is not localhost/127.0.0.1 -> location.origin + location.pathname + '?room=' + code
   // otherwise (file://, localhost)                 -> INVITE_BASE + '?room=' + code
PP.Net.codeFromLocation(location) -> code | null  // reads ?room=, normalizeCode
```

### 2.2 Errors
All rejections / `onError` payloads are `NetError`: `{ name: 'NetError', code, message }` (an `Error` with `.code`).
`PP.Net.ERR` = frozen map of codes:
`'room-not-found'` (peer-unavailable), `'room-taken'` (internal: unavailable-id after retries),
`'service-unreachable'` (PeerJS script failed to load, signaling timeout, server-error/socket-error/network),
`'network-blocked'` (signaling OK but data channel never opened — ICE/NAT/firewall),
`'browser-unsupported'` (browser-incompatible / no RTCPeerConnection), `'host-left'` (connection lost and reconnect
failed or host sent `closed`), `'timeout'`, `'closed'`, `'relay-offline'` (transport `'relay'` chosen but no relay is
configured or reachable — "try auto or direct").

### 2.3 Endpoints (identical shape for PeerJS and Loopback)
```js
PP.Net.createHost({ code?, hub?, clock?, rng?, transport? }) -> Promise<HostEndpoint>
   // transport (js/net-relay.js, PP.Net.TRANSPORTS): 'auto' (default: PeerJS + relay registration / relay-only
   // fallback), 'direct' (PeerJS only, never registers on the relay), 'relay' (relay-only host, no PeerJS).
   // Same option on PP.Net.join: 'auto' = PeerJS then relay fallback, 'direct' = never falls back,
   // 'relay' = straight onto the relay (no PeerJS wait). The Lobby persists the player's pick
   // (`transport` in 'pixelholdem.mp.v1') and passes it here / through Room.joinRoom({ transport }).
  // hub given -> Loopback; else PeerJS. On 'unavailable-id' regenerate the code (max 5 tries) -> else 'room-taken'.
HostEndpoint = {
  role: 'host', code,
  send(peerId, msg) -> boolean,            // false if unknown/closed peer
  broadcast(msg, exceptPeerId?) -> void,
  peers() -> string[],                     // currently connected peer ids
  kick(peerId, reason) -> void,            // sends {t:'kicked', reason} then closes that connection
  onPeerJoin(fn(peerId)) -> unsubscribe,   // data channel open
  onPeerLeave(fn(peerId, reason)) -> unsubscribe, // reason: 'closed' | 'timeout' | 'kicked' | 'error'
  onPeerStatus(fn(peerId, 'online'|'away')) -> unsubscribe,  // heartbeat-derived
  onMessage(fn(msg, peerId)) -> unsubscribe,
  onError(fn(NetError)) -> unsubscribe,
  close() -> void,                          // closes all conns + peer; idempotent
}
PP.Net.join(code, { hub?, clock? }) -> Promise<ClientEndpoint>   // resolves when the data channel is open
ClientEndpoint = {
  role: 'client', code, peerId,
  send(msg) -> boolean,
  onMessage(fn(msg)) -> unsubscribe,
  onStatus(fn('open'|'reconnecting'|'closed')) -> unsubscribe,
  onError(fn(NetError)) -> unsubscribe,
  close() -> void,
}
```
Rules:
- Messages are plain JSON-serializable objects with a string `t`. PeerJS: `peer.connect(id, { reliable: true,
  serialization: 'json' })`. Before handing a message to `onMessage`, Net checks `typeof msg === 'object'`,
  `typeof msg.t === 'string'`, and `JSON.stringify(msg).length <= MAX_INBOUND_*`; anything else is dropped and
  counted (`endpoint.stats.dropped`). Never `eval`, never `new Function`.
- Types starting with `_` are reserved for Net and never reach `onMessage`: `{t:'_ping', n}` / `{t:'_pong', n}`.
- Heartbeat: both sides send `_ping` every `PING_MS` (setTimeout chain). Host: no traffic from a peer for `AWAY_MS`
  → `onPeerStatus(peer,'away')`; any traffic → `'online'`; silent `DROP_MS` → close conn, `onPeerLeave(peer,'timeout')`.
  Client: silent `DROP_MS` → treat as connection lost (reconnect flow).
- Client reconnect: if the conn closes without `close()` being called, emit `onStatus('reconnecting')`, retry
  `RECONNECT_DELAYS` (each attempt = new `peer.connect` to the same host id, recreating the Peer if it was destroyed).
  Success → `onStatus('open')` (the app re-sends `hello` with its token). All fail → `onError(host-left)` then
  `onStatus('closed')`. A `{t:'closed'}` app message from the host is passed through to the app (the app then calls `close()`).
- Host signaling drop (`peer.on('disconnected')`): call `peer.reconnect()`; existing data channels keep working.
- Host: a second connection from the same `peerId` replaces the first (old one closed silently, no leave event).
- PeerJS lazy load: `PP.Net.loadPeerJS() -> Promise<PeerCtor>` injects one `<script src=PEERJS_URL integrity=PEERJS_SRI
  crossorigin="anonymous">`, memoized; rejects `service-unreachable` on error or 15 s timeout; if `globalThis.Peer`
  already exists use it. Use the default PeerJS ICE config (it already ships Google STUN + PeerJS TURN
  `eu-0/us-0.turn.peerjs.com:3478`); allow override via `PP.Net.config.iceServers` (null = default).
- `peer = new Peer(id?, { debug: 0, config? })`. Map PeerJS `err.type`: `peer-unavailable`→room-not-found,
  `unavailable-id`→retry/room-taken, `browser-incompatible`→browser-unsupported,
  `network|server-error|socket-error|socket-closed`→service-unreachable, `webrtc`→network-blocked.

### 2.4 Loopback transport (Node tests, also usable offline in the browser for demos)
```js
const hub = PP.Net.Loopback.createHub({ latencyMs = 0 });
hub.drop(peerId)          // simulate a client's connection dying (host gets onPeerLeave 'closed'; client starts reconnect)
hub.dropHost(code)        // simulate host tab closing
hub.flush() -> Promise    // resolves when no deliveries are pending (loop setImmediate until queue empty)
hub.log                   // array of {from, to, msg} for every delivered app message (tests scan it)
```
Delivery is async (queued, delivered via `setImmediate`/microtask, or `clock.setTimeout(latencyMs)` if > 0), in
order per connection, and **JSON round-tripped** (`JSON.parse(JSON.stringify(msg))`) so tests catch
non-serializable payloads and shared-mutation bugs. Size caps and `_ping` handling behave exactly as with PeerJS.
Client peer ids in loopback: `'peer-1'`, `'peer-2'`, ….  `join` to an unknown code rejects `room-not-found`.

### 2.4b Relay backends (`js/net-relay.js` picks, `js/net-firebase.js` provides one)
The "relay" role (transport `'relay'`, plus the `'auto'` fallback / host registration alongside PeerJS) has two
backends. If `PP.Net.config.firebase` (or `options.firebase`) holds a valid web config, it runs on **Firebase
Realtime Database** (`PP.Net.Firebase`): SDK 10.12.2 lazy-loaded via dynamic `import()` from gstatic only when
needed, anonymous auth (session persistence, one uid per tab), ids `'f-' + uid`, data layout documented at the top
of `js/net-firebase.js`, locked down by `database.rules.json` (setup: `relay/FIREBASE.md`). Otherwise it is the
WebSocket relay (`relay/server.js` via `relay.json`). `'direct'` touches neither. SDK load / sign-in failure →
`relay-offline`. Tests: `tests/net-firebase.test.js` against `tests/firebase-fake.js` (in-memory RTDB + a JS mirror
of the rules). Localhost-only `?fakeFirebase=1` runs the page on that fake (shared across tabs via localStorage).

### 2.5 Joining from an invite link
`?room=CODE` in the URL → Lobby opens the Join screen prefilled. The param is kept (a refresh = rejoin attempt).

### 2.6 Clock injection
Every timer in net/room/remote-engine goes through `clock = { now(), setTimeout(fn, ms), clearTimeout(h) }`
(default: `Date.now` + global timers). `PP.Net.createManualClock()` returns
`{ now, setTimeout, clearTimeout, advance(ms) -> Promise }` — `advance` runs due timers in time order and awaits a
`setImmediate` between them so promise chains settle. Tests use it for heartbeat and turn-timer cases.

---------------------------------------------------------------------------------------------------------

## 3. PP.RemoteEngine — client-side engine mirror (`js/remote-engine.js`, B1)

### 3.1 API
```js
const re = new PP.RemoteEngine({ selfId /* wire seat id or null for spectator */, clock?,
  players? /* TableInit.players (wire ids) */, mode?, send?(msg), onTurnCancelled?({reason, seq}) });
re.actionProvider = async (player, view, legal) => action;      // set by main.js integration
   // a turn (act / sync.pendingAct) that arrives before it is set WAITS for it (late join / rejoin: `sync` can
   // land before the table is built); a turn cancelled meanwhile never reaches it. Never auto-acts.
re.on(name, fn) -> unsubscribe     // same as Engine.on; listeners awaited in order; errors caught + console.error
re.publicView(/* id ignored */) -> View   // latest snapshot, ids already aliased; frozen
re.getLegal(id) -> Legal           // pending act's legal if id === 'hero' and a turn is pending, else NO_LEGAL
re.players -> [{ id, name, seat, stack, bet, totalBet, folded, allIn, out, isHuman, lastAction, hole }]
   // from the latest view; before the first event, from opts.players (so main.js can build the table on `start`)
re.handNumber, re.smallBlind, re.bigBlind, re.dealerSeat, re.inHand   // getters from latest view
re.isGameOver() -> boolean         // true after `end`, or hero `out` in a tournament
re.playHand() -> Promise<record|null>  // resolves on the next handEnd (null on game end); never deals
re.addChips() -> false
re.toLocalId(wireId), re.toWireId(localId)
re.receive(msg)                    // ClientRoom feeds host messages of type ev / act / actCancel / sync / end
re.dispose()
```
`NO_LEGAL` shape is identical to the engine's.

### 3.2 ID alias (the trick that keeps main.js unchanged)
Wire ids are host engine ids: host = `'hero'`, remote humans `'h1'..'h8'`, bots `'b1'..'b8'`.
On a client with `selfId = 'h2'`: `toLocalId` swaps `'h2' ⇄ 'hero'` (so the host shows up locally as `'h2'`);
every other id passes through. Spectators (`selfId = null`) have no swap. Applied by one deep walk over every
inbound payload/view/record: values of keys `id, playerId, winnerId, toActId, seatId` and every element of
`eligible` arrays. Outbound needs no mapping (actions carry no ids). Lobby/chat UI uses ClientRoom's mapped ids.

### 3.3 Event processing
- A single serial queue. `ev` → set `currentView = alias(msg.view)`, then `await emit(msg.name, alias(msg.payload))`.
  So when main.js's listener calls `publicView('hero')`, it gets the view captured on the host at that event.
- `act` messages are queued **in order** with events (the host is blocked waiting anyway). Processing: set
  `currentView = alias(msg.view)`, `pending = {seq, legal}`, call `actionProvider(alias(msg.player), view, legal)`;
  when it resolves, if `pending.seq` still equals `msg.seq`, `ClientRoom` sends `{t:'action', seq, action}`;
  otherwise discard. Provider throws → send `{type: legal.canCheck ? 'check' : 'fold'}`.
- `actCancel {seq}` is handled **immediately** (bypasses the queue): if it matches the pending turn → clear
  pending, call `opts.onTurnCancelled({reason})` (ClientRoom re-emits `turnCancelled`), discard the late result;
  if that act is still queued → remove it from the queue.
- `sync {view, pendingAct?}` (rejoin / late join) → replace `currentView`, emit synthetic event `'sync' {view}`,
  then process `pendingAct` like an `act`.
- `end` → `isGameOver()` true, emit `'gameOver' {winnerId}`, resolve outstanding `playHand()` with null.
- Queue never deadlocks: an exception in a listener is logged and processing continues.

---------------------------------------------------------------------------------------------------------

## 4. Message protocol v1 (`PP.Room.PROTOCOL = 1`)

Every app message: `{ v: 1, t: '<type>', ...fields }` (Net adds nothing; `v` is only validated on `hello`).
Ids in host→client messages are wire ids (RemoteEngine/ClientRoom alias them).

### 4.1 Client → Host  (host validates EVERY field; anything invalid is dropped and counts a strike)
| t | fields | validation / effect |
|---|---|---|
| `hello` | `v:1, name:string, avatar:string, token?:string` | must be the first message, within 10 s of join (else kick `'no-hello'`). `v !== 1` → `reject version-mismatch`. name → `sanitizeName` (4.4); avatar `/^[a-z0-9-]{1,24}$/` else `'a0'`; token `/^[0-9a-f]{32}$/`. Token matching a seat → reclaim seat; otherwise new seat (lobby, unlocked, free seat) or spectator (playing / full; max 8 spectators else `reject room-full`). |
| `action` | `seq:int, action:{type, amount?}` | type ∈ `fold check call bet raise allin`; amount finite ≥ 0 if present. Accepted only if the sender owns `pending.seatId` and `seq === pending.seq`. Engine `normalizeAction` then clamps legality. |
| `chat` | `text:string` | raw length ≤ 500 else drop; `sanitizeChat` → ≤ 140 chars, non-empty. Rate: 5 per 10 s per peer (token bucket). Host rebroadcasts with server-side sender identity. |
| `emote` | `id:string` | `id ∈ EMOTES`; rate 1 per 2 s. |
| `sitOut` | `on:boolean` | toggles seat `sittingOut` (on → auto check/fold instantly each turn; off → normal). |
| `rebuy` | — | cash mode + `settings.rebuys` + seat stack 0 → queued, applied before the next hand via `engine.addChips(seatId, startingStack)`. |
| `leave` | — | seat → `offline` (keeps chips; disconnect policy applies); spectator removed. |
Global: > 20 messages/second from one peer → excess dropped; 50 strikes → `kick(peer, 'spam')`.

### 4.2 Host → Client
| t | fields | when |
|---|---|---|
| `welcome` | `you:{seatId|null, role:'player'|'spectator', token}`, `room: LobbyState` | after valid hello |
| `reject` | `code:'room-full'|'version-mismatch'|'locked'|'kicked', message` | then host closes conn |
| `lobby` | `room: LobbyState` | any lobby change (phase `lobby`) |
| `start` | `table: TableInit` | game starts (also sent to late joiners before `sync`) |
| `ev` | `n:int, name, payload, view` | every engine event, per recipient (4.3) |
| `act` | `seq:int, player, view, legal, timeMs:int` | it is this client's turn (`timeMs` 0 = no timer) |
| `actCancel` | `seq, reason:'timeout'|'disconnect'|'sitout'` | host auto-acted for them |
| `timer` | `playerId, ms` | broadcast when a human's turn timer starts (for the seat countdown bar) |
| `seats` | `seats: Seat[]` | presence/sit-out/stack changes in game |
| `chat` | `from:{seatId|null, name}, text, ts` | |
| `emote` | `from:{seatId|null, name}, id` | |
| `tourney` | `state: TournamentState` | at start, on level change, after every hand in SNG |
| `sync` | `view, seats, tourney|null, pendingAct|null` | after `welcome` for a rejoin / late join in phase `playing` |
| `end` | `results: Results` | game over or host ended |
| `closed` | `reason:'host-ended'|'host-left'` | host leaves / closes room |
| `kicked` | `reason` | sent by Net `kick` |

Shapes:
```js
LobbyState = { v:1, code, phase:'lobby'|'playing'|'ended', hostName, settings: Settings,
               seats: Seat[], spectators: [{ name }] }
Seat       = { id:'hero'|'h1'..|'b1'.., kind:'host'|'human'|'bot', name, avatar, rating /*bots 1..5, humans 0*/,
               conn:'online'|'away'|'offline'|'bot', sittingOut:boolean, stack:number|null, place:number|null }
Settings   = { mode:'cash'|'sng', maxSeats:2..9 (6), startingStack, sb, bb,         // cash: from the option lists
               sngPreset:'turbo'|'regular'|'slow' ('regular'), antes:false,
               turnSeconds:0|15|30|60 (30), coachAllowed:true, disconnectPolicy:'autofold'|'bot' ('autofold'),
               rebuys:true /*cash only*/, locked:false }
   // option lists (sanitizeSettings clamps to them): cash stacks [500,1000,2000,5000] (1000),
   // cash blinds [[5,10],[10,20],[25,50],[50,100]] ([10,20]); sng stacks [1000,1500,3000,5000] (1500), sng sb/bb from level 1.
TableInit  = { mode, players:[{id,name,seat,stack}], meta:{ [id]: {rating, title, style, kind, avatar} },
               sb, bb, ante, coachAllowed, turnSeconds, yourSeatId: string|null }
Results    = { reason:'complete'|'host-ended'|'last-player', mode,
               standings:[{ id, name, place, stack, points|null }] /* sorted by place */ }
EMOTES     = ['nh','gg','wow','lol','ouch','think','fire','ty']
  // labels: nice hand, gg, wow, lol, ouch, hmm..., on fire, ty
```

### 4.3 Hidden-information rules (HostRoom MUST enforce; tests MUST prove)
- Every `ev.view`, `act.view`, `sync.view` is `engine.publicView(recipientSeatId)` (spectators: `publicView(null)`)
  computed **at emit time**, per recipient. Never broadcast one shared view.
- `act.player` = `view.players.find(p => p.id === seatId)`, never the engine's internal player object.
- `handEnd` payload: `record` deep-copied, then for every `record.players[i]` whose id is neither the recipient nor
  in `record.reveals`: `hole = []`. `reveals` are public (showdown). Bot reasoning is never sent.
- `showdown`/`potAwarded` payloads are public as emitted by the engine. `deal` payload is `{}` (the view carries
  only the recipient's hole). `turn` payload's `legal` is public information.
- Host listener order: HostRoom registers its broadcast listeners in `start()` **before** main.js binds its UI
  listeners, so clients get each event before the host starts animating it.

### 4.4 Text sanitizers (`PP.Room.sanitizeName`, `PP.Room.sanitizeChat`, pure, exported)
- Strip C0/C1 control chars, zero-width & bidi controls (`​-‏‪-‮⁦-⁩﻿`),
  collapse whitespace, trim.
- Name: keep `[\p{L}\p{N} ._!?'-]`, max 12 chars; empty → `'player'`; duplicates in the room get `' 2'`, `' 3'`.
- Chat: max 140 chars after cleanup; empty → dropped.
- Clients render ALL peer text with `textContent` (`UI.el(tag, cls, text)` already does). No `innerHTML`, no
  attribute injection, no URLs auto-linked.

---------------------------------------------------------------------------------------------------------

## 5. PP.Room — HostRoom & ClientRoom (`js/room.js`, B1)

### 5.1 HostRoom
```js
const room = new PP.Room.HostRoom({
  endpoint,            // HostEndpoint, or null = OFFLINE room (solo vs bots, e.g. offline Sit-n-Go)
  hostName, hostAvatar, settings?, clock?, rng?,   // rng -> Engine + seat shuffle (tests: PP.Cards.seededRng)
  handGapMs? /* default HAND_GAP_MS */, customStacks? /* host code only: any stack 20..1e6 */,
});
room.code                       // endpoint.code or null
room.phase                      // 'lobby' | 'playing' | 'ended'
room.lobbyState() -> LobbyState
room.updateSettings(patch)      // lobby only; sanitizeSettings; broadcasts `lobby`
room.addBot(rating=3, name?) -> seatId | null     // null when full
room.setBotRating(seatId, r) ; room.removeSeat(seatId)  // bots or humans (human → kick 'removed')
room.kick(seatId, reason)
room.start() -> TableSpec       // builds Engine (+ Tournament in sng), registers broadcast listeners,
                                // sends `start` (+ `tourney`), phase 'playing'. Needs >= 2 seats.
room.run() -> Promise<Results>  // the hand loop (5.3); resolves at game end
room.setLocalActionProvider(fn(player, view, legal) -> Promise<action>)  // host seat + bots (main.js)
room.dealNow()                  // skip the between-hands gap
room.requestRebuy(seatId='hero') ; room.setSittingOut(seatId, on)
room.sendChat(text) ; room.sendEmote(id)                 // as the host
room.endGame() -> Results       // host ends: broadcast `end` (reason host-ended), phase 'ended'
room.backToLobby()              // phase 'lobby', same seats/humans, broadcast `lobby` ("run it back")
room.close()                    // broadcast `closed {reason:'host-ended'}`, endpoint.close()
room.on(evt, fn) -> unsubscribe
   // evts: 'lobby' (LobbyState), 'seats' (Seat[]), 'chat', 'emote', 'tourney' (TournamentState),
   //       'timer' ({playerId, ms}), 'turnCancelled' ({playerId, reason}), 'eliminated' ({id,name,place,points}),
   //       'handGap' ({ms}), 'end' (Results), 'error' (NetError), 'log' (string)
room.engine, room.bots /* {seatId: bot} */, room.tournament /* or null */
TableSpec = { engine, heroId:'hero', players, meta, names, sb, bb, bots, isHost:true, room, coachAllowed, mode }
```
Seats: host is always seat id `'hero'` (kind `host`). Humans get the lowest free `'h1'..'h8'`, bots `'b1'..'b8'`.
Seat order at `start()`: lobby order, shuffled with `rng` (host still renders at the bottom; ui.js rotates).
Engine: `new PP.Engine({ players, smallBlind, bigBlind, ante, rng, endWhenHumanBusts: false })`, humans
`isHuman: true`, bots `isHuman: false`. Bots: `PP.Bots.create({ rating, id, name })`; names from
`PP.Bots.randomName(used)`.

### 5.2 Action routing (`engine.actionProvider` is owned by HostRoom — main.js must not overwrite it)
```
seat is remote human:
   sittingOut or conn offline  -> policy: 'autofold' => {check|fold} after 600 ms; 'bot' => takeover bot decides
   else -> pending = {seq: ++seq, seatId}; send `act` {seq, player, view, legal, timeMs}; broadcast `timer`
           race(action from that seat with that seq, turn timer, disconnect)
           timer/disconnect -> resolve {check|fold}, send `actCancel`, emit 'turnCancelled'
           2 consecutive timeouts -> sittingOut = true, broadcast `seats`
host seat ('hero') or bot:
   localProvider set -> race(localProvider(player, view, legal), turn timer [host seat only])
                        host timeout -> resolve check/fold, emit 'turnCancelled' {playerId:'hero'} (main cancels UI)
   no localProvider (tests / headless) -> bots: bot.decide(view, legal, me); host: check/fold
```
`takeover` bot for policy `'bot'`: one `PP.Bots.create({ rating: 3, id: seatId })` per seat, created lazily.
A decided/late action for a stale seq is ignored. The provider never throws (engine coerces null anyway).

### 5.3 Hand loop (`run()`)
```
loop while phase === 'playing':
   tournament?.beforeHand(engine)  -> if changed: broadcast `tourney`, emit 'tourney'
   apply queued rebuys (cash)       -> engine.addChips; broadcast `seats`
   record = await engine.playHand() ; null -> break
   tournament?.afterHand(engine, record) -> for each eliminated: emit/broadcast; broadcast `tourney`
   broadcast `seats` (stacks)
   over? sng: tournament.isComplete(); cash: <= 1 player with chips (and no pending rebuys) -> finish('complete')
   emit 'handGap' {ms: HAND_GAP_MS=4000}; wait gap or dealNow()
finish: results (sng: tournament.results(); cash: standings by stack), broadcast `end`, emit 'end', phase 'ended'
```

### 5.4 Presence, rejoin, spectators
- Token: 32 hex chars from `crypto.getRandomValues` (16 bytes), issued in `welcome`, stored per seat.
- `onPeerLeave` → seat `conn:'offline'` (+ pending act resolved per 5.2), `seats` broadcast; spectator removed.
- `onPeerStatus` → `conn:'away'|'online'`.
- Rejoin: `hello` with matching token → re-bind seat to the new peerId (old peer, if still open, is kicked
  `'replaced'`), `conn:'online'`, `sittingOut:false`; send `welcome`, then if playing `start` + `sync`
  (`pendingAct` if it is their turn right now: same seq, remaining time).
- New peers during `playing` (or room locked / full) → spectators (or `reject locked` if locked).
- Offline room (`endpoint: null`): all send/broadcast calls are no-ops; everything else identical.

### 5.5 ClientRoom
```js
const client = await PP.Room.joinRoom({ code, name, avatar, token?, hub?, clock?, transport? })  // Net.join + hello; resolves on welcome
   // rejects NetError (room-not-found, network-blocked, service-unreachable, ...) or reject codes as NetError
client.selfId (wire seat id or null) ; client.role ; client.token ; client.lobby (LobbyState)
client.engine        // RemoteEngine, created on `start` (re-created on each new game)
client.tableSpec() -> { engine, heroId: selfId ? 'hero' : null, players, meta, names, sb, bb,
                        bots:{}, isHost:false, room: client, coachAllowed, mode }   // ids aliased
client.sendChat(text) ; client.sendEmote(id) ; client.setSittingOut(on) ; client.requestRebuy() ; client.leave()
client.on(evt, fn) -> unsubscribe
  // 'welcome','lobby','start' (tableSpec),'seats','chat','emote','tourney','timer','turnCancelled',
  // 'eliminated','end','closed','error','status' ('open'|'reconnecting'|'closed')
```
On `status: 'open'` after a reconnect, ClientRoom re-sends `hello` with its token automatically.
Persistence of `{code, token, name, avatar, ts}` is the Lobby's job (storage), not room.js.
All ids emitted by ClientRoom events are local (aliased) ids, plus seats carry `isYou`.

---------------------------------------------------------------------------------------------------------

## 6. PP.Tournament — single-table Sit-n-Go (`js/tournament.js`, B2)

### 6.1 Additive engine API (B2 edits `js/engine.js`; nothing else in it changes)
```js
// constructor option (default true = current behaviour):
new PP.Engine({ ..., endWhenHumanBusts: false })   // isGameOver() then ignores the "hero busted" rule
eng.setBlinds(smallBlind, bigBlind, ante = eng.ante) -> boolean
  // false and no change while eng.inHand; else sb = max(1, toChips(sb)); bb = max(sb, toChips(bb) || 2*sb);
  // ante = toChips(ante); applies from the next hand's postForcedBets; returns true.
```
Tests in `tests/engine-mp.test.js`: setBlinds takes effect next hand (blinds event amounts, view.bigBlind);
rejected mid-hand (call it from inside a `turn` listener → false); ante posts; `endWhenHumanBusts:false` keeps
the game going after the human busts; default unchanged. Existing engine tests must stay green.

### 6.2 Module API
```js
PP.Tournament.PRESETS = { turbo:{ handsPerLevel: 6, label:'turbo' }, regular:{ handsPerLevel: 10, label:'regular' },
                          slow:{ handsPerLevel: 15, label:'slow' } }
PP.Tournament.BASE_SB = [10,15,25,50,75,100,150,200,300,400,500,700,1000,1500,2000,3000,4000,5000] // for 1500 chips
PP.Tournament.niceRound(x) -> int   // <10: round, min 1; <50: nearest 5; <200: nearest 5; <1000: nearest 25; else nearest 100
PP.Tournament.levels({ startingStack = 1500, preset = 'regular', antes = false }) -> Level[] (frozen)
   // Level = { level (1-based), sb, bb, ante, handsPerLevel }; sb = niceRound(BASE_SB[i] * startingStack / 1500),
   // strictly increasing (bump duplicates to the next nice value), bb = 2*sb,
   // ante = antes && level >= 3 ? max(1, round(bb / 10)) : 0. After the last level, the last level repeats.
PP.Tournament.payouts(entrants) -> number[]   // points pool 100: 2-3 → [100]; 4-5 → [65,35]; 6-9 → [50,30,20]
PP.Tournament.create({ players:[{id,name}], startingStack, preset, antes }) -> SitNGo

SitNGo:
  t.beforeHand(engine) -> { level, sb, bb, ante, changed }   // level = floor(handsPlayed / handsPerLevel);
                                                            // calls engine.setBlinds when changed (and on first hand)
  t.afterHand(engine, record) -> { eliminated:[{id,name,place,points}], complete:boolean }
       // handsPlayed++; a player is eliminated when their engine stack is 0 after the hand and they were alive before.
       // Several in one hand: larger start-of-hand stack (record.players[].startStack) finishes higher;
       // equal → the one seated closer clockwise to the left of the button finishes higher.
       // place = number of players alive before this elimination batch, counting down.
  t.isComplete() -> boolean     // <= 1 player with chips; winner gets place 1
  t.state() -> TournamentState  // frozen, JSON-safe
  t.results() -> [{ id, name, place, stack, points }]  // sorted by place; points from payouts(entrants), 0 if unpaid
TournamentState = { preset, level, sb, bb, ante, handsPlayed, handsPerLevel, handsToNext,
                    next: { sb, bb, ante } | null, entrants, alive,
                    standings: [{ id, name, stack, place|null, points|null }],   // alive by stack desc, then busted by place
                    eliminated: [{ id, name, place, points }], payouts: number[], complete }
```
Pure and DOM-free; works for multiplayer (inside HostRoom) and offline (HostRoom with `endpoint: null`).

---------------------------------------------------------------------------------------------------------

## 7. PP.Lobby — screens & overlays (`js/lobby.js`, `css/multiplayer.css`, B3)

### 7.1 Mount API (what main.js will wire later)
```js
const lobby = PP.Lobby.mount(rootEl /* #mp-root inside <section id="screen-mp"> */, {
  UI: PP.UI, Net: PP.Net, Room: PP.Room, Tournament: PP.Tournament, Bots: PP.Bots,
  overlayRoot,                 // #mp-overlay inside #screen-table
  showScreen(name),            // 'mp' | 'title' | 'table'  (PP.UI.showScreen)
  startNetGame(tableSpec),     // PP.App.startNetGame — builds the table for host/client/spectator
  endNetGame(),                // PP.App.endNetGame — tear down the table game (no confirm)
  storage,                     // globalThis.localStorage or null; every access in try/catch
  location,                    // globalThis.location
});
lobby.openHub(); lobby.openJoin(code?); lobby.openHost({ mode: 'cash'|'sng' }); lobby.openOfflineSng();
lobby.handleInviteLink() -> boolean   // ?room=CODE → openJoin(code), returns true if handled
lobby.isInGame() -> boolean ; lobby.leave() -> Promise   // confirm handled by main; leave = client.leave()/room.close()
lobby.destroy()
```
Storage key `'pixelholdem.mp.v1'`: `{ profile:{name, avatar}, rejoin:{code, token, name, avatar, ts} | null,
history:[Results + {code, ts}] (last 20) }`. Rejoin offered automatically when `rejoin.code` matches and
`ts` < 6 h old.

### 7.2 Screens (inside rootEl, all built with `UI.el/UI.button/UI.stars/UI.avatar/UI.openModal`)
1. **Hub** — title "play with friends" (dot-matrix strip), three paper cards: *host a table* (cash),
   *join with code*, *sit-n-go* (→ choose: with friends online / practice vs bots offline). Back → title.
   Small footnote: "play chips only — no real money, ever."
2. **Join** — code input (single `<input>` maxlength 5, uppercase display, letter-spaced, `autocapitalize=characters`,
   `inputmode=text`, validated with `Net.normalizeCode`), name input (maxlength 12), avatar picker
   (8 `UI.avatar(seed)` buttons, seeds `'a0'..'a7'` — avatar art seed = `name + '|' + seed` so it is stable),
   JOIN button. Live status line: `finding table… → connecting… → joined`.
3. **Host lobby** (host) / **Waiting lobby** (client, read-only):
   - Big room code in a `.dmd` panel at f4 (`.mp-code`, uppercase), buttons *copy invite link* (Net.inviteUrl) and
     *copy code*; `navigator.clipboard.writeText` in try/catch with a selectable fallback field.
   - Seat list (`.mp-panel`): avatar, name, kind tag (`host`/`player`/`bot`), connection dot + word
     (online/away/offline), stars for bots (interactive for host via `UI.stars(r, {interactive, onPick})`),
     remove ✕ (host). Row "add bot" + rating. Count "4 / 6 seats".
   - Settings (`.paper` card, host editable; clients see values): mode cash | sit-n-go; stack; blinds (cash) or
     speed turbo/regular/slow + antes (sng, show "level 1: 10/20 · up every 10 hands"); turn timer off/15/30/60;
     coach allowed on/off ("fair play: hides the coach for everyone"); disconnected players: auto-fold | bot plays;
     rebuys (cash); max seats; lock room.
   - Host: START (orange `btn-xl`, disabled < 2 seats). Client: "waiting for the host to deal…".
4. **Error states** — one `.mp-error` panel with title, plain explanation, actions:
   room-not-found ("no table with code K7QXM. codes are 5 characters, no O/I/L/0/1 — check with your host."),
   host-left ("the host closed the table. the game lives in the host's browser, so it can't continue without them."),
   network-blocked ("found the table, but your network blocks direct connections — common on school/work/public
   wi-fi. try a phone hotspot or home wi-fi."), service-unreachable ("can't reach the matchmaking server. check
   your connection — single-player still works offline."), room-full, locked, version-mismatch ("you and the host
   are on different versions — both refresh."), kicked, browser-unsupported. Actions: TRY AGAIN / BACK.

### 7.3 In-game overlay (inside `overlayRoot`, `position:absolute; inset:0; pointer-events:none`, children opt in)
- **Level bar** (sng): top-center `.dmd` strip: `LV 3  25/50  A5` + `NEXT 50/100 IN 4 HANDS`. Updates `#tb-blinds`
  text too (if that element exists).
- **Players panel** (toggle button bottom-left "players 5/6"): rows with conn dot + word, stack, sitting-out tag,
  place for busted. Host rows get *kick*.
- **Chat + emotes** (toggle "chat" with unread count): last 50 lines (`textContent` only), input maxlength 140,
  Enter sends, 8 emote buttons; emotes also float over the sender's seat via `UI.floatText(localId, label, 'emote')`.
- **Turn timer**: on `timer` → `UI.startTimer(playerId, ms)`.
- **Elimination toast**: "bit queen finishes 5th" (3 s, `aria-live=polite`).
- **Standings** (sng): in players panel ordered by `TournamentState.standings`; payouts shown.
- **Final podium**: `UI.openModal` wide: 1st/2nd/3rd pedestals with avatars, names, points; full standings below.
  Host: RUN IT BACK (room.backToLobby) / CLOSE ROOM; client: BACK TO LOBBY / LEAVE.
- **Host controls**: DEAL NOW during the gap (also bound to main's NEXT HAND button via integration), END GAME.
- **Client controls**: I'M BACK when sitting out; REBUY when busted in cash with rebuys on.
- **Connection banner**: `reconnecting…` (amber) while `status` is reconnecting; error panel on host-left.
  Host-side NetErrors (PeerJS signaling hiccups) are NOT fatal: open data channels keep working, so the Lobby only
  posts a system line in chat (or the lobby bar) and keeps the room running.

### 7.4 Visual + readability rules (binding — the user said the redesign is "too dark, hard to read")
Match "B Smoke & Felt" + C's dot-matrix scoreboard (`research/shotgun/b-hybrid/table.png`), reuse the tokens and
classes from `css/style.css` (`--room --felt --text --text-dim --chalk --slate --paper --ink --price --dmd-* --font
--u --f1/--f2/--f4`, `.slate .paper .dmd .dmd-text .btn .btn-orange .btn-sm .seg`), but **brighter**:
```css
.mp, .mp-overlay {          /* define in css/multiplayer.css; scoped, never on :root */
  --mp-panel: #22302a;      /* lifted slate */          --mp-panel-2: #2a3a33;
  --mp-text: #f6f1e2;       /* 12.2:1 on --mp-panel */
  --mp-dim:  #cfd6cb;       /*  9.3:1 */
  --mp-accent: #ffb26b;     /*  7.8:1 */   --mp-ok: #8fe39b; /* 8.9:1 */
  --mp-warn: #ffd36b;       /*  9.7:1 */   --mp-bad: #ff8c7a; /* 6.1:1 — status words, always with a label */
  --mp-ink: #1d130e;        /* on --paper 14.1:1 */     --mp-ink-dim: #4a3c2e; /* on --paper 8.2:1 */
}
```
- Body text ≥ 7:1, secondary ≥ 4.5:1 (all values above verified). Never use `--text-dim` on `--slate` (4.8:1)
  for body copy.
- **No chalk grain / dot mask on text below f2**: never apply `.chalk-text`, `--mask-chalk` or `.dmd-text`'s dot
  mask to f1 text; dot-matrix masked text only at f2/f4 (room code, level numbers). Small dmd text is plain
  `--dmd-on` on `--dmd-bg` (8.4:1).
- Min font size `max(var(--f1), 14px)` for inputs, chat, and lobby copy; room code ≥ 32px.
- Status is never color-only: conn dot + word; errors have a title.
- Phone width (friends open invite links on phones): lobby screens are a single column ≤ 520px with 16px side
  gutters, no horizontal scroll, tap targets ≥ 44px; overlay drawers become bottom sheets under 700px.
- Radius 0, stepped shadows, no gradients (style.css rules). Lowercase UI text (body transform) except room
  codes (`text-transform: uppercase`). Respect `prefers-reduced-motion` (`UI.reduced()`).
- Everything namespaced `.mp-*`; never restyle style.css selectors globally.

### 7.5 Dev / QA pages
- `multiplayer-preview.html` (built instead of `mp-dev.html`): lobby + overlay against mocked Net/Room, `?state=<name>`
  jumps to one of 32 states, `&shot=1` hides the panel. Not linked from the game.
- Real modules, real UI: `python3 tests/browser/integrate.py . <out-dir> --fake` applies section 9 to a COPY and loads
  `tests/browser/fake-net.js`; `<out-dir>/index.html?fake=1` then runs host/join/rejoin over an in-page Loopback hub.
  `node tests/browser/flow-host.js <out-dir>`, `flow-client.js <out-dir> [phone]`, `flow-offline.js <out-dir>` drive it
  headless (set `PLAYWRIGHT=/path/to/node_modules/playwright`) and save screenshots to `<out-dir>/qa-shots/`.

---------------------------------------------------------------------------------------------------------

## 8. Security & fairness notes
- Host is trusted (friends game): the host's browser holds the deck and every hole card. Documented in the hub
  footnote ("the host's browser deals").
- Clients never receive another player's hole cards before showdown reveal (4.3) — enforced per recipient and
  proven by tests that scan every loopback message.
- The coach uses only the player's own view, so it reveals nothing hidden; `coachAllowed: false` is an honor-system
  fairness switch (the client hides it). Bots never see hidden cards (existing contract).
- No `eval`, `new Function`, `innerHTML`, `insertAdjacentHTML`, or `document.write` with peer data anywhere in
  net/room/remote-engine/lobby. Peer text only via `textContent`. Names/chat sanitized on the host before rebroadcast;
  clients render what the host sends with `textContent` anyway (defense in depth).
- Message size caps (2 KB inbound at host, 64 KB at client), per-peer rate limits, strike-based kick, 10 s hello
  deadline, max 9 seats + 8 spectators, optional room lock, host kick.
- Tokens are random 128-bit, only used to reclaim a seat in the same room session; stored in localStorage.
- PeerJS loaded only from the pinned jsDelivr URL with SRI; no other third-party code.
- Play chips only. No payment, wallet, or crypto code paths; do not add "buy chips" UI.
- Host refresh/close ends the game (state lives in the host tab): HostRoom integration adds a `beforeunload`
  confirm while `phase === 'playing'`.

---------------------------------------------------------------------------------------------------------

## 9. Integration steps (after the readability workflow finishes — NOT by B1–B3)

Verified end to end on 2026-10-14: `tests/browser/integrate.py` is this section as code (exact anchors). It was
applied to a copy of the repo and all three browser flows passed with zero console errors (host: lobby → 2 joins +
bot → hands → chat → end → podium → run it back → close; client: join by code → SNG hands → connection drop →
reconnect banner → rejoin with start+sync → podium → host closes; offline practice SNG → leave). If an anchor moved,
keep the code and re-anchor. Running `python3 tests/browser/integrate.py . .` performs it in place (no `--fake`).

### 9.1 index.html
```html
<!-- in <head>, after css/tutorial.css -->
<link rel="stylesheet" href="css/multiplayer.css">

<!-- title menu, after nav-play -->
<button type="button" class="menu-item" id="nav-multi"><span class="btn-label">play friends</span></button>

<!-- new screen, before the TABLE section -->
<section class="screen" id="screen-mp" aria-label="Multiplayer"><div class="mp" id="mp-root"></div></section>

<!-- inside #screen-table, last child of the section (sibling of .stage) -->
<div class="mp-overlay" id="mp-overlay" hidden></div>

<!-- scripts: tournament/net/remote-engine/room right after coach.js; lobby.js after tutorial.js -->
<script src="js/tournament.js"></script>
<script src="js/net.js"></script>
<script src="js/remote-engine.js"></script>
<script src="js/room.js"></script>
...
<script src="js/tutorial.js"></script>
<script src="js/lobby.js"></script>
```

### 9.2 main.js
```js
// (a) coachEnabled(): first line
if (game && game.net && !game.net.coachAllowed) return false;

// (b) insert before endGame()
function startNetGame(spec) {
  endGame();
  gameCounter += 1;
  const g = {
    id: gameCounter, active: true, engine: spec.engine, bots: spec.bots || {}, meta: spec.meta, names: spec.names,
    stack: 0, sb: spec.sb, bb: spec.bb, hand: null, lastRecord: null, lastReview: null, next: null, autoTimer: 0, net: spec,
  };
  game = g;
  const provider = (player, view, legal) => provideAction(g, player, view, legal);
  if (spec.isHost) spec.room.setLocalActionProvider(provider);   // host engine.actionProvider is owned by HostRoom
  else spec.engine.actionProvider = provider;
  bindEngineEvents(g);
  g.engine.on('handEnd', (p) => { if (isLive(g)) netAfterHand(g, (p && p.record) || {}); });  // never awaits a modal
  g.engine.on('sync', (p) => { if (isLive(g) && p && p.view) restoreNetHand(g, p.view); });
  // restoreNetHand: hand label + UI.restoreHand(view) (marks the hand dealt so hole cards render: own face up,
  // others face down) + whose turn. A rejoin rebuilds the table on `start`, so the snapshot is all there is.
  const offs = [
    spec.room.on('timer', (t) => UI.startTimer(t.playerId, t.ms)),
    spec.room.on('turnCancelled', (t) => { if (t.playerId === HERO_ID && UI.isAwaitingHuman()) UI.cancelHumanAction(); }),
    spec.room.on('tourney', (s) => { g.bb = s.bb; UI.byId('tb-blinds').textContent = 'BLINDS ' + s.sb + '/' + s.bb; }),
  ];
  g.netOff = () => offs.forEach((off) => off());
  g.next = spec.isHost ? () => spec.room.dealNow() : null;        // btn-next / SPACE already call game.next()
  UI.byId('btn-next').hidden = !spec.isHost;
  UI.showScreen('table');
  UI.clearLog();
  UI.buildTable(g.engine.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, stack: p.stack })),
    spec.heroId, g.meta);                                         // RemoteEngine.players = TableInit roster pre-events
  UI.byId('tb-blinds').textContent = 'BLINDS ' + g.sb + '/' + g.bb;
  UI.byId('tb-hand').textContent = 'HAND #' + (g.engine.handNumber || 0);
  const view = g.engine.publicView(HERO_ID);
  g.hand = newHandState(view);
  if (view.handNumber > 0) restoreNetHand(g, view);              // late join / rejoin: the sync may already be in
  UI.renderCoach(null, coachOptions());
  syncTopbar();
  UI.log(spec.isHost ? 'Your table is live. Good luck!' : 'Seated at a friend\'s table. Good luck!', 'sep');
  return g;
}

function netAfterHand(g, record) {   // sync, cheap: no stats mixing, no modal
  g.lastRecord = record;
  g.lastReview = buildReview(g, record);
  UI.byId('btn-review').disabled = !g.lastReview;
  UI.setActionMode('between', '');   // clients get no handGap event; this also enables REVIEW HAND for them
}

// (c) endGame(): right after `if (g.next) g.next();`
if (g.netOff) g.netOff();
UI.byId('btn-next').hidden = false;
if (g.net && g.net.onLeave) g.net.onLeave();   // the Lobby guards against re-entry (quiet teardown)

// (d) leaveTable(): body text and navigation
body: UI.el('p', 'modal-text', !game.net ? 'Your current game will end. Stats so far are saved.'
  : game.net.isHost ? 'This ends the game for everyone at the table.' : 'You can rejoin with the same code.'),
...
if (choice !== 'leave') return;
const wasNet = !!(game && game.net);
endGame();
if (!wasNet) UI.showScreen('title');   // net games: the Lobby's onLeave already opened the hub

// (e) PP.App gains: startNetGame, endNetGame: endGame

// (f) boot(): right after bindTopbar()
const mpRoot = UI.byId('mp-root');
if (PP.Lobby && mpRoot) {
  const lobby = PP.Lobby.mount(mpRoot, {
    UI, Net: PP.Net, Room: PP.Room, Tournament: PP.Tournament, Bots: PP.Bots,
    overlayRoot: UI.byId('mp-overlay'), showScreen: UI.showScreen, startNetGame, endNetGame: endGame,
    storage: (() => { try { return globalThis.localStorage || null; } catch (e) { return null; } })(),
    location: globalThis.location,
  });
  UI.byId('nav-multi').addEventListener('click', () => lobby.openHub());
  globalThis.addEventListener('beforeunload', (e) => {   // the game lives in the host tab (section 8)
    if (game && game.net && game.net.isHost && game.net.room.phase === 'playing') { e.preventDefault(); e.returnValue = ''; }
  });
  if (lobby.handleInviteLink()) { decorateTitle(); return; }   // invite links skip the title
}
// (g) onKeyDown: nothing to add — screen 'mp' falls through; the Lobby binds ESC/Enter itself.
```

### 9.3 ui.js (small, additive)
```js
// sceneFor(): the lobby gets the calm room backdrop instead of the felt
if (screen === 'stats' || screen === 'mp') return 'room';

// buildSeat(): avatar seed + human tag instead of empty stars
const av = avatar(meta.avatar ? p.name + '|' + meta.avatar : p.name);
if (!isHero) sub.appendChild(meta.kind === 'human' || meta.kind === 'host'
  ? el('span', 'seat-tag', 'player') : stars(meta.rating || 0));

// new export (the Lobby calls it on every `seats` update when present; CSS is already in multiplayer.css)
function setSeatStatus(id, status /* 'online'|'away'|'offline'|'sittingOut'|null */) {
  const s = T.seats.get(id);
  if (!s) return;
  ['away', 'offline', 'sittingOut'].forEach((k) => s.root.classList.toggle('mp-' + k, status === k));
}
// add setSeatStatus to the PP.UI export list
```

### 9.4 tutorial.js (one line)
A first visit to an invite link must not get the "first time here" dealer prompt on top of the join screen (its
SPACE = "teach me" would also start a lesson and end a live net game). In `boot()`:
```js
const invite = /[?&]room=/.test((globalThis.location && globalThis.location.search) || '');
if (!invite && !progress.offered && !progress.done.length) offerFirstRun();
```

### 9.5 Deploy (GitHub Pages)
Repo `LVXCAS/pixel-poker`, Pages from `main` / root, add an empty `.nojekyll`. Do not deploy `tests/`-only files
by reference (they are inert) and never ship `js/dev-fake-net.js` (only `integrate.py --fake` creates it). Verify after
deploy: title loads offline-safe, `?room=XXXXX` opens Join, two browsers on different networks (one on a phone
hotspot) can host/join, and `node tests/run.js` is green on the deployed commit.

### 9.6 Known limits to tell the user
- The table screen itself is the core UI's layout (CONTRACT: usable down to ~1024px). On a 390px phone the lobby, join
  screen and overlay drawers fit, but the table is clipped on the right. Making the table responsive is core-UI work.
- Strict NAT/firewalls (school/work wi-fi): the relay carries the game — Firebase RTDB once `config.firebase` is set
  (see 2.4b), else the WebSocket relay if `relay.json` points at a live one. With neither, `network-blocked`
  unless PeerJS's free TURN servers answer. Two-browser check on real networks is still required.
- `turnSeconds: 0` (timer off) means a player who never acts stalls the table until the host kicks them (kick → seat
  offline → disconnect policy plays for them).

## 10. Test plan (Node, loopback; every test < 5 s; use small stacks / turbo / seeded rng)

**tests/net.test.js (B1)**
1. `makeCode` → 5 chars from the alphabet (1000 samples); `normalizeCode(' k7qxm ')` → `'K7QXM'`; rejects `O`, `I`,
   `L`, `0`, `1`, wrong length, non-strings; `peerIdFor`; `inviteUrl` for https / file: / localhost.
2. Loopback host + 2 clients: `onPeerJoin` fires twice; `send`, `broadcast(msg, except)`; ordering preserved per conn.
3. Messages are JSON round-tripped (mutating the received object does not affect the sender's).
4. `join` unknown code rejects `room-not-found` (NetError with `.code`).
5. Oversize inbound (> 2 KB to host) dropped and counted; non-object / missing `t` dropped; `_ping` never reaches `onMessage`.
6. Heartbeat with manual clock: silent client → `away` after 12 s, `onPeerLeave(…, 'timeout')` after 30 s.
7. `hub.drop(client)` → host `onPeerLeave 'closed'`; client `status` `reconnecting` → `open` on successful retry;
   `hub.dropHost` → client retries then `error host-left` + `status closed`.
8. `kick` delivers `kicked` then closes; `close()` idempotent.

**tests/remote-engine.test.js (B1)**
1. Feeding scripted `ev` messages emits the same names/payloads, awaiting async listeners in order.
2. Alias: selfId `'h2'` → its seat appears as `'hero'`, host's `'hero'` appears as `'h2'`, in payload, view,
   history, pots.eligible, awards, reveals, record. Spectator: no swap.
3. `publicView()` inside a listener equals that event's view.
4. `act` → `actionProvider(player, view, legal)` called with aliased data; result sent with the same seq;
   provider throwing → check/fold sent.
5. `actCancel` for pending → `onTurnCancelled` called, late result NOT sent; for a queued act → provider never called.
6. `playHand()` resolves with the next handEnd record; `end` → `isGameOver()` true, playHand resolves null.
7. `getLegal('hero')` returns pending legal, NO_LEGAL otherwise; `addChips` false.

**tests/room.test.js (B1)**
1. Lobby: host + 2 joins → seats `hero, h1, h2`; duplicate names → `'max'`, `'max 2'`; name sanitizer strips
   control/bidi chars and caps at 12; `addBot` → `b1` rating clamp 1..5; full room → spectator; locked → `reject locked`;
   `updateSettings` clamps to option lists; clients cannot change settings (no such message accepted).
2. **No hole-card leak**: host + 2 clients + 2 bots, 20 hands, seeded rng; scan `hub.log` for every message to
   each client: any `players[].hole` / `record.players[].hole` / `player.hole` non-empty for an id other than the
   recipient's seat must be in that hand's showdown reveals and only on/after the `showdown` event.
3. Chip conservation every hand (sum of stacks constant in cash without rebuys).
4. Action validation: from the wrong peer, wrong seq, out of turn, malformed type, NaN amount, oversized → ignored
   (no engine effect); legal-but-out-of-range raise is clamped by the engine.
5. Turn timer (manual clock, `turnSeconds: 30`): no answer → after 30 s auto check (or fold when facing a bet),
   `actCancel` received, `timer` broadcast seen; 2 consecutive timeouts → `sittingOut: true` in `seats`;
   `sitOut {on:false}` clears it.
6. Disconnect mid-turn → immediate auto-action (policy autofold) / takeover bot action (policy bot) is legal.
7. Rejoin: reconnect with token → same seat id, `conn: online`, `start` + `sync` received, pending act re-sent
   with the same seq; wrong/absent token during play → spectator with `publicView(null)` (no hole cards at all).
8. Chat: 141+ chars truncated to 140; empty dropped; 6th message within 10 s dropped; `from.name` is the seat's
   name even if the client sends a fake `name` field; emote id outside EMOTES dropped.
9. Rebuy in cash: busted client sends `rebuy` → stack restored before the next hand; ignored in sng.
10. Offline SNG: `new HostRoom({ endpoint: null })` + 5 bots, turbo, stack 300 → `run()` resolves Results with
    places 1..6 unique, points [50,30,20,0,0,0], chips conserved; `end` emitted.
11. Host `endGame()` → clients get `end`; `close()` → clients get `closed host-ended`.

**tests/tournament.test.js + tests/engine-mp.test.js (B2)**
1. `levels()` for 1500 equals `BASE_SB` ladder with bb = 2·sb; for 1000/3000/5000 values are nice-rounded and
   strictly increasing; antes 0 for levels 1–2, ≥ 1 after when enabled, 0 everywhere when disabled.
2. `beforeHand` changes level exactly at handsPlayed = k·handsPerLevel for each preset; calls `engine.setBlinds`.
3. `payouts(n)` for n = 2..9, sums to 100.
4. Eliminations: single bust → correct place; double bust same hand → bigger start stack places higher; equal
   start stacks → seat-from-button tiebreak; winner place 1; `results()` points match payouts.
5. `state()` JSON-safe and frozen; standings order.
6. Full offline SNG with the real engine + bots (6 seats, turbo, 300 chips) completes; level never decreases.
7. Engine: `setBlinds` next-hand effect, rejected mid-hand, ante posting, `endWhenHumanBusts` both ways;
   all pre-existing engine tests untouched and green.

Definition of done for every builder: `node tests/run.js` fully green; no edits to the forbidden files; new code
follows CONTRACT.md style (IIFE, `'use strict'`, functions < 50 lines, no `console.log` — `console.error` for
caught failures only, immutable public return values).
