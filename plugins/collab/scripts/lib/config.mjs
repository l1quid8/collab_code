import fs from "node:fs";
import path from "node:path";

const CONFIG_DIR = ".collab";
const CONFIG_FILE = "config.json";

const DEFAULTS = {
  architect: null,
  turnTimeoutMs: 600000, // 10 minutes
  idleTimeoutMs: 60000, // 60 seconds between idle heartbeats (does not terminate turn)
  codexSandbox: "workspace-write",
  codexDebateSandbox: "read-only",
  codexSelfReview: true,
};

/**
 * Resolve the config directory path.
 * @param {string} [cwd]
 * @returns {string}
 */
function resolveConfigDir(cwd) {
  return path.join(cwd ?? process.cwd(), CONFIG_DIR);
}

/**
 * Ensure the config directory exists.
 * @param {string} [cwd]
 */
function ensureConfigDir(cwd) {
  const dir = resolveConfigDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load the full config, merged with defaults.
 * @param {string} [cwd]
 * @returns {object}
 */
export function loadConfig(cwd) {
  const configPath = path.join(resolveConfigDir(cwd), CONFIG_FILE);
  let stored = {};

  try {
    stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    // No config yet — use defaults.
  }

  return { ...DEFAULTS, ...stored };
}

/**
 * Save a config value.
 * @param {string} key
 * @param {*} value
 * @param {string} [cwd]
 */
export function setConfigValue(key, value, cwd) {
  const dir = ensureConfigDir(cwd);
  const configPath = path.join(dir, CONFIG_FILE);
  const config = loadConfig(cwd);
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return config;
}
