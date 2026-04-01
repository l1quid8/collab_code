/**
 * JSON-RPC client for Codex App Server.
 *
 * Spawns `codex app-server` as a child process and communicates via
 * newline-delimited JSON over stdio. Handles the initialize handshake,
 * thread lifecycle, turn capture, and notification streaming.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadPluginVersion() {
  try {
    const pluginJsonPath = path.resolve(
      MODULE_DIR,
      "../../../.claude-plugin/plugin.json"
    );
    const pluginJson = require(pluginJsonPath);
    const version = pluginJson?.version;
    if (typeof version === "string" && version.trim() !== "") {
      return version;
    }
  } catch {
    // Fall through to default.
  }
  return "0.0.0";
}

const PLUGIN_VERSION = loadPluginVersion();

const CLIENT_INFO = {
  title: "Collab Plugin",
  name: "Claude Code Collab",
  version: PLUGIN_VERSION,
};

const CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
  ],
};

/**
 * @typedef {{
 *   threadId: string,
 *   turnId: string | null,
 *   lastMessage: string,
 *   reviewText: string,
 *   fileChanges: Array<object>,
 *   commandExecutions: Array<object>,
 *   error: unknown,
 *   completed: boolean,
 *   messages: Array<{ phase: string | null, text: string }>
 * }} TurnResult
 */

export class CodexAppServer {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.proc = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.onNotification = options.onNotification ?? null;
    this.onProgress = options.onProgress ?? null;
    this.onAgentDelta = options.onAgentDelta ?? null;
  }

  /**
   * Connect to the Codex app server.
   * Spawns the process and performs the initialize handshake.
   */
  async connect() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (err) => {
      this._rejectAll(err);
    });

    this.proc.on("exit", (code, signal) => {
      const err =
        code === 0
          ? null
          : new Error(
              `codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})`
            );
      this._rejectAll(err);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this._handleLine(line));

    // Initialize handshake
    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: CAPABILITIES,
    });
    this._send({ method: "initialized", params: {} });
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * @template T
   * @param {string} method
   * @param {object} params
   * @returns {Promise<T>}
   */
  request(method, params) {
    if (this.closed) throw new Error("App server connection is closed.");

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this._send({ id, method, params });
    });
  }

  /**
   * Start a new Codex thread.
   * @param {{ model?: string, sandbox?: string, threadName?: string, ephemeral?: boolean }} options
   */
  async startThread(options = {}) {
    const response = await this.request("thread/start", {
      cwd: this.cwd,
      model: options.model ?? null,
      approvalPolicy: "never",
      sandbox: options.sandbox ?? "read-only",
      serviceName: "claude_code_collab_plugin",
      ephemeral: options.ephemeral ?? true,
      experimentalRawEvents: false,
    });
    return response;
  }

  /**
   * Resume an existing thread.
   * @param {string} threadId
   * @param {{ model?: string, sandbox?: string }} options
   */
  async resumeThread(threadId, options = {}) {
    const response = await this.request("thread/resume", {
      threadId,
      cwd: this.cwd,
      model: options.model ?? null,
      approvalPolicy: "never",
      sandbox: options.sandbox ?? "read-only",
    });
    return response;
  }

  /**
   * Send a turn (message) to a thread and capture the full response.
   * Returns when the turn is complete.
   *
   * @param {string} threadId
   * @param {string} prompt
   * @param {{ model?: string, effort?: string, timeoutMs?: number, idleTimeoutMs?: number, onTurnStarted?: (info: { threadId: string, turnId: string }) => void | Promise<void> }} options
   * @returns {Promise<TurnResult>}
   */
  async sendTurn(threadId, prompt, options = {}) {
    const state = {
      threadId,
      turnId: null,
      lastMessage: "",
      reviewText: "",
      fileChanges: [],
      commandExecutions: [],
      error: null,
      completed: false,
      messages: [],
      _lastNotificationAt: null,
      _lastDeltaAt: null,
      _lastHeartbeatAt: null,
    };

    // Set up notification handler to capture turn progress
    const prevHandler = this.onNotification;
    this.onNotification = (notification) => {
      this._processTurnNotification(notification, state);
      if (prevHandler) prevHandler(notification);
    };

    try {
      const response = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: options.model ?? null,
        effort: options.effort ?? null,
        outputSchema: null,
      });
      const turnId = state.turnId ?? response?.turn?.id ?? response?.turnId ?? null;
      if (turnId) {
        state.turnId = turnId;
        if (typeof options.onTurnStarted === "function") {
          await options.onTurnStarted({ threadId, turnId });
        }
      }
      state._lastNotificationAt = Date.now();

      // Wait for turn completion via notifications
      if (!state.completed) {
        await this._waitForTurnCompletion(
          state,
          options.timeoutMs ?? 600000,
          options.idleTimeoutMs ?? 30000
        );
      }

      state.turnId = state.turnId ?? response?.turnId ?? null;
    } catch (error) {
      state.error = error;
    } finally {
      this.onNotification = prevHandler;
    }

    return state;
  }

  /**
   * Start a review on a thread.
   * @param {string} threadId
   * @param {{ target?: object }} options
   * @returns {Promise<TurnResult>}
   */
  async startReview(threadId, options = {}) {
    const state = {
      threadId,
      turnId: null,
      lastMessage: "",
      reviewText: "",
      fileChanges: [],
      commandExecutions: [],
      error: null,
      completed: false,
      messages: [],
      _lastNotificationAt: Date.now(),
    };

    const prevHandler = this.onNotification;
    this.onNotification = (notification) => {
      this._processTurnNotification(notification, state);
      if (prevHandler) prevHandler(notification);
    };

    try {
      await this.request("review/start", {
        threadId,
        delivery: "inline",
        target: options.target ?? { type: "uncommittedChanges" },
      });

      if (!state.completed) {
        await this._waitForTurnCompletion(state, 600000, 30000); // 10 min hard, 30s idle
      }
    } catch (error) {
      state.error = error;
    } finally {
      this.onNotification = prevHandler;
    }

    return state;
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
   * Close the app server connection.
   */
  async close(opts = {}) {
    if (this.closed) return;
    this.closed = true;
    const force = opts.force === true;

    if (this.rl) this.rl.close();
    if (this.proc && !this.proc.killed) {
      const proc = this.proc;
      this.proc.stdin.end();
      setTimeout(() => {
        if (proc && !proc.killed) proc.kill("SIGTERM");
      }, force ? 50 : 100);
      if (force) {
        setTimeout(() => {
          if (proc && !proc.killed) proc.kill("SIGKILL");
        }, 300);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  _send(message) {
    if (!this.proc?.stdin) throw new Error("App server stdin not available.");
    this.proc.stdin.write(JSON.stringify(message) + "\n");
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

    // Response to a request
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        const err = new Error(
          message.error.message ?? `App server ${pending.method} failed`
        );
        err.data = message.error;
        pending.reject(err);
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    // Server request (we auto-reject — we don't handle server-initiated requests)
    if (message.id !== undefined && message.method) {
      this._send({
        id: message.id,
        error: { code: -32601, message: `Unsupported: ${message.method}` },
      });
      return;
    }

    // Notification
    if (message.method && this.onNotification) {
      this.onNotification(message);
    }
  }

  _processTurnNotification(notification, state) {
    const method = notification.method;
    const params = notification.params ?? {};

    // Track last notification time for idle-timeout detection
    state._lastNotificationAt = Date.now();

    switch (method) {
      case "turn/started":
        state.turnId = params.turn?.id ?? params.turnId ?? state.turnId;
        this._emitProgress("Codex turn started.", "running");
        break;

      case "turn/completed":
        state.completed = true;
        state.turnId = params.turn?.id ?? params.turnId ?? state.turnId;
        // If deltas were accumulated but never flushed to messages array, do it now
        if (state.lastMessage && state.messages.length === 0) {
          state.messages.push({ phase: "agent", text: state.lastMessage });
        }
        this._emitProgress("Codex turn completed.", "done");
        break;

      case "turn/error":
        state.completed = true;
        state.error = params.error ?? params.message ?? "Turn error";
        this._emitProgress(`Codex error: ${state.error}`, "error");
        break;

      case "item/agentMessage/delta": {
        // Try all known field names for the text chunk
        const chunk = params.text ?? params.delta ?? params.output ?? params.content ?? params.value ?? "";
        if (chunk) {
          state.lastMessage = (state.lastMessage ?? "") + chunk;
          this.onAgentDelta?.(chunk);
        }
        state._lastDeltaAt = Date.now();
        break;
      }

      case "item/agentMessage": {
        // Consolidated message — use it if we don't already have accumulated deltas
        const msg = params.text ?? params.message ?? "";
        if (msg) {
          state.lastMessage = msg;
          state.messages.push({ phase: "agent", text: msg });
        }
        break;
      }

      case "item/reviewResult":
        state.reviewText = params.text ?? params.review ?? "";
        state.completed = true;
        this._emitProgress("Codex review complete.", "done");
        break;

      case "item/started": {
        const item = params.item ?? params;
        if (item.type === "fileChange") {
          state.fileChanges.push(item);
          const count = item.changes?.length ?? 0;
          this._emitProgress(`File change: ${count} edit(s).`, "editing");
        } else if (item.type === "commandExecution") {
          state.commandExecutions.push(item);
          const cmd = item.command ?? "";
          this._emitProgress(`Running: ${cmd.slice(0, 80)}`, "running");
        }
        break;
      }

      case "item/completed": {
        const item = params.item ?? params;
        if (item.type === "commandExecution") {
          const cmd = item.command ?? "";
          const exit = item.exitCode ?? item.exit_code;
          this._emitProgress(
            `Command finished (exit ${exit}): ${cmd.slice(0, 60)}`,
            exit === 0 ? "running" : "error"
          );
        }
        // Message-type item/completed no longer triggers turn completion.
        // Rely on turn/completed notification (or the hard timeout) instead.
        break;
      }
    }
  }

  _emitProgress(message, phase) {
    if (this.onProgress) {
      this.onProgress({ message, phase });
    }
  }

  _waitForTurnCompletion(state, timeoutMs, idleTimeoutMs = 30000) {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const now = Date.now();
        if (state.completed || state.error) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(state);
          return;
        }

        const sinceLastDelta = state._lastDeltaAt ? now - state._lastDeltaAt : Infinity;
        const sinceLastHeartbeat = state._lastHeartbeatAt ? now - state._lastHeartbeatAt : Infinity;
        if (!state.completed && !state.error && sinceLastDelta > 5000 && sinceLastHeartbeat > 5000) {
          this._emitProgress("Codex is still working...", "running");
          state._lastHeartbeatAt = now;
        }

        // Idle timeout: no notifications received for idleTimeoutMs
        if (
          state._lastNotificationAt !== null &&
          now - state._lastNotificationAt > idleTimeoutMs
        ) {
          this._emitProgress("Codex is still thinking (no new notifications)...", "running");
          state._lastNotificationAt = now;
        }
      }, 200);

      const timer = setTimeout(() => {
        clearInterval(interval);
        state.error = "Turn timed out.";
        state.completed = true;
        resolve(state);
      }, timeoutMs);
    });
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error("App server connection closed."));
    }
    this.pending.clear();
  }
}

/**
 * Create and connect an app server client.
 * @param {string} cwd
 * @param {object} [options]
 * @returns {Promise<CodexAppServer>}
 */
export async function connectAppServer(cwd, options = {}) {
  const server = new CodexAppServer(cwd, options);
  await server.connect();
  return server;
}
