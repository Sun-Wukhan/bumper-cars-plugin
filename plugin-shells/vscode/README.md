# VS Code shell (stub)

Minimal skeleton: `package.json` + `extension.js` register `Bumper Cars: Open Game`,
which opens `client/index.html` in a webview panel beside the editor.

## How wait-state detection will wire in (not yet implemented)

Both Claude Code and Codex expose lifecycle hooks. A small hook command
(installed by the user into their Claude Code / Codex hook config) writes a
signal file / sends a local message that this extension watches:

- `SessionStart` / `UserPromptSubmit` / `PreToolUse` → generation likely running → **show game panel** (after ~3s, so short turns don't flash it)
- `Stop` → turn finished → **pause / hide panel and return focus to the agent view**
- `PermissionRequest` → **hide immediately and return focus** — the game must never sit on top of an approval prompt

That focus rule is non-negotiable in the design. Until the hook bridge exists,
the game is opened manually with the command above.
