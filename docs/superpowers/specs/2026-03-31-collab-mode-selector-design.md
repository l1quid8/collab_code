# Collab Mode Selector & Rich Debate Prompts

**Date:** 2026-03-31
**Status:** Approved
**Scope:** `plugins/collab/commands/start.md` only

---

## Problem

The collab plugin always runs a full debate phase regardless of task complexity. For small changes this is wasteful — the debate overhead costs more than it saves. There is also no way to inject steering direction inline when approving or halting a debate turn; the user must go through a separate Interject step.

---

## Solution

Two changes to `start.md`:

1. **Mode selector** — after Claude writes the plan, ask the user how to proceed before calling `debate-start`
2. **Rich per-turn prompt** — replace the `Approve / Interject / Halt` prompt with a richer version that has an inline text field on every option

---

## Section 1: Mode Selector (Phase 1 → Phase 2 transition)

After Claude presents the plan, present an `AskUserQuestion`:

> *"Plan ready — how do you want to proceed?"*

| Option | Description | Notes field |
|--------|-------------|-------------|
| **Full debate** | Codex reviews your plan; debate until converged | Focus areas for Codex |
| **One round** | Codex reviews once, you decide after seeing the response | Focus areas |
| **Execute directly** | Skip debate, send to Codex for implementation now | Extra context for Codex |

**Note injection:**
- Full debate / One round → notes prepended as `[User context: <notes>]` at the top of the `debate-start` prompt
- Execute directly → notes appended to the plan passed into `execute`

**If "Execute directly":** skip Phase 2 entirely, proceed straight to Phase 3 with the plan + any notes.

---

## Section 2: Rich Per-Turn Debate Prompt

After every Codex response (whether from `debate-start` or `debate-turn`), replace the existing `Approve / Interject / Halt` prompt with:

> *"How do you want to proceed?"*

| Option | Description | Notes field |
|--------|-------------|-------------|
| **Proceed to execute** | Send the converged plan to Codex for implementation | Final context or constraints for Codex |
| **Continue debating** | Send another turn to Codex | Direction for next turn — Claude incorporates this |
| **Halt** | Stop and save session | Reason (saved via `session-note`) |

**Note injection:**
- **Continue debating** with notes → Claude weaves the user's direction into its architect response before calling `debate-turn`. The notes are not passed verbatim — Claude interprets and integrates them.
- **Proceed to execute** with notes → appended to the converged plan as `[User additions: <notes>]` in the `execute` call
- **Halt** with notes → saved to session via `session-note --type note --text "<notes>"`

This prompt appears after every turn regardless of which mode was selected at the mode selector.

---

## Section 3: One Round vs Full Debate

"One round" and "Full debate" follow the same code path — both call `debate-start` and then enter the per-turn loop. The distinction is **framing only**:

- **One round** signals Claude to keep the first exchange focused and concise, not exhaustive. Claude should surface the most important concerns rather than an exhaustive review.
- **Full debate** signals Claude to go deep — full pushback, edge cases, alternatives.

After the first Codex response, both modes present the same per-turn prompt. The user decides whether to continue.

---

## What Changes

**Single file:** `plugins/collab/commands/start.md`

Three targeted edits:
1. **End of Phase 1** — insert mode selector `AskUserQuestion` before Phase 2
2. **Phase 2** — rewrite the approval loop to use the rich per-turn prompt with note injection instructions
3. **Important Rules** — add: *"One round means keep the first exchange focused and concise. The per-turn prompt still appears after — the user decides whether to continue."*

**No changes to:**
- `collab-runtime.mjs` — all runtime subcommands already exist
- Any lib files
- Any other skill or command files

---

## Risks

- **Note injection ambiguity:** If the user writes conflicting direction in notes vs. what Claude already planned to say, Claude must use judgment. The rule is: user notes take precedence, Claude integrates them into its voice.
- **"Execute directly" skips all Codex review:** This is intentional and the user's explicit choice. No guard needed.
