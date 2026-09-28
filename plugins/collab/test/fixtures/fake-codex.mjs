#!/usr/bin/env node
// Stand-in for the `codex` CLI. Speaks the app-server JSON-RPC protocol with
// notification shapes captured from codex-cli 0.158.0. FAKE_CODEX_SCENARIO
// picks the turn: "debate" | "execute" | "fail" | "hang" | "subagent".
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.158.0");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "debate";
const log = process.env.FAKE_CODEX_LOG;
const THREAD = "thr_main";
const TURN = "turn_1";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
const item = (type, fields) => ({ id: `item_${Math.random().toString(36).slice(2, 8)}`, type, ...fields });

function agentMessage(text, phase, { stream = true } = {}) {
  const msg = item("agentMessage", { text: "", phase });
  notify("item/started", { item: msg, threadId: THREAD, turnId: TURN, startedAtMs: 0 });
  if (stream) {
    for (const delta of text.match(/.{1,8}/gs)) {
      notify("item/agentMessage/delta", { threadId: THREAD, turnId: TURN, itemId: msg.id, delta });
    }
  }
  notify("item/completed", { item: { ...msg, text }, threadId: THREAD, turnId: TURN, completedAtMs: 0 });
}

function completeTurn(status = "completed", error = null) {
  notify("turn/completed", { threadId: THREAD, turn: { id: TURN, items: [], status, error } });
}

function runTurn() {
  notify("turn/started", { threadId: THREAD, turn: { id: TURN, items: [], status: "inProgress", error: null } });
  switch (scenario) {
    case "debate":
      agentMessage("Reading the plan.", "commentary");
      agentMessage("LGTM with one change.", "final_answer", { stream: false });
      completeTurn();
      break;
    case "execute": {
      const cmd = item("commandExecution", { command: "/bin/bash -lc 'echo gen > gen.txt'", status: "inProgress", exitCode: null });
      notify("item/started", { item: cmd, threadId: THREAD, turnId: TURN, startedAtMs: 0 });
      fs.writeFileSync("gen.txt", "gen\n");
      notify("item/completed", { item: { ...cmd, status: "completed", exitCode: 0 }, threadId: THREAD, turnId: TURN, completedAtMs: 0 });

      fs.writeFileSync("hello.py", "def hello():\n    return 'hi'\n");
      fs.appendFileSync("app.py", "print('more')\n");
      const changes = [
        { path: path.resolve("hello.py"), kind: { type: "add" }, diff: "" },
        { path: path.resolve("app.py"), kind: { type: "update", move_path: null }, diff: "" },
      ];
      const patch = item("fileChange", { changes, status: "inProgress" });
      notify("item/started", { item: patch, threadId: THREAD, turnId: TURN, startedAtMs: 0 });
      notify("item/completed", { item: { ...patch, status: "completed" }, threadId: THREAD, turnId: TURN, completedAtMs: 0 });

      agentMessage("Done.", "final_answer");
      completeTurn();
      break;
    }
    case "fail": {
      const error = { message: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }), codexErrorInfo: "other", additionalDetails: null };
      notify("error", { error, willRetry: false, threadId: THREAD, turnId: TURN });
      completeTurn("failed", error);
      break;
    }
    case "subagent":
      // A sub-agent thread finishing must not end our turn.
      notify("turn/completed", { threadId: "thr_child", turn: { id: "turn_child", items: [], status: "completed", error: null } });
      agentMessage("Main thread answer.", "final_answer");
      completeTurn();
      break;
    case "hang":
      break; // Wait for turn/interrupt.
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(msg) + "\n");
  if (msg.id === undefined) return; // client notification
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ userAgent: "fake-codex/0.158.0" });
    case "account/read":
      return reply({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    case "thread/start":
      return reply({ thread: { id: THREAD } });
    case "thread/resume":
    case "thread/name/set":
      return reply({});
    case "turn/start":
      reply({ turn: { id: TURN, items: [], status: "inProgress", error: null } });
      return setImmediate(runTurn);
    case "turn/interrupt":
      reply({});
      return completeTurn("interrupted");
    default:
      return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
