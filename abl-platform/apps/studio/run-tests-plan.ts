import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPONENT_SHARDS = 2;
// Keep the Studio split-runner phase budget aligned with the pre-push test
// timeout. Pure logic suites can cross 3 minutes under Turbo/CPU contention.
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const COVERAGE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const COVERAGE_REPORT_CONFIG = 'vitest.coverage.config.ts';
export const SPLIT_COVERAGE_ROOT = '.vitest-reports/split-coverage';
export const SPLIT_COVERAGE_TEMP_DIR = `${SPLIT_COVERAGE_ROOT}/partials`;
const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(APP_ROOT, '..', '..');

const PASS_WITH_NO_TESTS_FLAG = '--passWithNoTests';
const SPLIT_UNSAFE_FLAGS = [
  '--api',
  '--browser',
  '--clearCache',
  '--config',
  '--coverage',
  '--inspect',
  '--inspectBrk',
  '--mergeReports',
  '--open',
  '--outputFile',
  '--project',
  '--reporter',
  '--shard',
  '--standalone',
  '--typecheck',
  '--ui',
  '--watch',
  '-c',
  '-h',
  '-w',
] as const;
const SAFE_VALUE_FLAGS = new Set(['-t', '--testNamePattern']);

export interface VitestPhaseCommand {
  allowTimeoutSuccess: boolean;
  args: string[];
  label: string;
  timeoutMs: number;
}

export interface VitestCoveragePhaseCommand extends VitestPhaseCommand {
  reportsDirectory: string;
  viteEnvironment: 'client' | 'ssr';
}

export type TestExecutionPlan =
  | {
      args: string[];
      mode: 'delegate';
    }
  | {
      commands: VitestPhaseCommand[];
      mode: 'split';
    };

export type CoverageExecutionPlan =
  | {
      args: string[];
      mode: 'delegate';
    }
  | {
      cleanupPaths: string[];
      commands: VitestCoveragePhaseCommand[];
      mode: 'split-coverage';
      reportConfigPath: string;
    };

function hasCliFlag(args: string[], flag: string): boolean {
  return args.some(
    (arg) =>
      arg === flag ||
      (flag.startsWith('--') && (arg.startsWith(`${flag}=`) || arg.startsWith(`${flag}.`))),
  );
}

function shouldDelegateToVitest(args: string[]): boolean {
  return SPLIT_UNSAFE_FLAGS.some((flag) => hasCliFlag(args, flag));
}

function isCoverageArg(arg: string): boolean {
  return arg === '--coverage' || arg.startsWith('--coverage=') || arg.startsWith('--coverage.');
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function toAppRelativePath(candidatePath: string): string | null {
  const relativePath = relative(APP_ROOT, candidatePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  return normalizeSlashes(relativePath);
}

function resolvePathFilter(arg: string): string {
  const candidates = isAbsolute(arg) ? [arg] : [resolve(APP_ROOT, arg), resolve(REPO_ROOT, arg)];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const appRelativePath = toAppRelativePath(candidate);
    if (appRelativePath) {
      return appRelativePath;
    }
  }

  return normalizeSlashes(arg);
}

function looksLikePathFilter(arg: string): boolean {
  return (
    arg.includes('/') ||
    arg.includes('\\') ||
    arg.endsWith('.test.ts') ||
    arg.endsWith('.test.tsx') ||
    existsSync(resolve(APP_ROOT, arg)) ||
    existsSync(resolve(REPO_ROOT, arg))
  );
}

function normalizeForwardedArgs(cliArgs: string[]): string[] {
  const normalizedArgs: string[] = [];
  let expectingValue = false;

  for (const arg of cliArgs) {
    if (arg === '--') {
      continue;
    }

    if (expectingValue) {
      normalizedArgs.push(arg);
      expectingValue = false;
      continue;
    }

    if (SAFE_VALUE_FLAGS.has(arg)) {
      normalizedArgs.push(arg);
      expectingValue = true;
      continue;
    }

    if (arg.startsWith('-')) {
      normalizedArgs.push(arg);
      continue;
    }

    normalizedArgs.push(looksLikePathFilter(arg) ? resolvePathFilter(arg) : arg);
  }

  return normalizedArgs;
}

function stripCoverageArgs(args: string[]): string[] {
  return args.filter((arg) => !isCoverageArg(arg));
}

function ensureCoverageEnabled(args: string[]): string[] {
  return args.some(isCoverageArg) ? args : ['--coverage', ...args];
}

function getCommandConfigPath(args: string[]): string {
  const configFlagIndex = args.findIndex(
    (arg) => arg === '--config' || arg.startsWith('--config='),
  );

  if (configFlagIndex === -1) {
    throw new Error(`Unable to determine Vitest config for args: ${args.join(' ')}`);
  }

  const configFlag = args[configFlagIndex];
  if (configFlag.startsWith('--config=')) {
    return configFlag.slice('--config='.length);
  }

  const configPath = args[configFlagIndex + 1];
  if (!configPath) {
    throw new Error(`Missing config path for args: ${args.join(' ')}`);
  }

  return configPath;
}

function getCoverageViteEnvironment(configPath: string): 'client' | 'ssr' {
  return configPath === 'vitest.unit.config.ts' ? 'client' : 'ssr';
}

function isComponentCoverageConfig(configPath: string): boolean {
  return configPath === 'vitest.unit.config.ts';
}

function toCoverageSlug(label: string, index: number): string {
  const normalizedLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${index + 1}-${normalizedLabel}`;
}

function createPhaseCommand(
  label: string,
  configPath: string,
  forwardedArgs: string[],
  options?: { allowTimeoutSuccess?: boolean; extraArgs?: string[] },
): VitestPhaseCommand {
  const passWithNoTestsArgs = hasCliFlag(forwardedArgs, PASS_WITH_NO_TESTS_FLAG)
    ? []
    : [PASS_WITH_NO_TESTS_FLAG];

  return {
    allowTimeoutSuccess: options?.allowTimeoutSuccess ?? false,
    args: [
      'vitest',
      'run',
      '--config',
      configPath,
      ...passWithNoTestsArgs,
      ...forwardedArgs,
      ...(options?.extraArgs ?? []),
    ],
    label,
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
}

export function buildTestExecutionPlan(cliArgs: string[]): TestExecutionPlan {
  const normalizedArgs = normalizeForwardedArgs(cliArgs);

  if (shouldDelegateToVitest(normalizedArgs)) {
    return {
      args: ['vitest', 'run', ...normalizedArgs],
      mode: 'delegate',
    };
  }

  return {
    commands: [
      createPhaseCommand('Pure logic tests', 'vitest.light.config.ts', normalizedArgs),
      ...Array.from({ length: COMPONENT_SHARDS }, (_value, index) =>
        createPhaseCommand(
          `Component shard ${index + 1}/${COMPONENT_SHARDS}`,
          'vitest.unit.config.ts',
          normalizedArgs,
          {
            extraArgs: [`--shard=${index + 1}/${COMPONENT_SHARDS}`],
          },
        ),
      ),
    ],
    mode: 'split',
  };
}

export function buildCoverageExecutionPlan(cliArgs: string[]): CoverageExecutionPlan {
  const normalizedArgs = normalizeForwardedArgs(cliArgs);
  const forwardedArgs = stripCoverageArgs(normalizedArgs);
  const basePlan = buildTestExecutionPlan(forwardedArgs);

  if (basePlan.mode === 'delegate') {
    return {
      args: ['vitest', 'run', ...ensureCoverageEnabled(normalizedArgs)],
      mode: 'delegate',
    };
  }

  return {
    cleanupPaths: [SPLIT_COVERAGE_ROOT, 'coverage'],
    commands: basePlan.commands.map((command, index) => {
      const slug = toCoverageSlug(command.label, index);
      const configPath = getCommandConfigPath(command.args);
      const reportsDirectory = `${SPLIT_COVERAGE_TEMP_DIR}/${slug}`;
      const coverageArgs = [
        '--coverage.enabled=true',
        '--coverage.provider=v8',
        '--coverage.reportOnFailure=true',
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=${reportsDirectory}`,
      ];

      if (isComponentCoverageConfig(configPath)) {
        coverageArgs.push('--no-file-parallelism', '--maxWorkers=1');
      }

      return {
        ...command,
        args: [...command.args, ...coverageArgs],
        reportsDirectory,
        timeoutMs: COVERAGE_COMMAND_TIMEOUT_MS,
        viteEnvironment: getCoverageViteEnvironment(configPath),
      };
    }),
    mode: 'split-coverage',
    reportConfigPath: COVERAGE_REPORT_CONFIG,
  };
}
