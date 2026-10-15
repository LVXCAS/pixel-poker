#!/usr/bin/env python3
"""MULTIPLAYER.md section 9 as code: copies the repo and applies the integration to the COPY.

    python3 tests/browser/integrate.py <repo> <out-dir> [--fake]

--fake also loads tests/browser/fake-net.js so `index.html?fake=1` runs every multiplayer path over an
in-page Loopback hub (no network). Then: node tests/browser/flow-host.js <out-dir> (also flow-client.js
[phone], flow-offline.js). Anchors are exact strings from index.html / main.js / ui.js / tutorial.js; a
missing anchor aborts with its name (the readability workflow may have moved it: re-anchor, keep the code).
Running it with <out-dir> = <repo> performs the real integration in place."""
import sys, shutil, pathlib, subprocess

src_root, root = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()
fake = '--fake' in sys.argv[3:]
if src_root != root:
    subprocess.run(['rsync', '-a', '--exclude', 'screenshots', '--exclude', 'research', '--exclude', '.git',
                    str(src_root) + '/', str(root) + '/'], check=True)


def patch(rel, pairs):
    p = root / rel
    s = p.read_text()
    for name, old, new in pairs:
        if old not in s:
            sys.exit('anchor not found in %s: %s' % (rel, name))
        s = s.replace(old, new, 1)
    p.write_text(s)


# ------------------------------------------------------------------ index.html (9.1)
patch('index.html', [
    ('css link', '<link rel="stylesheet" href="css/tutorial.css">',
     '<link rel="stylesheet" href="css/tutorial.css">\n  <link rel="stylesheet" href="css/multiplayer.css">'),
    ('nav button', '<button type="button" class="menu-item" id="nav-play"><span class="btn-label">play</span></button>',
     '<button type="button" class="menu-item" id="nav-play"><span class="btn-label">play</span></button>\n'
     '          <button type="button" class="menu-item" id="nav-multi"><span class="btn-label">play friends</span></button>'),
    ('mp screen', '    <!-- ============================== TABLE ============================== -->',
     '    <!-- ============================== MULTIPLAYER ============================== -->\n'
     '    <section class="screen" id="screen-mp" aria-label="Multiplayer"><div class="mp" id="mp-root"></div></section>\n\n'
     '    <!-- ============================== TABLE ============================== -->'),
    ('overlay', '      </div>\n    </section>\n\n    <!-- ============================== DRILLS',
     '      </div>\n      <div class="mp-overlay" id="mp-overlay" hidden></div>\n    </section>\n\n    <!-- ============================== DRILLS'),
    ('scripts', '  <script src="js/coach.js"></script>',
     '  <script src="js/coach.js"></script>\n  <script src="js/tournament.js"></script>\n  <script src="js/net.js"></script>\n'
     '  <script src="js/remote-engine.js"></script>\n  <script src="js/room.js"></script>'),
    ('lobby script', '  <script src="js/tutorial.js"></script>',
     '  <script src="js/tutorial.js"></script>\n  <script src="js/lobby.js"></script>'),
])

# ------------------------------------------------------------------ main.js (9.2)
NET_GAME = r'''
  // ------------------------------------------------------------- net games (MULTIPLAYER.md 9.2)
  // spec = room.start() (host) or client.tableSpec() (client / spectator). The room drives hands; main only
  // renders and answers the local seat. Engine listeners here never await a modal (it would stall the table).
  function startNetGame(spec) {
    endGame();
    gameCounter += 1;
    const g = {
      id: gameCounter, active: true, engine: spec.engine, bots: spec.bots || {}, meta: spec.meta, names: spec.names,
      stack: 0, sb: spec.sb, bb: spec.bb, hand: null, lastRecord: null, lastReview: null, next: null, autoTimer: 0, net: spec,
    };
    game = g;
    const provider = (player, view, legal) => provideAction(g, player, view, legal);
    if (spec.isHost) spec.room.setLocalActionProvider(provider);
    else spec.engine.actionProvider = provider;
    bindEngineEvents(g);
    g.engine.on('handEnd', (p) => { if (isLive(g)) netAfterHand(g, (p && p.record) || {}); });
    g.engine.on('sync', (p) => { if (isLive(g)) { g.hand = newHandState(p.view); UI.renderView(p.view); } });
    const offs = [
      spec.room.on('timer', (t) => UI.startTimer(t.playerId, t.ms)),
      spec.room.on('turnCancelled', (t) => { if (t.playerId === HERO_ID && UI.isAwaitingHuman()) UI.cancelHumanAction(); }),
      spec.room.on('tourney', (s) => { g.bb = s.bb; UI.byId('tb-blinds').textContent = 'BLINDS ' + s.sb + '/' + s.bb; }),
    ];
    g.netOff = () => offs.forEach((off) => off());
    g.next = spec.isHost ? () => spec.room.dealNow() : null;
    UI.byId('btn-next').hidden = !spec.isHost;
    UI.showScreen('table');
    UI.clearLog();
    UI.buildTable(g.engine.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, stack: p.stack })),
      spec.heroId, g.meta);
    UI.byId('tb-blinds').textContent = 'BLINDS ' + g.sb + '/' + g.bb;
    UI.byId('tb-hand').textContent = 'HAND #' + (g.engine.handNumber || 0);
    const view = g.engine.publicView(HERO_ID);
    g.hand = newHandState(view);
    if (view.handNumber > 0) UI.renderView(view);   // late join / rejoin: the sync may already be in
    UI.renderCoach(null, coachOptions());
    syncTopbar();
    UI.log(spec.isHost ? 'Your table is live. Good luck!' : 'Seated at a friend\'s table. Good luck!', 'sep');
    return g;
  }

  function netAfterHand(g, record) {   // sync and cheap: no stats mixing, no modal
    g.lastRecord = record;
    g.lastReview = buildReview(g, record);
    UI.byId('btn-review').disabled = !g.lastReview;
    UI.setActionMode('between', '');
  }

'''

patch('js/main.js', [
    ('coachEnabled', '''  function coachEnabled() {
    const t = game && game.tutor;''', '''  function coachEnabled() {
    if (game && game.net && !game.net.coachAllowed) return false;
    const t = game && game.tutor;'''),
    ('startNetGame', '  function endGame() {', NET_GAME + '  function endGame() {'),
    ('endGame net teardown', '''    if (g.next) g.next();''', '''    if (g.next) g.next();
    if (g.netOff) g.netOff();
    UI.byId('btn-next').hidden = false;
    if (g.net && g.net.onLeave) g.net.onLeave();   // the Lobby guards against re-entry'''),
    ('leaveTable body', '''      body: UI.el('p', 'modal-text', 'Your current game will end. Stats so far are saved.'),''',
     '''      body: UI.el('p', 'modal-text', !game.net ? 'Your current game will end. Stats so far are saved.'
        : game.net.isHost ? 'This ends the game for everyone at the table.' : 'You can rejoin with the same code.'),'''),
    ('leaveTable nav', '''    if (choice !== 'leave') return;
    endGame();
    UI.showScreen('title');''', '''    if (choice !== 'leave') return;
    const wasNet = !!(game && game.net);
    endGame();
    if (!wasNet) UI.showScreen('title');   // net games: the Lobby's onLeave already opened the hub'''),
    ('boot lobby', '''    bindNav();
    bindTopbar();''', '''    bindNav();
    bindTopbar();
    const mpRoot = UI.byId('mp-root');
    if (PP.Lobby && mpRoot) {
      const lobby = PP.Lobby.mount(mpRoot, {
        UI, Net: PP.Net, Room: PP.Room, Tournament: PP.Tournament, Bots: PP.Bots,
        overlayRoot: UI.byId('mp-overlay'), showScreen: UI.showScreen, startNetGame, endNetGame: endGame,
        storage: (() => { try { return globalThis.localStorage || null; } catch (e) { return null; } })(),
        location: globalThis.location,
      });
      UI.byId('nav-multi').addEventListener('click', () => lobby.openHub());
      globalThis.addEventListener('beforeunload', (e) => {
        if (game && game.net && game.net.isHost && game.net.room.phase === 'playing') { e.preventDefault(); e.returnValue = ''; }
      });
      if (lobby.handleInviteLink()) { decorateTitle(); return; }   // invite links skip the title
    }'''),
    ('PP.App', '''    isPlaying: () => !!game,
  });''', '''    isPlaying: () => !!game,
    startNetGame,
    endNetGame: endGame,
  });'''),
])

# ------------------------------------------------------------------ ui.js (9.3)
patch('js/ui.js', [
    ('sceneFor', "    if (screen === 'stats') return 'room';", "    if (screen === 'stats' || screen === 'mp') return 'room';"),
    ('avatar seed', '    const av = avatar(p.name);', "    const av = avatar(meta.avatar ? p.name + '|' + meta.avatar : p.name);"),
    ('human tag', '    if (!isHero) sub.appendChild(stars(meta.rating || 0));',
     "    if (!isHero) sub.appendChild(meta.kind === 'human' || meta.kind === 'host' ? el('span', 'seat-tag', 'player') : stars(meta.rating || 0));"),
    ('setSeatStatus', '  function resetHand() {', '''  /** Presence on a seat in net games: 'online'|'away'|'offline'|'sittingOut'|null (CSS in multiplayer.css). */
  function setSeatStatus(id, status) {
    const s = T.seats.get(id);
    if (!s) return;
    ['away', 'offline', 'sittingOut'].forEach((k) => s.root.classList.toggle('mp-' + k, status === k));
  }

  function resetHand() {'''),
    ('export', '    buildTable, resetHand,', '    buildTable, resetHand, setSeatStatus,'),
])
# ------------------------------------------------------------------ tutorial.js: no first-run offer on invite links
patch('js/tutorial.js', [
    ('first-run guard', "    if (!progress.offered && !progress.done.length) offerFirstRun();",
     "    const invite = /[?&]room=/.test((globalThis.location && globalThis.location.search) || '');\n"
     "    if (!invite && !progress.offered && !progress.done.length) offerFirstRun();"),
])
if fake:
    shutil.copy(pathlib.Path(__file__).with_name('fake-net.js'), root / 'js' / 'dev-fake-net.js')
    patch('index.html', [('fake shim', '  <script src="js/room.js"></script>',
                          '  <script src="js/room.js"></script>\n  <script src="js/dev-fake-net.js"></script>')])
print('integration applied to', root, '(with fake net)' if fake else '')
