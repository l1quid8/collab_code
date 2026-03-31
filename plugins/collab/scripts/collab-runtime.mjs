#!/usr/bin/env node

/**
 * collab-runtime.mjs — Collaboration companion for Claude Code.
 *
 * Subcommands:
 *   setup                          Check Codex availability and plugin config
 *   config --set key=value         Set a config value
 *   config --get key               Get a config value
 *   debate-start <plan>            Start a debate thread, send plan to Codex (read-only)
 *   debate-turn <message>          Continue the debate thread with a follow-up
 *   execute <plan>                 Start an execute thread (workspace-write), build the plan
 *   execute-continue <message>     Continue the execute thread (for fixes)
 *   session-create <task>          Create a new session
 *   session-status                 Show active session status
 *   session-halt                   Halt active session
 *   session-complete <status>      Mark session as complete
 */

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { getCodexAvailability, getCodexLoginStatus } from "./lib/process.mjs";
import { loadConfig, setConfigValue } from "./lib/config.mjs";
import {
  createSession,
  loadSession,
  saveSession,
  addMessage,
  setPhase,
  completeSession,
  getActiveSessionId,
} from "./lib/state.mjs";
import { connectAppServer } from "./lib/app-server.mjs";
import {
  renderSetupReport,
  renderCodexResponse,
  renderExecutionResult,
  renderSessionSummary,
  renderConfig,
} from "./lib/render.mjs";

const CWD = process.cwd();

// ── Helpers ─────────────────────────────────────────────────────────

function printUsage() {
  console.log(
    [
      "Usage:",
      '  collab-runtime setup [--json]',
      '  collab-runtime config --set <key>=<value>',
      '  collab-runtime config --get <key>',
      '  collab-runtime config --show',
      '  collab-runtime session-create "<task>"',
      '  collab-runtime session-status',
      '  collab-runtime session-halt',
      '  collab-runtime session-complete <completed|rejected>',
      '  collab-runtime debate-start "<plan text>"',
      '  collab-runtime debate-turn "<follow-up message>"',
      '  collab-runtime execute "<converged plan>"',
      '  collab-runtime execute-continue "<fix request>"',
    ].join("\n")
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function output(value, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === "string") {
    process.stdout.write(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function getActiveSession() {
  const id = getActiveSessionId(CWD);
  if (typeof id !== "string" || id.trim() === "") return null;
  return loadSession(id, CWD);
}

function addUniqueFile(list, filePath) {
  if (!filePath || filePath === "unknown") return;
  if (!list.includes(filePath)) {
    list.push(filePath);
  }
}

function ensureSessionFileLists(session) {
  if (!Array.isArray(session.filesCreated)) {
    session.filesCreated = [];
  }
  if (!Array.isArray(session.filesModified)) {
    session.filesModified = [];
  }
}

function trackFilesFromNotifications(session, fileChanges = []) {
  ensureSessionFileLists(session);
  for (const fc of fileChanges ?? []) {
    const changes = Array.isArray(fc.changes) ? fc.changes : [fc];
    for (const change of changes) {
      const filePath = change.path ?? change.filePath ?? "unknown";
      const action = String(change.action ?? "edit").toLowerCase();
      if (action === "create" || action === "add") {
        addUniqueFile(session.filesCreated, filePath);
      } else {
        addUniqueFile(session.filesModified, filePath);
      }
    }
  }
}

function parsePorcelainPath(rawPath) {
  const renameSeparator = " -> ";
  if (!rawPath.includes(renameSeparator)) return rawPath;
  return rawPath.split(renameSeparator).at(-1)?.trim() ?? rawPath;
}

function applyGitStatusFileTrackingFallback(session) {
  ensureSessionFileLists(session);
  const hasTrackedFiles =
    (session.filesCreated?.length ?? 0) > 0 ||
    (session.filesModified?.length ?? 0) > 0;
  if (hasTrackedFiles) return false;

  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: CWD,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return false;

  const lines = (result.stdout ?? "").split(/\r?\n/);
  const relevantCodes = new Set(["M", "A", "D", "R"]);
  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("?? ")) {
      addUniqueFile(session.filesCreated, line.slice(3).trim());
      continue;
    }

    const s0 = line[0];
    const s1 = line[1];
    if (!relevantCodes.has(s0) && !relevantCodes.has(s1)) continue;
    const rawPath = line.slice(3).trim();
    const filePath = parsePorcelainPath(rawPath);
    if (s0 === "A" || s1 === "A") {
      addUniqueFile(session.filesCreated, filePath);
    } else {
      addUniqueFile(session.filesModified, filePath);
    }
  }

  return true;
}

function requireActiveSession() {
  const session = getActiveSession();
  if (!session) {
    throw new Error("No active collaboration session. Start one with /collab:start <task>.");
  }
  if (session.status !== "active") {
    throw new Error(
      `Session ${session.id} is ${session.status}. Start a new one with /collab:start <task>.`
    );
  }
  return session;
}

function ensureCodexReady() {
  const auth = getCodexLoginStatus(CWD);
  if (!auth.available) {
    throw new Error(
      "Codex CLI is not installed. Install with: npm install -g @openai/codex"
    );
  }
  if (!auth.loggedIn) {
    throw new Error("Codex CLI is not authenticated. Run: !codex login");
  }
}

// ── Subcommand handlers ─────────────────────────────────────────────

function handleSetup(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const codex = getCodexAvailability(CWD);
  const auth = getCodexLoginStatus(CWD);
  const config = loadConfig(CWD);

  const nextSteps = [];
  if (!codex.available) {
    nextSteps.push("Install Codex: npm install -g @openai/codex");
  }
  if (codex.available && !auth.loggedIn) {
    nextSteps.push("Authenticate Codex: !codex login");
  }
  if (!config.architect) {
    nextSteps.push("Set architect model: /collab:config --set architect opus (or sonnet)");
  }

  const report = {
    ready: codex.available && auth.loggedIn && !!config.architect,
    node: { available: true },
    npm: { available: true },
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
    const [key, ...rest] = options.set.split("=");
    let value = rest.join("=");

    // Normalize architect shorthand
    if (key === "architect") {
      if (value === "opus") value = "opus-4.6";
      else if (value === "sonnet") value = "sonnet-4.6";
    }

    // Parse booleans and numbers
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);

    setConfigValue(key, value, CWD);
    output(`Set ${key} = ${JSON.stringify(value)}\n`);
    return;
  }

  if (options.get) {
    const config = loadConfig(CWD);
    const value = config[options.get] ?? null;
    output(options.json ? { key: options.get, value } : `${value}\n`, options.json);
  }
}

function handleSessionCreate(argv) {
  const task = argv.join(" ").trim();
  if (!task) {
    throw new Error("Task description required.");
  }

  const session = createSession(task, CWD);
  output(
    JSON.stringify({
      status: "created",
      sessionId: session.id,
      task: session.task,
      phase: session.phase,
    }) + "\n"
  );
}

function handleSessionStatus(argv) {
  const session = getActiveSession();
  if (!session) {
    output("No active session.\n");
    return;
  }

  output(
    JSON.stringify({
      sessionId: session.id,
      task: session.task,
      phase: session.phase,
      status: session.status,
      messageCount: session.messages.length,
      threadId: session.threadId,
      executeThreadId: session.executeThreadId,
    }) + "\n"
  );
}

function handleSessionHalt() {
  const session = requireActiveSession();
  completeSession(session, "halted", CWD);

  output(
    JSON.stringify({
      status: "halted",
      sessionId: session.id,
      message: "Session halted. No files were written.",
    }) + "\n"
  );
}

function handleSessionComplete(argv) {
  const status = argv[0] ?? "completed";
  const session = requireActiveSession();
  completeSession(session, status, CWD);
  output(renderSessionSummary(session));
}

async function handleDebateStart(argv) {
  ensureCodexReady();
  const session = requireActiveSession();
  const plan = argv.join(" ").trim();

  if (!plan) {
    throw new Error("Plan text required for debate-start.");
  }

  session.plan = plan;
  setPhase(session, "debate", CWD);
  addMessage(session, "claude", plan, CWD);

  const config = loadConfig(CWD);

  // Connect to Codex app server
  const server = await connectAppServer(CWD, {
    onProgress: (p) => {
      process.stderr.write(`[progress] ${p.message}\n`);
    },
  });

  try {
    // Start a read-only debate thread
    const thread = await server.startThread({
      sandbox: config.codexDebateSandbox || "read-only",
      threadName: `Collab Debate: ${session.task.slice(0, 50)}`,
      ephemeral: false,
    });

    const threadId = thread.thread?.id ?? thread.threadId;
    session.threadId = threadId;
    saveSession(session, CWD);

    // Frame the plan for Codex as a collaborative review
    const debatePrompt = [
      "<role>",
      "You are a senior engineer collaborating with an architect (Claude) on a plan.",
      "Your job is to review the plan critically, push back on over-engineering,",
      "flag missing concerns, suggest improvements, and challenge assumptions.",
      "Be direct and specific. Show code snippets when proposing alternatives.",
      "Read any relevant files in the codebase to ground your feedback.",
      "</role>",
      "",
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
    ].join("\n");

    const result = await server.sendTurn(threadId, debatePrompt, {
      timeoutMs: config.turnTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
    });

    // Log Codex's response
    addMessage(session, "codex", result.lastMessage || result.reviewText || "", CWD);

    // Surface server stderr when Codex returned nothing — aids debugging
    if (!result.lastMessage && !result.reviewText && server.stderr) {
      output(`[CODEX SERVER DEBUG]\n${server.stderr.slice(-2000)}\n`);
    }

    // Output for Claude to read
    output(renderCodexResponse(result));
  } finally {
    await server.close();
  }
}

async function handleDebateTurn(argv) {
  ensureCodexReady();
  const session = requireActiveSession();
  const message = argv.join(" ").trim();

  if (!message) {
    throw new Error("Message required for debate-turn.");
  }

  if (!session.threadId) {
    throw new Error("No active debate thread. Run debate-start first.");
  }

  addMessage(session, "claude", message, CWD);

  const config = loadConfig(CWD);

  const server = await connectAppServer(CWD, {
    onProgress: (p) => {
      process.stderr.write(`[progress] ${p.message}\n`);
    },
  });

  try {
    // Resume the debate thread
    await server.resumeThread(session.threadId, {
      sandbox: config.codexDebateSandbox || "read-only",
    });

    // Send Claude's follow-up
    const prompt = [
      "[ARCHITECT (Claude) responds]:",
      message,
      "",
      "Continue the discussion. Read any additional files if needed to validate your position.",
      "If you agree with the changes, say so clearly. If you still disagree, explain why with evidence.",
    ].join("\n");

    const result = await server.sendTurn(session.threadId, prompt, {
      timeoutMs: config.turnTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
    });

    addMessage(session, "codex", result.lastMessage || "", CWD);

    if (!result.lastMessage && server.stderr) {
      output(`[CODEX SERVER DEBUG]\n${server.stderr.slice(-2000)}\n`);
    }

    output(renderCodexResponse(result));
  } finally {
    await server.close();
  }
}

async function handleExecute(argv) {
  ensureCodexReady();
  const session = requireActiveSession();
  const plan = argv.join(" ").trim();

  if (!plan) {
    throw new Error("Converged plan required for execute.");
  }

  session.convergedPlan = plan;
  setPhase(session, "execute", CWD);
  saveSession(session, CWD);

  const config = loadConfig(CWD);

  const server = await connectAppServer(CWD, {
    onProgress: (p) => {
      process.stderr.write(`[progress] ${p.message}\n`);
    },
  });

  try {
    // Start a write-capable execute thread
    const thread = await server.startThread({
      sandbox: config.codexSandbox || "workspace-write",
      threadName: `Collab Execute: ${session.task.slice(0, 50)}`,
      ephemeral: false,
    });

    const threadId = thread.thread?.id ?? thread.threadId;
    session.executeThreadId = threadId;
    saveSession(session, CWD);

    const executePrompt = [
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
    ].join("\n");

    const result = await server.sendTurn(threadId, executePrompt, {
      timeoutMs: config.turnTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
    });

    trackFilesFromNotifications(session, result.fileChanges ?? []);
    const usedGitFallback = applyGitStatusFileTrackingFallback(session);

    setPhase(session, "review", CWD);
    addMessage(session, "codex", result.lastMessage || "", CWD);
    saveSession(session, CWD);

    if (!result.lastMessage && server.stderr) {
      output(`[CODEX SERVER DEBUG]\n${server.stderr.slice(-2000)}\n`);
    }

    if (usedGitFallback) {
      output("[COLLAB] File tracking from events was empty; fell back to git status --porcelain.\n");
    }

    output(renderExecutionResult(result));
  } finally {
    await server.close();
  }
}

async function handleExecuteContinue(argv) {
  ensureCodexReady();
  const session = requireActiveSession();
  const message = argv.join(" ").trim();

  if (!message) {
    throw new Error("Fix request required for execute-continue.");
  }

  if (!session.executeThreadId) {
    throw new Error("No active execute thread. Run execute first.");
  }

  addMessage(session, "claude", message, CWD);

  const config = loadConfig(CWD);

  const server = await connectAppServer(CWD, {
    onProgress: (p) => {
      process.stderr.write(`[progress] ${p.message}\n`);
    },
  });

  try {
    await server.resumeThread(session.executeThreadId, {
      sandbox: config.codexSandbox || "workspace-write",
    });

    const fixPrompt = [
      "[ARCHITECT (Claude) review findings]:",
      message,
      "",
      "Fix the issues identified above. Run build/tests again after fixing.",
      "Report what you changed.",
    ].join("\n");

    const result = await server.sendTurn(session.executeThreadId, fixPrompt, {
      timeoutMs: config.turnTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
    });

    trackFilesFromNotifications(session, result.fileChanges ?? []);
    const usedGitFallback = applyGitStatusFileTrackingFallback(session);

    addMessage(session, "codex", result.lastMessage || "", CWD);
    saveSession(session, CWD);

    if (!result.lastMessage && server.stderr) {
      output(`[CODEX SERVER DEBUG]\n${server.stderr.slice(-2000)}\n`);
    }

    if (usedGitFallback) {
      output("[COLLAB] File tracking from events was empty; fell back to git status --porcelain.\n");
    }

    output(renderExecutionResult(result));
  } finally {
    await server.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "config":
      handleConfig(argv);
      break;
    case "session-create":
      handleSessionCreate(argv);
      break;
    case "session-status":
      handleSessionStatus(argv);
      break;
    case "session-halt":
      handleSessionHalt();
      break;
    case "session-complete":
      handleSessionComplete(argv);
      break;
    case "debate-start":
      await handleDebateStart(argv);
      break;
    case "debate-turn":
      await handleDebateTurn(argv);
      break;
    case "execute":
      await handleExecute(argv);
      break;
    case "execute-continue":
      await handleExecuteContinue(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// Kill any lingering child processes on shutdown
function onShutdown() {
  process.exit(0);
}
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
