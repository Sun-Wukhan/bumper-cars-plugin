#!/usr/bin/env node
'use strict';
/*
 * Bumper Cars — local bridge.
 *
 * A zero-dependency Node http server bound to 127.0.0.1 ONLY. It exists so
 * the game page can learn what Claude is doing without any code, prompt or
 * output ever leaving the machine:
 *
 *   GET /        -> the plugin's own copy of the game client (client/index.html)
 *   GET /status  -> the agent status, read FRESH from the state file on
 *                   every request: { agent, event, updatedAt }
 *                   ({ agent: 'idle' } when no state file exists yet)
 *   GET /health  -> {"ok":true}
 *   everything else -> 404
 *
 * The state file lives at <CLAUDE_PLUGIN_DATA or ~/.bumper-cars>/state.json
 * and is written by hook.js; this server only reads it.
 *
 * Port: BUMPER_PORT (default 37173). If the port is taken, the bridge
 * tries the next port, up to BUMPER_PORT+5; if all six are busy it exits
 * quietly (another bridge is almost certainly already serving). After a
 * successful bind it records the actual port in <state dir>/bridge.json
 * so hook.js knows where to point the browser. The game page polls
 * /status same-origin, so it never needs to know the port.
 *
 * Env vars: CLAUDE_PLUGIN_DATA, BUMPER_PORT (same meanings as in hook.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BASE_PORT = parseInt(process.env.BUMPER_PORT, 10) || 37173;
const MAX_TRIES = 6; // BASE_PORT .. BASE_PORT+5
const CLIENT_HTML = path.join(__dirname, '..', 'client', 'index.html');

function stateDir() {
  return (
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.bumper-cars')
  );
}

function readStatus() {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir(), 'state.json'), 'utf8')
    );
    return {
      agent: data.agent || 'idle',
      event: data.event || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (_) {
    return { agent: 'idle', event: null, updatedAt: null };
  }
}

function recordPort(port) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bridge.json'),
      JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() })
    );
  } catch (_) {
    /* best-effort */
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(readStatus()));
    return;
  }
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(CLIENT_HTML, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('bumper-cars: client not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

let tries = 0;
function listen(port) {
  tries++;
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && tries < MAX_TRIES) {
      listen(port + 1);
    } else {
      // Port range exhausted or unexpected error: exit quietly — a
      // bridge that cannot bind must never spam or break anything.
      process.exit(0);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    recordPort(port);
    console.log('bumper-cars bridge listening on http://127.0.0.1:' + port);
  });
}

listen(BASE_PORT);
