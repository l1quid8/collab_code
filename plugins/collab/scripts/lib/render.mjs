/**
 * Render helpers for collab plugin output.
 * Output is consumed by Claude Code (the host), so we format
 * for readability but keep it structured enough for Claude to parse.
 */

/**
 * Render the setup report.
 */
export function renderSetupReport(report) {
  const lines = [];
  lines.push("collab — setup check");
  lines.push("─".repeat(50));
  lines.push("");

  const check = (ok, label, detail) =>
    `  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`;

  lines.push(check(report.node.available, "node", report.node.version));
  lines.push(check(report.npm?.available, "npm", report.npm?.version));
  lines.push(check(report.codex.available, "codex", report.codex.version ?? report.codex.detail));
  lines.push(check(report.auth.loggedIn, "codex auth", report.auth.detail));
  lines.push(
    check(
      true,
      "architect model (optional)",
      report.architect ?? "not set — set with /collab:config --set architect=opus"
    )
  );
  lines.push("");

  if (report.ready) {
    lines.push("  ✓ Ready for collaboration.");
  } else {
    lines.push("  Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`    • ${step}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render a codex response for Claude to read.
 * Prefixes with CODEX so Claude can distinguish agent output.
 */
export function renderCodexResponse(turnResult, opts = {}) {
  const lines = [];
  const streamed = !!opts.streamed;

  if (turnResult.error) {
    lines.push(`[CODEX ERROR] ${turnResult.error}`);
    return lines.join("\n");
  }

  if (turnResult.lastMessage && !streamed) {
    lines.push("[CODEX RESPONSE]");
    lines.push(turnResult.lastMessage);
  }

  if (turnResult.reviewText) {
    lines.push("");
    lines.push("[CODEX REVIEW]");
    lines.push(turnResult.reviewText);
  }

  // Surface what Codex read/ran during the turn — visibility for Claude
  const commandExecutions = turnResult.commandExecutions ?? [];
  if (commandExecutions.length > 0) {
    lines.push("");
    lines.push("[CODEX COMMANDS EXECUTED]");
    for (const cmd of commandExecutions) {
      const command = cmd.command ?? "";
      const exit = cmd.exitCode ?? cmd.exit_code ?? "?";
      lines.push(`  $ ${command} (exit ${exit})`);
    }
  }

  const fileChanges = turnResult.fileChanges ?? [];
  if (fileChanges.length > 0) {
    lines.push("");
    lines.push("[CODEX FILE CHANGES]");
    for (const fc of fileChanges) {
      for (const change of fc.changes ?? []) {
        lines.push(`  ${change.action ?? "edit"}: ${change.path ?? "unknown"}`);
      }
    }
  }

  if (!turnResult.lastMessage && !turnResult.reviewText) {
    lines.push("[CODEX] No response content captured.");
  }

  return lines.join("\n");
}

/**
 * Render execution result summary.
 */
export function renderExecutionResult(turnResult, opts = {}) {
  const lines = [];
  const streamed = !!opts.streamed;
  lines.push("[CODEX EXECUTION COMPLETE]");
  lines.push("");

  if (turnResult.error) {
    lines.push(`Error: ${turnResult.error}`);
    return lines.join("\n");
  }

  const fileChanges = turnResult.fileChanges ?? [];
  if (fileChanges.length > 0) {
    lines.push("Files changed:");
    for (const fc of fileChanges) {
      for (const change of fc.changes ?? []) {
        lines.push(`  ${change.action ?? "edit"}: ${change.path ?? "unknown"}`);
      }
    }
  }

  const commandExecutions = turnResult.commandExecutions ?? [];
  if (commandExecutions.length > 0) {
    lines.push("");
    lines.push("Commands run:");
    for (const cmd of commandExecutions) {
      const command = cmd.command ?? "";
      const exit = cmd.exitCode ?? cmd.exit_code ?? "?";
      lines.push(`  $ ${command} (exit ${exit})`);
    }
  }

  if (turnResult.lastMessage && !streamed) {
    lines.push("");
    lines.push("Codex summary:");
    lines.push(turnResult.lastMessage);
  }

  return lines.join("\n");
}

/**
 * Render a session summary.
 */
export function renderSessionSummary(session) {
  const lines = [];
  lines.push("─".repeat(50));
  lines.push("");

  const status = session.status === "completed" ? "✓ Collaboration complete" :
                 session.status === "halted" ? "■ Session halted" :
                 session.status === "rejected" ? "✗ Changes rejected" :
                 "● Session active";

  lines.push(`  ${status}`);
  lines.push("");

  if (session.decisions.length > 0) {
    lines.push("  Decisions:");
    for (const d of session.decisions) {
      const by = d.decidedBy ? ` (decided by ${d.decidedBy})` : "";
      lines.push(`    • ${d.description}${by}`);
    }
    lines.push("");
  }

  if (session.bugsCaught.length > 0) {
    lines.push(`  Bugs caught: ${session.bugsCaught.length}`);
    for (const bug of session.bugsCaught) {
      lines.push(`    • ${bug}`);
    }
    lines.push("");
  }

  const created = session.filesCreated?.length ?? 0;
  const modified = session.filesModified?.length ?? 0;
  if (created || modified) {
    lines.push(`  Files: ${created} created, ${modified} modified`);
  }

  lines.push(`  Session: ${session.id}`);
  lines.push(`  Log: .collab/sessions/${session.id}.json`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render config.
 */
export function renderConfig(config) {
  const lines = [];
  lines.push("collab — configuration");
  lines.push("─".repeat(50));
  lines.push("");
  lines.push(
    `  architect model (Claude preference): ${config.architect ?? "(not set — will ask on first run)"}`
  );
  lines.push(`  codex sandbox:      ${config.codexSandbox}`);
  lines.push(`  debate sandbox:     ${config.codexDebateSandbox}`);
  lines.push(`  turn timeout:       ${config.turnTimeoutMs / 1000}s`);
  lines.push(`  idle timeout:       ${config.idleTimeoutMs / 1000}s`);
  lines.push("");
  return lines.join("\n");
}
