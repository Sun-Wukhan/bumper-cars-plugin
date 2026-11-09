# Codex shell (stub)

`hooks.json` here deliberately uses **only** Codex-supported hook events:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.
(Using Claude-only events in a Codex hooks file can break loading.)

## Why this is only a signal, not a game

Codex hooks are command hooks — they can run a command when a turn starts or
stops, but they **cannot draw UI** inside the Codex TUI. So the Codex route is:

1. Hook command signals a companion (the VS Code extension in `../vscode/`,
   or a small standalone companion window) that the agent is generating.
2. The companion shows the game (shared client in `../../client/`, backed by
   the shared WebSocket server).
3. On `Stop` — and immediately on any permission request — the companion
   hides/pauses the game and returns focus.

The echo commands in `hooks.json` are placeholders for that signal command.
