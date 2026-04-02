# collab — Claude ↔ Codex collaboration plugin

Three-way collaboration between Claude (architect), Codex (implementer), and you (arbiter).

Claude plans. Codex challenges. They debate until they agree. Then Codex builds it. Claude reviews it. You ship it.

## What you get

- `/collab:start <task>` — start a collaboration session
- `/collab:setup` — check if Codex is installed and ready
- `/collab:config` — set architect model (Opus or Sonnet) and other preferences
- `/collab:status` — check current session status

## Requirements

- **Claude Code** (you're already here)
- **ChatGPT subscription (incl. Free) or OpenAI API key** for Codex
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add l1quid8/collab_code
```

Install the plugin:

```
/plugin install collab@collab-code
```

Reload plugins:

```
/reload-plugins
```

Then run:

```
/collab:setup
```

## How it works

### Phase 1: Plan
Claude reads your codebase and produces a comprehensive implementation plan. Files, dependencies, tradeoffs, risks.

### Phase 2: Debate
The plan goes to Codex. Codex reads the codebase (read-only) and pushes back. Claude responds. They argue. You can interject at any point to add context or correct either agent. **This loop runs until you approve the plan.**

Nothing touches disk during debate. Codex runs in read-only sandbox. All commands Codex runs and files it reads are visible to you and Claude.

### Phase 3: Execute
The converged plan goes to Codex with write access. Codex builds the whole thing — creates files, modifies existing ones, installs dependencies, runs builds.

### Phase 4: Review
Claude reviews everything Codex built. Reads every file, checks for bugs, verifies correctness against the plan. If issues are found, they go back to Codex for fixing. Repeat until clean.

### Final gate
You decide: commit, inspect diffs, or reject everything.

## Your role as arbiter

You only make decisions at three points:
1. **During debate** — approve the plan, interject with context, or halt
2. **During Claude Code tool use** — approve/deny file reads (standard Claude Code flow)
3. **After review** — commit, inspect, or reject

Everything else flows between Claude and Codex automatically.

## The debate loop

```
     ┌────────────────────────────────┐
     │                                │
     ▼                                │
claude proposes ──► codex responds ───┤
     ▲                                │
     │      you interject ────────────┤
     │                                │
     │      they respond ─────────────┘
     │
     │   (loops until you approve or halt)
     │
┌────┴─────┐
│ approve  │──────► codex executes
└──────────┘
```

There's no limit on debate rounds. Go 50 rounds if the architecture warrants it.

## Visibility

Everything Codex does is visible to both you and Claude:
- Files Codex reads during debate
- Commands Codex runs (npm ls, git log, etc.)
- Build output during execution
- Test results

This is intentional. No black-box delegation.

## Configuration

Set your architect model:
```
/collab:config --set architect=opus
/collab:config --set architect=sonnet
```

View all config:
```
/collab:config --show
```

### Sandbox mode

Codex runs inside a sandbox that controls what it can do on your system. The default is `workspace-write`, which lets Codex read anything but only write within your project directory.

Available modes:

| Mode | Debate | Execute | Description |
|------|--------|---------|-------------|
| `read-only` | default | - | No writes. Used for debate phase. |
| `workspace-write` | - | default | Read anything, write within project only. |
| `danger-full-access` | - | - | No restrictions. Full system access. |

**If Codex hits a sandbox blocking error during execution** (e.g. trying to install global packages, write outside the project, or access restricted paths), switch to `danger-full-access`:

```
/collab:config --set codexSandbox=danger-full-access
```

This gives Codex unrestricted access — only use this when you trust the task and environment.

You can also change the debate sandbox if needed:
```
/collab:config --set codexDebateSandbox=workspace-write
```

## Session management

Sessions are saved to `.collab/sessions/`. You can:
- **Halt** a session mid-debate
- **Reject** after review to discard all changes
- **Inspect** diffs before committing
Halt saves the session state to `.collab/sessions/`. Halted sessions can be resumed with `session-activate <id>`.

## Knowledge base

Cross-session decisions are stored in `.collab/knowledge.json`.

- Add decisions with `session-note --type decision --text "..."`
- When a session is completed, those decisions are persisted into the knowledge base
- Future `debate-start` prompts inject the top recent decisions as advisory `<past_decisions>` context

## License

MIT
