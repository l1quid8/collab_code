/**
 * Track which files Codex created or modified during execute, so the
 * commit/reject steps can act on exactly those files.
 *
 * Two sources are merged: Codex `fileChange` items (apply_patch edits) and a
 * `git status` delta against a baseline taken before execute (catches files
 * written by shell commands, lockfiles, generated output). Paths are stored
 * relative to the working directory, ready for `git add` / `git checkout`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const STATE_DIR = ".collab";

/**
 * Path relative to cwd when it lies inside cwd, otherwise absolute.
 * @param {string} filePath
 * @param {string} cwd
 */
export function relPath(filePath, cwd) {
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel.split(path.sep).join("/");
}

function isStatePath(rel) {
  return rel === STATE_DIR || rel.startsWith(`${STATE_DIR}/`);
}

/**
 * Parse `git status --porcelain=v1 -z` output into { repoRelativePath: XY }.
 * A rename is split into the new path (added) and the old path (deleted).
 * @param {string} stdout
 */
export function parsePorcelainZ(stdout) {
  const entries = {};
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const original = fields[++i];
      entries[file] = "A ";
      if (code.includes("R") && original) entries[original] = "D ";
      continue;
    }
    entries[file] = code;
  }
  return entries;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * Snapshot the working tree before Codex writes anything.
 * @param {string} cwd
 * @returns {{ root: string, entries: Record<string, string> } | null} null outside a git repo
 */
export function captureGitBaseline(cwd) {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (!root) return null;
  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (status == null) return null;
  return { root, entries: parsePorcelainZ(status) };
}

/**
 * Apply one created/modified/deleted observation to the session lists.
 * A file Codex created stays "created" when edited again, and disappears
 * from the lists if Codex later deletes it.
 */
function classify(created, modified, rel, kind) {
  if (kind === "add") {
    if (!modified.has(rel)) created.add(rel);
  } else if (kind === "delete") {
    if (created.has(rel)) created.delete(rel);
    else modified.add(rel);
  } else if (!created.has(rel)) {
    modified.add(rel);
  }
}

function withLists(session, fn) {
  const created = new Set(session.filesCreated ?? []);
  const modified = new Set(session.filesModified ?? []);
  const out = fn(created, modified);
  session.filesCreated = [...created];
  session.filesModified = [...modified];
  return out;
}

/**
 * Record Codex fileChange items on the session.
 * @param {{ filesCreated: string[], filesModified: string[] }} session
 * @param {Array<{ path: string, kind: string, movePath?: string | null }>} changes
 * @param {string} cwd
 */
export function recordFileChanges(session, changes, cwd) {
  withLists(session, (created, modified) => {
    for (const change of changes ?? []) {
      const rel = relPath(change.path, cwd);
      if (change.movePath) {
        classify(created, modified, rel, "delete");
        classify(created, modified, relPath(change.movePath, cwd), "add");
      } else {
        classify(created, modified, rel, change.kind);
      }
    }
  });
}

/**
 * Record files that changed since the baseline but were not reported as
 * fileChange items. Files already dirty at baseline can't be attributed to
 * Codex, so they are skipped unless Codex reported them.
 *
 * @param {{ filesCreated: string[], filesModified: string[] }} session
 * @param {{ root: string, entries: Record<string, string> } | null} baseline
 * @param {string} cwd
 * @returns {{ added: string[], unattributed: string[], preDirtyEdited: string[] } | null}
 */
export function recordGitDelta(session, baseline, cwd) {
  if (!baseline?.root) return null;
  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (status == null) return null;

  return withLists(session, (created, modified) => {
    const added = [];
    const unattributed = [];
    const preDirtyEdited = [];
    const toRel = (file) => relPath(path.join(baseline.root, file), cwd);

    for (const file of Object.keys(baseline.entries)) {
      const rel = toRel(file);
      if (created.has(rel) || modified.has(rel)) preDirtyEdited.push(rel);
    }

    for (const [file, code] of Object.entries(parsePorcelainZ(status))) {
      const rel = toRel(file);
      if (isStatePath(rel) || created.has(rel) || modified.has(rel)) continue;
      if (Object.hasOwn(baseline.entries, file)) {
        unattributed.push(rel);
        continue;
      }
      const kind = code === "??" || code.includes("A") ? "add" : code.includes("D") ? "delete" : "update";
      classify(created, modified, rel, kind);
      added.push(rel);
    }
    return { added, unattributed, preDirtyEdited };
  });
}
