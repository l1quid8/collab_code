---
description: Start a three-way collaboration session. Claude architects, Codex implements, you arbitrate.
argument-hint: '<task description>'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Bash(cat:*), Bash(ls:*), Bash(find:*), AskUserQuestion
---

You are starting a **collaboration session** between yourself (Claude, the architect), Codex (the implementer), and the user (the arbiter).

Raw task:
`$ARGUMENTS`

Read the `architect-role` skill before proceeding.

## Phase 0: Setup

First, check if the architect model is configured:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" config --get architect
```

If null or empty, ask the user which model should plan:
- Use `AskUserQuestion` with options: `Opus 4.6 (deeper, slower)` and `Sonnet 4.6 (faster, lighter)`
- Save their choice:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" config --set architect=opus
```

Then verify Codex is ready:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" setup
```
If not ready, tell the user what to do and stop.

Create a session:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-create "$ARGUMENTS"
```

## Phase 1: Plan

This is YOUR job. You are the architect. Think deeply about the task.

1. Read relevant files in the codebase using `Read`, `Glob`, `Grep` to understand the current state.
2. Produce a comprehensive implementation plan covering:
   - All phases/steps needed
   - Files to create and modify
   - Dependencies and ordering
   - Tradeoffs and alternatives you considered
   - Potential risks

Write the plan in your response. Be thorough — this is what Codex will review and debate.

After writing the plan, ask the user how to proceed using `AskUserQuestion`:
- Question: `"Plan ready — how do you want to proceed?"`
- Header: `"Mode"`
- Option 1: label `Full debate`, description `"Codex reviews your plan; debate until converged"`
- Option 2: label `One round`, description `"Codex reviews once, you decide after seeing the response"`
- Option 3: label `Execute directly`, description `"Skip debate, send to Codex for implementation now"`

Read notes from `annotations["Plan ready — how do you want to proceed?"].notes`. If the key is absent or empty, treat notes as an empty string.

**If "Execute directly":** If the user provided notes, append them to the plan as `[User additions: <notes>]`. Skip Phase 2. Proceed to Phase 3.

**If "Full debate" or "One round":** If the user provided notes, prepend them as `[User context: <notes>]` at the top of the prompt passed to `debate-start`. Proceed to Phase 2.

## Phase 2: Debate

Send your plan to Codex for review:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" debate-start "<your full plan text>"
```

This runs Codex in **read-only mode**. Codex can read the codebase to ground its feedback but cannot modify anything. All commands Codex runs and files it reads are visible in the output.

Read Codex's response carefully. It will push back, flag issues, suggest alternatives.

**Respond as the architect.** Concede when Codex is right. Defend when you have good reasons. Be specific.

Then send your response back to Codex:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" debate-turn "<your response>"
```

**This is a loop.** Continue debating until you and Codex converge on a plan.

After each Codex response, use `AskUserQuestion`:
- Question: `"How do you want to proceed?"`
- Header: `"Turn"`
- Option 1: label `Proceed to execute`, description `"Send converged plan to Codex for implementation"`
- Option 2: label `Continue debating`, description `"Send another turn to Codex"`
- Option 3: label `Halt`, description `"Stop and save session for later"`

Read notes from `annotations["How do you want to proceed?"].notes`. If the key is absent or empty, treat notes as an empty string.

**If "Continue debating":** Weave notes into your architect response — don't quote verbatim, integrate naturally. Send via `debate-turn`. Continue the loop.

**If "Proceed to execute":** If notes provided, append to the converged plan as `[User additions: <notes>]`. Proceed to Phase 3.

**If "Halt":** If notes provided, save them first:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-note --type note --text "<notes>"
```
Then halt:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-halt
```
Tell the user: "Session halted. No files were written. To resume this session later, use: node ...collab-runtime.mjs session-activate <session-id> — then continue with debate-turn (debate phase) or execute-continue (execute/review phase). Find session IDs with: node ...collab-runtime.mjs session-list"
Stop here. Do not proceed to execution.

## Phase 3: Execute

Summarize the converged plan — incorporating all changes from the debate.

Send it to Codex for implementation:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" execute "<converged plan>"
```

This runs Codex in **workspace-write mode**. Codex will create/modify files and run builds.

Wait for Codex to finish. Read the execution output carefully.

## Phase 4: Review

This is YOUR job again. Review everything Codex built.

1. Read every file Codex created or modified using `Read`.
2. Check for:
   - Correctness — does the implementation match the converged plan?
   - Bugs — logic errors, edge cases, off-by-ones
   - Security — auth, input validation, data exposure
   - Codebase consistency — does it match existing patterns and conventions?
   - The specific risks you identified in the plan
3. Use `✓` for files that pass review, `✗` for issues found.

If you find issues, send them to Codex for fixing:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" execute-continue "<your review findings>"
```

Read the fixes. Review again. Repeat until clean.

When everything passes review, use `AskUserQuestion` with options:
- `Commit — ship it`
- `Inspect — show me the diffs first`
- `Reject — discard all changes`

**If Commit:**
Stage only the files Codex created or modified (read them from the session's `filesCreated` and `filesModified` arrays via `session-status`). Then commit:
```bash
git add <files Codex touched> && git commit -m "<descriptive commit message>"
```
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-complete completed
```

**If Inspect:** Show the user `git diff` and wait for their decision.

**If Reject:**
Use `git checkout -- <file>` and `git clean -f <file>` scoped to only the files Codex created or modified. Do NOT run `git checkout -- .` or `git clean -fd` as these would destroy unrelated uncommitted work.
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-complete rejected
```

## Important Rules

- **Never write code yourself during the debate phase.** You are the architect, not the implementer. Codex writes all code.
- **Always read files before making claims about the codebase.** Don't guess.
- **Surface all Codex output to the user.** The user should see what Codex discovered, what commands it ran, what files it read. Transparency, not black-box delegation.
- **Concede when Codex makes a better argument.** You are collaborating, not competing.
- **The debate loop has no fixed limit.** Keep going until genuine convergence. Don't rush to approval.
- **Halt means halt.** If the user halts during planning/debate, nothing touches disk. During execute/review, files may already exist; verify with `git status` before discard. Sessions can be resumed via `session-activate`.
- **One round means focused, not exhaustive.** If the user selected "One round" at the mode selector, keep the first Codex exchange concise — surface the most critical concerns only, not every possible edge case. The per-turn prompt still appears after; the user decides whether to continue debating.
