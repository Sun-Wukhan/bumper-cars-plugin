# Bumper Cars — play while Claude Code / Codex generates

A multiplayer bumper-cars game designed to fill the wait while an AI coding
agent is generating. Real people can join the same room and play against each
other; bots fill the rest of the arena so a match is never empty or dead.

## Run it locally

One Node server does everything on one port — it serves the game client
over HTTP and runs the multiplayer WebSocket on that same port:

```bash
cd server
npm install         # installs `ws` (already present if node_modules/ exists)
node server.js      # http://localhost:8787  (PORT=9999 node server.js to change)
```

Then open **http://localhost:8787** in a browser. That's it — no separate
static server needed: `GET /` returns the game client and the client
connects its WebSocket back to the same origin (`ws://localhost:8787`).
`GET /health` returns `{"ok":true}`.

Client server address logic (in `client/index.html`), in order:

- `?server=ws://HOST:PORT` in the URL always wins (dev / LAN override, e.g.
  `?server=ws://192.168.1.5:8787` for a friend on your LAN; this is also
  how the Claude Code plugin's opener points the page at the real server).
- Served over `https:` → connects to the same host over `wss:`.
- Served from `localhost` / `127.0.0.1` (e.g. by the Claude plugin's local
  bridge) → the public multiplayer server
  `wss://bumper-cars-gfye.onrender.com`, because a local page is not a
  game server.
- Served over plain `http:` from another host → same host over `ws:`.
- Opened as a `file://` page → falls back to `ws://localhost:8787`
  (you can still open `client/index.html` directly that way).

The page also supports `?auto=1&name=<name>&room=<CODE>` — preset the
player name and join immediately (Quick Match, or the given room) with no
click. The Claude Code plugin's opener uses this.

Play: enter a name → **Quick Match**, or enter a 4-letter room code → **Join by code**.
The room code is shown in-game — share it so friends land in your exact room.
Controls: arrow keys / WASD on desktop. On touch devices you get a two-thumb
layout — **◀ ▶ steering** bottom-left, **GAS / BRAKE pedals** bottom-right
(large multi-touch buttons: hold GAS with one thumb while steering with the
other) — plus a **drag joystick**: touch and drag anywhere on the arena and
the car drives toward the drag direction. All three input sources combine.
The in-game layout fits a phone screen without scrolling, and the canvas
renders at devicePixelRatio for crisp graphics on retina displays.

## Install as a Claude Code plugin

This repo doubles as a Claude Code plugin marketplace (marketplace name:
`bumper-cars`). In a Claude Code session, type these **with the leading
slash** — without it, Claude treats the line as a chat message and the
plugin system never sees it:

```
/plugin marketplace add Sun-Wukhan/bumper-cars-plugin
/plugin install bumper-cars@bumper-cars
```

The first command should reply `Successfully added marketplace:
bumper-cars`. The `@bumper-cars` suffix on the second is required: it is
`<plugin>@<marketplace>`, per Anthropic's plugin docs.

Shell alternative (run in a normal terminal, no session needed):

```
claude plugin marketplace add Sun-Wukhan/bumper-cars-plugin
claude plugin install bumper-cars@bumper-cars
```

If `/plugin` does not appear in Claude Code's command autocomplete, your
Claude Code predates plugins — run `claude update`, restart it, and retry.

**Requirements:** Claude Code with plugin support, and Node.js on your
PATH (the plugin's hooks and bridge are zero-dependency Node scripts).

What happens once it's installed:

| Claude event                    | What happens                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| You submit a prompt             | The game opens in your browser and auto-joins Quick Match on the public server. |
| Claude needs your attention (notification / permission request) | The game shows a pulsing **"⚠️ Claude needs you — check your terminal"** warning banner and flags the tab title — but never pauses: you keep driving until you've dealt with it. |
| The turn finishes               | A **"✅ Your code is ready"** banner appears; you can finish your round.      |
| Any time                        | Type `/bumper` to open the game manually.                                    |

Under the hood: plugin hooks (`plugins/bumper-cars/hooks/hooks.json`)
record the agent's status in a local state file, and a tiny local bridge
(bound to 127.0.0.1 only) serves the game page and that status to the
browser, which polls it once a second. No code, prompts or tool output
ever leave your machine — see `plugins/bumper-cars/README.md` for the
full design and privacy notes.

Environment variables (set them before starting Claude Code):

| Variable         | Default                               | Meaning                                        |
| ---------------- | ------------------------------------- | ---------------------------------------------- |
| `BUMPER_PORT`    | `37173`                               | Preferred port for the local bridge.           |
| `BUMPER_NAME`    | your OS username                      | Player name for auto-join.                     |
| `BUMPER_NO_OPEN` | *(unset)*                             | If set, never open a browser window automatically. |
| `BUMPER_SERVER`  | `wss://bumper-cars-gfye.onrender.com` | Multiplayer server to connect to (self-hosting). |

Uninstall:

```
/plugin uninstall bumper-cars
```

Phase 1 is hooks + bridge, as above. An in-terminal Mod UI (a game view
inside Claude Code's own interface, using the newer Mods API) is a
**later phase** and is not part of this plugin yet.

## Architecture

```
client/index.html        vanilla JS + canvas, no dependencies. Renders server snapshots.
        │  HTTP (client + /health) and WebSocket (JSON) — SAME port/origin
server/server.js         Node + `ws`. AUTHORITATIVE: owns physics, scoring, timers, bots.
                         Also serves client/index.html at GET / and {"ok":true} at GET /health.
render.yaml              Render Blueprint: one free web service for the whole game.
.claude-plugin/marketplace.json
                         turns this repo into a Claude Code plugin marketplace.
plugins/bumper-cars/     the real Claude Code plugin (phase 1: hooks + local bridge,
                         bundled client copy, /bumper command). See its README.
plugin-shells/vscode/    stub VS Code extension: opens the client in a webview panel.
plugin-shells/claude-mod/ stub Claude Code plugin (manifest + hooks) for the ui.render pane route.
plugin-shells/codex/     stub Codex hooks (signal only — Codex hooks can't draw UI).
```

No root `package.json` on purpose: `render.yaml` builds and starts from
`server/` explicitly (`cd server && npm install` / `cd server && node server.js`),
so dependencies and the entry point live in exactly one place (`server/package.json`)
and can't drift between a root manifest and the server manifest.

The server is the single source of truth: clients only send input, never positions.
That makes the same core reusable from every shell (browser, VS Code webview,
Claude terminal pane) and keeps cheating / desync out of scope for v1.

- Tick: 20 Hz authoritative physics, full state snapshot broadcast each tick.
- Arena: circle, radius 400 units. Cars are circles (r=22) for physics;
  the client draws them as proper top-down cars (body, cabin, wheels,
  headlights) rotated to their heading, with a health bar and name above each.
- Driving: steering (left/right) + thrust/reverse (up/down), arcade damping, max speed 360 u/s.
- Collisions: elastic impulse between cars. Impacts above 80 u/s score
  `round(impact / 12)` points for the faster car, with a 300 ms per-pair cooldown.
- **Health & damage:** every car has **100 health**. A scoring hit (impact
  > 80 u/s, same threshold and 300 ms cooldown as scoring) also deals damage:
  `damage = 0.09 × impact × (otherSpeed + 20) / (ownSpeed + otherSpeed + 40)`,
  using the pre-impact speeds. The slower car — the one being rammed — takes
  most of the damage; the rammer takes a small share (the +20 floor), never
  zero. Examples: a 300 u/s ram into a stationary car deals ≈25 to the victim
  and ≈1.6 to the rammer; an equal-speed 250 u/s head-on deals ≈11 to each.
- **Eliminations (out for the rest of the round, no respawn):**
  - *Ring-out:* a car pushed/driven beyond the arena edge is **out**. Whoever
    last bumped it (within 3 s) still scores **+25**.
  - *Wrecked:* a car whose health reaches **0** is **out**.
  Eliminated cars leave the physics simulation and are shown as grey wrecks;
  their score is kept. An eliminated human **spectates** — their input is
  ignored — until the next round, but spectating is a **choice**: the
  "You're out" banner offers **▶ Play a new game** (leave immediately and
  quick-match into a *different* room — see `exclude` in the protocol
  below) or **Keep spectating** (the banner collapses to a minimal
  spectating note until the next round). The results panel has the same
  **▶ Play a new game** button. Leaving works like disconnecting: if the
  car were still active a bot would take it over — an eliminated wreck
  simply stays behind. (Bot takeover on disconnect only applies to cars
  that are still in the round.)
- **Power-ups (speed boost):** a golden ⚡ token spawns at a random spot
  inside the arena (within 80% of the radius) every **8–15 seconds** of
  round time, with at most **2 tokens active** per room. Any **active**
  car — human or bot — that drives over a token (centre distance < 34)
  collects it: its acceleration **and** top speed are multiplied by
  **×1.6 for 8 seconds** (`boostLeft` in the state snapshot counts down).
  Eliminated cars cannot collect tokens; elimination and round reset both
  clear the boost. Only the `boost` type exists for now, but tokens carry
  a `type` field so more types need no protocol change. Note the synergy:
  a boosted ram reaches higher impact speeds, so it deals more damage
  under the damage formula above — no special case required.
- **Rounds & winning:** rounds last 90 seconds, but end **early** as soon as
  at most one active car remains: the sole survivor wins outright, regardless
  of score. (If a pile-up eliminates everyone simultaneously, the highest
  score wins posthumously.) On timer expiry the winner is the highest score;
  eliminated cars keep their scores, but a surviving car wins ties over an
  eliminated one. The `results` message carries the winner, a `cause`
  (`last_car_standing` / `time`), and each car's final score, health and
  elimination status/reason. A new round then resets scores, health,
  eliminations and positions and auto-restarts.
- Rooms: max 6 cars. Quick Match reuses a room with space, otherwise creates one
  with a random 4-letter code. Join-by-code creates the room if it doesn't exist.
  A Quick Match join may carry `exclude` (a room code): the matchmaker will
  never place that player into the excluded room — it picks another open room
  or creates a fresh one. Explicit join-by-code is unaffected (`exclude` is
  ignored when a room is named).
- Bots: rooms are filled with bots to at least 4 cars from the start. When a real
  player disconnects mid-round, **a bot immediately takes over their exact car**
  (same id, name gets a `(bot)` suffix) — matches never contain a dead car.
  When the last human leaves, the room is deleted.

## Protocol (JSON over WebSocket)

Client → server:

```json
{ "type": "join",  "name": "Alice", "room": "TEST" }   // room optional: omit/empty = Quick Match
{ "type": "join",  "name": "Alice", "exclude": "TEST" } // Quick Match, but never into room TEST
{ "type": "input", "keys": { "up": true, "down": false, "left": false, "right": true } }
```

Server → client:

```json
{ "type": "welcome", "id": "c4", "room": "TEST", "color": "#e74c3c", "name": "Alice", "arena": { "radius": 400 } }
{ "type": "state",   "room": "TEST", "timeLeft": 87, "arena": { "radius": 400 },
  "cars": [ { "id": "c4", "name": "Alice", "color": "#e74c3c", "isBot": false,
              "x": 180, "y": 12.5, "vx": 40, "vy": 120, "angle": 1.57, "score": 12,
              "health": 87, "eliminated": false, "elimReason": null, "boostLeft": 5.5 } ],
  "powerups": [ { "id": "p1", "x": -120, "y": 240, "type": "boost" } ] }
{ "type": "results", "room": "TEST", "cause": "last_car_standing",
  "winner": { "id": "c4", "name": "Alice", "score": 62 },
  "standings": [ { "id": "c4", "name": "Alice", "score": 62, "isBot": false, "health": 41, "eliminated": false, "elimReason": null },
                 { "id": "c5", "name": "Bob", "score": 30, "isBot": false, "health": 0, "eliminated": true, "elimReason": "wrecked" } ] }
{ "type": "error",   "message": "room full" }
```

## Tests

```bash
node tests/multiplayer.test.js
```

See `TEST-RESULTS.md` for the verified runs (two real WebSocket clients,
movement seen cross-client, collision/scoring unit tests, bot takeover, plus
the elimination suite: damage split, wreck elimination, ring-out elimination
with the +25 credit and ignored spectator input, early round end with a sole
survivor, and new-round reset — plus the "Play a new game" exclusion checks
and the power-up suite: token in state, pickup → boost, boosted-vs-control
speed, boost expiry, no pickup when eliminated, and the token spawner).

## Deploy to Render (public internet play)

The project is Render-ready as **one web service** (`render.yaml` at the
repo root) — prepared and verified locally; the actual deploy is a separate
step done from Navid's Render account (not done here).

To deploy:

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, select the repo. Render reads
   `render.yaml` and creates one free web service named `bumper-cars` with:
   - Build: `cd server && npm install`
   - Start: `cd server && node server.js`
   - Health check: `/health`
   - `NODE_ENV=production`
3. Render injects `PORT` automatically (the server reads `process.env.PORT`,
   defaulting to 8787 locally) and gives the service one public URL, e.g.
   **https://bumper-cars.onrender.com** (the exact subdomain is whatever
   Render assigns at creation).
4. Players just open that URL. The page is served from the service itself,
   so the client automatically connects back over
   **`wss://<same host>`** — same origin, same port, TLS handled by Render.
   No `?server=` parameter and no client configuration needed.

**Cold-start caveat (free plan):** a free Render web service sleeps when
idle. The first player after a quiet period waits for the service to wake
(typically tens of seconds, showing as a slow page load / delayed
connection), after which play is normal until it idles out again. The
health check at `/health` confirms liveness once it's awake.

After the deploy, the remaining wiring is the plugin shells' wait-state
hooks opening the client automatically (design in
`plugin-shells/vscode/README.md`).

Until that deploy is run, the game is LAN/local only — do not expect a
friend outside your network to connect.

## Limitations (honest)

- Full snapshots at 20 Hz, no delta compression or client prediction/interpolation — fine at this scale, would want interpolation for a polished feel.
- No accounts, persistence, or anti-cheat beyond server authority; scores live only for the round.
- The shells under `plugin-shells/` are honest stubs (see their READMEs), not published extensions. The Claude Code plugin under `plugins/bumper-cars/` is real (phase 1, hooks + bridge), but it has been validated by simulating hook events and driving the bridge directly — not by installing it into a live Claude Code, because the Claude CLI is not available in the environment where it was built.
- The 90 s timer expiry itself was not waited out end-to-end in automated tests, but the results broadcast + round reset it triggers is the same `endRound` path now verified via the early-end (last-car-standing) tests.
- Client visuals (car rendering, damage smoke/flames, mobile layout) are code-reviewed and syntax-checked but not yet visually verified in a real browser — that check belongs with the deploy step.
