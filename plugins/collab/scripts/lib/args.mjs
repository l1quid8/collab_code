/**
 * Lightweight argument parser for collab companion commands.
 */

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
