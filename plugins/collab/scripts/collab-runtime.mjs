#!/usr/bin/env node

/**
 * collab-runtime.mjs — Collaboration companion for Claude Code.
 *
 * Subcommands:
 *   setup                          Check Codex availability, version and auth
 *   config --set key=value         Set a config value
 *   config --get key               Get a config value
 *   debate-start <plan>            Start a debate thread, send plan to Codex (read-only)
 *   debate-turn <message>          Continue the debate thread with a follow-up
 *   execute <plan>                 Start an execute thread (workspace-write), build the plan
 *   execute-continue <message>     Continue the execute thread (for fixes)
 *   session-create <task>          Create a new session
 *   session-list                   List existing sessions
 *   session-activate <id>          Reactivate an active or halted session by ID
 *   session-prune                  Delete old non-active sessions
 *   session-note                   Add bug/decision/note to the active session
 *   session-status                 Show active session status
 *   session-halt                   Halt active session
 *   session-complete <status>      Mark session as complete
 *   turn-interrupt                 Show the currently pending turn metadata
 *
 * Text arguments (plan, message, task) may be passed as `-` to read them from
 * stdin, e.g. a quoted heredoc, which avoids shell quoting of markdown.
 */

import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { compareVersions, getCodexVersion } from "./lib/process.mjs";
import { loadConfig, setConfigValue } from "./lib/config.mjs";
import {
  createSession,
  loadSession,
  saveSession,
  addMessage,
  completeSession,
  getActiveSessionId,
  setActiveSession,
  listSessions,
  deleteSession,
  resumeSession,
  loadKnowledge,
  appendDecisionsToKnowledge,
} from "./lib/state.mjs";
import { connectAppServer, MIN_CODEX_VERSION, withTimeout } from "./lib/app-server.mjs";
import { captureGitBaseline, recordFileChanges, recordGitDelta, relPath } from "./lib/files.mjs";
import {
  renderSetupReport,
  renderCodexResponse,
  renderExecutionResult,
  renderSessionSummary,
  renderConfig,
} from "./lib/render.mjs";

const CWD = process.cwd();
let activeServer = null;
let activeTurn = null;
let shuttingDown = false;

// ── Helpers ─────────────────────────────────────────────────────────

function printUsage() {
  console.log(
    [
      "Usage:",
      "  collab-runtime setup [--json]",
      "  collab-runtime config --set <key>=<value>",
      "  collab-runtime config --get <key>",
      "  collab-runtime config --show",
      '  collab-runtime session-create "<task>"',
      "  collab-runtime session-list",
      "  collab-runtime session-activate <session-id>",
      "  collab-runtime session-prune [--older-than <days>] [--status <csv>] [--dry-run]",
      '  collab-runtime session-note --type <bug|decision|note> --text "<text>" | -',
      "  collab-runtime session-status",
      "  collab-runtime session-halt",
      "  collab-runtime session-complete <completed|rejected|halted>",
      '  collab-runtime debate-start "<plan text>" | -',
      '  collab-runtime debate-turn "<follow-up message>" | -',
      '  collab-runtime execute "<converged plan>" | -',
      '  collab-runtime execute-continue "<fix request>" | -',
      "  collab-runtime turn-interrupt",
      "",
      "Pass - to read the text from stdin, e.g.:",
      "  collab-runtime debate-start - <<'COLLAB_EOF'",
      "  ...plan...",
      "  COLLAB_EOF",
    ].join("\n")
  );
}

function output(value, asJson = false) {
  if (!asJson && typeof value === "string") process.stdout.write(value);
  else console.log(JSON.stringify(value, null, 2));
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function nowIso() {
  return new Date().toISOString();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Text from positional args, or from stdin when the only arg is "-".
 * @param {string[]} argv
 * @param {string} what
 */
async function readTextArg(argv, what) {
  const text = (argv.length === 1 && argv[0] === "-" ? await readStdin() : argv.join(" ")).trim();
  if (!text) throw new Error(`${what} required. Pass it as an argument, or pass - and pipe it on stdin.`);
  return text;
}

function getActiveSession() {
  const id = getActiveSessionId(CWD);
  return id ? loadSession(id, CWD) : null;
}

function requireActiveSession() {
  const session = getActiveSession();
  if (!session) {
    throw new Error("No active collaboration session. Start one with /collab:start <task>.");
  }
  if (session.status !== "active") {
    throw new Error(`Session ${session.id} is ${session.status}. Start a new one with /collab:start <task>.`);
  }
  return session;
}

function listPreview(files, max = 5) {
  const shown = files.slice(0, max).join(", ");
  return files.length > max ? `${shown}, … (+${files.length - max} more)` : shown;
}

function createAgentStreamer() {
  let currentItem = null;
  let wrote = false;
  let finished = false;
  return {
    onAgentText(itemId, text) {
      if (!wrote) process.stdout.write("[CODEX RESPONSE]\n");
      else if (itemId !== currentItem) process.stdout.write("\n\n");
      currentItem = itemId;
      wrote = true;
      process.stdout.write(text);
    },
    get streamed() {
      return wrote;
    },
    finish() {
      if (wrote && !finished) process.stdout.write("\n");
      finished = true;
    },
  };
}

/**
 * Connect to Codex, start or resume one of the session's threads, run a
 * single turn, and always shut the app-server down.
 *
 * @param {object} session
 * @param {{ threadKey: "threadId" | "executeThreadId", newThread: boolean, name: string, sandbox: string, prompt: string }} spec
 */
async function runCodexTurn(session, spec) {
  const config = loadConfig(CWD);
  const streamer = createAgentStreamer();
  const server = await connectAppServer(CWD, {
    onProgress: (message) => process.stderr.write(`[progress] ${message}\n`),
    onAgentText: streamer.onAgentText,
  });
  activeServer = server;

  try {
    // Fail fast on a missing login; if the check itself errors, let the turn
    // run — a real auth failure is reported by the turn.
    const auth = await server.readAccount().catch(() => null);
    if (auth?.requiresOpenaiAuth && !auth.account) {
      throw new Error("Codex CLI is not authenticated. Run: !codex login");
    }

    let threadId = session[spec.threadKey];
    if (spec.newThread || !threadId) {
      threadId = await server.startThread({ sandbox: spec.sandbox, name: spec.name });
      session[spec.threadKey] = threadId;
      saveSession(session, CWD);
    } else {
      await server.resumeThread(threadId, { sandbox: spec.sandbox });
    }

    const turn = await server.runTurn(threadId, spec.prompt, {
      timeoutMs: config.turnTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      onTurnStarted: (info) => {
        activeTurn = info;
        session.pendingTurn = { ...info, startedAt: nowIso() };
        saveSession(session, CWD);
      },
    });
    session.pendingTurn = null;
    streamer.finish();

    turn.fileChanges = turn.fileChanges.map((c) => ({
      ...c,
      path: relPath(c.path, CWD),
      movePath: c.movePath ? relPath(c.movePath, CWD) : null,
    }));
    if (!turn.text && !turn.error && server.stderr.trim()) {
      output(`[CODEX SERVER DEBUG]\n${server.stderr.slice(-2000)}\n`);
    }
    return { turn, streamed: streamer.streamed };
  } finally {
    streamer.finish();
    activeTurn = null;
    await server.close();
    if (activeServer === server) activeServer = null;
  }
}

function buildDebatePrompt(plan, priorDecisions) {
  const escapeXml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const priorDecisionsBlock =
    priorDecisions.length > 0
      ? [
          '<past_decisions advisory="true">',
          "Advisory context from previous completed sessions:",
          ...priorDecisions.map(
            (entry, index) =>
              `  <decision index="${index + 1}" sessionId="${escapeXml(entry.sessionId ?? "unknown")}" decidedBy="${escapeXml(entry.decidedBy ?? "unknown")}" date="${escapeXml(entry.date ?? "unknown")}">${escapeXml(entry.description ?? "")}</decision>`
          ),
          "</past_decisions>",
          "",
        ].join("\n")
      : "";

  return [
    "<role>",
    "You are a senior engineer collaborating with an architect (Claude) on a plan.",
    "Your job is to review the plan critically, push back on over-engineering,",
    "flag missing concerns, suggest improvements, and challenge assumptions.",
    "Be direct and specific. Show code snippets when proposing alternatives.",
    "Read any relevant files in the codebase to ground your feedback.",
    "</role>",
    "",
    priorDecisionsBlock,
    "<plan>",
    plan,
    "</plan>",
    "",
    "<instructions>",
    "Review this plan as a peer. For each phase:",
    "1. Is this the right approach? Would you do it differently?",
    "2. What's missing that could bite us in production?",
    "3. What's over-engineered that should be simpler?",
    "4. Are there codebase-specific constraints the plan ignores?",
    "",
    "Read relevant source files before responding — don't guess about the codebase.",
    "Be concrete. Cite file paths and line numbers when pushing back.",
    "</instructions>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Record a finished debate turn and print it.
 */
function finishDebateTurn(session, { turn, streamed }) {
  addMessage(session, "codex", turn.text);
  saveSession(session, CWD);
  output(renderCodexResponse(turn, { streamed }));
  if (turn.error) process.exitCode = 1;
}

/**
 * Record files touched by an execute turn (events + git delta), move the
 * session to review, and print the result.
 */
function finishExecuteTurn(session, { turn, streamed }) {
  recordFileChanges(session, turn.fileChanges, CWD);
  const git = recordGitDelta(session, session.gitBaseline, CWD);
  session.phase = "review";
  addMessage(session, "codex", turn.text);
  saveSession(session, CWD);

  if (git?.added.length) {
    output(`[COLLAB] Tracked ${git.added.length} file(s) changed outside apply_patch (via git status): ${listPreview(git.added)}\n`);
  }
  if (git?.preDirtyEdited.length) {
    output(`[COLLAB] Warning: Codex edited file(s) that already had uncommitted changes; rejecting would discard those too: ${listPreview(git.preDirtyEdited)}\n`);
  }
  if (git?.unattributed.length) {
    output(`[COLLAB] Not auto-tracked (uncommitted before execute): ${listPreview(git.unattributed)}\n`);
  }
  output(renderExecutionResult(turn, session, { streamed }));
  if (turn.error) process.exitCode = 1;
}

// ── Subcommand handlers ─────────────────────────────────────────────

async function handleSetup(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const config = loadConfig(CWD);
  const codex = getCodexVersion(CWD);
  codex.versionOk = codex.available && (!codex.version || compareVersions(codex.version, MIN_CODEX_VERSION) >= 0);

  let auth = { ok: false, detail: "skipped (codex not available)" };
  if (codex.available) {
    let server = null;
    try {
      server = await connectAppServer(CWD);
      const { account, requiresOpenaiAuth } = await server.readAccount();
      auth = !account
        ? { ok: !requiresOpenaiAuth, detail: requiresOpenaiAuth ? "not logged in" : "custom model provider (no OpenAI login needed)" }
        : account.type === "chatgpt"
          ? { ok: true, detail: `ChatGPT${account.email ? ` (${account.email})` : ""}, plan: ${account.planType}` }
          : { ok: true, detail: account.type === "apiKey" ? "API key" : account.type };
    } catch (error) {
      auth = { ok: false, detail: `app-server check failed: ${error.message}` };
    } finally {
      await server?.close();
    }
  }

  const nextSteps = [];
  if (!codex.available) nextSteps.push("Install Codex: npm install -g @openai/codex");
  else if (!codex.versionOk) nextSteps.push(`Upgrade Codex to ${MIN_CODEX_VERSION} or later: npm install -g @openai/codex@latest`);
  if (codex.available && !auth.ok) nextSteps.push("Authenticate Codex: !codex login");

  const report = {
    ready: codex.available && codex.versionOk && auth.ok,
    node: { version: process.version },
    codex,
    auth,
    architect: config.architect,
    architectConfigured: !!config.architect,
    nextSteps,
  };
  output(options.json ? report : renderSetupReport(report), options.json);
}

function handleConfig(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["set", "get"],
    booleanOptions: ["show", "json"],
  });

  if (options.show || (!options.set && !options.get)) {
    const config = loadConfig(CWD);
    output(options.json ? config : renderConfig(config), options.json);
    return;
  }

  if (options.set) {
    const [key, ...rest] = String(options.set).split("=");
    let value = rest.join("=");
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value === "null") value = null;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);

    setConfigValue(key, value, CWD);
    output(`Set ${key} = ${JSON.stringify(value)}\n`);
    return;
  }

  const value = loadConfig(CWD)[options.get] ?? null;
  output(options.json ? { key: options.get, value } : `${value}\n`, options.json);
}

async function handleSessionCreate(argv) {
  const task = await readTextArg(argv, "Task description");
  const previous = getActiveSession();
  if (previous?.status === "active") {
    output(`[COLLAB] Warning: overwriting active session pointer (previous: ${previous.id})\n`);
  }
  const session = createSession(task, CWD);
  outputJson({ status: "created", sessionId: session.id, task: session.task, phase: session.phase });
}

function handleSessionList() {
  const sessions = listSessions(CWD);
  if (sessions.length === 0) {
    output("No sessions found.\n");
    return;
  }
  for (const s of sessions) {
    const date = (s.startedAt ?? "").slice(0, 16).replace("T", " ");
    const status = (s.status ?? "unknown").padEnd(10);
    const phase = (s.phase ?? "unknown").padEnd(8);
    output(`  ${status} ${phase} ${date}  ${s.id}  ${(s.task ?? "").slice(0, 55)}\n`);
  }
}

function handleSessionStatus() {
  const session = getActiveSession();
  if (!session) {
    output("No active session.\n");
    return;
  }
  outputJson({
    sessionId: session.id,
    task: session.task,
    phase: session.phase,
    status: session.status,
    messageCount: session.messages.length,
    threadId: session.threadId,
    executeThreadId: session.executeThreadId,
    filesCreated: session.filesCreated,
    filesModified: session.filesModified,
    pendingTurn: session.pendingTurn,
  });
}

async function handleSessionNote(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ["type", "text"] });
  const type = String(options.type ?? "").trim().toLowerCase();
  if (!["bug", "decision", "note"].includes(type)) {
    throw new Error("Invalid note type. Must be one of: bug, decision, note");
  }
  const text = typeof options.text === "string" ? options.text.trim() : await readTextArg(positionals, "Note text");
  if (!text) throw new Error("Note text required.");

  const session = requireActiveSession();
  if (type === "bug") session.bugsCaught.push(text);
  else if (type === "decision") session.decisions.push({ description: text, proposedBy: "claude", decidedBy: null });
  else session.notes.push(text);

  saveSession(session, CWD);
  outputJson({ status: "noted", sessionId: session.id, type, text });
}

function handleSessionHalt() {
  const session = requireActiveSession();
  const message =
    session.phase === "execute" || session.phase === "review"
      ? "Warning: Codex may have already written files. Review with git status before discarding."
      : "No files were written.";
  completeSession(session, "halted", CWD);
  outputJson({ status: "halted", sessionId: session.id, message });
}

function handleSessionComplete(argv) {
  const status = argv[0] ?? "completed";
  if (!["completed", "rejected", "halted"].includes(status)) {
    throw new Error(`Invalid session status: '${status}'. Must be one of: completed, rejected, halted`);
  }
  const session = requireActiveSession();
  completeSession(session, status, CWD);
  if (status === "completed") appendDecisionsToKnowledge(session, CWD);
  output(renderSessionSummary(session));
}

function handleSessionActivate(argv) {
  const sessionId = (argv[0] ?? "").trim();
  if (!sessionId) throw new Error("Session ID required. Usage: session-activate <session-id>");

  const session = loadSession(sessionId, CWD);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== "active" && session.status !== "halted") {
    throw new Error(
      `Cannot activate session ${sessionId}: status is "${session.status}". Only sessions with status "active" or "halted" can be activated.`
    );
  }

  if (session.status === "halted") {
    resumeSession(session, CWD);
    outputJson({
      status: "resumed",
      sessionId: session.id,
      task: session.task,
      phase: session.phase,
      warning: "This session was previously halted. Files may have already been written; run git status before continuing.",
    });
    return;
  }

  setActiveSession(sessionId, CWD);
  outputJson({
    status: "activated",
    sessionId: session.id,
    task: session.task,
    phase: session.phase,
    message: `Session reactivated at phase: ${session.phase}. Use debate-turn (if in debate) or execute-continue (if in execute/review).`,
  });
}

function handleSessionPrune(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["older-than", "status"],
    booleanOptions: ["dry-run"],
  });

  let olderThanDays = null;
  if (options["older-than"] != null) {
    olderThanDays = Number(options["older-than"]);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error("Invalid --older-than value. Provide a non-negative number of days.");
    }
  }

  let statusFilter = null;
  if (options.status != null) {
    statusFilter = new Set(String(options.status).split(",").map((v) => v.trim()).filter(Boolean));
    if (statusFilter.size === 0) {
      throw new Error("Invalid --status value. Provide a comma-separated list of statuses.");
    }
  }

  const activeSessionId = getActiveSessionId(CWD);
  const nowMs = Date.now();
  const candidates = listSessions(CWD).filter((session) => {
    if (!session?.id || session.id === activeSessionId || session.status === "active") return false;
    if (statusFilter && !statusFilter.has(session.status ?? "")) return false;
    if (olderThanDays != null) {
      const timestamp = Date.parse(session.completedAt ?? session.startedAt ?? "");
      if (!Number.isFinite(timestamp)) return false;
      if ((nowMs - timestamp) / 86400000 < olderThanDays) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    output("No sessions matched prune criteria.\n");
    return;
  }

  for (const session of candidates) {
    const date = String(session.completedAt ?? session.startedAt ?? "").slice(0, 16).replace("T", " ");
    const status = String(session.status ?? "unknown").padEnd(10);
    output(`  ${status} ${date}  ${session.id}  ${String(session.task ?? "").slice(0, 55)}\n`);
  }

  if (options["dry-run"]) {
    output(`Matched ${candidates.length} session(s). (--dry-run, no changes made)\n`);
    return;
  }

  const pruned = candidates.filter((session) => deleteSession(session.id, CWD)).length;
  output(`Pruned ${pruned} session(s).\n`);
}

function handleTurnInterrupt() {
  const session = requireActiveSession();
  if (!session.pendingTurn) {
    throw new Error("No pending turn found. A turn must be actively running before turn-interrupt can inspect it.");
  }
  outputJson({
    status: "pending-turn-found",
    pendingTurn: session.pendingTurn,
    note: "EXPERIMENTAL: in-process interruption is not yet supported. This command reports what would be interrupted.",
  });
}

async function handleDebateStart(argv) {
  const session = requireActiveSession();
  const plan = await readTextArg(argv, "Plan text");
  const config = loadConfig(CWD);

  session.plan = plan;
  session.phase = "debate";
  addMessage(session, "claude", plan);
  saveSession(session, CWD);

  const run = await runCodexTurn(session, {
    threadKey: "threadId",
    newThread: true,
    name: `Collab Debate: ${session.task.slice(0, 50)}`,
    sandbox: config.codexDebateSandbox || "read-only",
    prompt: buildDebatePrompt(plan, loadKnowledge(CWD).slice(0, 5)),
  });
  finishDebateTurn(session, run);
}

async function handleDebateTurn(argv) {
  const session = requireActiveSession();
  const message = await readTextArg(argv, "Message");
  if (!session.threadId) throw new Error("No active debate thread. Run debate-start first.");
  const config = loadConfig(CWD);

  addMessage(session, "claude", message);
  saveSession(session, CWD);

  const run = await runCodexTurn(session, {
    threadKey: "threadId",
    newThread: false,
    sandbox: config.codexDebateSandbox || "read-only",
    prompt: [
      "[ARCHITECT (Claude) responds]:",
      message,
      "",
      "Continue the discussion. Read any additional files if needed to validate your position.",
      "If you agree with the changes, say so clearly. If you still disagree, explain why with evidence.",
    ].join("\n"),
  });
  finishDebateTurn(session, run);
}

async function handleExecute(argv) {
  const session = requireActiveSession();
  const plan = await readTextArg(argv, "Converged plan");
  const config = loadConfig(CWD);

  session.convergedPlan = plan;
  session.phase = "execute";
  session.gitBaseline = captureGitBaseline(CWD);
  addMessage(session, "claude", plan);
  saveSession(session, CWD);

  const run = await runCodexTurn(session, {
    threadKey: "executeThreadId",
    newThread: true,
    name: `Collab Execute: ${session.task.slice(0, 50)}`,
    sandbox: config.codexSandbox || "workspace-write",
    prompt: [
      "<role>",
      "You are implementing a plan that has been reviewed and agreed upon by both you",
      "and an architect (Claude). The plan has been through a debate phase and this is",
      "the converged version. Implement it fully.",
      "</role>",
      "",
      "<converged_plan>",
      plan,
      "</converged_plan>",
      "",
      "<instructions>",
      "Implement the full plan. All phases, all files.",
      "After implementation, run the build and any relevant linters/tests to verify.",
      "If a build or test fails, fix it before finishing.",
      "Report what you created, what you modified, and the verification results.",
      "</instructions>",
    ].join("\n"),
  });
  finishExecuteTurn(session, run);
}

async function handleExecuteContinue(argv) {
  const session = requireActiveSession();
  const message = await readTextArg(argv, "Fix request");
  if (!session.executeThreadId) throw new Error("No active execute thread. Run execute first.");
  const config = loadConfig(CWD);

  addMessage(session, "claude", message);
  saveSession(session, CWD);

  const run = await runCodexTurn(session, {
    threadKey: "executeThreadId",
    newThread: false,
    sandbox: config.codexSandbox || "workspace-write",
    prompt: [
      "[ARCHITECT (Claude) review findings]:",
      message,
      "",
      "Fix the issues identified above. Run build/tests again after fixing.",
      "Report what you changed.",
    ].join("\n"),
  });
  finishExecuteTurn(session, run);
}

// ── Main ────────────────────────────────────────────────────────────

const HANDLERS = {
  setup: handleSetup,
  config: handleConfig,
  "session-create": handleSessionCreate,
  "session-list": handleSessionList,
  "session-activate": handleSessionActivate,
  "session-prune": handleSessionPrune,
  "session-note": handleSessionNote,
  "session-status": handleSessionStatus,
  "session-halt": handleSessionHalt,
  "session-complete": handleSessionComplete,
  "debate-start": handleDebateStart,
  "debate-turn": handleDebateTurn,
  execute: handleExecute,
  "execute-continue": handleExecuteContinue,
  "turn-interrupt": handleTurnInterrupt,
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  const handler = HANDLERS[subcommand];
  if (!handler) throw new Error(`Unknown subcommand: ${subcommand}`);
  await handler(argv);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    if (activeServer) {
      // Stop Codex (and the commands it is running) before tearing down.
      if (activeTurn) {
        await withTimeout(activeServer.interruptTurn(activeTurn.threadId, activeTurn.turnId), 1000, null);
      }
      await activeServer.close({ force: true });
      activeServer = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[COLLAB] Shutdown cleanup error: ${message}\n`);
  } finally {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    process.exit();
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
