export type Dict = Record<string, string | undefined>;

export function parseArgs(argv: string[]): { cmd: string; flags: Dict } {
  const [, , cmd = 'help', ...rest] = argv;
  const flags: Dict = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = rest[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = 'true';
        }
      }
    }
  }
  return { cmd, flags };
}

export function getFlag(flags: Dict, name: string, envName?: string): string | undefined {
  return flags[name] ?? (envName ? process.env[envName] : undefined);
}
