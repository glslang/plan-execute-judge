/**
 * Parses command-line arguments into { flags, positionals }.
 *
 * Supported forms:
 *   --key value    -> flags.key = "value"
 *   --key=value    -> flags.key = "value"
 *   --key          -> flags.key = true (when not followed by a value)
 *   anything else  -> collected into positionals, in order
 */
export function parse(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[i + 1];
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}
