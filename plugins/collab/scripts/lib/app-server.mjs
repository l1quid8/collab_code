/**
 * JSON-RPC client for `codex app-server` (protocol v2).
 *
 * Spawns `codex app-server` as a child process and speaks newline-delimited
 * JSON over stdio: initialize handshake, thread start/resume, and one turn at
 * a time. Verified against codex-cli 0.158.0 (`codex app-server
 * generate-ts`); requires 0.118.0+ for kebab-case sandbox values.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

export const MIN_CODEX_VERSION = "0.118.0";

const STDERR_TAIL_BYTES = 8192;

// Notifications this client never reads. Opting out keeps large payloads off
// the pipe — notably `turn/diff/updated`, which resends the cumulative diff on
// every file edit, and streamed command output (it also arrives, aggregated,
// on `item/completed`).
const OPT_OUT_NOTIFICATIONS = [
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "thread/status/changed",
  "account/rateLimits/updated",
  "remoteControl/status/changed",
  "mcpServer/startupStatus/updated",
  "rawResponseItem/completed",
  "rawResponse/completed",
];

const WARNING_NOTIFICATIONS = new Set(["warning", "configWarning", "deprecationNotice"]);

function loadPluginVersion() {
  try {
    const url = new URL("../../.claude-plugin/plugin.json", import.meta.url);
    const version = JSON.parse(fs.readFileSync(url, "utf8"))?.version;
    if (typeof version === "string" && version.trim() !== "") return version;
  } catch {
    // Fall through to default.
  }
  return "0.0.0";
}

const CLIENT_INFO = {
  name: "claude_code_collab",
  title: "Claude Code Collab",
  version: loadPluginVersion(),
};

/**
 * Normalize a sandbox string to the kebab-case form the app-server expects
 * ("read-only", "workspace-write", "danger-full-access"). Accepts the legacy
 * camelCase form. An unrecognized string passes through so the server
 * returns a clear error instead of silently picking a policy.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function normalizeSandbox(value) {
  if (!value) return "read-only";
  return String(value)
    .replace(/([a-z])([A-Z])/g, (_, a, b) => `${a}-${b}`)
    .toLowerCase();
}

/**
 * Strip the `bash -lc '...'` wrapper Codex puts around commands and cap the
 * result to one line, so rendered command lists stay short.
 *
 * @param {string} command
 * @param {number} [max]
 */
export function shortCommand(command, max = 160) {
  let cmd = String(command ?? "");
  const wrapped = cmd.match(/^\S*\b(?:ba|z)?sh -lc (['"]?)([\s\S]*)\1$/);
  if (wrapped) {
    cmd = wrapped[1] === "'" ? wrapped[2].replaceAll(`'\\''`, "'") : wrapped[2];
  }
  const lines = cmd.split("\n");
  let first = lines[0];
  if (first.length > max) first = `${first.slice(0, max - 1)}…`;
  return lines.length > 1 ? `${first} … (+${lines.length - 1} lines)` : first;
}

/**
 * Turn a TurnError into readable text. Provider errors often arrive as a raw
 * JSON body in `message`; unwrap the inner message when that is the case.
 *
 * @param {{ message?: string, additionalDetails?: string | null } | string | null | undefined} error
 */
export function describeTurnError(error) {
  if (!error) return "Codex turn failed.";
  if (typeof error === "string") return error;
  let message = String(error.message ?? "Codex turn failed.");
  try {
    const inner = JSON.parse(message)?.error;
    if (inner?.message) message = inner.code ? `${inner.message} (${inner.code})` : inner.message;
  } catch {
    // Not JSON — use as-is.
  }
  return error.additionalDetails ? `${message} — ${error.additionalDetails}` : message;
}

/**
 * Resolve with `promise`, or with `fallback` after `ms`. The timer is cleared
 * either way so it never holds the process open.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {{ path: string, kind: "add" | "delete" | "update", movePath: string | null }} FileChange
 * @typedef {{ command: string, exitCode: number | null, status: string | null }} CommandRun
 * @typedef {{
 *   threadId: string,
 *   turnId: string | null,
 *   status: "inProgress" | "completed" | "failed" | "interrupted" | "timeout",
 *   messages: Array<{ phase: string | null, text: string }>,
 *   commands: CommandRun[],
 *   fileChanges: FileChange[],
 *   error: string | null,
 *   streamedItems: Set<string>,
 * }} TurnState
 * @typedef {{
 *   onAgentText?: (itemId: string, text: string) => void,
 *   onProgress?: (message: string) => void,
 * }} TurnHooks
 */

/** @returns {TurnState} */
export function createTurnState(threadId) {
  return {
    threadId,
    turnId: null,
    status: "inProgress",
    messages: [],
    commands: [],
    fileChanges: [],
    error: null,
    streamedItems: new Set(),
  };
}

/**
 * Fold one server notification into the turn state.
 *
 * Notifications for other threads (e.g. sub-agents Codex spawns) and other
 * turns are ignored, so they cannot complete this turn early. Items are
 * recorded on `item/completed`, when exit codes and patch status are final.
 *
 * @param {TurnState} turn
 * @param {{ method: string, params?: any }} notification
 * @param {TurnHooks} [hooks]
 */
export function applyTurnNotification(turn, notification, hooks = {}) {
  const { method } = notification;
  const params = notification.params ?? {};
  if (params.threadId && params.threadId !== turn.threadId) return;
  const turnId = params.turnId ?? params.turn?.id;
  if (turn.turnId && turnId && turnId !== turn.turnId) return;

  switch (method) {
    case "turn/started":
      turn.turnId ??= turnId ?? null;
      break;

    case "item/agentMessage/delta":
      if (params.delta) {
        turn.streamedItems.add(params.itemId);
        hooks.onAgentText?.(params.itemId, params.delta);
      }
      break;

    case "item/started":
      if (params.item?.type === "commandExecution") {
        hooks.onProgress?.(`Running: ${shortCommand(params.item.command, 80)}`);
      }
      break;

    case "item/completed": {
      const item = params.item ?? {};
      if (item.type === "agentMessage") {
        const text = item.text ?? "";
        if (!text) break;
        turn.messages.push({ phase: item.phase ?? null, text });
        // Providers that don't stream deltas still get their text shown.
        if (!turn.streamedItems.has(item.id)) hooks.onAgentText?.(item.id, text);
      } else if (item.type === "commandExecution") {
        const exitCode = item.exitCode ?? null;
        turn.commands.push({ command: item.command ?? "", exitCode, status: item.status ?? null });
        hooks.onProgress?.(
          `Command ${exitCode === 0 ? "finished" : `exited ${exitCode ?? "?"}`}: ${shortCommand(item.command, 60)}`
        );
      } else if (item.type === "fileChange") {
        const changes = item.changes ?? [];
        if (item.status === "completed") {
          for (const change of changes) {
            turn.fileChanges.push({
              path: change.path,
              kind: change.kind?.type ?? "update",
              movePath: change.kind?.move_path ?? null,
            });
          }
        }
        hooks.onProgress?.(`File change ${item.status ?? "done"}: ${changes.length} file(s)`);
      }
      break;
    }

    case "error": {
      const message = describeTurnError(params.error);
      if (params.willRetry) hooks.onProgress?.(`Codex error, retrying: ${message}`);
      else turn.error = message;
      break;
    }

    case "turn/completed": {
      const t = params.turn ?? {};
      turn.turnId ??= t.id ?? null;
      turn.status = t.status === "failed" || t.status === "interrupted" ? t.status : "completed";
      if (t.status === "failed") turn.error = describeTurnError(t.error ?? turn.error);
      if (t.status === "interrupted") turn.error ??= "Codex turn was interrupted.";
      break;
    }
  }
}

export class CodexAppServer {
  /**
   * @param {string} cwd
   * @param {{ env?: NodeJS.ProcessEnv, onProgress?: (message: string) => void, onAgentText?: (itemId: string, text: string) => void }} [options]
   */
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.env = options.env ?? process.env;
    this.onProgress = options.onProgress ?? null;
    this.onAgentText = options.onAgentText ?? null;
    this.proc = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.failure = null;
    /** @type {((notification: object) => void) | null} */
    this.turnListener = null;
    /** @type {((error: Error) => void) | null} */
    this.turnAbort = null;
  }

  /** Spawn the app-server and perform the initialize handshake. */
  async connect() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // Writes after the child dies raise EPIPE here; the exit handler reports it.
    this.proc.stdin.on("error", () => {});

    this.proc.on("error", (err) => {
      this._fail(
        err.code === "ENOENT"
          ? new Error("Codex CLI not found on PATH. Install with: npm install -g @openai/codex")
          : err
      );
    });
    this.proc.on("exit", (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
      this._fail(new Error(`codex app-server exited (${how})${tail ? `:\n${tail}` : ""}`));
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this._handleLine(line));

    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: OPT_OUT_NOTIFICATIONS,
      },
    });
    this._send({ method: "initialized" });
  }

  /**
   * Send a JSON-RPC request and wait for its response.
   * @param {string} method
   * @param {object} params
   */
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("App server connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this._send({ id, method, params });
    });
  }

  /**
   * Current auth state. `requiresOpenaiAuth` is false for custom model
   * providers that bring their own credentials.
   * @returns {Promise<{ account: object | null, requiresOpenaiAuth: boolean }>}
   */
  readAccount() {
    return this.request("account/read", { refreshToken: false });
  }

  /**
   * Start a persistent thread and return its id.
   * @param {{ sandbox?: string, name?: string }} [options]
   */
  async startThread(options = {}) {
    const response = await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: normalizeSandbox(options.sandbox),
      serviceName: "claude_code_collab_plugin",
      ephemeral: false,
    });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id.");
    if (options.name) {
      // Cosmetic (shows in Codex's own thread list); never fail the turn over it.
      await this.request("thread/name/set", { threadId, name: options.name }).catch(() => {});
    }
    return threadId;
  }

  /**
   * Resume a thread from disk. `excludeTurns` keeps the response from
   * carrying the whole history back, which grows with every debate round.
   * @param {string} threadId
   * @param {{ sandbox?: string }} [options]
   */
  async resumeThread(threadId, options = {}) {
    await this.request("thread/resume", {
      threadId,
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: normalizeSandbox(options.sandbox),
      excludeTurns: true,
    });
  }

  /**
   * Run one turn to completion. Never throws for turn-level failures: they
   * come back as `status` + `error` so callers can still record partial work.
   *
   * @param {string} threadId
   * @param {string} prompt
   * @param {{ timeoutMs?: number, idleTimeoutMs?: number, onTurnStarted?: (info: { threadId: string, turnId: string }) => void }} [options]
   */
  async runTurn(threadId, prompt, options = {}) {
    const timeoutMs = options.timeoutMs ?? 570000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 60000;
    const turn = createTurnState(threadId);
    const hooks = {
      onAgentText: this.onAgentText ?? undefined,
      onProgress: (message) => this._progress(message),
    };
    const startedAt = Date.now();
    let lastEventAt = startedAt;
    let settle;
    const done = new Promise((resolve) => (settle = resolve));

    this.turnListener = (notification) => {
      lastEventAt = Date.now();
      applyTurnNotification(turn, notification, hooks);
      if (turn.status !== "inProgress") settle();
    };
    this.turnAbort = (error) => {
      turn.status = "failed";
      turn.error ??= error.message;
      settle();
    };

    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastEventAt < idleTimeoutMs) return;
      lastEventAt = now;
      this._progress(`Codex is still working (${Math.round((now - startedAt) / 1000)}s elapsed)...`);
    }, Math.max(1000, idleTimeoutMs));
    const timer = setTimeout(() => {
      turn.status = "timeout";
      turn.error = `Codex turn timed out after ${Math.round(timeoutMs / 1000)}s.`;
      settle();
    }, timeoutMs);

    try {
      const response = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      turn.turnId ??= response?.turn?.id ?? null;
      if (turn.turnId) await options.onTurnStarted?.({ threadId, turnId: turn.turnId });
    } catch (error) {
      turn.status = "failed";
      turn.error ??= error.message;
      settle();
    }

    await done;
    clearInterval(heartbeat);
    clearTimeout(timer);
    this.turnListener = null;
    this.turnAbort = null;

    if (turn.status === "timeout" && turn.turnId) {
      const result = await withTimeout(this.interruptTurn(threadId, turn.turnId), 5000, { interrupted: false });
      if (result.interrupted) turn.error += " Codex was interrupted.";
    }

    const { streamedItems, ...result } = turn;
    return { ...result, text: turn.messages.map((m) => m.text).join("\n\n") };
  }

  /**
   * Interrupt a running turn.
   * @param {string} threadId
   * @param {string} turnId
   */
  async interruptTurn(threadId, turnId) {
    try {
      await this.request("turn/interrupt", { threadId, turnId });
      return { interrupted: true };
    } catch (error) {
      return { interrupted: false, detail: error.message };
    }
  }

  /**
   * Close the connection. The app-server exits on stdin EOF after flushing
   * thread state; signals are only a fallback so a later resume sees the
   * last turn.
   */
  async close(opts = {}) {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    const proc = this.proc;
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;

    const force = opts.force === true;
    await new Promise((resolve) => {
      const term = setTimeout(() => proc.kill("SIGTERM"), force ? 50 : 2000);
      const kill = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, force ? 300 : 5000);
      proc.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
      proc.stdin.end();
    });
  }

  // ── Internal ──────────────────────────────────────────────────────

  _send(message) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  _progress(message) {
    this.onProgress?.(message);
  }

  _handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`[app-server] non-JSON line: ${line.slice(0, 120)}\n`);
      return;
    }

    // Response to one of our requests.
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const err = new Error(message.error.message ?? `App server ${pending.method} failed`);
        err.data = message.error;
        pending.reject(err);
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    // Server-initiated request. With approvalPolicy "never" none are expected.
    if (message.id !== undefined && message.method) {
      this._send({
        id: message.id,
        error: { code: -32601, message: `Unsupported: ${message.method}` },
      });
      return;
    }

    if (WARNING_NOTIFICATIONS.has(message.method)) {
      const p = message.params ?? {};
      const text = p.summary ?? p.message ?? p.details ?? JSON.stringify(p);
      this._progress(`Codex ${message.method}: ${text}`);
      return;
    }

    this.turnListener?.(message);
  }

  _fail(error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turnAbort?.(error);
  }
}

/**
 * Create and connect an app server client.
 * @param {string} cwd
 * @param {ConstructorParameters<typeof CodexAppServer>[1]} [options]
 */
export async function connectAppServer(cwd, options = {}) {
  const server = new CodexAppServer(cwd, options);
  try {
    await server.connect();
  } catch (error) {
    await server.close({ force: true });
    throw error;
  }
  return server;
}
