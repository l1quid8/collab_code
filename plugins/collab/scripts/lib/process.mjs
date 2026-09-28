import { spawnSync } from "node:child_process";

/**
 * Compare dotted versions numerically. Returns <0, 0 or >0.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Get Codex CLI availability and version.
 * @param {string} [cwd]
 * @returns {{ available: boolean, version: string | null, detail: string | null }}
 */
export function getCodexVersion(cwd) {
  const result = spawnSync("codex", ["--version"], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error) {
    return {
      available: false,
      version: null,
      detail: result.error.code === "ENOENT" ? "codex not found on PATH" : result.error.message,
    };
  }
  const line = (result.stdout || result.stderr || "").trim().split("\n").at(-1) ?? "";
  return { available: true, version: line.match(/\d+\.\d+\.\d+/)?.[0] ?? null, detail: line || null };
}
