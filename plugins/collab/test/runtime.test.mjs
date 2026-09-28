// End-to-end tests of collab-runtime.mjs against a fake `codex` on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, "..", "scripts", "collab-runtime.mjs");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");
let binDir;

before(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-bin-"));
  const shim = path.join(binDir, "codex");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
});

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-e2e-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "app.py"), "print('hi')\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

function collab(cwd, args, { scenario = "debate", input, log } = {}) {
  const result = spawnSync(process.execPath, [RUNTIME, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_SCENARIO: scenario,
      ...(log ? { FAKE_CODEX_LOG: log } : {}),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const status = (cwd) => JSON.parse(collab(cwd, ["session-status"]).stdout);

test("setup reports ready with version and auth", () => {
  const cwd = tempRepo();
  const out = collab(cwd, ["setup", "--json"]);
  assert.equal(out.code, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.codex.version, "0.158.0");
  assert.equal(report.auth.detail, "API key");
});

test("debate reads the plan from stdin and separates Codex messages", () => {
  const cwd = tempRepo();
  const log = path.join(cwd, ".collab-rpc.log");
  collab(cwd, ["session-create", "add hello"]);
  const plan = "Use `hello()`; keep $HOME and \"quotes\" literal.";
  const out = collab(cwd, ["debate-start", "-"], { input: plan, log });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\[CODEX RESPONSE\]\nReading the plan\.\n\nLGTM with one change\./);

  const sent = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const init = sent.find((m) => m.method === "initialize");
  assert.equal(init.params.capabilities.requestAttestation, false);
  assert.ok(init.params.capabilities.optOutNotificationMethods.includes("turn/diff/updated"));
  const turnStart = sent.find((m) => m.method === "turn/start");
  assert.ok(turnStart.params.input[0].text.includes(plan));
  assert.equal(sent.find((m) => m.method === "thread/start").params.sandbox, "read-only");

  const resume = collab(cwd, ["debate-turn", "Agreed."], { log });
  assert.equal(resume.code, 0, resume.stderr);
  const resumed = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.method === "thread/resume");
  assert.equal(resumed.params.excludeTurns, true);
});

test("a failed Codex turn exits non-zero with the real error", () => {
  const cwd = tempRepo();
  collab(cwd, ["session-create", "t"]);
  const out = collab(cwd, ["debate-start", "plan"], { scenario: "fail" });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /\[CODEX ERROR\] Rate limit reached \(rate_limit_exceeded\)/);
});

test("sub-agent completions do not end the turn early", () => {
  const cwd = tempRepo();
  collab(cwd, ["session-create", "t"]);
  const out = collab(cwd, ["debate-start", "plan"], { scenario: "subagent" });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Main thread answer\./);
});

test("execute tracks created vs modified files and exit codes", () => {
  const cwd = tempRepo();
  collab(cwd, ["session-create", "t"]);
  const out = collab(cwd, ["execute", "build it"], { scenario: "execute" });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\$ echo gen > gen\.txt \(exit 0\)/);
  assert.match(out.stdout, /add: hello\.py/);

  const s = status(cwd);
  assert.equal(s.phase, "review");
  assert.deepEqual(s.filesCreated.sort(), ["gen.txt", "hello.py"]);
  assert.deepEqual(s.filesModified, ["app.py"]);

  // The state dir ignores itself, so git status shows only Codex's work.
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  assert.doesNotMatch(porcelain, /\.collab/);
});

test("a turn that exceeds the timeout is interrupted and reported", () => {
  const cwd = tempRepo();
  collab(cwd, ["config", "--set", "turnTimeoutMs=1000"]);
  collab(cwd, ["session-create", "t"]);
  const out = collab(cwd, ["debate-start", "plan"], { scenario: "hang" });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /timed out after 1s\. Codex was interrupted\./);
  assert.equal(status(cwd).pendingTurn, null);
});

test("config rejects values that would break turns", () => {
  const cwd = tempRepo();
  assert.equal(collab(cwd, ["config", "--set", "turnTimeoutMs=5m"]).code, 1);
  assert.equal(collab(cwd, ["config", "--set", "codexSandbox=workspace"]).code, 1);
  assert.equal(collab(cwd, ["config", "--set", "architect=opus"]).code, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, ".collab", "config.json"), "utf8"));
  assert.deepEqual(stored, { architect: "opus" });
});

test("missing codex binary gives an install hint", () => {
  const cwd = tempRepo();
  collab(cwd, ["session-create", "t"]);
  const result = spawnSync(process.execPath, [RUNTIME, "debate-start", "plan"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: path.dirname(process.execPath) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex CLI not found on PATH\. Install with: npm install -g @openai\/codex/);
});
