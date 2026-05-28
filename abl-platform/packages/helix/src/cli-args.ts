const BOOLEAN_FLAGS = new Set([
  '--all',
  '--auto-approve',
  '--auto-commit',
  '--concerns',
  '--dry-run',
  '--enable-embeddings',
  '--follow',
  '--help',
  '--in-place',
  '--interactive',
  '--json',
  '--no-write',
  '--open-only',
  '--run-simple',
  '--skip-worktree-install',
  '--verbose',
  '--worktree',
  '-f',
  '-h',
  '-i',
  '-v',
]);

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

export function parseFlags(args: string[]): ParsedFlags {
  const result: ParsedFlags = {
    positional: [],
    flags: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg || arg === '-' || !arg.startsWith('-')) {
      result.positional.push(arg);
      i += 1;
      continue;
    }

    if (arg === '--') {
      result.positional.push(...args.slice(i + 1));
      break;
    }

    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0) {
      const key = arg.slice(0, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      result.flags[key] = value.length > 0 ? value : 'true';
      i += 1;
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      result.flags[arg] = 'true';
      i += 1;
      continue;
    }

    const next = args[i + 1];
    if (next && !next.startsWith('-')) {
      result.flags[arg] = next;
      i += 2;
      continue;
    }

    result.flags[arg] = 'true';
    i += 1;
  }

  return result;
}
