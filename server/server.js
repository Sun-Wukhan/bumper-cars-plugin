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
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
const BOT_NAMES = ['RoboRam', 'CrashBot', 'TurboTed', 'Bump-o-matic', 'Sir Honks'];

let nextId = 1;
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
    score: 0, input: { up: false, down: false, left: false, right: false },
    lastHitBy: null, lastHitAt: 0, bumpCooldownUntil: 0, outUntil: 0, botSeed: Math.random() * 1000,
  };
}
function makeRoom(code) {
  const room = { code, cars: new Map(), timeLeft: ROUND_SECONDS, createdAt: Date.now() };
  rooms.set(code, room);
  return room;
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
function findQuickRoom() {
  for (const room of rooms.values()) {
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
    const restitution = 0.92;
    const impulse = -(1 + restitution) * relNormal / 2;
    a.vx -= impulse * nx; a.vy -= impulse * ny;
    b.vx += impulse * nx; b.vy += impulse * ny;
    const impact = -relNormal;
    if (impact > 80 && now >= Math.min(a.bumpCooldownUntil, b.bumpCooldownUntil)) {
      // Scorer = whoever was driving into the other harder.
      const aInto = a.vx * nx + a.vy * ny; // after impulse approx, use speeds pre-score heuristic via impact
      const scorer = (Math.hypot(a.vx, a.vy) >= Math.hypot(b.vx, b.vy)) ? a : b;
      const other = scorer === a ? b : a;
      const pts = Math.max(1, Math.round(impact / 12));
      scorer.score += pts;
      other.lastHitBy = scorer.id; other.lastHitAt = now;
      scorer.lastHitBy = other.id; // mutual contact record is fine; ring-out uses victim.lastHitBy set below
      other.lastHitBy = scorer.id; other.lastHitAt = now;
      a.bumpCooldownUntil = now + 300; b.bumpCooldownUntil = now + 300;
      void aInto;
    } else if (impact > 30) {
      a.lastHitBy = b.id; a.lastHitAt = now;
      b.lastHitBy = a.id; b.lastHitAt = now;
    }
    return impact;
  }
  return 0;
}
function stepCar(car, dt) {
  const inp = car.input || {};
  if (inp.left) car.angle -= 3.2 * dt;
  if (inp.right) car.angle += 3.2 * dt;
  const accel = 340;
  if (inp.up) { car.vx += Math.cos(car.angle) * accel * dt; car.vy += Math.sin(car.angle) * accel * dt; }
  if (inp.down) { car.vx -= Math.cos(car.angle) * accel * 0.55 * dt; car.vy -= Math.sin(car.angle) * accel * 0.55 * dt; }
  // damping
  const damp = Math.pow(0.35, dt); // strong-ish arcade damping per second
  car.vx *= damp; car.vy *= damp;
  const speed = Math.hypot(car.vx, car.vy);
  const MAXV = 360;
  if (speed > MAXV) { car.vx = car.vx / speed * MAXV; car.vy = car.vy / speed * MAXV; }
  car.x += car.vx * dt; car.y += car.vy * dt;
}
function botDrive(car, room, dt, now) {
  // Target nearest other car; if near/outside edge, head to centre first.
  const distC = Math.hypot(car.x, car.y);
  let tx, ty;
  if (distC > ARENA_R - 90) { tx = 0; ty = 0; }
  else {
    let best = null, bd = 1e9;
    for (const o of room.cars.values()) { if (o.id === car.id) continue; const d = Math.hypot(o.x - car.x, o.y - car.y); if (d < bd) { bd = d; best = o; } }
    if (!best) { car.input = { up: false, down: false, left: false, right: false }; return; }
    tx = best.x; ty = best.y;
  }
  const desired = Math.atan2(ty - car.y, tx - car.x);
  let diff = desired - car.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  car.input = { up: Math.abs(diff) < 1.2, down: false, left: diff < -0.12, right: diff > 0.12 };
  void dt; void now;
}
function stepRoom(room, dt) {
  const now = Date.now();
  for (const car of room.cars.values()) if (car.isBot) botDrive(car, room, dt, now);
  for (const car of room.cars.values()) stepCar(car, dt);
  const cars = [...room.cars.values()];
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) resolveCollision(cars[i], cars[j], now);
  // Ring-out: centre beyond arena radius
  for (const car of cars) {
    if (Math.hypot(car.x, car.y) > ARENA_R + CAR_R) {
      if (car.lastHitBy && now - car.lastHitAt < 3000) {
        const scorer = room.cars.get(car.lastHitBy);
        if (scorer && scorer.id !== car.id) scorer.score += 25;
      }
      const p = spawnPos(Math.floor(Math.random() * 8));
      car.x = p.x * 0.3; car.y = p.y * 0.3; car.vx = 0; car.vy = 0; car.angle = p.angle;
      car.lastHitBy = null;
    }
  }
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    const standings = cars.slice().sort((a, b) => b.score - a.score)
      .map(c => ({ id: c.id, name: c.name, score: c.score, isBot: c.isBot }));
    broadcast(room, { type: 'results', room: room.code, standings });
    for (const car of cars) { car.score = 0; const p = spawnPos(Math.floor(Math.random() * 8)); car.x = p.x; car.y = p.y; car.vx = 0; car.vy = 0; }
    room.timeLeft = ROUND_SECONDS;
  }
}
function snapshot(room) {
  return {
    type: 'state', room: room.code, arena: { radius: ARENA_R }, timeLeft: Math.max(0, Math.ceil(room.timeLeft)),
    cars: [...room.cars.values()].map(c => ({
      id: c.id, name: c.name, color: c.color, isBot: c.isBot,
      x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
      vx: Math.round(c.vx), vy: Math.round(c.vy),
      angle: Math.round(c.angle * 100) / 100, score: c.score,
    })),
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
        if (code) { room = rooms.get(code) || makeRoom(code); }
        else { room = findQuickRoom() || makeRoom(randomCode()); }
        const car = addHumanToRoom(room, msg.name);
        if (!car) { ws.send(JSON.stringify({ type: 'error', message: 'room full' })); return; }
        clients.set(ws, { room, carId: car.id });
        ws.send(JSON.stringify({ type: 'welcome', id: car.id, room: room.code, color: car.color, name: car.name, arena: { radius: ARENA_R } }));
        ws.send(JSON.stringify(snapshot(room)));
      } else if (msg.type === 'input') {
        const info = clients.get(ws); if (!info) return;
        const car = info.room.cars.get(info.carId); if (!car || car.isBot) return;
        car.input = normaliseInput(msg);
      }
    });
    ws.on('close', () => {
      const info = clients.get(ws); clients.delete(ws);
      if (!info) return;
      const { room, carId } = info;
      const car = room.cars.get(carId);
      if (car) { // Bot takeover: car stays, bot drives it.
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
module.exports = { start, rooms, resolveCollision, stepCar, makeCar, ARENA_R, CAR_R, ROUND_SECONDS };
