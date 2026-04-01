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

function normalizeSession(session) {
  if (!session || typeof session !== "object") return session;
  if (!Array.isArray(session.decisions)) session.decisions = [];
  if (!Array.isArray(session.notes)) session.notes = [];
  if (!Array.isArray(session.bugsCaught)) session.bugsCaught = [];
  if (!Array.isArray(session.filesCreated)) session.filesCreated = [];
  if (!Array.isArray(session.filesModified)) session.filesModified = [];
  if (!Array.isArray(session.resumeEvents)) session.resumeEvents = [];
  if (
    session.pendingTurn == null ||
    typeof session.pendingTurn !== "object" ||
    Array.isArray(session.pendingTurn)
  ) {
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
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeSession(parsed);
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
 * Resume a halted session.
 * @param {Session} session
 * @param {string} [cwd]
 */
export function resumeSession(session, cwd) {
  normalizeSession(session);
  session.resumeEvents.push({
    resumedAt: nowIso(),
    previousStatus: session.status ?? "unknown",
  });
  session.status = "active";
  session.completedAt = null;
  saveSession(session, cwd);
  setActiveSession(session.id, cwd);
}

/**
 * Delete a session by ID.
 * @param {string} id
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function deleteSession(id, cwd) {
  const filePath = path.join(resolveSessionsDir(cwd), `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
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
      .map((f) => normalizeSession(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))))
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  } catch {
    return [];
  }
}

/**
 * Load the cross-session decision knowledge base.
 * @param {string} [cwd]
 * @returns {Array<{ description: string, decidedBy: string | null, sessionId: string, date: string | null }>}
 */
export function loadKnowledge(cwd) {
  const filePath = path.join(resolveStateDir(cwd), KNOWLEDGE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save the cross-session decision knowledge base atomically.
 * @param {Array<object>} entries
 * @param {string} [cwd]
 */
export function saveKnowledge(entries, cwd) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });

  const knowledgePath = path.join(stateDir, KNOWLEDGE_FILE);
  const tmpPath = `${knowledgePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + "\n");
  fs.renameSync(tmpPath, knowledgePath);
}

/**
 * Add unique decisions from a completed session into the knowledge base.
 * @param {Session} session
 * @param {string} [cwd]
 */
export function appendDecisionsToKnowledge(session, cwd) {
  const existing = loadKnowledge(cwd);
  const deduped = new Map();

  for (const entry of existing) {
    const description = typeof entry?.description === "string" ? entry.description.trim() : "";
    const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
    if (!description || !sessionId) continue;
    const key = `${sessionId}::${description}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        description,
        decidedBy: entry.decidedBy ?? null,
        sessionId,
        date: entry.date ?? null,
      });
    }
  }

  for (const decision of session.decisions ?? []) {
    const description =
      typeof decision?.description === "string" ? decision.description.trim() : "";
    if (!description) continue;

    const key = `${session.id}::${description}`;
    if (deduped.has(key)) continue;
    deduped.set(key, {
      description,
      decidedBy: decision.decidedBy ?? null,
      sessionId: session.id,
      date: session.completedAt ?? null,
    });
  }

  const sorted = Array.from(deduped.values()).sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? "")
  );
  const capped = sorted.slice(0, 20);
  saveKnowledge(capped, cwd);
}
