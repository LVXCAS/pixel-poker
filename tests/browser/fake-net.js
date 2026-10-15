/* Test-only shim: ?fake=1 routes PP.Net through one in-page Loopback hub and adds fake peers. */
(function () {
  if (!/[?&]fake=1/.test(location.search)) return;
  const PP = globalThis.PP;
  const hub = PP.Net.Loopback.createHub({});
  const createHost = PP.Net.createHost;
  const join = PP.Net.join;
  PP.Net.createHost = (o) => createHost({ ...(o || {}), hub });
  PP.Net.join = (code, o) => join(code, { ...(o || {}), hub });
  const passive = (l) => (l.canCheck ? { type: 'check' } : { type: 'call' });
  /* dev/QA only: never loaded by the shipped index.html */
  window.fake = { hub, clients: [], host: null, errors: [] };
  window.fakeJoin = async (name, code) => {
    const c = await PP.Room.joinRoom({ code: code || document.querySelector('.mp-code-v').textContent, name, avatar: 'a2' });
    c.on('start', (spec) => { spec.engine.actionProvider = (p, v, l) => new Promise((r) => setTimeout(() => r(passive(l)), 150)); });
    fake.clients.push(c);
    return c.selfId;
  };
  window.fakeChat = (i, text) => fake.clients[i].sendChat(text);
  window.fakeHost = async () => {
    const ep = await PP.Net.createHost({});
    const room = new PP.Room.HostRoom({ endpoint: ep, hostName: 'hosty', hostAvatar: 'a4', settings: { mode: 'sng', sngPreset: 'turbo', turnSeconds: 15 } });
    room.addBot(2); room.addBot(4);
    room.setLocalActionProvider((p, v, l) => new Promise((r) => setTimeout(() => {
      r(p.id === 'hero' ? passive(l) : room.bots[p.id].decide(v, l, v.players.find((x) => x.id === p.id)));
    }, 120)));
    fake.host = room;
    room.handGapMs = 1500;
    return ep.code;
  };
  window.fakeHostStart = () => { fake.host.start(); fake.host.run(); };
})();
