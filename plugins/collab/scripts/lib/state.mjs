import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".collab";
const SESSIONS_DIR = "sessions";
const ACTIVE_FILE = "active-session.json";
const KNOWLEDGE_FILE = "knowledge.json";

/**
 * @typedef {{
 *   id: string,
 *   task: string,
 *   phase: string,
 *   threadId: string | null,
 *   executeThreadId: string | null,
 *   messages: Array<{ role: string, content: string, timestamp: string }>,
 *   plan: string | null,
 *   convergedPlan: string | null,
 *   decisions: Array<{ description: string, proposedBy: string, decidedBy: string | null }>,
 *   notes: string[],
 *   bugsCaught: string[],
 *   filesCreated: string[],
 *   filesModified: string[],
 *   resumeEvents: Array<{ resumedAt: string, previousStatus: string }>,
 *   pendingTurn: { threadId: string, turnId: string, startedAt: string } | null,
 *   gitBaseline: { root: string, entries: Record<string, string> } | null,
 *   startedAt: string,
 *   completedAt: string | null,
 *   status: string
 * }} Session
 */

function resolveStateDir(cwd) {
  return path.join(cwd ?? process.cwd(), STATE_DIR);
}

function resolveSessionsDir(cwd) {
  return path.join(resolveStateDir(cwd), SESSIONS_DIR);
}

/**
 * Create the state dir with a `*` .gitignore so session logs never show up in
 * `git status` or get swept into a commit.
 */
export function ensureStateDir(cwd) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(path.join(dir, SESSIONS_DIR), { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

/**
 * Write JSON via a temp file + rename, so a process killed mid-write (e.g. a
 * Bash tool timeout) never leaves a truncated file behind.
 */
function writeJsonAtomic(filePath, value, pretty = true) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  for (const key of ["messages", "decisions", "notes", "bugsCaught", "filesCreated", "filesModified", "resumeEvents"]) {
    if (!Array.isArray(session[key])) session[key] = [];
  }
  if (session.pendingTurn == null || typeof session.pendingTurn !== "object" || Array.isArray(session.pendingTurn)) {
    session.pendingTurn = null;
  }
  return session;
}

function generateSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `collab-${ts}-${rand}`;
}

/**
 * Create a new session and make it active.
 * @param {string} task
 * @param {string} [cwd]
 * @returns {Session}
 */
export function createSession(task, cwd) {
  /** @type {Session} */
  const session = {
    id: generateSessionId(),
    task,
    phase: "plan",
    threadId: null,
    executeThreadId: null,
    messages: [],
    plan: null,
    convergedPlan: null,
    decisions: [],
    notes: [],
    bugsCaught: [],
    filesCreated: [],
    filesModified: [],
    resumeEvents: [],
    pendingTurn: null,
    gitBaseline: null,
    startedAt: nowIso(),
    completedAt: null,
    status: "active",
  };

  saveSession(session, cwd);
  setActiveSession(session.id, cwd);
  return session;
}

/**
 * @param {Session} session
 * @param {string} [cwd]
 */
export function saveSession(session, cwd) {
  ensureStateDir(cwd);
  writeJsonAtomic(path.join(resolveSessionsDir(cwd), `${session.id}.json`), session);
}

/**
 * @param {string} id
 * @param {string} [cwd]
 * @returns {Session | null}
 */
export function loadSession(id, cwd) {
  return normalizeSession(readJson(path.join(resolveSessionsDir(cwd), `${id}.json`)));
}

/**
 * @param {string | null} id
 * @param {string} [cwd]
 */
export function setActiveSession(id, cwd) {
  const dir = ensureStateDir(cwd);
  writeJsonAtomic(path.join(dir, ACTIVE_FILE), { id, updatedAt: nowIso() }, false);
}

/**
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function getActiveSessionId(cwd) {
  const id = readJson(path.join(resolveStateDir(cwd), ACTIVE_FILE))?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * Append a message to the session log (in memory; call saveSession after).
 * @param {Session} session
 * @param {string} role - "claude" | "codex" | "user" | "system"
 * @param {string} content
 */
export function addMessage(session, role, content) {
  session.messages.push({ role, content, timestamp: nowIso() });
}

/**
 * Mark session as finished. Completed/rejected sessions release the active
 * pointer; halted ones keep it so they can be resumed.
 * @param {Session} session
 * @param {string} status - "completed" | "halted" | "rejected"
 * @param {string} [cwd]
 */
export function completeSession(session, status, cwd) {
  session.status = status;
  session.completedAt = nowIso();
  saveSession(session, cwd);
  if (status === "completed" || status === "rejected") setActiveSession(null, cwd);
}

/**
 * Resume a halted session.
 * @param {Session} session
 * @param {string} [cwd]
 */
export function resumeSession(session, cwd) {
  session.resumeEvents.push({ resumedAt: nowIso(), previousStatus: session.status ?? "unknown" });
  session.status = "active";
  session.completedAt = null;
  saveSession(session, cwd);
  setActiveSession(session.id, cwd);
}

/**
 * @param {string} id
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function deleteSession(id, cwd) {
  try {
    fs.unlinkSync(path.join(resolveSessionsDir(cwd), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * List all sessions, newest first. Unreadable files are skipped.
 * @param {string} [cwd]
 * @returns {Session[]}
 */
export function listSessions(cwd) {
  const dir = resolveSessionsDir(cwd);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => normalizeSession(readJson(path.join(dir, f))))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/**
 * Load the cross-session decision knowledge base.
 * @param {string} [cwd]
 * @returns {Array<{ description: string, decidedBy: string | null, sessionId: string, date: string | null }>}
 */
export function loadKnowledge(cwd) {
  const parsed = readJson(path.join(resolveStateDir(cwd), KNOWLEDGE_FILE));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * @param {Array<object>} entries
 * @param {string} [cwd]
 */
export function saveKnowledge(entries, cwd) {
  const dir = ensureStateDir(cwd);
  writeJsonAtomic(path.join(dir, KNOWLEDGE_FILE), entries);
}

/**
 * Add unique decisions from a completed session into the knowledge base
 * (newest 20 kept).
 * @param {Session} session
 * @param {string} [cwd]
 */
export function appendDecisionsToKnowledge(session, cwd) {
  const deduped = new Map();
  const add = (description, decidedBy, sessionId, date) => {
    const text = typeof description === "string" ? description.trim() : "";
    if (!text || !sessionId) return;
    const key = `${sessionId}::${text}`;
    if (!deduped.has(key)) deduped.set(key, { description: text, decidedBy: decidedBy ?? null, sessionId, date: date ?? null });
  };

  for (const entry of loadKnowledge(cwd)) {
    add(entry?.description, entry?.decidedBy, typeof entry?.sessionId === "string" ? entry.sessionId : "", entry?.date);
  }
  for (const decision of session.decisions ?? []) {
    add(decision?.description, decision?.decidedBy, session.id, session.completedAt);
  }

  const sorted = [...deduped.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  saveKnowledge(sorted.slice(0, 20), cwd);
}
