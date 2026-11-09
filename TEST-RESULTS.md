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

---

# Elimination rules + car rendering + mobile controls — 2026-11-09 (third pass)

Changes: (1) server-authoritative **health/damage and eliminations** — cars
have 100 health; scoring hits deal damage
`0.09 × impact × (otherSpeed + 20) / (ownSpeed + otherSpeed + 40)` (pre-impact
speeds, so the slower/rammed car takes most of it); **ring-out = elimination**
(+25 to the last bumper kept, no more centre respawn); **health ≤ 0 =
wrecked = elimination**; eliminated cars leave physics, eliminated humans
spectate with input ignored; rounds **end early** at ≤1 active car
(survivor wins outright; timer winner = top score, survivors win ties);
results now include `winner`, `cause`, and per-car `eliminated`/`elimReason`.
(2) Client draws **car-shaped cars** (rounded body, cabin/windshield, wheels,
headlights, stripe; white outline for your car), health bars (green→red),
smoke under 50 health, flames under 25, grey X-marked wrecks, an in-page
results panel (replaces `alert()`), and a "You're out — spectating" banner.
(3) Client mobile rework: **two-thumb controls** (◀ ▶ bottom-left, GAS/BRAKE
bottom-right, ≥76px targets, per-pointer multi-touch tracking with pointer
capture), **canvas drag joystick**, keyboard/buttons/joystick OR-ed into one
keys state, **single input interval** (the per-`connect()` duplicate is
fixed), fit-to-screen `100dvh` in-game layout with no scroll/pull-to-refresh,
and devicePixelRatio-crisp canvas rendering in the same 800-unit space.

## Test adaptations to the existing suite (and why)
- **No existing test was removed or weakened.** The 8 original checks pass
  unchanged (same assertions and thresholds).
- One existing-behaviour change made an old *implicit* assumption unusable:
  the original suite never tested ring-outs, but live rounds can now end
  early organically. In the new early-end test the survivor is therefore
  parked at the arena centre before the other cars are eliminated, so the
  test deterministically exercises the survivor path rather than the
  zero-survivor fallback (the first version of this test caught exactly
  that: the "survivor" had been rung out organically and won posthumously —
  correct server behaviour, wrong test setup; the test now also asserts the
  winner's standing has `eliminated=false`).
- The harness client additionally records `results` messages (needed by the
  new tests); two forward-looking checks were added alongside the originals
  (snapshots carry `health`/`eliminated`; new-round reset).

## Syntax checks
```
server/server.js          node --check OK
tests/multiplayer.test.js node --check OK
client inline JS          node --check OK (extracted from client/index.html)
```

## Automated suite — `node tests/multiplayer.test.js` (15/15, exit 0)
Run three consecutive times during this pass: **15/15 each time**. Verbatim
output of the final run:
```
PASS  unit: collision resolves overlap & imparts impulse  impact=250.0 separation=44.0 scoreA=0 scoreB=21 vxA=-40.0 vxB=190.0
PASS  unit: stepCar moves car under thrust  x -0.0 -> 125.2
PASS  unit: high-impact collision damages both, slower car much more  impact=300.0 healthRammer=98.4 healthVictim=74.6 (victim dmg=25.4, rammer dmg=1.6)
PASS  unit: car dropped to <=0 health is WRECKED (eliminated)  fragile health=-5.4 eliminated=true reason=wrecked wreckerHealth=98.4
server started on ephemeral port 44751
PASS  both clients welcomed to same room  room=TEST idA=c8 idB=c12
PASS  B receives state containing BOTH players cars  cars in state=Alice,RoboRam-TEST(bot),CrashBot-TEST(bot),TurboTed-TEST(bot),Bob total=5
PASS  bots fill room to at least 4 cars  total cars=5
PASS  state snapshots include health=100 and eliminated=false for fresh cars  healths=100,100,100,100,100
PASS  A car position changed in state received by B after 1s input  A before=(180,0) after=(180,125.2) moved=125.2px
PASS  after A disconnects, its car remains in state as a bot (not a dead/vanished car)  car id=c8 present=true isBot=true name=Alice (bot) total cars=5
PASS  bot-takeover car actually drives (moves over time)  bot moved=21.5px from (150.6,229.3)
PASS  ring-out eliminates the car (no respawn) and pays +25 to the last bumper  eliminated=true reason=ring_out scorer 0 -> 25 bobPos=(480,0)
PASS  eliminated player input is ignored (car stays frozen, spectating)  pos before=(480,0) after=(480,0)
PASS  round ends early with the sole survivor as winner (before the 90s timer)  cause=last_car_standing winner=Alice (bot)(c8) survivorEliminated=false standings=Alice (bot):25, Bob:19:OUT/ring_out, RoboRam-TEST:0:OUT/wrecked, CrashBot-TEST:0:OUT/wrecked, TurboTed-TEST:0:OUT/wrecked
PASS  new round resets every car to health=100, eliminated=false  cars=Alice (bot)@100, RoboRam-TEST@100, CrashBot-TEST@100, TurboTed-TEST@100, Bob@100 timeLeft=90

TOTAL: 15/15 passed
```

Key numbers:
- Damage split exactly matches the documented formula: 300 u/s ram into a
  stationary car → victim −25.4 health (100 → 74.6), rammer −1.6 (100 → 98.4).
- Wreck: a 20-health car taking that hit drops to −5.4 → `eliminated=true`,
  `elimReason=wrecked`; the wrecker is untouched by elimination.
- Ring-out: Bob teleported beyond the arena edge with Alice's car as last
  bumper → Bob `eliminated=true, elimReason=ring_out`, Alice's car +25
  (0 → 25), Bob's wreck stays at (480,0) — no respawn — and 700 ms of Bob
  sending drive input moves it 0.0px (spectating).
- Early end: with only Alice's car active, `results` arrived with
  `cause=last_car_standing`, winner Alice (bot) with `eliminated=false` in
  her standing, Bob's standing showing `OUT/ring_out` — all well before 90 s.
- Reset: the following states show every car at health 100, none eliminated,
  timer back at 90.

## HTTP smoke (same build, real process on PORT=9998)
```
GET /health -> {"ok":true}
GET /       -> 200, 15274 bytes, <title>Bumper Cars — while your code generates</title>,
               26 matches for the new client markers (touchbar / tbtn / drawCar / outBanner / resultsPanel)
```

## Not tested in this pass
- Client visuals and touch controls in a real browser / on a real phone —
  JS is syntax-checked and the served page byte-checked, but the car
  rendering, smoke/flames, joystick and two-thumb layout have NOT been
  visually exercised. That verification belongs with the parent agent's
  browser/deploy step.
- The 90 s timer-expiry results path end-to-end (the early-end path through
  the same `endRound` code is now covered; see above).
