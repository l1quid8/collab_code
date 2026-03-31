---
description: Check collaboration runtime prerequisites and Codex auth.
allowed-tools: Bash(node:*), Bash(npm:*)
---

Run setup checks:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" setup
```

If setup is not ready, surface the exact missing steps to the user and stop.
