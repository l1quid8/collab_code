---
description: Show active collaboration session status.
allowed-tools: Bash(node:*)
---

Report the active session state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-status
```

If no active session exists, tell the user to start one with `/collab:start <task>`.

To inspect historical sessions and resume an active one:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-list
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-activate <session-id>
```
