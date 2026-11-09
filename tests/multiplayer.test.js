'use strict';
// Two-client integration test + collision unit test. Run: node tests/multiplayer.test.js
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const serverMod = require(path.join(__dirname, '..', 'server', 'server.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(port, name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { ws, name, id: null, room: null, lastState: null, states: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, room })));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') { c.id = m.id; c.room = m.room; resolve(c); }
      if (m.type === 'state') { c.lastState = m; c.states++; }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout ' + name)), 5000);
  });
}
async function waitState(c, pred, timeout = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (c.lastState && pred(c.lastState)) return c.lastState; await sleep(50); }
  throw new Error('waitState timeout ' + label);
}

(async () => {
  // --- Unit: collision / scoring ---
  const a = serverMod.makeCar('UnitA', false); const b = serverMod.makeCar('UnitB', false);
  a.x = 0; a.y = 0; a.vx = 200; a.vy = 0; b.x = 30; b.y = 0; b.vx = -50; b.vy = 0;
  const impact = serverMod.resolveCollision(a, b, Date.now() + 10000);
  const sep = Math.hypot(b.x - a.x, b.y - a.y);
  check('unit: collision resolves overlap & imparts impulse', impact > 80 && sep >= 43 && a.score + b.score > 0,
    `impact=${impact.toFixed(1)} separation=${sep.toFixed(1)} scoreA=${a.score} scoreB=${b.score} vxA=${a.vx.toFixed(1)} vxB=${b.vx.toFixed(1)}`);
  const a2 = serverMod.makeCar('Still', false); a2.input = { up: true, down: false, left: false, right: false }; a2.angle = 0;
  const x0 = a2.x; for (let i = 0; i < 20; i++) serverMod.stepCar(a2, 0.05);
  check('unit: stepCar moves car under thrust', a2.x > x0 + 10, `x ${x0.toFixed(1)} -> ${a2.x.toFixed(1)}`);

  // --- Integration ---
  const srv = await serverMod.start(0);
  const port = srv.port;
  console.log(`server started on ephemeral port ${port}`);
  try {
    const A = await makeClient(port, 'Alice', 'TEST');
    const B = await makeClient(port, 'Bob', 'TEST');
    check('both clients welcomed to same room', A.room === 'TEST' && B.room === 'TEST' && A.id !== B.id, `room=${A.room} idA=${A.id} idB=${B.id}`);

    const stBoth = await waitState(B, s => s.cars.some(c => c.id === A.id) && s.cars.some(c => c.id === B.id), 4000, 'both cars in B state');
    check('B receives state containing BOTH players cars', true, `cars in state=${stBoth.cars.map(c => c.name + (c.isBot ? '(bot)' : '')).join(',')} total=${stBoth.cars.length}`);
    check('bots fill room to at least 4 cars', stBoth.cars.length >= 4, `total cars=${stBoth.cars.length}`);

    const before = stBoth.cars.find(c => c.id === A.id);
    // Drive A forward for ~1s (resend input, server keeps last input)
    const iv = setInterval(() => A.ws.send(JSON.stringify({ type: 'input', keys: { up: true } })), 50);
    A.ws.send(JSON.stringify({ type: 'input', keys: { up: true } }));
    await sleep(1000); clearInterval(iv);
    A.ws.send(JSON.stringify({ type: 'input', keys: { up: false } }));
    const stAfter = await waitState(B, s => { const c = s.cars.find(x => x.id === A.id); return c && Math.hypot(c.x - before.x, c.y - before.y) > 20; }, 4000, 'A moved in B view');
    const after = stAfter.cars.find(c => c.id === A.id);
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    check('A car position changed in state received by B after 1s input', moved > 20,
      `A before=(${before.x},${before.y}) after=(${after.x},${after.y}) moved=${moved.toFixed(1)}px`);

    // Disconnect A: car must remain, bot-driven
    const aId = A.id; A.ws.close();
    await sleep(700);
    const stBot = await waitState(B, s => { const c = s.cars.find(x => x.id === aId); return c && c.isBot; }, 4000, 'bot takeover');
    const botCar = stBot.cars.find(c => c.id === aId);
    check('after A disconnects, its car remains in state as a bot (not a dead/vanished car)', !!botCar && botCar.isBot === true,
      `car id=${aId} present=${!!botCar} isBot=${botCar && botCar.isBot} name=${botCar && botCar.name} total cars=${stBot.cars.length}`);
    // And it should move under bot control over time
    const bp = { x: botCar.x, y: botCar.y };
    let botMoved = 0;
    try {
      const stBot2 = await waitState(B, s => { const c = s.cars.find(x => x.id === aId); return c && Math.hypot(c.x - bp.x, c.y - bp.y) > 15; }, 5000, 'bot moves');
      const c2 = stBot2.cars.find(x => x.id === aId); botMoved = Math.hypot(c2.x - bp.x, c2.y - bp.y);
    } catch { botMoved = 0; }
    check('bot-takeover car actually drives (moves over time)', botMoved > 15, `bot moved=${botMoved.toFixed(1)}px from (${bp.x},${bp.y})`);

    B.ws.close();
  } finally {
    clearInterval(srv.timer); srv.wss.close(); srv.httpServer.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\nTOTAL: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FAIL  test crashed:', e.message); process.exit(1); });
