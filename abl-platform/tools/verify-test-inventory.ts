#!/usr/bin/env npx tsx
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT = resolve(__dirname, '..');
export const BASELINES_ROOT = join(ROOT, 'tools', 'test-baselines');
export const LIST_TIMEOUT_MS = 5 * 60 * 1000;
const RUNTIME_FLAKY_FILTERS = [
  'src/__tests__/sessions/session-service.test.ts',
  'src/__tests__/sessions/session-ttl-dynamic.test.ts',
  'src/__tests__/sessions/chat-routes.test.ts',
  'src/__tests__/sessions/session-routes.test.ts',
  'src/__tests__/auth/user-isolation.integration.test.ts',
  'src/__tests__/llm-queue-distributed.test.ts',
];
const RUNTIME_SDK_AUTH_FILTERS = [
  'src/__tests__/auth/sdk-session-token.test.ts',
  'src/__tests__/execution/contexts/orchestration/chat-identity-wiring.test.ts',
  'src/__tests__/channels/ws-sdk-handler.test.ts',
  'src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts',
  'src/__tests__/channels/channels-sdk-runtime.e2e.test.ts',
];
const RUNTIME_CONNECTOR_E2E_FILTERS = [
  'src/__tests__/connector-connection-crud.e2e.test.ts',
  'src/__tests__/connector-oauth-flow.e2e.test.ts',
  'src/__tests__/connector-trigger-lifecycle.e2e.test.ts',
  'src/__tests__/connector-tool-execution.e2e.test.ts',
];
const RUNTIME_AFG_E2E_FILTERS = [
  'src/__tests__/integration/afg-blue-advisory/afg-abl-runtime.integration.test.ts',
];

export type TargetApp = 'runtime' | 'studio';

export interface InventoryLane {
  app: TargetApp;
  args: string[];
  cwd: string;
  kind: 'config' | 'script-alias';
  label: string;
}

export interface LaneSnapshot {
  basenames: string[];
  count: number;
  duplicateBasenames: string[];
  label: string;
  paths: string[];
}

export interface InventorySnapshot {
  app: TargetApp;
  capturedAt: string;
  laneCount: number;
  lanes: LaneSnapshot[];
  onDiskBasenames: string[];
  onDiskCount: number;
  onDiskPaths: string[];
  uncoveredBasenames: string[];
  uncoveredCount: number;
  uncoveredPaths: string[];
}

export interface SnapshotDiff {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

interface CliOptions {
  app: TargetApp;
  mode: 'capture' | 'verify';
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function uniqSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function getBasenameList(filePaths: string[]): string[] {
  return filePaths
    .map((filePath) => basename(filePath))
    .sort((left, right) => left.localeCompare(right));
}

export function getDuplicateBasenames(filePaths: string[]): string[] {
  const counts = new Map<string, number>();

  for (const filePath of filePaths) {
    const filename = basename(filePath);
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([filename]) => filename)
    .sort((left, right) => left.localeCompare(right));
}

export function sanitizeLaneLabel(label: string): string {
  return label
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isTestFile(filePath: string): boolean {
  return /\.(test)\.(ts|tsx)$/.test(filePath);
}

export function getBaselineDir(root: string, app: TargetApp): string {
  return join(root, 'tools', 'test-baselines', app);
}

export function getLaneDefinitions(root: string, app: TargetApp): InventoryLane[] {
  if (app === 'runtime') {
    const cwd = join(root, 'apps', 'runtime');
    return [
      runtimeConfigLane(cwd, 'default', ['--config', 'vitest.config.ts']),
      runtimeConfigLane(cwd, 'fast', ['--config', 'vitest.fast.config.ts']),
      runtimeConfigLane(cwd, 'smoke', ['--config', 'vitest.smoke.config.ts']),
      runtimeConfigLane(cwd, 'integration', ['--config', 'vitest.integration.config.ts']),
      runtimeConfigLane(cwd, 'e2e', ['--config', 'vitest.e2e.config.ts']),
      runtimeAliasLane(cwd, 'flaky', [
        '--config',
        'vitest.integration.config.ts',
        ...RUNTIME_FLAKY_FILTERS,
      ]),
      runtimeAliasLane(cwd, 'sdk-auth', [
        '--config',
        'vitest.e2e.config.ts',
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--testTimeout=90000',
        '--hookTimeout=180000',
        ...RUNTIME_SDK_AUTH_FILTERS,
      ]),
      runtimeAliasLane(cwd, 'connector-e2e', [
        '--config',
        'vitest.e2e.config.ts',
        '--maxWorkers=2',
        '--testTimeout=90000',
        '--hookTimeout=90000',
        ...RUNTIME_CONNECTOR_E2E_FILTERS,
      ]),
      runtimeAliasLane(cwd, 'afg-e2e', [
        '--config',
        'vitest.e2e.config.ts',
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--testTimeout=120000',
        '--hookTimeout=60000',
        ...RUNTIME_AFG_E2E_FILTERS,
      ]),
    ];
  }

  const cwd = join(root, 'apps', 'studio');
  return [
    studioLane(cwd, 'full', ['--config', 'vitest.config.ts']),
    studioLane(cwd, 'light', ['--config', 'vitest.light.config.ts']),
    studioLane(cwd, 'unit', ['--config', 'vitest.unit.config.ts']),
    studioLane(cwd, 'node', ['--config', 'vitest.node.config.ts']),
  ];
}

function runtimeConfigLane(cwd: string, label: string, extraArgs: string[]): InventoryLane {
  return {
    app: 'runtime',
    args: ['vitest', 'list', ...extraArgs, '--filesOnly', '--passWithNoTests'],
    cwd,
    kind: 'config',
    label,
  };
}

function runtimeAliasLane(cwd: string, label: string, extraArgs: string[]): InventoryLane {
  return {
    app: 'runtime',
    args: ['vitest', 'list', ...extraArgs, '--filesOnly', '--passWithNoTests'],
    cwd,
    kind: 'script-alias',
    label,
  };
}

function studioLane(cwd: string, label: string, extraArgs: string[]): InventoryLane {
  return {
    app: 'studio',
    args: ['vitest', 'list', ...extraArgs, '--filesOnly', '--passWithNoTests'],
    cwd,
    kind: 'config',
    label,
  };
}

export function parseFilesOnlyOutput(stdout: string, root: string, cwd: string): string[] {
  const normalized = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeListedPath(line, root, cwd))
    .filter(Boolean)
    .filter(isTestFile);

  return uniqSorted(normalized);
}

function normalizeListedPath(line: string, root: string, cwd: string): string {
  const absolutePath = isAbsolute(line) ? line : resolve(cwd, line);
  return normalizeSlashes(relative(root, absolutePath));
}

export async function captureSnapshot(root: string, app: TargetApp): Promise<InventorySnapshot> {
  const lanes = getLaneDefinitions(root, app);
  const snapshots: LaneSnapshot[] = [];

  for (const lane of lanes) {
    const paths = await captureLane(root, lane);
    snapshots.push({
      basenames: getBasenameList(paths),
      count: paths.length,
      duplicateBasenames: getDuplicateBasenames(paths),
      label: lane.label,
      paths,
    });
  }

  const onDiskPaths = await discoverOnDiskTests(root, app);
  const discoveredPaths = new Set(snapshots.flatMap((lane) => lane.paths));
  const uncoveredPaths = onDiskPaths.filter((filePath) => !discoveredPaths.has(filePath));

  return {
    app,
    capturedAt: new Date().toISOString(),
    laneCount: snapshots.length,
    lanes: snapshots,
    onDiskBasenames: getBasenameList(onDiskPaths),
    onDiskCount: onDiskPaths.length,
    onDiskPaths,
    uncoveredBasenames: getBasenameList(uncoveredPaths),
    uncoveredCount: uncoveredPaths.length,
    uncoveredPaths,
  };
}

export async function captureLane(root: string, lane: InventoryLane): Promise<string[]> {
  const { stdout } = await execLane(lane);
  return parseFilesOnlyOutput(stdout, root, lane.cwd);
}

async function execLane(lane: InventoryLane): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'npx',
      lane.args,
      {
        cwd: lane.cwd,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NODE_NO_WARNINGS: '1',
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: LIST_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const hint = [
            `Lane "${lane.label}" failed.`,
            `cwd: ${lane.cwd}`,
            `args: npx ${lane.args.join(' ')}`,
            stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
            stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          rejectPromise(new Error(hint));
          return;
        }

        resolvePromise({ stderr, stdout });
      },
    );
  });
}

export async function discoverOnDiskTests(root: string, app: TargetApp): Promise<string[]> {
  const scanRoot =
    app === 'runtime' ? join(root, 'apps', 'runtime', 'src') : join(root, 'apps', 'studio', 'src');
  const discovered = await walkTestFiles(scanRoot);
  return uniqSorted(discovered.map((filePath) => normalizeSlashes(relative(root, filePath))));
}

async function walkTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTestFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isTestFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function writeSnapshot(root: string, snapshot: InventorySnapshot): Promise<void> {
  const baselineDir = getBaselineDir(root, snapshot.app);
  await mkdir(baselineDir, { recursive: true });

  await writeFile(
    join(baselineDir, 'inventory.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  for (const lane of snapshot.lanes) {
    const laneFile = join(baselineDir, `${sanitizeLaneLabel(lane.label)}.paths.txt`);
    const contents = lane.paths.length > 0 ? `${lane.paths.join('\n')}\n` : '';
    await writeFile(laneFile, contents, 'utf8');
  }

  const uncoveredContents =
    snapshot.uncoveredPaths.length > 0 ? `${snapshot.uncoveredPaths.join('\n')}\n` : '';
  await writeFile(join(baselineDir, 'uncovered.paths.txt'), uncoveredContents, 'utf8');
}

export async function readSnapshot(root: string, app: TargetApp): Promise<InventorySnapshot> {
  const baselineDir = getBaselineDir(root, app);
  const inventoryPath = join(baselineDir, 'inventory.json');

  if (!existsSync(inventoryPath)) {
    throw new Error(
      `Missing baseline at ${normalizeSlashes(relative(root, inventoryPath))}. Run --capture first.`,
    );
  }

  const contents = await readFile(inventoryPath, 'utf8');
  return JSON.parse(contents) as InventorySnapshot;
}

export function compareSnapshots(
  baseline: InventorySnapshot,
  current: InventorySnapshot,
): SnapshotDiff {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (baseline.app !== current.app) {
    problems.push(`App mismatch: baseline=${baseline.app}, current=${current.app}`);
  }

  const baselineLabels = baseline.lanes.map((lane) => lane.label);
  const currentLabels = current.lanes.map((lane) => lane.label);

  if (baselineLabels.join('\n') !== currentLabels.join('\n')) {
    problems.push(
      `Lane labels changed.\nBaseline: ${baselineLabels.join(', ')}\nCurrent: ${currentLabels.join(', ')}`,
    );
  }

  const currentByLabel = new Map(current.lanes.map((lane) => [lane.label, lane] as const));
  for (const baselineLane of baseline.lanes) {
    const currentLane = currentByLabel.get(baselineLane.label);
    if (!currentLane) {
      problems.push(`Missing lane: ${baselineLane.label}`);
      continue;
    }

    if (baselineLane.count !== currentLane.count) {
      problems.push(
        `Lane "${baselineLane.label}" count changed: baseline=${baselineLane.count}, current=${currentLane.count}`,
      );
    }

    const baselineBasenames = getLaneBasenames(baselineLane);
    const currentBasenames = getLaneBasenames(currentLane);
    const basenameDiff = diffLists(baselineBasenames, currentBasenames);
    if (basenameDiff.length > 0) {
      problems.push(`Lane "${baselineLane.label}" basename delta:\n${basenameDiff.join('\n')}`);
    }

    const currentDuplicates = getLaneDuplicateBasenames(currentLane);
    if (currentDuplicates.length > 0) {
      warnings.push(
        `Lane "${baselineLane.label}" has duplicate basenames: ${currentDuplicates.join(', ')}`,
      );
    }
  }

  const baselineOnDiskBasenames = getSnapshotBasenames(
    baseline.onDiskBasenames,
    baseline.onDiskPaths,
  );
  const currentOnDiskBasenames = getSnapshotBasenames(current.onDiskBasenames, current.onDiskPaths);
  const onDiskDiff = diffLists(baselineOnDiskBasenames, currentOnDiskBasenames);
  if (onDiskDiff.length > 0) {
    problems.push(`On-disk basename delta:\n${onDiskDiff.join('\n')}`);
  }

  const baselineUncoveredBasenames = getSnapshotBasenames(
    baseline.uncoveredBasenames,
    baseline.uncoveredPaths,
  );
  const currentUncoveredBasenames = getSnapshotBasenames(
    current.uncoveredBasenames,
    current.uncoveredPaths,
  );
  const uncoveredDiff = diffLists(baselineUncoveredBasenames, currentUncoveredBasenames);
  if (uncoveredDiff.length > 0) {
    problems.push(`Uncovered basename delta:\n${uncoveredDiff.join('\n')}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
  };
}

function getLaneBasenames(lane: LaneSnapshot): string[] {
  return getSnapshotBasenames(lane.basenames, lane.paths);
}

function getLaneDuplicateBasenames(lane: LaneSnapshot): string[] {
  const basenames = getLaneBasenames(lane);
  const counts = countValues(basenames);

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([basename]) => basename)
    .sort((left, right) => left.localeCompare(right));
}

function getSnapshotBasenames(storedBasenames: string[] | undefined, paths: string[]): string[] {
  if (Array.isArray(storedBasenames) && storedBasenames.length === paths.length) {
    return storedBasenames;
  }

  return getBasenameList(paths);
}

function diffLists(before: string[], after: string[]): string[] {
  const beforeCounts = countValues(before);
  const afterCounts = countValues(after);
  const labels = uniqSorted([...beforeCounts.keys(), ...afterCounts.keys()]);
  const diffs: string[] = [];

  for (const label of labels) {
    const beforeCount = beforeCounts.get(label) ?? 0;
    const afterCount = afterCounts.get(label) ?? 0;

    if (beforeCount > afterCount) {
      for (let index = 0; index < beforeCount - afterCount; index += 1) {
        diffs.push(`- ${label}`);
      }
    }

    if (afterCount > beforeCount) {
      for (let index = 0; index < afterCount - beforeCount; index += 1) {
        diffs.push(`+ ${label}`);
      }
    }
  }

  return diffs;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function formatSnapshotSummary(snapshot: InventorySnapshot): string {
  const laneLines = snapshot.lanes.map((lane) => `- ${lane.label}: ${lane.count} files`);
  return [
    `App: ${snapshot.app}`,
    `Lanes: ${snapshot.laneCount}`,
    ...laneLines,
    `On-disk tests: ${snapshot.onDiskCount}`,
    `Uncovered tests: ${snapshot.uncoveredCount}`,
  ].join('\n');
}

export function parseCliArgs(argv: string[]): CliOptions {
  let app: TargetApp | null = null;
  let mode: 'capture' | 'verify' | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--capture') {
      mode = ensureSingleMode(mode, 'capture');
      continue;
    }
    if (arg === '--verify') {
      mode = ensureSingleMode(mode, 'verify');
      continue;
    }
    if (arg === '--app') {
      const value = argv[index + 1];
      if (!value || (value !== 'runtime' && value !== 'studio')) {
        throw new Error('Expected --app runtime|studio');
      }
      app = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!mode) {
    throw new Error('Expected exactly one of --capture or --verify');
  }

  if (!app) {
    throw new Error('Expected --app runtime|studio');
  }

  return { app, mode };
}

function ensureSingleMode(
  currentMode: 'capture' | 'verify' | null,
  nextMode: 'capture' | 'verify',
): 'capture' | 'verify' {
  if (currentMode && currentMode !== nextMode) {
    throw new Error('Expected exactly one of --capture or --verify');
  }
  return nextMode;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    const snapshot = await captureSnapshot(ROOT, options.app);

    if (options.mode === 'capture') {
      await writeSnapshot(ROOT, snapshot);
      console.log(formatSnapshotSummary(snapshot));
      console.log(
        `Baseline written to ${normalizeSlashes(relative(ROOT, getBaselineDir(ROOT, options.app)))}`,
      );
      return 0;
    }

    const baseline = await readSnapshot(ROOT, options.app);
    const diff = compareSnapshots(baseline, snapshot);
    if (!diff.ok) {
      console.error(formatSnapshotSummary(snapshot));
      console.error('\nVerification failed:\n');
      for (const problem of diff.problems) {
        console.error(problem);
        console.error('');
      }
      return 1;
    }

    console.log(formatSnapshotSummary(snapshot));
    if (diff.warnings.length > 0) {
      console.warn('\nWarnings:\n');
      for (const warning of diff.warnings) {
        console.warn(warning);
      }
    }
    console.log('Verification passed.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  });
}
