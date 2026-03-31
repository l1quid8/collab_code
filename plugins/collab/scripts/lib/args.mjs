/**
 * Lightweight argument parser for collab companion commands.
 */

/**
 * Split a raw argument string into tokens, respecting quoted strings.
 * @param {string} raw
 * @returns {string[]}
 */
export function splitRawArgs(raw) {
  const tokens = [];
  let current = "";
  let inQuote = null;

  for (const ch of raw) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse argv into { options, positionals }.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} config
 */
export function parseArgs(argv, config = {}) {
  const valueOpts = new Set(config.valueOptions ?? []);
  const boolOpts = new Set(config.booleanOptions ?? []);
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (boolOpts.has(key)) {
        options[key] = true;
      } else if (valueOpts.has(key) && i + 1 < argv.length) {
        options[key] = argv[++i];
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { options, positionals };
}
