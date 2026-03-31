import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".collab";
const SESSIONS_DIR = "sessions";
const ACTIVE_FILE = "active-session.json";

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
 *   bugsCaught: string[],
 *   filesCreated: string[],
 *   filesModified: string[],
 *   gitBaseline: Record<string, string> | null,
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

function ensureDirs(cwd) {
  const sessDir = resolveSessionsDir(cwd);
  fs.mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function nowIso() {
  return new Date().toISOString();
}

function generateSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `collab-${ts}-${rand}`;
}

/**
 * Create a new session.
 * @param {string} task
 * @param {string} [cwd]
 * @returns {Session}
 */
export function createSession(task, cwd) {
  const id = generateSessionId();
  /** @type {Session} */
  const session = {
    id,
    task,
    phase: "plan",
    threadId: null,
    executeThreadId: null,
    messages: [],
    plan: null,
    convergedPlan: null,
    decisions: [],
    bugsCaught: [],
    filesCreated: [],
    filesModified: [],
    gitBaseline: null,
    startedAt: nowIso(),
    completedAt: null,
    status: "active",
  };

  saveSession(session, cwd);
  setActiveSession(id, cwd);
  return session;
}

/**
 * Save a session to disk.
 * @param {Session} session
 * @param {string} [cwd]
 */
export function saveSession(session, cwd) {
  const dir = ensureDirs(cwd);
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n");

  // Also write latest-session mirror file (not a symlink — plain file copy)
  const latestPath = path.join(resolveStateDir(cwd), "session-latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Load a session by ID.
 * @param {string} id
 * @param {string} [cwd]
 * @returns {Session | null}
 */
export function loadSession(id, cwd) {
  const filePath = path.join(resolveSessionsDir(cwd), `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load the latest session.
 * @param {string} [cwd]
 * @returns {Session | null}
 */
export function loadLatestSession(cwd) {
  const latestPath = path.join(resolveStateDir(cwd), "session-latest.json");
  try {
    return JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Set the active session ID.
 * @param {string} id
 * @param {string} [cwd]
 */
export function setActiveSession(id, cwd) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ACTIVE_FILE),
    JSON.stringify({ id, updatedAt: nowIso() }) + "\n"
  );
}

/**
 * Get the active session ID.
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function getActiveSessionId(cwd) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(resolveStateDir(cwd), ACTIVE_FILE), "utf8")
    );
    return data.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a message to a session.
 * @param {Session} session
 * @param {string} role - "claude" | "codex" | "user" | "system"
 * @param {string} content
 * @param {string} [cwd]
 */
export function addMessage(session, role, content, cwd) {
  session.messages.push({ role, content, timestamp: nowIso() });
  saveSession(session, cwd);
}

/**
 * Update session phase.
 * @param {Session} session
 * @param {string} phase
 * @param {string} [cwd]
 */
export function setPhase(session, phase, cwd) {
  session.phase = phase;
  saveSession(session, cwd);
}

/**
 * Mark session as complete.
 * @param {Session} session
 * @param {string} status - "completed" | "halted" | "rejected"
 * @param {string} [cwd]
 */
export function completeSession(session, status, cwd) {
  const completedAt = nowIso();
  session.status = status;
  session.completedAt = completedAt;
  saveSession(session, cwd);

  if (status === "completed" || status === "rejected") {
    const stateDir = resolveStateDir(cwd);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ACTIVE_FILE),
      JSON.stringify({ id: null, clearedAt: completedAt }) + "\n"
    );
  }
}

/**
 * List all sessions.
 * @param {string} [cwd]
 * @returns {Session[]}
 */
export function listSessions(cwd) {
  const dir = resolveSessionsDir(cwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  } catch {
    return [];
  }
}
