import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = dirname(__filename);

const GLOBAL_EXCLUDES = ['dist/**', 'node_modules/**'];
const VITEST_COMMANDS = new Set(['bench', 'dev', 'list', 'related', 'run', 'vitest', 'watch']);
const FLAGS_WITH_VALUES = new Set([
  '--attachmentsDir',
  '--bail',
  '--browser',
  '--config',
  '--coverage',
  '--diff',
  '--dir',
  '--environment',
  '--exclude',
  '--hookTimeout',
  '--inspect',
  '--inspectBrk',
  '--maxConcurrency',
  '--maxWorkers',
  '--minWorkers',
  '--mode',
  '--outputFile',
  '--pool',
  '--project',
  '--reporter',
  '--retry',
  '--root',
  '--sequence',
  '--shard',
  '--silent',
  '--slowTestThreshold',
  '--teardownTimeout',
  '--testNamePattern',
  '--testTimeout',
  '-c',
  '-r',
  '-t',
]);
const INLINE_VALUE_PREFIXES = [
  '--attachmentsDir=',
  '--bail=',
  '--browser=',
  '--config=',
  '--coverage.',
  '--coverage=',
  '--diff=',
  '--dir=',
  '--environment=',
  '--exclude=',
  '--hookTimeout=',
  '--inspect=',
  '--inspectBrk=',
  '--maxConcurrency=',
  '--maxWorkers=',
  '--minWorkers=',
  '--mode=',
  '--outputFile=',
  '--pool=',
  '--project=',
  '--reporter=',
  '--retry=',
  '--root=',
  '--sequence=',
  '--shard=',
  '--silent=',
  '--slowTestThreshold=',
  '--teardownTimeout=',
  '--testNamePattern=',
  '--testTimeout=',
];

export interface VitestPathSelection {
  exclude: string[];
  hasPathFilters: boolean;
  include: string[];
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizePathFilter(filter: string): string {
  const normalized = normalizeSlashes(filter);

  if (normalized.startsWith('apps/runtime/')) {
    return normalized.slice('apps/runtime/'.length);
  }

  if (!isAbsolute(filter)) {
    return normalized;
  }

  const relativeToApp = normalizeSlashes(relative(APP_ROOT, filter));
  return relativeToApp.startsWith('../') ? normalized : relativeToApp;
}

function expandPathFilter(filter: string): string[] {
  const normalized = normalizePathFilter(filter);
  const absolutePath = isAbsolute(filter)
    ? filter
    : isAbsolute(normalized)
      ? normalized
      : `${APP_ROOT}/${normalized}`;

  if (!existsSync(absolutePath)) {
    return [normalized];
  }

  if (!statSync(absolutePath).isDirectory()) {
    return [normalized];
  }

  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return [`${trimmed}/**/*.test.ts`, `${trimmed}/**/*.test.tsx`];
}

export function getCliPathFilters(argv: string[] = process.argv.slice(2)): string[] {
  const pathFilters: string[] = [];
  let skipNext = false;

  for (const arg of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (FLAGS_WITH_VALUES.has(arg)) {
      skipNext = true;
      continue;
    }

    if (INLINE_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }

    if (VITEST_COMMANDS.has(arg) || arg.startsWith('-')) {
      continue;
    }

    pathFilters.push(...expandPathFilter(arg));
  }

  return Array.from(new Set(pathFilters));
}

export function resolveVitestPathSelection(
  defaultInclude: string[],
  defaultExclude: string[] = GLOBAL_EXCLUDES,
): VitestPathSelection {
  const pathFilters = getCliPathFilters();

  if (pathFilters.length === 0) {
    return {
      exclude: defaultExclude,
      hasPathFilters: false,
      include: defaultInclude,
    };
  }

  return {
    exclude: Array.from(new Set([...GLOBAL_EXCLUDES, ...defaultExclude])),
    hasPathFilters: true,
    include: pathFilters,
  };
}
