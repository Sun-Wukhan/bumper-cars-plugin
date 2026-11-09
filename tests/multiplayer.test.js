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

function makeClient(port, name, room, extra) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { ws, name, id: null, room: null, lastState: null, states: 0, lastResults: null, resultsCount: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, room, ...(extra || {}) })));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') { c.id = m.id; c.room = m.room; resolve(c); }
      if (m.type === 'state') { c.lastState = m; c.states++; }
      if (m.type === 'results') { c.lastResults = m; c.resultsCount++; }
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
async function waitResults(c, pred, timeout = 5000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (c.lastResults && pred(c.lastResults)) return c.lastResults; await sleep(50); }
  throw new Error('waitResults timeout ' + label);
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

  // --- Unit (NEW a): damage — fast rammer vs stationary victim ---
  // Rammer 300 u/s into a stationary car: impact 300. Formula:
  // dmg = 0.09 * impact * (otherSpeed + 20) / (speedSum + 40)
  // victim: 0.09*300*320/340 = 25.4 ; rammer: 0.09*300*20/340 = 1.6
  const ra = serverMod.makeCar('Rammer', false); const rb = serverMod.makeCar('Victim', false);
  ra.x = 0; ra.y = 0; ra.vx = 300; ra.vy = 0; rb.x = 30; rb.y = 0; rb.vx = 0; rb.vy = 0;
  const impA = serverMod.resolveCollision(ra, rb, Date.now() + 20000);
  check('unit: high-impact collision damages both, slower car much more',
    impA > 250 && rb.health < ra.health && rb.health <= 80 && ra.health >= 95 && !ra.eliminated && !rb.eliminated,
    `impact=${impA.toFixed(1)} healthRammer=${ra.health.toFixed(1)} healthVictim=${rb.health.toFixed(1)} (victim dmg=${(100 - rb.health).toFixed(1)}, rammer dmg=${(100 - ra.health).toFixed(1)})`);

  // --- Unit (NEW c): wreck elimination at health <= 0 ---
  const wa = serverMod.makeCar('Wrecker', false); const wb = serverMod.makeCar('Fragile', false);
  wa.x = 0; wa.y = 0; wa.vx = 300; wa.vy = 0; wb.x = 30; wb.y = 0; wb.vx = 0; wb.vy = 0; wb.health = 20;
  serverMod.resolveCollision(wa, wb, Date.now() + 30000);
  check('unit: car dropped to <=0 health is WRECKED (eliminated)',
    wb.eliminated === true && wb.elimReason === 'wrecked' && wb.health <= 0 && wa.eliminated === false,
    `fragile health=${wb.health.toFixed(1)} eliminated=${wb.eliminated} reason=${wb.elimReason} wreckerHealth=${wa.health.toFixed(1)}`);

  // --- Unit (power-ups): boosted car is measurably faster than a control ---
  // Identical input for 3 s of stepCar: boost multiplies accel AND top
  // speed by 1.6, so the boosted car must end up much faster/farther.
  const pc = serverMod.makeCar('Control', false); const pb = serverMod.makeCar('Boosted', false);
  for (const c of [pc, pb]) { c.x = 0; c.y = 0; c.vx = 0; c.vy = 0; c.angle = 0; c.input = { up: true, down: false, left: false, right: false }; }
  pb.boostT = serverMod.BOOST_SECONDS;
  for (let i = 0; i < 60; i++) { serverMod.stepCar(pc, 0.05); serverMod.stepCar(pb, 0.05); }
  const pcSpeed = Math.hypot(pc.vx, pc.vy), pbSpeed = Math.hypot(pb.vx, pb.vy);
  check('unit: boosted car accelerates harder and reaches a much higher speed than control',
    pbSpeed > pcSpeed * 1.4 && pbSpeed > 400 && pb.x > pc.x * 1.3,
    `after 3s: control speed=${pcSpeed.toFixed(1)} x=${pc.x.toFixed(1)} | boosted speed=${pbSpeed.toFixed(1)} x=${pb.x.toFixed(1)} boostLeft=${pb.boostT.toFixed(1)}s`);

  // --- Unit (power-ups): boost expires to 0 and speed caps return to normal ---
  const ex = serverMod.makeCar('Expiring', false);
  ex.boostT = 0.12; ex.input = { up: false, down: false, left: false, right: false };
  for (let i = 0; i < 4; i++) serverMod.stepCar(ex, 0.05); // 0.20s > 0.12s of boost
  const boostAfter = ex.boostT;
  ex.vx = 500; ex.vy = 0; serverMod.stepCar(ex, 0.05);
  const exSpeed = Math.hypot(ex.vx, ex.vy);
  check('unit: boost expires back to 0 and the normal 360 top-speed cap applies again',
    boostAfter === 0 && exSpeed <= 360.5,
    `boostT after 0.2s=${boostAfter} speed from 500 after one step=${exSpeed.toFixed(1)} (cap 360)`);

  // --- Unit (power-ups): eliminated cars do NOT pick up tokens ---
  const dead = serverMod.makeCar('Dead', false);
  dead.x = 50; dead.y = 50; serverMod.eliminate(dead, 'wrecked');
  const fakeRoom = { cars: new Map([[dead.id, dead]]), powerups: [{ id: 'px', x: 50, y: 50, type: 'boost' }] };
  serverMod.collectPowerups(fakeRoom);
  check('unit: eliminated car sitting on a token does not collect it',
    fakeRoom.powerups.length === 1 && (dead.boostT || 0) === 0,
    `tokens left=${fakeRoom.powerups.length} deadBoostT=${dead.boostT || 0}`);

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
    check('state snapshots include health=100 and eliminated=false for fresh cars',
      stBoth.cars.every(c => c.health === 100 && c.eliminated === false),
      `healths=${stBoth.cars.map(c => c.health).join(',')}`);

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

    // --- Integration (NEW b): ring-out = elimination, +25 to last bumper, input ignored ---
    const room = serverMod.rooms.get('TEST');
    const bob = room.cars.get(B.id);
    const scorerBefore = room.cars.get(aId).score;
    bob.x = serverMod.ARENA_R + 80; bob.y = 0; bob.vx = 0; bob.vy = 0;
    bob.lastHitBy = aId; bob.lastHitAt = Date.now();
    const stOut = await waitState(B, s => { const c = s.cars.find(x => x.id === B.id); return c && c.eliminated; }, 4000, 'ring-out elimination in state');
    const outCar = stOut.cars.find(c => c.id === B.id);
    const scorerAfter = room.cars.get(aId).score;
    check('ring-out eliminates the car (no respawn) and pays +25 to the last bumper',
      outCar.eliminated === true && outCar.elimReason === 'ring_out' && scorerAfter >= scorerBefore + 25,
      `eliminated=${outCar.eliminated} reason=${outCar.elimReason} scorer ${scorerBefore} -> ${scorerAfter} bobPos=(${outCar.x},${outCar.y})`);
    // Eliminated human's input must be ignored: position stays frozen.
    const frozen = { x: outCar.x, y: outCar.y };
    const ivB = setInterval(() => B.ws.send(JSON.stringify({ type: 'input', keys: { up: true, left: true } })), 50);
    await sleep(700); clearInterval(ivB);
    const stFrozen = B.lastState.cars.find(c => c.id === B.id);
    check('eliminated player input is ignored (car stays frozen, spectating)',
      Math.hypot(stFrozen.x - frozen.x, stFrozen.y - frozen.y) < 0.2,
      `pos before=(${frozen.x},${frozen.y}) after=(${stFrozen.x},${stFrozen.y})`);

    // --- Integration (NEW d): early round end when only one car remains ---
    // Park the survivor (bot-taken-over Alice car) safely at the centre —
    // organic bot ramming can otherwise ring her out during the earlier
    // stages — then eliminate every other car directly in the authoritative
    // room state; the next tick must end the round with her as SURVIVOR.
    const survivor = room.cars.get(aId);
    survivor.x = 0; survivor.y = 0; survivor.vx = 0; survivor.vy = 0;
    survivor.health = 100; survivor.eliminated = false; survivor.elimReason = null;
    for (const car of room.cars.values()) {
      if (car.id !== aId && !car.eliminated) serverMod.eliminate(car, 'wrecked');
    }
    const res = await waitResults(B, r => r.winner && r.winner.id === aId, 5000, 'early results');
    const bobStanding = res.standings.find(s => s.id === B.id);
    const survStanding = res.standings.find(s => s.id === aId);
    check('round ends early with the sole survivor as winner (before the 90s timer)',
      res.cause === 'last_car_standing' && !!bobStanding && bobStanding.eliminated === true && bobStanding.elimReason === 'ring_out'
        && !!survStanding && survStanding.eliminated === false,
      `cause=${res.cause} winner=${res.winner && res.winner.name}(${res.winner && res.winner.id}) survivorEliminated=${survStanding && survStanding.eliminated} standings=${res.standings.map(s => s.name + ':' + s.score + (s.eliminated ? ':OUT/' + s.elimReason : '')).join(', ')}`);

    // --- Integration (NEW e): new round resets health + elimination ---
    const stFresh = await waitState(B, s => s.cars.length >= 4 && s.cars.every(c => c.health === 100 && c.eliminated === false), 5000, 'fresh round state');
    check('new round resets every car to health=100, eliminated=false',
      stFresh.cars.every(c => c.health === 100 && !c.eliminated),
      `cars=${stFresh.cars.map(c => c.name + '@' + c.health).join(', ')} timeLeft=${stFresh.timeLeft}`);

    // --- Integration (NEW f): quick match with `exclude` never lands in the excluded room ---
    // (Quick match WITHOUT exclude is covered unchanged by the original
    // suite above and the earlier smoke tests — same code path, no exclude.)
    // Seed a room by code, then quick-match while excluding it.
    const E = await makeClient(port, 'ExclSeed', 'EXCL');
    const Q = await makeClient(port, 'Quinn', undefined, { exclude: 'EXCL' });
    const stQ = await waitState(Q, s => s.cars.some(c => c.id === Q.id), 4000, 'quick-match-with-exclude state');
    check('quick match with exclude skips the excluded room and receives state',
      Q.room !== 'EXCL' && !!Q.room && stQ.cars.length >= 1,
      `seeded room=EXCL quickRoom=${Q.room} cars=${stQ.cars.length}`);

    // --- Integration (NEW g): eliminated player chooses "Play a new game" ---
    // Eliminate Bob in TEST (same mechanism as the ring-out/wreck tests),
    // confirm he observes himself eliminated, then simulate exactly what
    // the client button does: close his socket and re-join by QUICK MATCH
    // with exclude=<old room>. He must land in a DIFFERENT room as an
    // active car at full health.
    const testRoom = serverMod.rooms.get('TEST');
    const bobCar = testRoom.cars.get(B.id);
    serverMod.eliminate(bobCar, 'wrecked');
    const stElim = await waitState(B, s => { const c = s.cars.find(x => x.id === B.id); return c && c.eliminated; }, 4000, 'Bob observes his own elimination');
    const bobElim = stElim.cars.find(c => c.id === B.id);
    B.ws.close(); // leaving the old room (his wreck stays behind; nothing to take over)
    await sleep(300);
    const B2 = await makeClient(port, 'Bob', undefined, { exclude: 'TEST' });
    const stB2 = await waitState(B2, s => s.cars.some(c => c.id === B2.id), 4000, 'new-game state');
    const b2car = stB2.cars.find(c => c.id === B2.id);
    check('eliminated player starts a new game in a DIFFERENT room as an active car (health=100)',
      bobElim.eliminated === true && B2.room !== 'TEST' && !!b2car && b2car.eliminated === false && b2car.health === 100,
      `wasEliminated=${bobElim.eliminated}/${bobElim.elimReason} oldRoom=TEST newRoom=${B2.room} active=${b2car && !b2car.eliminated} health=${b2car && b2car.health}`);

    // --- Integration (power-ups): token appears in state, pickup consumes it, spawner refills ---
    const room2 = serverMod.rooms.get(B2.room);
    const b2srv = room2.cars.get(B2.id);
    const tok = serverMod.spawnPowerup(room2, 0, -300, 'boost');
    const stTok = await waitState(B2, s => (s.powerups || []).some(p => p.id === tok.id), 4000, 'power-up token in state');
    const tokSeen = stTok.powerups.find(p => p.id === tok.id);
    check('power-up token placed in the room appears in state snapshots',
      !!tokSeen && tokSeen.type === 'boost',
      `token id=${tok.id} at=(${tokSeen && tokSeen.x},${tokSeen && tokSeen.y}) type=${tokSeen && tokSeen.type} totalTokens=${stTok.powerups.length}`);
    // Teleport B2's car straight onto the token: next ticks must consume
    // it and switch its boost on.
    b2srv.x = 0; b2srv.y = -300; b2srv.vx = 0; b2srv.vy = 0;
    const stPick = await waitState(B2, s => { const c = s.cars.find(x => x.id === B2.id); return c && c.boostLeft > 0 && !(s.powerups || []).some(p => p.id === tok.id); }, 4000, 'power-up pickup');
    const pickCar = stPick.cars.find(c => c.id === B2.id);
    check('driving onto a token consumes it and sets boostLeft > 0',
      pickCar.boostLeft > 0 && pickCar.boostLeft <= serverMod.BOOST_SECONDS,
      `boostLeft=${pickCar.boostLeft}s tokenGone=${!(stPick.powerups || []).some(p => p.id === tok.id)}`);
    // Spawner: clear tokens and shorten the spawn timer directly (the
    // documented hook) instead of waiting a real 8–15 s.
    room2.powerups = []; room2.spawnIn = 0.05;
    const stSpawn = await waitState(B2, s => (s.powerups || []).length >= 1, 3000, 'spawner produces a token');
    check('spawner creates a new token when the spawn timer fires (shortened-interval hook)',
      stSpawn.powerups.length >= 1 && stSpawn.powerups.length <= 2,
      `tokens=${stSpawn.powerups.length} first=${stSpawn.powerups[0].id}/${stSpawn.powerups[0].type} at=(${stSpawn.powerups[0].x},${stSpawn.powerups[0].y})`);

    E.ws.close(); Q.ws.close(); B2.ws.close();
    B.ws.close();
  } finally {
    clearInterval(srv.timer); srv.wss.close(); srv.httpServer.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\nTOTAL: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FAIL  test crashed:', e.message); process.exit(1); });
