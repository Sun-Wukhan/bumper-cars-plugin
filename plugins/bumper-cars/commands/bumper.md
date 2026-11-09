---
description: Open Bumper Cars — play while Claude works
allowed-tools: Bash
---

Run exactly this command using the Bash tool, and nothing else:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.js" open
```

That invocation makes sure the local Bumper Cars bridge is running and
opens the game in the user's default browser, auto-joined to a Quick
Match. After running it, briefly confirm to the user that the game is
opening. Do not run any other commands, read any files, or do any other
work for this command.
