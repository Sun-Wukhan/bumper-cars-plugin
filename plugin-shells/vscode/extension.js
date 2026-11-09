'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
// Stub shell: opens the shared game client in a webview panel.
// Wait-state wiring (see README) will call openPanel()/panel.dispose() automatically.
let panel = null;
function openPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return panel; }
  panel = vscode.window.createWebviewPanel('bumperCars', 'Bumper Cars', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true });
  const clientPath = path.join(context.extensionPath, '..', '..', 'client', 'index.html');
  let html;
  try { html = fs.readFileSync(clientPath, 'utf8'); }
  catch { html = '<h1>Bumper Cars</h1><p>Start the server (server/server.js) and open client/index.html — see project README.</p>'; }
  panel.webview.html = html;
  panel.onDidDispose(() => { panel = null; });
  return panel;
}
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('bumperCars.open', () => openPanel(context)));
}
function deactivate() {}
module.exports = { activate, deactivate };
