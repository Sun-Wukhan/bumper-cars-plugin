# Claude Code mod shell (stub)

Layout follows Claude Code plugin conventions researched for this project:
a plugin manifest (`.claude-plugin/plugin.json`) plus `hooks/hooks.json`.

## Intended route (not yet implemented)

Claude Code "mods" (v2.1.287+, installed via `/plugin`) can run inside
Claude Code and draw their own panes via `ui.render` hooks. The full version
of this shell would register a `ui.render` pane that draws a text-mode /
lightweight version of the bumper-cars arena while a turn is running, with
the shared WebSocket server (see `../../server/`) as the multiplayer backend,
so a terminal player and a VS Code player end up in the same room.

This stub only contains the manifest and a classic settings-style hooks file
(echo commands on `UserPromptSubmit` / `Stop`) as placeholders marking where
turn-start / turn-stop detection attaches. It makes no claim to render a game
in the terminal yet.
