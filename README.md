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

Client server address logic (in `client/index.html`):

- `?server=ws://HOST:PORT` in the URL always wins (dev / LAN override, e.g.
  `?server=ws://192.168.1.5:8787` for a friend on your LAN).
- Served over `http:`/`https:` → connects to the same host over `ws:`/`wss:`.
- Opened as a `file://` page → falls back to `ws://localhost:8787`
  (you can still open `client/index.html` directly that way).

Play: enter a name → **Quick Match**, or enter a 4-letter room code → **Join by code**.
The room code is shown in-game — share it so friends land in your exact room.
Controls: arrow keys / WASD on desktop, on-screen buttons on touch devices.

## Architecture

```
client/index.html        vanilla JS + canvas, no dependencies. Renders server snapshots.
        │  HTTP (client + /health) and WebSocket (JSON) — SAME port/origin
server/server.js         Node + `ws`. AUTHORITATIVE: owns physics, scoring, timers, bots.
                         Also serves client/index.html at GET / and {"ok":true} at GET /health.
render.yaml              Render Blueprint: one free web service for the whole game.
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
- Arena: circle, radius 400 units. Cars are circles (r=22).
- Driving: steering (left/right) + thrust/reverse (up/down), arcade damping, max speed 360 u/s.
- Collisions: elastic impulse between cars. Impacts above 80 u/s score
  `round(impact / 12)` points for the faster car, with a 300 ms per-pair cooldown.
- Ring-out: a car pushed/driven beyond the arena edge scores **+25** for whoever
  last bumped it (within 3 s) and respawns at the centre.
- Rounds: 90 seconds, then a `results` message with standings, scores reset, auto-restart.
- Rooms: max 6 cars. Quick Match reuses a room with space, otherwise creates one
  with a random 4-letter code. Join-by-code creates the room if it doesn't exist.
- Bots: rooms are filled with bots to at least 4 cars from the start. When a real
  player disconnects mid-round, **a bot immediately takes over their exact car**
  (same id, name gets a `(bot)` suffix) — matches never contain a dead car.
  When the last human leaves, the room is deleted.

## Protocol (JSON over WebSocket)

Client → server:

```json
{ "type": "join",  "name": "Alice", "room": "TEST" }   // room optional: omit/empty = Quick Match
{ "type": "input", "keys": { "up": true, "down": false, "left": false, "right": true } }
```

Server → client:

```json
{ "type": "welcome", "id": "c4", "room": "TEST", "color": "#e74c3c", "name": "Alice", "arena": { "radius": 400 } }
{ "type": "state",   "room": "TEST", "timeLeft": 87, "arena": { "radius": 400 },
  "cars": [ { "id": "c4", "name": "Alice", "color": "#e74c3c", "isBot": false,
              "x": 180, "y": 12.5, "vx": 40, "vy": 120, "angle": 1.57, "score": 12 } ] }
{ "type": "results", "room": "TEST", "standings": [ { "id": "c4", "name": "Alice", "score": 62, "isBot": false } ] }
{ "type": "error",   "message": "room full" }
```

## Tests

```bash
node tests/multiplayer.test.js
```

See `TEST-RESULTS.md` for the verified run (two real WebSocket clients,
movement seen cross-client, collision unit test, bot takeover).

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
- Plugin shells are honest stubs (see their READMEs), not published extensions.
- The round timer was not waited out end-to-end (90 s) in automated tests; results/reset code shares the same tick path that was tested.
