import fs from "node:fs";
import path from "node:path";

import { ensureStateDir } from "./state.mjs";

const CONFIG_DIR = ".collab";
const CONFIG_FILE = "config.json";

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

const DEFAULTS = {
  architect: null,
  // Just under the Bash tool's 10-minute ceiling, so the runtime can
  // interrupt Codex and report partial work before the host kills it.
  turnTimeoutMs: 570000,
  idleTimeoutMs: 60000, // heartbeat after this much silence (does not end the turn)
  codexSandbox: "workspace-write",
  codexDebateSandbox: "read-only",
};

const isDuration = (v) => Number.isInteger(v) && v >= 1000;
const isSandbox = (v) => SANDBOX_MODES.includes(v);

const VALIDATORS = {
  architect: [(v) => v === null || (typeof v === "string" && v.trim() !== ""), "a model name, e.g. opus or sonnet"],
  turnTimeoutMs: [isDuration, "an integer number of milliseconds >= 1000"],
  idleTimeoutMs: [isDuration, "an integer number of milliseconds >= 1000"],
  codexSandbox: [isSandbox, SANDBOX_MODES.join(" | ")],
  codexDebateSandbox: [isSandbox, SANDBOX_MODES.join(" | ")],
};

function resolveConfigPath(cwd) {
  return path.join(cwd ?? process.cwd(), CONFIG_DIR, CONFIG_FILE);
}

function loadStored(cwd) {
  try {
    const stored = JSON.parse(fs.readFileSync(resolveConfigPath(cwd), "utf8"));
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {}; // No config yet — use defaults.
  }
}

/**
 * Load the full config, merged with defaults.
 * @param {string} [cwd]
 * @returns {typeof DEFAULTS}
 */
export function loadConfig(cwd) {
  return { ...DEFAULTS, ...loadStored(cwd) };
}

/**
 * Validate and save a config value.
 * @param {string} key
 * @param {*} value
 * @param {string} [cwd]
 */
export function setConfigValue(key, value, cwd) {
  const validator = VALIDATORS[key];
  if (!validator) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${Object.keys(DEFAULTS).join(", ")}`);
  }
  const [isValid, expected] = validator;
  if (!isValid(value)) {
    throw new Error(`Invalid value ${JSON.stringify(value)} for ${key}. Expected ${expected}.`);
  }

  // Persist only explicitly set keys, so later default changes still apply.
  ensureStateDir(cwd);
  const stored = loadStored(cwd);
  stored[key] = value;
  fs.writeFileSync(resolveConfigPath(cwd), JSON.stringify(stored, null, 2) + "\n");
  return { ...DEFAULTS, ...stored };
}
