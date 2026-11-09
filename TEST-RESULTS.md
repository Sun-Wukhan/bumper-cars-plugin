# Test Results — 2026-11-09

## Environment
- Node v24.22.1, npm 10.9.4
- `ws` — **npm install worked**: `added 1 package`, resolved ws ^8.22.2, `require('ws').WebSocketServer` verified OK.

## Syntax checks (`node --check`)
- `server/server.js`: OK
- `plugin-shells/vscode/extension.js`: OK
- `tests/multiplayer.test.js`: OK
- Client inline JS (extracted from `client/index.html`): OK
- All JSON manifests / hooks files in `plugin-shells/` parsed with `JSON.parse`: see below (verified in final check run).

## Automated multiplayer test — `node tests/multiplayer.test.js`
Server started in-process on an ephemeral port; two real WebSocket clients
(Alice, Bob) joined room `TEST` by code. Verbatim output:

```
PASS  unit: collision resolves overlap & imparts impulse  impact=250.0 separation=44.0 scoreA=0 scoreB=21 vxA=-40.0 vxB=190.0
PASS  unit: stepCar moves car under thrust  x 0.0 -> 125.2
server started on ephemeral port 41491
PASS  both clients welcomed to same room  room=TEST idA=c4 idB=c8
PASS  B receives state containing BOTH players cars  cars in state=Alice,RoboRam-TEST(bot),CrashBot-TEST(bot),TurboTed-TEST(bot),Bob total=5
PASS  bots fill room to at least 4 cars  total cars=5
PASS  A car position changed in state received by B after 1s input  A before=(180,0) after=(180,146.8) moved=146.8px
PASS  after A disconnects, its car remains in state as a bot (not a dead/vanished car)  car id=c4 present=true isBot=true name=Alice (bot) total cars=5
PASS  bot-takeover car actually drives (moves over time)  bot moved=18.0px from (180.6,245.3)

TOTAL: 8/8 passed
EXIT: 0
```

Notes on the numbers:
- Collision unit test: two cars placed overlapping (30px apart, closing at 250 u/s)
  separated to exactly 44.0px (2 × car radius), velocities reversed by the impulse,
  and the faster car scored 21 points (= round(250/12)).
- Alice's spawn angle pointed along +y, so 1s of "up" input moved her in +y:
  (180, 0) → (180, 146.8). Movement was asserted from **Bob's** received state, not Alice's.
- Bot movement after takeover is modest (18px in the wait window) because the bot
  first has to turn toward its target; it is movement under bot control, not drift —
  Alice's input had been explicitly zeroed before disconnect.

## Quick Match smoke test (separate run, real server process on port 8787)

```
bumper-cars server listening on ws://localhost:8787 (tick 20Hz, round 90s)
QUICKMATCH welcome room=ZAKP id=c1 color=#e74c3c
QUICKMATCH state cars=4 timeLeft=90
HTTP GET / -> "bumper-cars server ok"
```

Quick Match auto-created a 4-letter room (`ZAKP`), assigned a server-side colour,
and bots filled the room to 4 cars.

## Not tested
- 90-second round expiry / results message (not waited out; same tick code path as tested state broadcast).
- Browser rendering of `client/index.html` visually (JS syntax-checked; protocol it speaks is the one exercised by the two Node clients).
- Public / wss connectivity — local only, by design (see README "Next step").

---

# Render-ready verification — 2026-11-09 (second pass)

The server was restructured so ONE Node HTTP server on `process.env.PORT || 8787`
serves the client (`GET /`), answers health checks (`GET /health` → `{"ok":true}`),
and hosts the WebSocket game on the **same port** — the shape Render requires.
Client now defaults to the same origin over ws/wss when served over http(s),
keeping `?server=` override and the `ws://localhost:8787` file:// fallback.
`render.yaml` Blueprint added at project root. **No deploy was performed.**

## Syntax / parse checks
```
server/server.js          node --check OK
tests/multiplayer.test.js node --check OK
client inline JS          node --check OK (extracted from client/index.html)
render.yaml               YAML parsed OK
```

## HTTP checks — real server process started with PORT=9999
Server log:
```
bumper-cars listening on http://localhost:9999 (client + health at /health + WebSocket on same port, tick 20Hz, round 90s)
```
curl results (verbatim):
```
GET /        -> HTTP 200, 5668 bytes
                <title>Bumper Cars — while your code generates</title>
                body contains the join screen ("Quick Match" present)
GET /health  -> HTTP 200  {"ok":true}
GET /nope    -> HTTP 404
```

## Same-port WebSocket check (new)
A WebSocket client connected to `ws://localhost:9999` — the HTTP server's own
port, **not** a separate WS port — against the externally started PORT=9999
process, joined Quick Match, and received state. Verbatim:
```
welcome on ws://localhost:9999 room=SWBW id=c1 color=#e74c3c
state received on SAME port 9999: room=SWBW cars=4 timeLeft=90 names=PortCheck,RoboRam-SWBW,CrashBot-SWBW,TurboTed-SWBW
PASS  same-port WS check: HTTP and WebSocket share port 9999
exit=0
```
Quick Match auto-created room `SWBW`; bots filled it to 4 cars; round timer at 90.

## Existing suite re-run against the restructured server
**No test adaptation was needed** — the test boots the server in-process via
`start(0)`, whose interface did not change. Verbatim:
```
PASS  unit: collision resolves overlap & imparts impulse  impact=250.0 separation=44.0 scoreA=0 scoreB=21 vxA=-40.0 vxB=190.0
PASS  unit: stepCar moves car under thrust  x -180.0 -> -54.8
server started on ephemeral port 45031
PASS  both clients welcomed to same room  room=TEST idA=c4 idB=c8
PASS  B receives state containing BOTH players cars  cars in state=Alice,RoboRam-TEST(bot),CrashBot-TEST(bot),TurboTed-TEST(bot),Bob total=5
PASS  bots fill room to at least 4 cars  total cars=5
PASS  A car position changed in state received by B after 1s input  A before=(0,-180) after=(168.4,-180) moved=168.4px
PASS  after A disconnects, its car remains in state as a bot (not a dead/vanished car)  car id=c4 present=true isBot=true name=Alice (bot) total cars=5
PASS  bot-takeover car actually drives (moves over time)  bot moved=16.3px from (306.8,-180)

TOTAL: 8/8 passed
EXIT=0
```
(Movement numbers differ from the first run because spawns/directions are
randomised — Alice moved 168.4px this run vs 146.8px before; assertions are
threshold-based and passed on both.)

## Not tested in this pass
- The actual Render deploy itself and real `wss://` public connectivity —
  deliberately not done (local preparation only, no credentials used).
- Browser rendering of the served client visually (same status as before:
  JS syntax-checked, protocol exercised by Node WebSocket clients, and
  `GET /` byte-checked for the real client HTML including title/join screen).
