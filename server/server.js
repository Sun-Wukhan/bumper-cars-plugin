'use strict';
// Authoritative multiplayer bumper-cars server.
// Coordinates: arena centre is (0,0), radius ARENA_R. Cars are circles.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8787', 10);
// Client HTML resolved relative to THIS file (server/../client/index.html),
// so it works regardless of the process working directory (local or Render).
const CLIENT_HTML = path.join(__dirname, '..', 'client', 'index.html');
const ARENA_R = 400;
const CAR_R = 22;
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const ROUND_SECONDS = 90;
const MAX_CARS = 6;
const MIN_CARS = 4;
const MAX_HEALTH = 100;
// Damage model (see resolveCollision): on a scoring hit (impact > 80 u/s,
// same threshold + 300 ms pair cooldown as bump scoring), each car loses
//   damage = DAMAGE_K * impact * (otherSpeed + 20) / (ownSpeed + otherSpeed + 40)
// health. The (speed + 20) share means the slower car — the one being
// rammed — takes most of the damage, while a fast rammer takes little;
// the +20 floor means the rammer still takes a small share, never zero.
// With DAMAGE_K = 0.09: a 300 u/s ram into a stationary car deals ~25 to
// the victim and ~1.6 to the rammer; an equal-speed 250 u/s head-on deals
// ~11 to each car.
const DAMAGE_K = 0.09;
const HIT_THRESHOLD = 80; // u/s impact: below this, no points and no damage
// Power-ups: tokens spawn inside the arena every 8–15 s (max 2 active per
// room). Type 'boost' is the only type for now; the token carries a `type`
// field so a second type can be added without a protocol change.
const POWERUP_TYPES = ['boost'];
const POWERUP_MAX_ACTIVE = 2;
const POWERUP_SPAWN_MIN_S = 8, POWERUP_SPAWN_MAX_S = 15;
const POWERUP_PICKUP_DIST = 34; // car centre to token centre (car r=22 + token r≈12)
const BOOST_SECONDS = 8;
const BOOST_MULT = 1.6; // multiplies BOTH acceleration and top speed while active
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
const BOT_NAMES = ['RoboRam', 'CrashBot', 'TurboTed', 'Bump-o-matic', 'Sir Honks'];

let nextId = 1;
let nextPowerId = 1;
const rooms = new Map(); // code -> room

function randomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function spawnPos(i) {
  const a = (i / MIN_CARS) * Math.PI * 2;
  return { x: Math.cos(a) * 180, y: Math.sin(a) * 180, angle: a + Math.PI / 2 };
}
function makeCar(name, isBot) {
  const id = 'c' + (nextId++);
  const p = spawnPos(Math.floor(Math.random() * 8));
  return {
    id, name: String(name || 'Player').slice(0, 16) || 'Player', isBot: !!isBot,
    color: COLORS[(nextId - 2) % COLORS.length],
    x: p.x, y: p.y, vx: 0, vy: 0, angle: p.angle,
    score: 0, health: MAX_HEALTH, eliminated: false, elimReason: null, boostT: 0,
    input: { up: false, down: false, left: false, right: false },
    lastHitBy: null, lastHitAt: 0, bumpCooldownUntil: 0, outUntil: 0, botSeed: Math.random() * 1000,
    away: false, // client reports its page hidden/unfocused -> a bot drives this car until the player returns
    botAI: null, // lazily-created bot decision state (see botDrive); server-side only, never snapshotted
  };
}
function eliminate(car, reason) {
  if (car.eliminated) return;
  car.eliminated = true;
  car.elimReason = reason; // 'ring_out' | 'wrecked'
  if (reason === 'wrecked') car.health = Math.min(car.health, 0);
  car.vx = 0; car.vy = 0;
  car.boostT = 0; // elimination clears any active boost
  car.input = { up: false, down: false, left: false, right: false };
}
function makeRoom(code) {
  const room = {
    code, cars: new Map(), timeLeft: ROUND_SECONDS, createdAt: Date.now(),
    powerups: [], spawnIn: POWERUP_SPAWN_MIN_S + Math.random() * (POWERUP_SPAWN_MAX_S - POWERUP_SPAWN_MIN_S),
  };
  rooms.set(code, room);
  return room;
}
// Spawn a power-up token at a random position within ~80% of the arena
// radius (or at an explicit position — used by tests for determinism).
function spawnPowerup(room, x, y, type) {
  if (x == null || y == null) {
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * ARENA_R * 0.8;
    x = Math.cos(ang) * rad; y = Math.sin(ang) * rad;
  }
  const p = { id: 'p' + (nextPowerId++), x, y, type: type || POWERUP_TYPES[0] };
  room.powerups.push(p);
  return p;
}
// Pickup: any ACTIVE car (human or bot) whose centre comes within
// POWERUP_PICKUP_DIST of a token collects it. Eliminated cars never do.
function collectPowerups(room) {
  if (!room.powerups || room.powerups.length === 0) return;
  room.powerups = room.powerups.filter(p => {
    for (const car of room.cars.values()) {
      if (car.eliminated) continue;
      if (Math.hypot(car.x - p.x, car.y - p.y) < POWERUP_PICKUP_DIST) {
        if (p.type === 'boost') car.boostT = BOOST_SECONDS; // (re)starts the 8 s timer
        return false; // token consumed
      }
    }
    return true;
  });
}
function humanCount(room) { return [...room.cars.values()].filter(c => !c.isBot).length; }
function ensureBots(room) {
  // Fill to at least MIN_CARS total whenever there is at least 1 human,
  // and specifically when real players drop below 2.
  if (humanCount(room) === 0) return;
  let i = 0;
  while (room.cars.size < MIN_CARS) {
    const bot = makeCar(BOT_NAMES[i++ % BOT_NAMES.length] + '-' + room.code, true);
    room.cars.set(bot.id, bot);
  }
}
function findQuickRoom(excludeCode) {
  for (const room of rooms.values()) {
    if (excludeCode && room.code === excludeCode) continue; // quick match must not land back in the excluded room
    if (humanCount(room) >= 1 && room.cars.size < MAX_CARS) return room;
    if (humanCount(room) >= 1 && humanCount(room) < MAX_CARS) return room; // full of bots: a bot can be swapped out
  }
  return null;
}
function addHumanToRoom(room, name) {
  if (room.cars.size >= MAX_CARS) {
    const bot = [...room.cars.values()].find(c => c.isBot);
    if (bot) room.cars.delete(bot.id); else return null;
  }
  const car = makeCar(name, false);
  room.cars.set(car.id, car);
  ensureBots(room);
  return car;
}

// --- Physics (exported for unit tests) ---
function resolveCollision(a, b, now = Date.now()) {
  if (a.eliminated || b.eliminated) return 0; // wrecks are out of physics
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const minDist = CAR_R * 2;
  if (dist >= minDist) return 0;
  const nx = dx / dist, ny = dy / dist;
  const overlap = (minDist - dist) / 2;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const relNormal = rvx * nx + rvy * ny; // <0 means approaching
  if (relNormal < 0) {
    // Speeds BEFORE the impulse: these drive both the scorer heuristic
    // baseline and the damage split (the rammer is the faster car).
    const speedA = Math.hypot(a.vx, a.vy);
    const speedB = Math.hypot(b.vx, b.vy);
    const restitution = 0.92;
    const impulse = -(1 + restitution) * relNormal / 2;
    a.vx -= impulse * nx; a.vy -= impulse * ny;
    b.vx += impulse * nx; b.vy += impulse * ny;
    const impact = -relNormal;
    if (impact > HIT_THRESHOLD && now >= Math.min(a.bumpCooldownUntil, b.bumpCooldownUntil)) {
      // Scorer = whoever was driving into the other harder.
      const scorer = (Math.hypot(a.vx, a.vy) >= Math.hypot(b.vx, b.vy)) ? a : b;
      const other = scorer === a ? b : a;
      const pts = Math.max(1, Math.round(impact / 12));
      scorer.score += pts;
      other.lastHitBy = scorer.id; other.lastHitAt = now;
      scorer.lastHitBy = other.id; scorer.lastHitAt = now;
      // Damage: slower car takes the bigger share (see DAMAGE_K note).
      const shareA = (speedB + 20) / (speedA + speedB + 40);
      const shareB = (speedA + 20) / (speedA + speedB + 40);
      a.health -= DAMAGE_K * impact * shareA;
      b.health -= DAMAGE_K * impact * shareB;
      if (a.health <= 0) eliminate(a, 'wrecked');
      if (b.health <= 0) eliminate(b, 'wrecked');
      a.bumpCooldownUntil = now + 300; b.bumpCooldownUntil = now + 300;
    } else if (impact > 30) {
      a.lastHitBy = b.id; a.lastHitAt = now;
      b.lastHitBy = a.id; b.lastHitAt = now;
    }
    return impact;
  }
  return 0;
}
function stepCar(car, dt) {
  if (car.eliminated) return; // out for the round: not simulated at all
  const inp = car.input || {};
  if (inp.left) car.angle -= 3.2 * dt;
  if (inp.right) car.angle += 3.2 * dt;
  // Boost: the timer ticks down in real time, and while it is running BOTH
  // acceleration and top speed are multiplied. Higher impact speed from a
  // boosted ram therefore deals more damage via resolveCollision as-is.
  const boosted = (car.boostT || 0) > 0;
  if (boosted) car.boostT = Math.max(0, car.boostT - dt);
  const mult = boosted ? BOOST_MULT : 1;
  const accel = 340 * mult;
  if (inp.up) { car.vx += Math.cos(car.angle) * accel * dt; car.vy += Math.sin(car.angle) * accel * dt; }
  if (inp.down) { car.vx -= Math.cos(car.angle) * accel * 0.55 * dt; car.vy -= Math.sin(car.angle) * accel * 0.55 * dt; }
  // damping
  const damp = Math.pow(0.35, dt); // strong-ish arcade damping per second
  car.vx *= damp; car.vy *= damp;
  const speed = Math.hypot(car.vx, car.vy);
  const MAXV = 360 * mult;
  if (speed > MAXV) { car.vx = car.vx / speed * MAXV; car.vy = car.vy / speed * MAXV; }
  car.x += car.vx * dt; car.y += car.vy * dt;
}
// --- Bot AI ---
// The old bot aimed at the target's CURRENT position at full throttle and
// re-picked the nearest car every tick: a classic pursuit curve that
// orbits a moving target forever (two bots chasing each other settled
// into a stable circle dance) and blows through wide arcs because it
// never braked to turn. The replacement decides, in priority order:
//   1. EDGE SURVIVAL — beyond ~70% of the radius with outward heading or
//      velocity (or beyond ~85% regardless): abandon the chase, drive
//      for the centre, resume only once back inside ~60% (hysteresis).
//   2. ANTI-STALL MANOEUVRE — a short reverse-and-turn burst (below).
//   3. POWER-UP DETOUR — a close boost token beats a distant chase.
//   4. CHASE — steer at the target's PREDICTED position (interception,
//      not tail-chasing), with throttle discipline: brake/reverse when
//      the target is far off the nose, coast mid-turn so damping
//      tightens the turn radius, full power only when roughly aligned.
// Target selection is sticky for ~2–3 s (stops flip-flopping) and scores
// candidates by effective distance: humans preferred at comparable
// range, wounded cars and the score leader pulled closer. Progress =
// closing distance or scoring; ~4 s with neither triggers the anti-stall
// manoeuvre plus a forced re-target, so a bot can never settle into an
// orbit. Small per-bot personality (from botSeed) varies aggression,
// steering responsiveness and stickiness so the field isn't in lockstep.
const BOT_EDGE_RECOVER_R = ARENA_R * 0.70;
const BOT_EDGE_SAFE_R = ARENA_R * 0.60;
const BOT_EDGE_HARD_R = ARENA_R * 0.85;
const BOT_TOKEN_DETOUR_DIST = 300;
const BOT_TOKEN_TARGET_MIN = 210;
const BOT_STALL_MS = 4000;
const BOT_MANEUVER_MS = 650;

function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

function botPersonality(car) {
  const s = car.botSeed || 0;
  return {
    aggro: 0.85 + ((s * 0.731) % 1) * 0.35,        // cornering throttle eagerness
    turn: 0.9 + ((s * 0.317) % 1) * 0.3,           // steering deadband (responsiveness)
    stickyMs: 1900 + ((s * 0.529) % 1) * 1100,     // target hold time 1.9–3.0 s
  };
}

function pickBotTarget(car, room, excludeId) {
  let topScore = 0;
  for (const o of room.cars.values()) if (!o.eliminated && o.score > topScore) topScore = o.score;
  let best = null, bestEff = Infinity, fallback = null, fallbackEff = Infinity;
  for (const o of room.cars.values()) {
    if (o.id === car.id || o.eliminated) continue;
    const d = Math.hypot(o.x - car.x, o.y - car.y);
    let eff = d;
    if (o.isBot) eff *= 1.35;                             // humans first at comparable range
    eff -= (MAX_HEALTH - o.health) * 0.9;                 // wounded cars are attractive
    if (topScore > 0 && o.score >= topScore) eff *= 0.85; // hunt the score leader
    if (eff < fallbackEff) { fallbackEff = eff; fallback = o; }
    if (excludeId && o.id === excludeId) continue;        // anti-stall exclusion (fallback keeps it if it's the only option)
    if (eff < bestEff) { bestEff = eff; best = o; }
  }
  return best || fallback;
}

// Steer `car` toward aim point (ax, ay) and set car.input accordingly.
function botSteer(car, ax, ay, opt) {
  const diff = wrapAngle(Math.atan2(ay - car.y, ax - car.x) - car.angle);
  const adiff = Math.abs(diff);
  const dead = 0.09 / opt.persona.turn;
  const input = { up: false, down: false, left: diff < -dead, right: diff > dead };
  if (opt.mode === 'recover') {
    // NO coast band while recovering. With the nose anywhere in the
    // outward hemisphere, reverse thrust points inward and — with
    // damping — actively kills the outward slide; once the nose has an
    // inward component, drive in. (The original coast band between the
    // two let a knocked bot slide out on damping alone: live forensics
    // in TEST-RESULTS.md show a bot crossing r=285 at ~280 u/s outward
    // and coasting through the rim while its nose crossed the band.)
    if (adiff > 1.5) input.down = true;
    else input.up = true;
  } else {
    if (adiff > 1.85) input.down = true;      // target far off the nose (>~106°): brake/reverse to tighten the turn instead of a wide powered arc
    else if (adiff <= 1.0) {
      input.up = true;
      if (opt.persona.aggro < 1 && adiff > 0.55) input.up = false; // calmer personalities corner slower
      // Final approach: very close and arriving much faster than the
      // target — coast, so a near miss doesn't blow past and loop.
      if (opt.dist != null && opt.dist < 60 && opt.relSpeed != null && opt.relSpeed > 150) input.up = false;
    }
    // 1.0 < adiff <= 1.85: coast through the turn — damping shrinks the turn radius
  }
  car.input = input;
}

function botDrive(car, room, dt, now) {
  if (!car.botAI) car.botAI = { targetId: null, targetSince: 0, excludeId: null, recovering: false, bestDist: Infinity, lastProgressAt: now, lastScore: car.score, maneuverUntil: 0, maneuverDir: 1 };
  const ai = car.botAI;
  const persona = botPersonality(car);
  const distC = Math.hypot(car.x, car.y);
  const speed = Math.hypot(car.vx, car.vy);
  const radialOut = distC > 1 ? (car.vx * car.x + car.vy * car.y) / distC : 0;   // outward radial speed
  const headingOut = distC > 1 ? (Math.cos(car.angle) * car.x + Math.sin(car.angle) * car.y) / distC : 0; // cos(nose vs outward radial)

  // 1) Edge survival — highest priority, with hysteresis.
  if (!ai.recovering && (distC > BOT_EDGE_HARD_R || (distC > BOT_EDGE_RECOVER_R && (radialOut > 25 || headingOut > 0.25)))) ai.recovering = true;
  if (ai.recovering && distC < BOT_EDGE_SAFE_R && radialOut < 60) ai.recovering = false;
  if (ai.recovering) { botSteer(car, 0, 0, { persona, mode: 'recover' }); return; }

  // 2) Anti-stall manoeuvre in progress: reverse-and-turn burst.
  if (now < ai.maneuverUntil) {
    car.input = { up: false, down: true, left: ai.maneuverDir < 0, right: ai.maneuverDir > 0 };
    return;
  }

  // 3) Target bookkeeping: sticky pick + progress tracking.
  let target = ai.targetId ? room.cars.get(ai.targetId) : null;
  if (target && target.eliminated) target = null;
  if (!target || now - ai.targetSince >= persona.stickyMs) {
    const nt = pickBotTarget(car, room, ai.excludeId);
    ai.excludeId = null;
    if (nt && (!target || nt.id !== target.id)) { ai.targetId = nt.id; ai.targetSince = now; ai.bestDist = Infinity; ai.lastProgressAt = now; }
    target = nt || target;
  }
  if (!target) { car.input = { up: false, down: false, left: false, right: false }; return; }
  const distT = Math.hypot(target.x - car.x, target.y - car.y);
  if (distT < ai.bestDist - 12 || car.score !== ai.lastScore) {
    ai.bestDist = Math.min(ai.bestDist, distT); ai.lastProgressAt = now; ai.lastScore = car.score;
  } else if (now - ai.lastProgressAt > BOT_STALL_MS) {
    // No contact and no approach progress for ~4 s: break the pattern —
    // reverse-and-turn burst, and afterwards pick a different target if
    // one exists. This is what kills the mutual-orbit circle dance.
    ai.maneuverUntil = now + BOT_MANEUVER_MS;
    ai.maneuverDir = wrapAngle(Math.atan2(target.y - car.y, target.x - car.x) - car.angle) >= 0 ? -1 : 1;
    ai.excludeId = target.id; ai.targetId = null; ai.lastProgressAt = now; ai.bestDist = Infinity;
    car.input = { up: false, down: true, left: ai.maneuverDir < 0, right: ai.maneuverDir > 0 };
    return;
  }

  // 4) Power-up detour: a close boost token beats a distant chase.
  let token = null, tokenDist = Infinity;
  for (const p of room.powerups || []) { const d = Math.hypot(p.x - car.x, p.y - car.y); if (d < tokenDist) { tokenDist = d; token = p; } }
  if (token && tokenDist < BOT_TOKEN_DETOUR_DIST && distT > BOT_TOKEN_TARGET_MIN) {
    botSteer(car, token.x, token.y, { persona, mode: 'token', dist: tokenDist });
    return;
  }

  // 5) Chase by interception: aim where the target WILL be, and keep the
  // aim point inside the arena so a target being shoved out doesn't drag
  // the bot out after it.
  const lead = Math.min(0.85, distT / Math.max(speed, 130));
  let aimX = target.x + target.vx * lead, aimY = target.y + target.vy * lead;
  const ad = Math.hypot(aimX, aimY), maxR = ARENA_R - 26;
  if (ad > maxR) { aimX *= maxR / ad; aimY *= maxR / ad; }
  botSteer(car, aimX, aimY, { persona, mode: 'chase', dist: distT, relSpeed: speed - Math.hypot(target.vx, target.vy) });
  void dt;
}
function standingsOf(room) {
  // Score first; a surviving car wins ties over an eliminated one.
  return [...room.cars.values()].slice()
    .sort((x, y) => (y.score - x.score) || ((x.eliminated ? 0 : 1) - (y.eliminated ? 0 : 1)))
    .map(c => ({
      id: c.id, name: c.name, score: c.score, isBot: c.isBot,
      health: Math.max(0, Math.round(c.health)),
      eliminated: c.eliminated, elimReason: c.elimReason,
    }));
}
function endRound(room, cause) {
  const standings = standingsOf(room);
  let winner = null;
  if (cause === 'last_car_standing') {
    // The sole survivor wins outright, whatever the scores say. If a
    // simultaneous pile-up left ZERO survivors, fall back to the timer
    // rule: highest score wins posthumously (standings order above).
    winner = [...room.cars.values()].find(c => !c.eliminated) || null;
    if (!winner && standings.length) {
      const top = room.cars.get(standings[0].id);
      winner = top || null;
    }
  } else if (standings.length) {
    winner = room.cars.get(standings[0].id) || null;
  }
  broadcast(room, {
    type: 'results', room: room.code, cause,
    winner: winner ? { id: winner.id, name: winner.name, score: winner.score } : null,
    standings,
  });
  // Reset for the next round: scores, health, elimination, positions,
  // boosts and power-up tokens.
  room.powerups = [];
  room.spawnIn = POWERUP_SPAWN_MIN_S + Math.random() * (POWERUP_SPAWN_MAX_S - POWERUP_SPAWN_MIN_S);
  for (const car of room.cars.values()) {
    car.score = 0; car.health = MAX_HEALTH; car.eliminated = false; car.elimReason = null; car.boostT = 0;
    const p = spawnPos(Math.floor(Math.random() * 8));
    car.x = p.x; car.y = p.y; car.vx = 0; car.vy = 0; car.angle = p.angle;
    car.lastHitBy = null;
    car.input = { up: false, down: false, left: false, right: false };
    car.botAI = null; // fresh decisions for the new round
  }
  room.timeLeft = ROUND_SECONDS;
}
function stepRoom(room, dt) {
  const now = Date.now();
  for (const car of room.cars.values()) if ((car.isBot || car.away) && !car.eliminated) botDrive(car, room, dt, now);
  for (const car of room.cars.values()) stepCar(car, dt);
  const cars = [...room.cars.values()];
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) resolveCollision(cars[i], cars[j], now);
  collectPowerups(room);
  // Power-up spawner: every 8–15 s of round time, max POWERUP_MAX_ACTIVE
  // tokens live at once. Tests can force a spawn by setting room.spawnIn ≈ 0.
  room.spawnIn -= dt;
  if (room.spawnIn <= 0) {
    if (room.powerups.length < POWERUP_MAX_ACTIVE) spawnPowerup(room);
    room.spawnIn = POWERUP_SPAWN_MIN_S + Math.random() * (POWERUP_SPAWN_MAX_S - POWERUP_SPAWN_MIN_S);
  }
  // Ring-out = ELIMINATION for the rest of the round (no respawn). The
  // player who last bumped the victim (within 3 s) still gets +25.
  for (const car of cars) {
    if (car.eliminated) continue;
    if (Math.hypot(car.x, car.y) > ARENA_R + CAR_R) {
      if (car.lastHitBy && now - car.lastHitAt < 3000) {
        const scorer = room.cars.get(car.lastHitBy);
        if (scorer && scorer.id !== car.id) scorer.score += 25;
      }
      eliminate(car, 'ring_out');
    }
  }
  // Early end: at most one active car left (and at least one elimination
  // actually happened, so a fresh room can never trigger this).
  const active = cars.filter(c => !c.eliminated);
  if (cars.length > 0 && active.length <= 1 && cars.some(c => c.eliminated)) {
    endRound(room, 'last_car_standing');
    return;
  }
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) endRound(room, 'time');
}
function snapshot(room) {
  return {
    type: 'state', room: room.code, arena: { radius: ARENA_R }, timeLeft: Math.max(0, Math.ceil(room.timeLeft)),
    cars: [...room.cars.values()].map(c => ({
      id: c.id, name: c.name, color: c.color, isBot: c.isBot, away: !!c.away,
      x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
      vx: Math.round(c.vx), vy: Math.round(c.vy),
      angle: Math.round(c.angle * 100) / 100, score: c.score,
      health: Math.max(0, Math.round(c.health)), eliminated: c.eliminated, elimReason: c.elimReason,
      boostLeft: Math.max(0, Math.round((c.boostT || 0) * 10) / 10),
    })),
    powerups: (room.powerups || []).map(p => ({ id: p.id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, type: p.type })),
  };
}
const clients = new Map(); // ws -> {room, carId}
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const [ws, info] of clients.entries()) if (info.room === room && ws.readyState === 1) ws.send(s);
}
function normaliseInput(msg) {
  const src = msg.keys || msg.state || msg.input || msg;
  return { up: !!(src.up || src.ArrowUp || src.w || src.W), down: !!(src.down || src.ArrowDown || src.s),
           left: !!(src.left || src.ArrowLeft || src.a), right: !!(src.right || src.ArrowRight || src.d) };
}

function start(port = PORT) {
  // One HTTP server does everything on ONE port (Render gives a service a
  // single port/origin): it serves the game client and health check over
  // HTTP, and the WebSocketServer below attaches to the very same server.
  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      fs.readFile(CLIENT_HTML, (err, data) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('client not found\n'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'join') {
        let room;
        const code = (msg.room || '').toString().trim().toUpperCase();
        // Join-by-code is a deliberate choice and is always honoured.
        // `exclude` only applies to Quick Match (no room requested): the
        // matchmaker will not place the player into that room (used by the
        // "Play a new game" button so an eliminated player does not land
        // straight back in the match they just left).
        const exclude = (msg.exclude || '').toString().trim().toUpperCase();
        if (code) { room = rooms.get(code) || makeRoom(code); }
        else { room = findQuickRoom(exclude) || makeRoom(randomCode()); }
        const car = addHumanToRoom(room, msg.name);
        if (!car) { ws.send(JSON.stringify({ type: 'error', message: 'room full' })); return; }
        clients.set(ws, { room, carId: car.id });
        ws.send(JSON.stringify({ type: 'welcome', id: car.id, room: room.code, color: car.color, name: car.name, arena: { radius: ARENA_R } }));
        ws.send(JSON.stringify(snapshot(room)));
      } else if (msg.type === 'input') {
        const info = clients.get(ws); if (!info) return;
        const car = info.room.cars.get(info.carId); if (!car || car.isBot || car.eliminated) return; // eliminated humans spectate: input ignored
        car.away = !!msg.away;
        car.input = normaliseInput(msg);
      }
    });
    ws.on('close', () => {
      const info = clients.get(ws); clients.delete(ws);
      if (!info) return;
      const { room, carId } = info;
      const car = room.cars.get(carId);
      if (car && !car.eliminated) { // Bot takeover: car stays, bot drives it. (An eliminated car is already out — nothing to take over.)
        car.isBot = true; car.input = { up: false, down: false, left: false, right: false };
        if (!car.name.endsWith(' (bot)')) car.name = (car.name + ' (bot)').slice(0, 20);
      }
      if (humanCount(room) === 0) { rooms.delete(room.code); }
      else ensureBots(room);
    });
  });
  const timer = setInterval(() => { for (const room of [...rooms.values()]) { stepRoom(room, DT); broadcast(room, snapshot(room)); } }, 1000 / TICK_HZ);
  return new Promise((resolve) => httpServer.listen(port, () => resolve({ httpServer, wss, timer, port: httpServer.address().port })));
}

if (require.main === module) {
  start().then(({ port }) => console.log(`bumper-cars listening on http://localhost:${port} (client + health at /health + WebSocket on same port, tick ${TICK_HZ}Hz, round ${ROUND_SECONDS}s)`));
}
module.exports = { start, rooms, resolveCollision, stepCar, makeCar, eliminate, spawnPowerup, collectPowerups, botDrive, pickBotTarget, ARENA_R, CAR_R, ROUND_SECONDS, MAX_HEALTH, DAMAGE_K, HIT_THRESHOLD, BOOST_SECONDS, BOOST_MULT, POWERUP_PICKUP_DIST };
