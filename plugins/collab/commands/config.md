---
description: Configure collaboration runtime settings.
argument-hint: '[--set key=value | --get key | --show]'
allowed-tools: Bash(node:*)
---

Use the collab runtime configuration command directly.

Examples:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" config --show
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" config --get architect
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" config --set architect=opus
```

If no arguments are provided, default to `--show`.
