---
name: codex-prompting
description: Prompting conventions for routing architect plans and review feedback to Codex
user-invocable: false
---

# Codex Prompting

Use concise, deterministic prompts when handing work to Codex.

## Debate prompts
- Start with a role line describing Codex as a peer reviewer.
- Include the full plan verbatim in a dedicated section.
- Ask for concrete pushback on correctness, complexity, and missing risks.
- Require file-path evidence when possible.

## Execution prompts
- Mark the plan as converged and approved.
- Request complete implementation, not partial slices.
- Require validation via build/tests before completion.
- Ask for explicit changed-file summaries.

## Fix prompts
- Quote each review issue precisely.
- Require Codex to address every issue in-order.
- Require rerunning validation and reporting results.

## Output hygiene
- Prefer explicit checklists over open-ended language.
- Avoid ambiguous words like "maybe", "probably", "roughly".
- Keep one canonical plan version per turn to avoid drift.
