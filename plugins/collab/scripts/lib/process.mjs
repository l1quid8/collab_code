import { spawnSync } from "node:child_process";

/**
 * Check if a binary is available on PATH.
 * @param {string} name
 * @param {string[]} [testArgs]
 * @param {{ cwd?: string }} [options]
 * @returns {{ available: boolean, version?: string, detail?: string }}
 */
export function binaryAvailable(name, testArgs = ["--version"], options = {}) {
  try {
    const result = spawnSync(name, testArgs, {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.error) {
      return {
        available: false,
        detail: result.error.code === "ENOENT" ? `${name} not found` : result.error.message,
      };
    }

    const version = (result.stdout || result.stderr || "").trim().split("\n")[0];
    return { available: true, version };
  } catch (error) {
    return { available: false, detail: error.message };
  }
}

/**
 * Run a command synchronously and return result.
 * @param {string} name
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number }} [options]
 */
export function runCommand(name, args, options = {}) {
  try {
    const result = spawnSync(name, args, {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      timeout: options.timeout ?? 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? null,
    };
  } catch (error) {
    return { status: 1, stdout: "", stderr: "", error };
  }
}

/**
 * Get Codex CLI availability and version.
 * @param {string} [cwd]
 */
export function getCodexAvailability(cwd) {
  const result = binaryAvailable("codex", ["--version"], { cwd });
  return {
    available: result.available,
    version: result.version ?? null,
    detail: result.detail ?? null,
  };
}

/**
 * Get Codex login status.
 * @param {string} [cwd]
 */
export function getCodexLoginStatus(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }

  const result = runCommand("codex", ["login", "status"], { cwd });
  if (result.error) {
    return { available: true, loggedIn: false, detail: result.error.message };
  }

  if (result.status === 0) {
    return {
      available: true,
      loggedIn: true,
      detail: result.stdout.trim() || "authenticated",
    };
  }

  return {
    available: true,
    loggedIn: false,
    detail: result.stderr.trim() || result.stdout.trim() || "not authenticated",
  };
}
