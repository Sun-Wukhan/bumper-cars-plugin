'use strict';
// Bot-AI behaviour tests (new AI: sticky targets, interception, throttle
// discipline, edge survival, anti-stall). Unit decision checks plus
// protocol-level scenarios. Run: node tests/bot-ai.test.js
// Scenarios place cars by direct room-state writes — the same technique
// the main suite uses (teleporting Bob out of the ring, forcing spawns).
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
    const c = { ws, name, id: null, room: null, lastState: null, lastResults: null };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, room })));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') { c.id = m.id; c.room = m.room; resolve(c); }
      if (m.type === 'state') { c.lastState = m; }
      if (m.type === 'results') { c.lastResults = m; }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout ' + name)), 5000);
  });
}
// Poll a predicate against live room state; returns {ok, ms, value}.
async function pollRoom(room, pred, timeoutMs, intervalMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = pred(room);
    if (v) return { ok: true, ms: Date.now() - t0, value: v };
    await sleep(intervalMs);
  }
  return { ok: false, ms: timeoutMs, value: null };
}
function botsOf(room) { return [...room.cars.values()].filter(c => c.isBot); }
function keepOnlyBots(room, n) {
  const bots = botsOf(room);
  const keep = bots.slice(0, n);
  for (const b of bots.slice(n)) room.cars.delete(b.id);
  return keep;
}

(async () => {
  // --- Unit 1: edge-survival steering decision ---
  // Bot at r=342 (>85% hard radius) heading outward-ish with outward
  // velocity: one botDrive call must choose brake/reverse + turn toward
  // the centre, NOT chase the car sitting at the centre... (the centre
  // car is also the chase target — recovery aims at the same point, so
  // the distinguishing signal is the BRAKE: chase at this alignment
  // would throttle up, recovery brakes while the nose comes around).
  {
    const bot = serverMod.makeCar('EdgeBot', true);
    const other = serverMod.makeCar('CentreCar', false);
    const room = { cars: new Map([[bot.id, bot], [other.id, other]]), powerups: [] };
    other.x = 0; other.y = 0;
    bot.x = 330; bot.y = 90; bot.angle = 0.9; bot.vx = 135; bot.vy = 37;
    serverMod.botDrive(bot, room, 0.05, Date.now());
    check('unit: bot beyond 85% radius brakes/reverses and turns toward centre (edge override)',
      bot.input.down === true && bot.input.up === false && bot.input.right === true && bot.input.left === false,
      `input=${JSON.stringify(bot.input)} distC=${Math.hypot(bot.x, bot.y).toFixed(0)}`);
  }

  // --- Unit 2: interception steers at the PREDICTED position ---
  // Target crossing fast at (30,100) moving +250 u/s in x. Pure pursuit
  // would aim at (30,100) -> desired angle 1.28 rad -> from nose 0.9 that
  // is a RIGHT turn. Interception aims at ~(231,100) -> 0.41 rad -> LEFT.
  {
    const bot = serverMod.makeCar('Hunter', true);
    const tgt = serverMod.makeCar('Crosser', false);
    const room = { cars: new Map([[bot.id, bot], [tgt.id, tgt]]), powerups: [] };
    bot.x = 0; bot.y = 0; bot.angle = 0.9; bot.vx = 0; bot.vy = 0;
    tgt.x = 30; tgt.y = 100; tgt.vx = 250; tgt.vy = 0;
    serverMod.botDrive(bot, room, 0.05, Date.now());
    check('unit: bot intercepts predicted position (steers LEFT) where pure pursuit would steer RIGHT',
      bot.input.left === true && bot.input.right === false,
      `input=${JSON.stringify(bot.input)} (pure-pursuit desired=1.28 rad, intercept desired=0.41 rad, nose=0.9)`);
  }

  // --- Unit 3: knockback sweep — recovery never rings itself out ---
  // Worst cases: knocked radially outward at up to 320 u/s (near the
  // physical max a collision can impart) from r=150/220/280, nose
  // tangential (worst: thrust can't oppose the slide until it rotates)
  // or pointing straight out. Uses the real botDrive + stepCar offline.
  {
    let worst = 0, allIn = true, anyOut = false;
    for (const noseOff of [Math.PI / 2, Math.PI]) {
      for (const r0 of [150, 220, 280]) for (const vRad of [200, 260, 320]) {
        const bot = serverMod.makeCar('SimBot', true);
        const dummy = serverMod.makeCar('Dummy', false);
        const room = { cars: new Map([[bot.id, bot], [dummy.id, dummy]]), powerups: [] };
        dummy.x = 0; dummy.y = 0;
        const ra = 0.7;
        bot.x = Math.cos(ra) * r0; bot.y = Math.sin(ra) * r0;
        bot.vx = Math.cos(ra) * vRad; bot.vy = Math.sin(ra) * vRad;
        bot.angle = ra + noseOff;
        let peak = r0;
        for (let i = 0; i < 100; i++) {
          serverMod.botDrive(bot, room, 0.05, i * 50);
          serverMod.stepCar(bot, 0.05);
          peak = Math.max(peak, Math.hypot(bot.x, bot.y));
          if (peak > serverMod.ARENA_R + serverMod.CAR_R) break;
        }
        worst = Math.max(worst, peak);
        if (peak > serverMod.ARENA_R + serverMod.CAR_R) anyOut = true;
        if (Math.hypot(bot.x, bot.y) >= 280) allIn = false;
      }
    }
    check('unit: knockback sweep (18 worst cases) — no self ring-out, worst peak radius < 422',
      !anyOut && worst < serverMod.ARENA_R + serverMod.CAR_R,
      `worst peak radius=${worst.toFixed(0)} (ring-out at ${serverMod.ARENA_R + serverMod.CAR_R}), all cases ended back inside r<280: ${allIn}`);
  }

  // --- Integration ---
  const srv = await serverMod.start(0);
  const port = srv.port;
  console.log(`server started on ephemeral port ${port}`);
  const clients = [];
  try {
    // --- Scenario A: chase-and-hit a parked dummy ---
    {
      const dummyC = await makeClient(port, 'DummyA', 'BOTA'); clients.push(dummyC);
      const room = serverMod.rooms.get('BOTA');
      const [bot] = keepOnlyBots(room, 1);
      const dummy = room.cars.get(dummyC.id);
      dummy.x = 200; dummy.y = 0; dummy.vx = 0; dummy.vy = 0;
      bot.x = -250; bot.y = 0; bot.vx = 0; bot.vy = 0; bot.angle = 0; bot.botAI = null;
      const hit = await pollRoom(room, r => {
        const d = r.cars.get(dummyC.id), b = [...r.cars.values()].find(c => c.isBot);
        return (d && (d.health < 100 || d.eliminated)) || (b && b.score > 0) ? { dummyHealth: d && d.health, dummyOut: d && d.eliminated, botScore: b && b.score } : null;
      }, 10000);
      check('integration: lone bot hunts down a parked dummy and makes contact (damage or score) within 10s',
        hit.ok, hit.ok ? `contact after ${(hit.ms / 1000).toFixed(1)}s: dummyHealth=${hit.value.dummyHealth} dummyEliminated=${hit.value.dummyOut} botScore=${hit.value.botScore}` : 'no contact in 10s');
    }

    // --- Scenario B: 15 s organic brawl — no bot rings ITSELF out ---
    {
      const dummyC = await makeClient(port, 'ParkedB', 'BOTB'); clients.push(dummyC);
      const room = serverMod.rooms.get('BOTB');
      const dummy = room.cars.get(dummyC.id);
      dummy.x = 0; dummy.y = 0; dummy.vx = 0; dummy.vy = 0;
      let botRingOuts = 0, botWrecks = 0, maxBotScore = 0, minBotHealth = 100;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        for (const c of room.cars.values()) {
          if (!c.isBot) continue;
          if (c.eliminated && c.elimReason === 'ring_out') botRingOuts++;
          if (c.eliminated && c.elimReason === 'wrecked') botWrecks++;
          maxBotScore = Math.max(maxBotScore, c.score);
          minBotHealth = Math.min(minBotHealth, c.health);
        }
        if (dummyC.lastResults) for (const s of dummyC.lastResults.standings) {
          // a ring_out that ended the round would show up here after reset
          if (s.isBot && s.elimReason === 'ring_out') botRingOuts++;
        }
        if (botRingOuts > 0) break;
        await sleep(100);
      }
      check('integration: 15s organic brawl (3 bots + parked human) — zero bot ring-outs',
        botRingOuts === 0,
        `botRingOuts=${botRingOuts} botWrecks=${botWrecks} maxBotScore=${maxBotScore} minBotHealth=${Math.round(minBotHealth)} (bots fought; only ring-outs count)`);
    }

    // --- Scenario C: two bots head-on — contact, not a circle dance ---
    {
      const dummyC = await makeClient(port, 'ParkedC', 'BOTC'); clients.push(dummyC);
      const room = serverMod.rooms.get('BOTC');
      const [b1, b2] = keepOnlyBots(room, 2);
      const dummy = room.cars.get(dummyC.id);
      dummy.x = 0; dummy.y = 380; dummy.vx = 0; dummy.vy = 0; // parked out of the way at the rim
      b1.x = -100; b1.y = 0; b1.vx = 0; b1.vy = 0; b1.angle = 0; b1.botAI = null;
      b2.x = 100; b2.y = 0; b2.vx = 0; b2.vy = 0; b2.angle = Math.PI; b2.botAI = null;
      const hit = await pollRoom(room, r => {
        const bots = botsOf(r);
        const contact = bots.some(c => c.score > 0 || c.health < 100);
        return contact ? { scores: bots.map(c => c.score).join('/'), healths: bots.map(c => Math.round(c.health)).join('/') } : null;
      }, 12000);
      check('integration: two bots alone together collide (score/damage) within 12s instead of orbiting',
        hit.ok, hit.ok ? `contact after ${(hit.ms / 1000).toFixed(1)}s: botScores=${hit.value.scores} botHealths=${hit.value.healths}` : 'no contact in 12s — circle dance persists');
    }

    // --- Scenario D: shoved toward the rim — bot fights back to centre ---
    {
      const dummyC = await makeClient(port, 'ParkedD', 'BOTD'); clients.push(dummyC);
      const room = serverMod.rooms.get('BOTD');
      const [bot] = keepOnlyBots(room, 1);
      const dummy = room.cars.get(dummyC.id);
      dummy.x = 0; dummy.y = 0; dummy.vx = 0; dummy.vy = 0;
      bot.x = 345; bot.y = 0; bot.vx = 150; bot.vy = 0; bot.angle = 0; bot.botAI = null; // hard outward shove, nose pointing out
      let rungOut = false, peak = 345;
      const back = await pollRoom(room, r => {
        const b = [...r.cars.values()].find(c => c.isBot);
        if (!b) return null;
        peak = Math.max(peak, Math.hypot(b.x, b.y));
        if (b.eliminated && b.elimReason === 'ring_out') { rungOut = true; return { rungOut }; }
        return Math.hypot(b.x, b.y) < 280 ? { r: Math.hypot(b.x, b.y) } : null;
      }, 6000);
      check('integration: bot shoved to r=345 at 150 u/s outward recovers inside r<280 without ringing out',
        back.ok && !rungOut && back.value.r != null,
        back.ok ? `back inside after ${(back.ms / 1000).toFixed(1)}s (r=${back.value.r && back.value.r.toFixed(0)}), peak radius=${peak.toFixed(0)}, ringOut=${rungOut}` : `never got back inside in 6s, peak=${peak.toFixed(0)} ringOut=${rungOut}`);
    }
  } finally {
    for (const c of clients) { try { c.ws.close(); } catch { /* already closed */ } }
    clearInterval(srv.timer); srv.wss.close(); srv.httpServer.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\nTOTAL: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FAIL  test crashed:', e.message); process.exit(1); });
