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

---

# "Play a new game" choice + speed power-ups — 2026-11-09 (fourth pass)

Changes: (1) **New-game choice for eliminated players** — the join protocol
gains `exclude` (Quick Match only: the matchmaker never places the player
in the excluded room; join-by-code unaffected). The client's out banner is
now a choice — **▶ Play a new game** (quick-match elsewhere with
`exclude` = the room just left, keeping the joined name; the old socket is
closed by the existing `connect()`, so exactly one socket and the single
input interval remain, and server-side bot takeover treats it as a normal
disconnect) or **Keep spectating** (tracked per-round in `spectateChosen`;
the banner collapses to a minimal spectating note and stays collapsed
across state ticks until the player is alive again). The results panel
gets the same **▶ Play a new game** button. The previously landed local
client fixes (results-panel 6 s minimum display, stronger smoke, wreck /
label clamping) are untouched.
(2) **Random speed power-ups** — server spawns a golden `boost` token
every 8–15 s of round time (max 2 active/room, random position within 80%
of the arena radius; tokens carry a `type` field for future types). An
active car (human or bot) within 34 units collects it: acceleration AND
top speed ×1.6 for 8 s (`boostT` per car, counted down in `stepCar`,
cleared on elimination and on round reset). Snapshots now carry
`powerups: [{id,x,y,type}]` and per-car `boostLeft`. The client draws
pulsing ⚡ orbs, exhaust streaks/flames on boosted cars, and a "⚡ Ns"
countdown in the car's name label (next to its health bar).

## Syntax checks
```
server/server.js          node --check OK
tests/multiplayer.test.js node --check OK
client inline JS          node --check OK (extracted from client/index.html)
```

## Automated suite — `node tests/multiplayer.test.js` (23/23, exit 0)
All 15 previous checks pass **unchanged**, plus 8 new ones. The suite was
run **three consecutive times: 23/23 each time**. Verbatim output of the
first of those runs:
```
PASS  unit: collision resolves overlap & imparts impulse  impact=250.0 separation=44.0 scoreA=0 scoreB=21 vxA=-40.0 vxB=190.0
PASS  unit: stepCar moves car under thrust  x -0.0 -> 125.2
PASS  unit: high-impact collision damages both, slower car much more  impact=300.0 healthRammer=98.4 healthVictim=74.6 (victim dmg=25.4, rammer dmg=1.6)
PASS  unit: car dropped to <=0 health is WRECKED (eliminated)  fragile health=-5.4 eliminated=true reason=wrecked wreckerHealth=98.4
PASS  unit: boosted car accelerates harder and reaches a much higher speed than control  after 3s: control speed=301.9 x=666.2 | boosted speed=483.1 x=1065.9 boostLeft=5.0s
PASS  unit: boost expires back to 0 and the normal 360 top-speed cap applies again  boostT after 0.2s=0 speed from 500 after one step=360.0 (cap 360)
PASS  unit: eliminated car sitting on a token does not collect it  tokens left=1 deadBoostT=0
server started on ephemeral port 38653
PASS  both clients welcomed to same room  room=TEST idA=c12 idB=c16
PASS  B receives state containing BOTH players cars  cars in state=Alice,RoboRam-TEST(bot),CrashBot-TEST(bot),TurboTed-TEST(bot),Bob total=5
PASS  bots fill room to at least 4 cars  total cars=5
PASS  state snapshots include health=100 and eliminated=false for fresh cars  healths=100,100,100,100,100
PASS  A car position changed in state received by B after 1s input  A before=(0,180) after=(-146.8,180) moved=146.8px
PASS  after A disconnects, its car remains in state as a bot (not a dead/vanished car)  car id=c12 present=true isBot=true name=Alice (bot) total cars=5
PASS  bot-takeover car actually drives (moves over time)  bot moved=17.1px from (-275,180)
PASS  ring-out eliminates the car (no respawn) and pays +25 to the last bumper  eliminated=true reason=ring_out scorer 0 -> 25 bobPos=(480,0)
PASS  eliminated player input is ignored (car stays frozen, spectating)  pos before=(480,0) after=(480,0)
PASS  round ends early with the sole survivor as winner (before the 90s timer)  cause=last_car_standing winner=Alice (bot)(c12) survivorEliminated=false standings=Alice (bot):25, RoboRam-TEST:0:OUT/wrecked, CrashBot-TEST:0:OUT/wrecked, TurboTed-TEST:0:OUT/wrecked, Bob:0:OUT/ring_out
PASS  new round resets every car to health=100, eliminated=false  cars=Alice (bot)@100, RoboRam-TEST@100, CrashBot-TEST@100, TurboTed-TEST@100, Bob@100 timeLeft=90
PASS  quick match with exclude skips the excluded room and receives state  seeded room=EXCL quickRoom=TEST cars=6
PASS  eliminated player starts a new game in a DIFFERENT room as an active car (health=100)  wasEliminated=true/wrecked oldRoom=TEST newRoom=EXCL active=true health=100
PASS  power-up token placed in the room appears in state snapshots  token id=p1 at=(0,-300) type=boost totalTokens=1
PASS  driving onto a token consumes it and sets boostLeft > 0  boostLeft=8s tokenGone=true
PASS  spawner creates a new token when the spawn timer fires (shortened-interval hook)  tokens=1 first=p2/boost at=(233.2,137.1)

TOTAL: 23/23 passed
```

Key numbers:
- Boost physics: identical input for 3 s → control 301.9 u/s / x=666.2 vs
  boosted 483.1 u/s / x=1065.9 (1.60× the speed, as designed), with 5.0 s
  of boost still remaining.
- Expiry: `boostT` 0.12 → 0 after 0.2 s of stepping, and a 500 u/s car is
  immediately back under the normal 360 cap (360.0 after one step).
- Exclusion: seeded room `EXCL`; a quick-match join with `exclude=EXCL`
  was welcomed to `TEST` (a different open room) with 6 cars in state.
  Quick match *without* `exclude` is the pre-existing path, covered by
  the original checks above and the earlier smoke tests.
- New-game flow (end to end): Bob was wreck-eliminated in `TEST`,
  observed his own elimination in state, then rejoined by quick match
  with `exclude=TEST` and landed in `EXCL` as an active car at health 100.
- Pickup: a token placed at (0,−300) appeared in snapshots
  (`p1 … type=boost`); teleporting the player's car onto it consumed the
  token and set `boostLeft=8`.
- Spawner: with the room's token list cleared and `spawnIn` shortened to
  0.05 s (the direct-manipulation hook, not a real 8–15 s wait), the next
  states contained a fresh token (`p2/boost`) at a random in-arena spot.

## HTTP smoke (same build, real process on PORT=9997)
```
GET /health -> {"ok":true}
GET /       -> 200, 19,783 bytes; markers present: outNewGame ×2, outSpectate ×2,
               resultsNewGame ×2, playNewGame ×3, exclude ×5, powerups, boostLeft ×2, ⚡ ×3
```

## Not tested in this pass
- The new client UI (out-banner buttons, results-panel button, token /
  boost rendering) in a real browser — syntax-checked and byte-checked
  only; the protocol behaviour behind the buttons is what the Node-client
  tests exercise (the button's exact join message is the one tested).
- Organic bot pickups of randomly spawned tokens in live play (bots are
  eligible via the same `collectPowerups` path the tests drive; no
  bot-specific pickup was staged).
- The natural 8–15 s spawn cadence over a full round (the spawner was
  verified via the shortened-timer hook instead of real-time waits).

---

# Fourth pass — Claude Code plugin (hooks + bridge), 2026-11-09

New surface: repo-root marketplace (`.claude-plugin/marketplace.json`),
the plugin at `plugins/bumper-cars/` (manifest, `hooks/hooks.json`,
zero-dependency `scripts/hook.js` + `scripts/bridge.js`, `commands/bumper.md`,
bundled `client/index.html`), plus client additions (auto-join, bridge
status polling with attention/done overlays, paused input on attention,
localhost → public-server fallback). All local: no push, no deploy, no
Claude install (the `claude` CLI is not available in this environment, so
hook events were simulated by invoking `hook.js` directly with the exact
arguments `hooks.json` uses, and the browser-open call itself — suppressed
here with `BUMPER_NO_OPEN=1` — was not executed against a real browser).

## JSON validity + syntax

```
JSON OK: .claude-plugin/marketplace.json
JSON OK: plugins/bumper-cars/.claude-plugin/plugin.json
JSON OK: plugins/bumper-cars/hooks/hooks.json
node --check OK: hook.js / bridge.js / server.js / tests
node --check OK: client inline script (main) and (plugin copy)
client copies byte-identical: client/index.html == plugins/bumper-cars/client/index.html (cmp)
```

## Game suite (client changes must not break it)

```
node tests/multiplayer.test.js -> TOTAL: 23/23 passed
```
(All 23 pre-existing checks, including boosts and exclusions — see the
earlier sections for the full list.)

## Hook simulation (temp HOME=/tmp/bc-home.*, BUMPER_PORT=37291, BUMPER_NO_OPEN=1)

State file (`$HOME/.bumper-cars/state.json`) after each invocation —
exactly the required sequence idle→busy→attention→attention→done:

```
after session-start      -> {"agent":"idle","event":"session-start",...}
after user-prompt-submit -> {"agent":"busy","event":"user-prompt-submit",...}
after notification       -> {"agent":"attention","event":"notification",...}
after permission-request -> {"agent":"attention","event":"permission-request",...}
after stop               -> {"agent":"done","event":"stop",...}
```

The `user-prompt-submit` run also started the bridge with the browser
suppressed (the documented `BUMPER_NO_OPEN=1` assertion): the spawned
bridge wrote `{"port":37291,...}` to `bridge.json`,
`GET http://127.0.0.1:37291/health` -> `{"ok":true}`, and `/status`
reflected the state file (`done` after the sequence).

PascalCase event names (what `hooks.json` actually passes) verified too:
`SessionStart`→idle, `PermissionRequest`→attention, `Stop`→done,
`SessionEnd`→idle.

## Bridge end-to-end (fresh bridge, BUMPER_PORT=37293, temp CLAUDE_PLUGIN_DATA)

```
bridge log: bumper-cars bridge listening on http://127.0.0.1:37293
GET /health -> {"ok":true}
GET /status (no state file) -> {"agent":"idle","event":null,"updatedAt":null}
GET /       -> 200, 23,067 bytes; served page byte-identical to the
               plugin's client/index.html; markers: auto x9,
               attentionOverlay x4, "Claude needs you" x2, doneBanner x4,
               "Your code is ready" x1, /status x2,
               bumper-cars-gfye.onrender.com x1
after hook user-prompt-submit -> /status = {"agent":"busy",...}
after hook notification       -> /status = {"agent":"attention",...}
after hook stop               -> /status = {"agent":"done",...}
GET /nope   -> HTTP 404
```

## Not tested in this pass (honest)

- Installing the plugin into a real Claude Code (`/plugin marketplace add` /
  `/plugin install`) and observing hooks fire from Claude itself — the
  `claude` CLI is not installed here. `hooks.json` follows the documented
  format and the invoked command line was exercised verbatim by hand.
- The browser-open call in `hook.js` (platform opener) — never executed
  without `BUMPER_NO_OPEN` in this sandbox.
- The client overlays/auto-join in a real browser — the served page is
  syntax- and byte-checked with all markers present, and the /status
  values they react to were driven live through the bridge above; the
  visual behaviour itself belongs to the on-machine install test.

---

# Fifth pass — smarter bots, dual controls, attention = warning (Nov 9, 2026)

Navid's feedback after real play: (1) "the AI just bump each other and
keep going in circles"; (2) arrow keys AND WASD should both work;
(3) when Claude needs attention the game must NOT pause — keep playing,
show a warning instead. All three addressed; local only, not yet pushed.

## What was wrong with the old bot

`botDrive` re-picked the NEAREST car every tick (no stickiness), aimed
at its CURRENT position (pure pursuit — the classic orbiting pursuit
curve against a moving target), applied full throttle whenever the
target was within ~69° of the nose (wide powered arcs, never braked),
and only thought about the edge within 90 units of the rim.

## New bot decision structure (server/server.js)

Per tick, in priority order: (1) edge survival with hysteresis (recover
beyond 70% radius with outward heading/velocity, or beyond 85%
regardless; resume inside 60%); (2) anti-stall reverse-and-turn burst;
(3) power-up detour (token <300 away beats a chase target >210 away);
(4) chase by INTERCEPTION — aim at target pos + vel × lead (≤0.85 s,
aim clamped inside the arena) — with throttle discipline: brake/reverse
when the target is >~106° off the nose, coast mid-turn (damping
tightens the radius), full power only when aligned, coast on a very
close fast final approach so a near miss doesn't blow past and loop.
Targets are sticky 1.9–3.0 s and scored by effective distance (humans
×1.0 vs bots ×1.35, wounded cars pulled in, score leader ×0.85).
Progress = closing ≥12 units or scoring; 4 s without progress forces
the manoeuvre + a re-target excluding the current one. Per-bot
personality (aggro / turn deadband / stickiness) derives from botSeed.

## Client changes (both copies, byte-identical)

- Keys: arrows and WASD were both present in the keymap, but shared ONE
  boolean per direction — hold ArrowUp + KeyW, release ArrowUp, and the
  throttle cut out while KeyW was still held. Now physical keys are
  tracked in a Set by e.code and kb is derived (kb.up = ArrowUp ||
  KeyW, etc.); arrows preventDefault (no page scroll), Space
  preventDefaults except on buttons/inputs, and a window-blur handler
  clears the set so keys can't stick.
- Attention: the input sender no longer zeroes keys — it sends
  currentKeys() unconditionally. The old `#attentionOverlay` is now
  `#attentionWarning`: pulsing red banner ("⚠️ Claude needs you —
  check your terminal"), pointer-events:none so it can never block a
  click, plus document.title switches to "⚠️ Claude needs you —
  Bumper Cars" while attention lasts and restores afterwards. Polling
  mechanics unchanged (localhost-only, 1 s, stops after 3 failures);
  the 'done' banner is untouched.
- Docs: plugin README events table + troubleshooting and the root
  README events table reworded — the game warns, never pauses. Grep
  confirms no residual "inputs are paused / blocking overlay / all keys
  forced / car coasts" wording.

## Test receipts

Original suite: `node tests/multiplayer.test.js` → **23/23 passed**
(before and after the bot rewrite).

New suite `node tests/bot-ai.test.js` (3 unit + 4 integration), run 3×
after the recovery fix below — **7/7 in all three runs**:

```
unit: edge override (>85% radius) brakes + turns to centre
      input={up:false,down:true,left:false,right:true}
unit: interception steers LEFT where pure pursuit steers RIGHT
      (target crossing at +250 u/s; pursuit desired 1.28 rad,
       intercept desired 0.41 rad, nose 0.9)
unit: knockback sweep, 18 worst cases (r0 150/220/280 x vRad
      200/260/320 x nose tangential/straight-out): worst peak radius
      392 < 422 ring-out line; every case back inside r<280
integration A: lone bot vs parked dummy — contact after 2.2 s,
      dummy health 100 -> 77.6 (identical geometry all 3 runs)
integration B: 15 s brawl, 3 bots + parked human — bot ring-outs 0/0/0,
      bot wrecks 0; max bot score 39/32/38, min bot health 58/55/74
      (they are fighting — scores and damage — just not self-eliminating)
integration C: two bots placed head-on — contact after 0.9 s,
      scores 20-23 vs 0, healths 88-89/88-89 (no orbiting)
integration D: bot teleported to r=345 with a 150 u/s outward shove,
      nose pointing out — peak radius 394, back inside r<280 after
      1.8 s, no ring-out (all 3 runs)
```

Client greps: copies byte-identical (cmp); extracted script passes
`node --check`; keymap contains both schemes and `kb.up` derives from
`pressedCodes.has('ArrowUp')||pressedCodes.has('KeyW')`; the only
remaining `agentStatus==='attention'` conditional in the file is the
document.title setter; `attentionOverlay` occurs 0 times.

## The honest part: a failure the 3× runs caught, and the fix

Bot-suite run 3 of the FIRST version failed integration B with
`botRingOuts=1`. Rather than re-rolling, a forensic harness (6 rooms ×
20 s brawls, per-bot radius/velocity trails + lastHitBy/lastHitAt)
reproduced 1 ring-out in 120 room-seconds and identified it: victim
RoboRam, last hit 3,948 ms before exiting (NOT a fresh knockout blow).
Trail: from r=146 it travelled outward at a sustained ~270 u/s (it was
powered/chasing outward), crossed the recovery trigger at r≈285 still
doing ~280 u/s outward, and then its outward speed decayed at roughly
the pure-damping rate until it crossed 422 — i.e. while its nose
crossed the recovery COAST band (1.15–2.35 rad off the centre
direction) neither brake nor inward thrust engaged, and damping alone
cannot arrest a 280 u/s slide from r=285. Fix: recovery has NO coast
band — nose in the outward hemisphere => reverse thrust (which points
inward) + damping actively kill the slide; nose with an inward
component => drive in. After the fix: knockback sweep worst peak
397 -> 392; forensic harness 2 × (6 rooms × 20 s) = 240 room-seconds
with **0** bot ring-outs; suite 7/7 three times (above).

## Not tested in this pass (honest)

- The warning banner's visual appearance in a real browser (pulsing,
  title swap) — code is syntax-checked and grep-verified; the visual
  pass belongs to the on-machine plugin session, as before.
- Keyboard behaviour in a real browser — the Set-based tracking is
  plain DOM event code, syntax-checked; no browser here can hold keys.
- Bot quality over full 90 s rounds against a skilled human — the
  tests prove contact-making, anti-orbit and edge survival on bounded
  windows, not long-game balance.
