#!/usr/bin/env node
'use strict';
/*
 * Bumper Cars — Claude Code hook entry point.
 *
 * Invoked by Claude Code hooks as:  node hook.js <EventName>
 * (kebab-case event names, e.g. "user-prompt-submit", are also accepted.)
 *
 * What it does:
 *  - Records the agent's status in a small local state file:
 *      <CLAUDE_PLUGIN_DATA or ~/.bumper-cars>/state.json
 *      { agent: 'idle'|'busy'|'attention'|'done', event, updatedAt }
 *    The local bridge serves that file at GET /status and the game page
 *    polls it to show/hide its overlays and to show a warning banner
 *    when Claude needs the user's attention (the game never pauses).
 *  - Only on the explicit `open` invocation (the /bumper command):
 *    makes sure the bridge is running, then opens the game in the
 *    default browser (unless BUMPER_NO_OPEN is set). Lifecycle events
 *    NEVER open a window — opening on every prompt spammed a new tab
 *    and a new game per prompt (removed Nov 10, 2026, at Navid's word).
 *
 * Privacy: Claude passes a hook payload on stdin. This script NEVER reads,
 * logs, stores or transmits it — the state file contains only the agent
 * status, the event name and a timestamp.
 *
 * A hook must never break Claude's turn: everything is wrapped, errors
 * are swallowed, and the process always exits 0 quickly.
 *
 * Env vars:
 *   CLAUDE_PLUGIN_DATA  state directory (Claude sets this for plugins)
 *   BUMPER_PORT         preferred bridge port (default 37173)
 *   BUMPER_NAME         player name for auto-join (default: OS username)
 *   BUMPER_SERVER       multiplayer server URL
 *                       (default wss://bumper-cars-gfye.onrender.com)
 *   BUMPER_NO_OPEN      if set, never open a browser window
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PORT = parseInt(process.env.BUMPER_PORT, 10) || 37173;
const GAME_SERVER =
  process.env.BUMPER_SERVER || 'wss://bumper-cars-gfye.onrender.com';

function stateDir() {
  return (
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.bumper-cars')
  );
}

function writeState(agent, event) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const data = { agent, event, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(data));
  } catch (_) {
    /* state is best-effort */
  }
}

function readBridgePort() {
  try {
    const raw = fs.readFileSync(
      path.join(stateDir(), 'bridge.json'),
      'utf8'
    );
    const port = parseInt(JSON.parse(raw).port, 10);
    if (port > 0) return port;
  } catch (_) {
    /* no bridge record yet */
  }
  return DEFAULT_PORT;
}

function health(port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
        (res) => {
          res.resume();
          finish(res.statusCode === 200);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
    } catch (_) {
      finish(false);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBridge() {
  // Already running? (bridge.json records the actual port it bound.)
  if (await health(readBridgePort(), 400)) return readBridgePort();
  if (await health(DEFAULT_PORT, 400)) return DEFAULT_PORT;

  // Start it detached; it picks the first free port in
  // [BUMPER_PORT, BUMPER_PORT+5] and records it in bridge.json.
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'bridge.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    return DEFAULT_PORT;
  }

  // Poll briefly for it to come up (hooks have a generous 10s budget).
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const port = readBridgePort();
    if (await health(port, 300)) return port;
    if (await health(DEFAULT_PORT, 300)) return DEFAULT_PORT;
  }
  return readBridgePort();
}

function playerName() {
  if (process.env.BUMPER_NAME) return process.env.BUMPER_NAME;
  try {
    const u = os.userInfo().username;
    if (u) return u;
  } catch (_) {
    /* fall through */
  }
  return 'Player';
}

function openGame(port) {
  if (process.env.BUMPER_NO_OPEN) return;
  const url =
    'http://localhost:' +
    port +
    '/?auto=1&name=' +
    encodeURIComponent(playerName()) +
    '&server=' +
    encodeURIComponent(GAME_SERVER);
  try {
    let child;
    if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    /* opening the browser is best-effort */
  }
}

// Event name (PascalCase or kebab-case) -> agent status to record.
// `open` is not a Claude event: it is the manual invocation used by the
// /bumper slash command and only ensures the bridge + opens the game.
const TRANSITIONS = {
  'session-start': 'idle',
  sessionstart: 'idle',
  'user-prompt-submit': 'busy',
  userpromptsubmit: 'busy',
  notification: 'attention',
  'permission-request': 'attention',
  permissionrequest: 'attention',
  stop: 'done',
  'session-end': 'idle',
  sessionend: 'idle',
};

async function main() {
  const rawEvent = String(process.argv[2] || '').trim();
  const key = rawEvent.toLowerCase();

  // NOTE: stdin (Claude's hook payload) is deliberately never read.

  if (key === 'open') {
    const port = await ensureBridge();
    openGame(port);
    return;
  }

  const agent = TRANSITIONS[key];
  if (agent) writeState(agent, rawEvent);

  // All other events leave the bridge running: it is stateless (it reads
  // the state file fresh per request) and tiny, so there is nothing to
  // clean up at SessionEnd.
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
