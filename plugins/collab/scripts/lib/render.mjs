/**
 * Render helpers for collab plugin output.
 * Output is consumed by Claude Code (the host), so we format
 * for readability but keep it structured enough for Claude to parse.
 */

import { shortCommand } from "./app-server.mjs";

const RULE = "─".repeat(50);

/**
 * Render the setup report.
 */
export function renderSetupReport(report) {
  const check = (ok, label, detail) => `  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`;
  const lines = ["collab — setup check", RULE, ""];

  lines.push(check(true, "node", report.node.version));
  lines.push(check(report.codex.available && report.codex.versionOk, "codex", report.codex.version ?? report.codex.detail));
  lines.push(check(report.auth.ok, "codex auth", report.auth.detail));
  lines.push(check(true, "architect model (optional)", report.architect ?? "not set — set with /collab:config --set architect=opus"));
  lines.push("");

  if (report.ready) {
    lines.push("  ✓ Ready for collaboration.");
  } else {
    lines.push("  Next steps:");
    for (const step of report.nextSteps) lines.push(`    • ${step}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderCommands(commands, heading) {
  if (!commands?.length) return [];
  return ["", heading, ...commands.map((c) => `  $ ${shortCommand(c.command)} (exit ${c.exitCode ?? "?"})`)];
}

function renderChanges(changes, heading) {
  if (!changes?.length) return [];
  return [
    "",
    heading,
    ...changes.map((c) => (c.movePath ? `  rename: ${c.path} -> ${c.movePath}` : `  ${c.kind}: ${c.path}`)),
  ];
}

/**
 * Render a debate turn for Claude to read. The response text is omitted when
 * it was already streamed to stdout.
 */
export function renderCodexResponse(turn, opts = {}) {
  const lines = [];
  if (turn.text && !opts.streamed) lines.push("[CODEX RESPONSE]", turn.text);
  lines.push(...renderCommands(turn.commands, "[CODEX COMMANDS EXECUTED]"));
  lines.push(...renderChanges(turn.fileChanges, "[CODEX FILE CHANGES]"));
  if (turn.error) lines.push("", `[CODEX ERROR] ${turn.error}`);
  else if (!turn.text) lines.push("[CODEX] No response content captured.");
  return lines.length ? lines.join("\n").replace(/^\n+/, "") + "\n" : "";
}

/**
 * Render an execute turn: what this turn changed, plus the session-wide
 * file lists Claude should review.
 */
export function renderExecutionResult(turn, session, opts = {}) {
  const lines = [turn.error ? "[CODEX EXECUTION FAILED]" : "[CODEX EXECUTION COMPLETE]"];
  if (turn.error) lines.push(`Error: ${turn.error}`);
  lines.push(...renderChanges(turn.fileChanges, "Files changed this turn:"));
  lines.push(...renderCommands(turn.commands, "Commands run:"));

  const created = session.filesCreated ?? [];
  const modified = session.filesModified ?? [];
  lines.push("", `Session files to review — ${created.length} created, ${modified.length} modified:`);
  for (const f of created) lines.push(`  created: ${f}`);
  for (const f of modified) lines.push(`  modified: ${f}`);

  if (turn.text && !opts.streamed) lines.push("", "Codex summary:", turn.text);
  return lines.join("\n") + "\n";
}

/**
 * Render a session summary.
 */
export function renderSessionSummary(session) {
  const status =
    session.status === "completed" ? "✓ Collaboration complete" :
    session.status === "halted" ? "■ Session halted" :
    session.status === "rejected" ? "✗ Changes rejected" :
    "● Session active";
  const lines = [RULE, "", `  ${status}`, ""];

  if (session.decisions.length > 0) {
    lines.push("  Decisions:");
    for (const d of session.decisions) {
      lines.push(`    • ${d.description}${d.decidedBy ? ` (decided by ${d.decidedBy})` : ""}`);
    }
    lines.push("");
  }

  if (session.bugsCaught.length > 0) {
    lines.push(`  Bugs caught: ${session.bugsCaught.length}`);
    for (const bug of session.bugsCaught) lines.push(`    • ${bug}`);
    lines.push("");
  }

  const created = session.filesCreated?.length ?? 0;
  const modified = session.filesModified?.length ?? 0;
  if (created || modified) lines.push(`  Files: ${created} created, ${modified} modified`);

  lines.push(`  Session: ${session.id}`, `  Log: .collab/sessions/${session.id}.json`, "");
  return lines.join("\n");
}

/**
 * Render config.
 */
export function renderConfig(config) {
  return [
    "collab — configuration",
    RULE,
    "",
    `  architect model (Claude preference): ${config.architect ?? "(not set — will ask on first run)"}`,
    `  codex sandbox:      ${config.codexSandbox}`,
    `  debate sandbox:     ${config.codexDebateSandbox}`,
    `  turn timeout:       ${config.turnTimeoutMs / 1000}s`,
    `  idle heartbeat:     ${config.idleTimeoutMs / 1000}s`,
    "",
  ].join("\n");
}
