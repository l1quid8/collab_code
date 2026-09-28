import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyTurnNotification,
  createTurnState,
  describeTurnError,
  normalizeSandbox,
  shortCommand,
} from "../scripts/lib/app-server.mjs";

const THREAD = "thr_main";
const TURN = "turn_1";

function run(notifications) {
  const turn = createTurnState(THREAD);
  const text = [];
  const hooks = { onAgentText: (_id, chunk) => text.push(chunk) };
  for (const n of notifications) applyTurnNotification(turn, n, hooks);
  return { turn, streamed: text.join("") };
}

const completed = (item) => ({ method: "item/completed", params: { item, threadId: THREAD, turnId: TURN } });
const turnCompleted = (status, error = null, threadId = THREAD) => ({
  method: "turn/completed",
  params: { threadId, turn: { id: threadId === THREAD ? TURN : "other", status, error } },
});

test("failed turn surfaces the provider error message", () => {
  const error = { message: '{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}' };
  const { turn } = run([
    { method: "error", params: { error, willRetry: false, threadId: THREAD, turnId: TURN } },
    turnCompleted("failed", error),
  ]);
  assert.equal(turn.status, "failed");
  assert.equal(turn.error, "Rate limit reached (rate_limit_exceeded)");
});

test("retryable errors do not fail the turn", () => {
  const { turn } = run([
    { method: "error", params: { error: { message: "stream disconnected" }, willRetry: true, threadId: THREAD, turnId: TURN } },
    turnCompleted("completed"),
  ]);
  assert.equal(turn.status, "completed");
  assert.equal(turn.error, null);
});

test("commands are recorded with their final exit code", () => {
  const cmd = { id: "c1", type: "commandExecution", command: "/bin/bash -lc ls", status: "inProgress", exitCode: null };
  const { turn } = run([
    { method: "item/started", params: { item: cmd, threadId: THREAD, turnId: TURN } },
    completed({ ...cmd, status: "completed", exitCode: 0 }),
  ]);
  assert.deepEqual(turn.commands, [{ command: "/bin/bash -lc ls", exitCode: 0, status: "completed" }]);
});

test("file changes use kind.type and skip declined patches", () => {
  const { turn } = run([
    completed({
      id: "p1",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "/r/new.py", kind: { type: "add" } },
        { path: "/r/old.py", kind: { type: "update", move_path: "/r/moved.py" } },
      ],
    }),
    completed({ id: "p2", type: "fileChange", status: "declined", changes: [{ path: "/r/x.py", kind: { type: "delete" } }] }),
  ]);
  assert.deepEqual(turn.fileChanges, [
    { path: "/r/new.py", kind: "add", movePath: null },
    { path: "/r/old.py", kind: "update", movePath: "/r/moved.py" },
  ]);
});

test("agent messages are kept separately; unstreamed text is still emitted", () => {
  const { turn, streamed } = run([
    { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "Looking." } },
    completed({ id: "m1", type: "agentMessage", text: "Looking.", phase: "commentary" }),
    completed({ id: "m2", type: "agentMessage", text: "Final.", phase: "final_answer" }),
  ]);
  assert.deepEqual(turn.messages.map((m) => m.text), ["Looking.", "Final."]);
  assert.equal(streamed, "Looking.Final.");
});

test("notifications from other threads cannot complete the turn", () => {
  const { turn } = run([turnCompleted("completed", null, "thr_child")]);
  assert.equal(turn.status, "inProgress");
});

test("shortCommand unwraps shell wrappers and collapses multi-line commands", () => {
  assert.equal(shortCommand("/bin/bash -lc ls"), "ls");
  assert.equal(shortCommand("/bin/bash -lc 'echo it'\\''s'"), "echo it's");
  assert.equal(shortCommand("bash -lc 'cat > f <<EOF\na\nEOF'"), "cat > f <<EOF … (+2 lines)");
  assert.equal(shortCommand("git status"), "git status");
});

test("describeTurnError passes plain messages through", () => {
  assert.equal(describeTurnError({ message: "boom", additionalDetails: "ctx" }), "boom — ctx");
  assert.equal(describeTurnError(null), "Codex turn failed.");
});

test("normalizeSandbox emits kebab-case", () => {
  assert.equal(normalizeSandbox("workspaceWrite"), "workspace-write");
  assert.equal(normalizeSandbox("danger-full-access"), "danger-full-access");
  assert.equal(normalizeSandbox(null), "read-only");
});
