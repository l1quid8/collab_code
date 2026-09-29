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
- **Codex CLI 0.118.0 or later** (`npm install -g @openai/codex`) — verified against 0.158.0
- **ChatGPT subscription (incl. Free), OpenAI API key, or a custom model provider** configured in Codex
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

| Key | Default | Description |
|-----|---------|-------------|
| `architect` | unset | Which Claude model plans (`opus` or `sonnet`); a preference shown in setup |
| `codexSandbox` | `workspace-write` | Sandbox for execute turns |
| `codexDebateSandbox` | `read-only` | Sandbox for debate turns |
| `turnTimeoutMs` | `570000` | Max time for one Codex turn. Just under Claude Code's 10-minute Bash limit, so a slow turn is interrupted and reported instead of killed |
| `idleTimeoutMs` | `60000` | Print a heartbeat after this much silence from Codex |

Invalid values (e.g. `turnTimeoutMs=5m`) are rejected when set.

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

Sessions are saved to `.collab/sessions/`. The `.collab/` directory contains a `*` `.gitignore`, so it never shows up in `git status` or gets committed. You can:
- **Halt** a session mid-debate — halted sessions can be resumed with `session-activate <id>`
- **Reject** after review to discard all changes
- **Inspect** diffs before committing

During execute, the plugin tracks which files Codex created and modified — both its patches and files written by shell commands (lockfiles, generated code), via a `git status` baseline taken before execute. Files you already had uncommitted edits in are flagged rather than silently included, so a reject never discards your own work without asking.

If a Codex turn fails (rate limit, auth, timeout), the command exits non-zero and prints the real error, so Claude can surface it instead of treating it as an empty reply.

## Knowledge base

Cross-session decisions are stored in `.collab/knowledge.json`.

- Add decisions with `session-note --type decision --text "..."`
- When a session is completed, those decisions are persisted into the knowledge base
- Future `debate-start` prompts inject the top recent decisions as advisory `<past_decisions>` context

## Development

```
npm test
```

Runs the `node:test` suite against a fake `codex` binary that replays the app-server protocol, so no Codex install or OpenAI account is needed. To check compatibility with a new Codex release, compare `codex app-server generate-ts --out <dir>` against `plugins/collab/scripts/lib/app-server.mjs`.

### Releasing

1. Bump the version in `plugins/collab/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `package.json`.
2. Add a `## [x.y.z]` section to `CHANGELOG.md`.
3. On `main`, either run the **release** workflow from the Actions tab with version `x.y.z`, or push a `vx.y.z` tag. It runs the tests, checks the versions match, creates the tag if needed, and publishes the GitHub release with the changelog section as notes.

## License

MIT
