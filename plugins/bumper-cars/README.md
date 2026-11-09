# Bumper Cars — Claude Code plugin

Play multiplayer bumper cars while Claude generates code. When you send a
prompt, the game opens in your browser and auto-joins a Quick Match on the
public multiplayer server. When Claude needs your attention, the game
tells you — and stops your car. When the turn finishes, it tells you your
code is ready.

This is phase 1: standard Claude Code lifecycle **hooks** plus a tiny
local **bridge**. (An in-terminal Mod UI is a later phase.)

## How it works

Two small, zero-dependency Node scripts do everything:

- `scripts/hook.js` — invoked by the plugin's hooks on each lifecycle
  event. It writes the agent's status to a local state file and, when a
  turn starts, makes sure the bridge is running and opens the game.
- `scripts/bridge.js` — an http server bound to **127.0.0.1 only**. It
  serves the game page (`client/index.html`, bundled in this plugin) at
  `GET /`, the live agent status at `GET /status` (read fresh from the
  state file on every request), and `{"ok":true}` at `GET /health`.

The game page polls `/status` once a second and reacts:

| Hook event         | State       | What you see / what happens                                             |
| ------------------ | ----------- | ----------------------------------------------------------------------- |
| `SessionStart`     | `idle`      | Nothing yet. The bridge starts lazily on your first prompt.             |
| `UserPromptSubmit` | `busy`      | The game opens in your browser and auto-joins Quick Match.              |
| `Notification`     | `attention` | —                                                                       |
| `PermissionRequest`| `attention` | A pulsing red **warning banner**: **"⚠️ Claude needs you — check your terminal"**, and the tab title changes to flag it. The game **never pauses** — you keep driving normally; the warning is purely visual and clears when Claude no longer needs you. |
| `Stop`             | `done`      | Banner: **"✅ Your code is ready — this turn finished"**. Inputs stay live — finish your round. The banner clears on the next turn. |
| `SessionEnd`       | `idle`      | Overlays clear. The bridge is left running — it's stateless and tiny.   |

There is also a **`/bumper`** slash command that opens the game at any
time (it runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.js" open`).

The state file and the bridge's port record live in the plugin data
directory — `CLAUDE_PLUGIN_DATA` when Claude provides it, otherwise
`~/.bumper-cars/` — as `state.json` and `bridge.json`.

## Requirements

- Claude Code with plugin support.
- **Node.js on your PATH** (hooks and the bridge are plain Node scripts
  with zero dependencies — nothing to `npm install`).

## Environment variables

| Variable         | Default                                  | Meaning                                                                 |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `BUMPER_PORT`    | `37173`                                  | Preferred bridge port. If taken, the bridge tries up to 5 higher ports and records the actual port in `bridge.json`. |
| `BUMPER_NAME`    | your OS username                         | Player name used for auto-join.                                         |
| `BUMPER_NO_OPEN` | *(unset)*                                | If set, hooks still record state and start the bridge, but never open a browser window (useful for testing / CI). |
| `BUMPER_SERVER`  | `wss://bumper-cars-gfye.onrender.com`    | Multiplayer game-server URL the opened page connects to. Point it at your own server (e.g. `ws://localhost:8787`) to self-host. |

## Privacy

- The bridge binds to **127.0.0.1 only** — it is not reachable from your
  network.
- Hooks receive Claude's hook payload on stdin, but `hook.js` **never
  reads, logs, stores or transmits it**. The state file stores only the
  agent status (`idle`/`busy`/`attention`/`done`), the event name and a
  timestamp.
- The only network traffic the game makes is the multiplayer WebSocket
  connection to the game server (`BUMPER_SERVER`) — the same connection
  you'd make opening the game manually. No code, prompts or tool output
  are ever sent anywhere.

## Troubleshooting

- **The game doesn't open when I send a prompt.** Check Node is on your
  PATH (`node --version`). Check the bridge is up:
  `curl http://localhost:37173/health` → `{"ok":true}`. If another
  program owns 37173, look for the actual port in
  `~/.bumper-cars/bridge.json` (or your `CLAUDE_PLUGIN_DATA` directory).
- **The game opens but shows the join screen.** The opener passes
  `?auto=1&name=…&server=…`; if you opened the bridge URL manually
  without those parameters you'll get the normal join screen — just use
  Quick Match, or add `?auto=1`.
- **The "Claude needs you" warning won't clear.** It follows `/status`
  live: it clears as soon as the next hook event moves the state out of
  `attention` (answering Claude's prompt leads to `busy`/`done`). You can
  check the raw state at `http://localhost:<port>/status`.
- **Don't open a browser on every prompt.** Set `BUMPER_NO_OPEN=1` in
  your environment before starting Claude Code; open the game manually
  with `/bumper` (with the variable unset in that shell) or by visiting
  the bridge URL.
- **Wrong player name.** Set `BUMPER_NAME` before starting Claude Code.

## Uninstall

```
/plugin uninstall bumper-cars
```

Optionally delete the leftover state directory
(`~/.bumper-cars/`, or your `CLAUDE_PLUGIN_DATA` directory) and stop any
running bridge (`pkill -f bumper-cars/scripts/bridge.js` on macOS/Linux).
