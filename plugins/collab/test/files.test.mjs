import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  captureGitBaseline,
  parsePorcelainZ,
  recordFileChanges,
  recordGitDelta,
} from "../scripts/lib/files.mjs";

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-files-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "app.py"), "a\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "n\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

const emptySession = () => ({ filesCreated: [], filesModified: [] });

test("parsePorcelainZ handles renames, spaces and untracked files", () => {
  const entries = parsePorcelainZ("R  sub/new.txt\0sub/old.txt\0 M top.txt\0?? with space.txt\0");
  assert.deepEqual(entries, {
    "sub/new.txt": "A ",
    "sub/old.txt": "D ",
    "top.txt": " M",
    "with space.txt": "??",
  });
});

test("recordFileChanges classifies adds, edits, renames and deletes", () => {
  const cwd = "/repo";
  const session = emptySession();
  recordFileChanges(session, [
    { path: "/repo/new.py", kind: "add" },
    { path: "/repo/app.py", kind: "update" },
    { path: "/repo/old.txt", kind: "update", movePath: "/repo/renamed.txt" },
    { path: "/repo/gone.txt", kind: "delete" },
  ], cwd);
  assert.deepEqual(session.filesCreated, ["new.py", "renamed.txt"]);
  assert.deepEqual(session.filesModified, ["app.py", "old.txt", "gone.txt"]);

  // A later round editing a created file keeps it "created"; deleting it drops it.
  recordFileChanges(session, [{ path: "/repo/new.py", kind: "update" }, { path: "/repo/renamed.txt", kind: "delete" }], cwd);
  assert.deepEqual(session.filesCreated, ["new.py"]);
  assert.deepEqual(session.filesModified, ["app.py", "old.txt", "gone.txt"]);
});

test("recordGitDelta adds shell-written files and skips pre-existing edits", () => {
  const { dir } = tempRepo();
  fs.appendFileSync(path.join(dir, "notes.txt"), "user wip\n"); // dirty before execute
  fs.mkdirSync(path.join(dir, ".collab"));
  fs.writeFileSync(path.join(dir, ".collab", "state.json"), "{}");
  const baseline = captureGitBaseline(dir);

  // "Codex" writes: one reported patch, plus files from shell commands.
  fs.appendFileSync(path.join(dir, "app.py"), "b\n");
  fs.mkdirSync(path.join(dir, "out", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "deep", "gen.txt"), "g\n");
  fs.appendFileSync(path.join(dir, "notes.txt"), "codex\n");

  const session = emptySession();
  recordFileChanges(session, [{ path: path.join(dir, "app.py"), kind: "update" }], dir);
  const delta = recordGitDelta(session, baseline, dir);

  assert.deepEqual(session.filesCreated, ["out/deep/gen.txt"]);
  assert.deepEqual(session.filesModified, ["app.py"]);
  assert.deepEqual(delta.added, ["out/deep/gen.txt"]);
  assert.deepEqual(delta.unattributed, ["notes.txt"]);
});

test("recordGitDelta is a no-op outside a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-nogit-"));
  assert.equal(captureGitBaseline(dir), null);
  assert.equal(recordGitDelta(emptySession(), null, dir), null);
});
