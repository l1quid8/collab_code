# Collab Mode Selector & Rich Debate Prompts — Implementation Plan

> **Note (v0.1.10):** AskUserQuestion per-option "notes field:" syntax was invalid. Corrected in v0.1.10 — see start.md and spec doc for the current pattern.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mode selector after the plan phase and replace the `Approve / Interject / Halt` prompt with a richer per-turn prompt that has inline text input on every option.

**Architecture:** Single-file edit to `plugins/collab/commands/start.md`. Three surgical changes: insert mode selector at end of Phase 1, rewrite Phase 2 debate loop, add one Important Rule. No runtime changes.

**Tech Stack:** Markdown prompt file (no build step, no tests — verification is diff review + manual smoke check)

---

## File Map

| Action | File | Lines affected |
|--------|------|----------------|
| Modify | `plugins/collab/commands/start.md` | 51–52 (insert), 53–87 (rewrite), 151 (append) |

---

### Task 1: Insert mode selector at end of Phase 1

**Files:**
- Modify: `plugins/collab/commands/start.md:51-52`

- [ ] **Step 1: Make the edit**

Replace line 51–52 (the last line of Phase 1 and the blank line before Phase 2):

Current content at lines 51–52:
```
Write the plan in your response. Be thorough — this is what Codex will review and debate.

## Phase 2: Debate
```

Replace with:
```
Write the plan in your response. Be thorough — this is what Codex will review and debate.

After writing the plan, ask the user how to proceed using `AskUserQuestion`:
- Question: `"Plan ready — how do you want to proceed?"`
- Option 1: label `Full debate`, description `"Codex reviews your plan; debate until converged"`, notes field: `"Focus areas for Codex (optional)"`
- Option 2: label `One round`, description `"Codex reviews once, you decide after seeing the response"`, notes field: `"Focus areas (optional)"`
- Option 3: label `Execute directly`, description `"Skip debate, send to Codex for implementation now"`, notes field: `"Extra context for Codex (optional)"`

**If "Execute directly":** If the user provided notes, append them to the plan as `[User additions: <notes>]`. Skip Phase 2. Proceed to Phase 3.

**If "Full debate" or "One round":** If the user provided notes, prepend them as `[User context: <notes>]` at the top of the prompt passed to `debate-start`. Proceed to Phase 2.

## Phase 2: Debate
```

- [ ] **Step 2: Verify the edit**

Run:
```bash
sed -n '49,70p' plugins/collab/commands/start.md
```

Expected output — Phase 1 ends with the mode selector block, followed by `## Phase 2: Debate`:
```
Write the plan in your response. Be thorough — this is what Codex will review and debate.

After writing the plan, ask the user how to proceed using `AskUserQuestion`:
...
**If "Full debate" or "One round":** ...

## Phase 2: Debate
```

- [ ] **Step 3: Commit**

```bash
git add plugins/collab/commands/start.md
git commit -m "feat: add mode selector after plan phase in collab:start"
```

---

### Task 2: Rewrite Phase 2 debate loop

**Files:**
- Modify: `plugins/collab/commands/start.md` — the `After each exchange` block through `If the user chooses Approve`

- [ ] **Step 1: Make the edit**

Find and replace the entire approval block (lines 73–87 in the original file):

Current content:
```
After each exchange, use `AskUserQuestion` with three options:
- `Approve — send converged plan to Codex for execution`
- `Interject — I want to add context`
- `Halt — stop everything, save plan for later`

**If the user chooses Interject:** Read their input. Incorporate it. Send it to Codex via another `debate-turn`. Continue the loop.

**If the user chooses Halt:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab-runtime.mjs" session-halt
```
Tell the user: "Session halted. No files were written. To resume this session later, use: node ...collab-runtime.mjs session-activate <session-id> — then continue with debate-turn (debate phase) or execute-continue (execute/review phase). Find session IDs with: node ...collab-runtime.mjs session-list"
Stop here. Do not proceed to execution.

**If the user chooses Approve:** Proceed to Phase 3.
```

Replace with:
```
After each Codex response, use `AskUserQuestion`:
- Question: `"How do you want to proceed?"`
- Option 1: label `Proceed to execute`, description `"Send converged plan to Codex for implementation"`, notes field: `"Final context or constraints for Codex (optional)"`
- Option 2: label `Continue debating`, description `"Send another turn to Codex"`, notes field: `"Direction for next turn — Claude will incorporate this"`
- Option 3: label `Halt`, description `"Stop and save session for later"`, notes field: `"Reason (optional)"`

**If "Continue debating":** Read the user's notes. Weave their direction into your architect response — don't quote verbatim, integrate it naturally. Send via `debate-turn`. Continue the loop.

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
```

- [ ] **Step 2: Verify the edit**

Run:
```bash
grep -n "AskUserQuestion\|Interject\|Approve\|Proceed to execute\|Continue debating" plugins/collab/commands/start.md
```

Expected: no lines containing `Interject` or `Approve — send converged`. Lines containing `Proceed to execute` and `Continue debating` should appear in the Phase 2 section.

- [ ] **Step 3: Commit**

```bash
git add plugins/collab/commands/start.md
git commit -m "feat: replace Approve/Interject/Halt with rich per-turn prompt in collab:start"
```

---

### Task 3: Add One Round rule to Important Rules

**Files:**
- Modify: `plugins/collab/commands/start.md` — end of Important Rules section

- [ ] **Step 1: Make the edit**

Append to the end of the Important Rules section (after the `Halt means halt` line):

Current last line:
```
- **Halt means halt.** If the user halts during planning/debate, nothing touches disk. During execute/review, files may already exist; verify with `git status` before discard. Sessions can be resumed via `session-activate`.
```

Append after it:
```
- **One round means focused, not exhaustive.** If the user selected "One round" at the mode selector, keep the first Codex exchange concise — surface the most critical concerns only, not every possible edge case. The per-turn prompt still appears after; the user decides whether to continue debating.
```

- [ ] **Step 2: Verify the edit**

Run:
```bash
tail -6 plugins/collab/commands/start.md
```

Expected: last bullet is the new "One round means focused" rule.

- [ ] **Step 3: Full file sanity check**

Run:
```bash
wc -l plugins/collab/commands/start.md
```

Expected: approximately 165–175 lines (original was 152; we added ~18 lines net).

Run:
```bash
grep -c "AskUserQuestion" plugins/collab/commands/start.md
```

Expected: 3 (Phase 0 architect config, Phase 1 mode selector, Phase 2 per-turn prompt).

- [ ] **Step 4: Commit**

```bash
git add plugins/collab/commands/start.md
git commit -m "feat: add One Round rule to collab:start Important Rules"
```

---

### Task 4: Final review and push

- [ ] **Step 1: Read the full file and verify all three sections look correct**

```bash
cat -n plugins/collab/commands/start.md
```

Check:
- Phase 1 ends with the mode selector `AskUserQuestion` block and both branch instructions
- Phase 2 has the new per-turn prompt replacing `Approve / Interject / Halt`
- Important Rules ends with the "One round" rule
- No stray references to `Interject` or `Approve — send converged`

- [ ] **Step 2: Push**

```bash
git push
```
