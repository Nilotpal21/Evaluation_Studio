import { describe, expect, it } from 'vitest';

import {
  BASELINES_ROOT,
  ROOT,
  compareSnapshots,
  formatSnapshotSummary,
  getBasenameList,
  getBaselineDir,
  getDuplicateBasenames,
  getLaneDefinitions,
  isTestFile,
  parseCliArgs,
  parseFilesOnlyOutput,
  sanitizeLaneLabel,
  type InventorySnapshot,
} from './verify-test-inventory';

describe('verify-test-inventory', () => {
  it('sanitizes lane labels for baseline files', () => {
    expect(sanitizeLaneLabel('connector-e2e')).toBe('connector-e2e');
    expect(sanitizeLaneLabel('sdk auth')).toBe('sdk-auth');
    expect(sanitizeLaneLabel('lane/with spaces')).toBe('lane-with-spaces');
  });

  it('parses files-only vitest output relative to cwd', () => {
    const stdout = [
      'src/__tests__/alpha.test.ts',
      'src/__tests__/beta.integration.test.ts',
      '',
    ].join('\n');

    expect(parseFilesOnlyOutput(stdout, ROOT, `${ROOT}/apps/runtime`)).toEqual([
      'apps/runtime/src/__tests__/alpha.test.ts',
      'apps/runtime/src/__tests__/beta.integration.test.ts',
    ]);
  });

  it('filters non-test lines from files-only output', () => {
    const stdout = ['README.md', 'src/__tests__/alpha.test.ts', 'src/__tests__/setup.ts'].join(
      '\n',
    );

    expect(parseFilesOnlyOutput(stdout, ROOT, `${ROOT}/apps/studio`)).toEqual([
      'apps/studio/src/__tests__/alpha.test.ts',
    ]);
  });

  it('detects snapshot deltas by lane and uncovered files', () => {
    const baseline: InventorySnapshot = {
      app: 'runtime',
      capturedAt: '2026-03-27T00:00:00.000Z',
      laneCount: 1,
      lanes: [
        {
          basenames: ['alpha.test.ts'],
          count: 1,
          duplicateBasenames: [],
          label: 'fast',
          paths: ['apps/runtime/src/__tests__/alpha.test.ts'],
        },
      ],
      onDiskBasenames: ['alpha.test.ts', 'beta.test.ts'],
      onDiskCount: 2,
      onDiskPaths: [
        'apps/runtime/src/__tests__/alpha.test.ts',
        'apps/runtime/src/__tests__/beta.test.ts',
      ],
      uncoveredBasenames: ['beta.test.ts'],
      uncoveredCount: 1,
      uncoveredPaths: ['apps/runtime/src/__tests__/beta.test.ts'],
    };

    const current: InventorySnapshot = {
      ...baseline,
      lanes: [
        {
          basenames: ['gamma.test.ts'],
          count: 1,
          duplicateBasenames: [],
          label: 'fast',
          paths: ['apps/runtime/src/__tests__/gamma.test.ts'],
        },
      ],
      onDiskBasenames: ['gamma.test.ts'],
      onDiskPaths: ['apps/runtime/src/__tests__/gamma.test.ts'],
      uncoveredBasenames: [],
      uncoveredCount: 0,
      uncoveredPaths: [],
    };

    const diff = compareSnapshots(baseline, current);
    expect(diff.ok).toBe(false);
    expect(diff.problems.join('\n')).toContain('Lane "fast" basename delta');
    expect(diff.problems.join('\n')).toContain('Uncovered basename delta');
  });

  it('treats path-only moves as a successful parity match', () => {
    const baseline: InventorySnapshot = {
      app: 'runtime',
      capturedAt: '2026-03-27T00:00:00.000Z',
      laneCount: 1,
      lanes: [
        {
          basenames: ['alpha.test.ts'],
          count: 1,
          duplicateBasenames: [],
          label: 'fast',
          paths: ['apps/runtime/src/__tests__/alpha.test.ts'],
        },
      ],
      onDiskBasenames: ['alpha.test.ts'],
      onDiskCount: 1,
      onDiskPaths: ['apps/runtime/src/__tests__/alpha.test.ts'],
      uncoveredBasenames: [],
      uncoveredCount: 0,
      uncoveredPaths: [],
    };

    const current: InventorySnapshot = {
      ...baseline,
      lanes: [
        {
          basenames: ['alpha.test.ts'],
          count: 1,
          duplicateBasenames: [],
          label: 'fast',
          paths: ['apps/runtime/src/__tests__/execution/alpha.test.ts'],
        },
      ],
      onDiskPaths: ['apps/runtime/src/__tests__/execution/alpha.test.ts'],
    };

    const diff = compareSnapshots(baseline, current);
    expect(diff.ok).toBe(true);
    expect(diff.problems).toEqual([]);
  });

  it('recomputes basenames from paths when legacy baselines stored deduped metadata', () => {
    const baseline: InventorySnapshot = {
      app: 'runtime',
      capturedAt: '2026-03-27T00:00:00.000Z',
      laneCount: 1,
      lanes: [
        {
          basenames: ['alpha.test.ts'],
          count: 2,
          duplicateBasenames: [],
          label: 'fast',
          paths: [
            'apps/runtime/src/__tests__/alpha.test.ts',
            'apps/runtime/src/services/foo/__tests__/alpha.test.ts',
          ],
        },
      ],
      onDiskBasenames: ['alpha.test.ts'],
      onDiskCount: 2,
      onDiskPaths: [
        'apps/runtime/src/__tests__/alpha.test.ts',
        'apps/runtime/src/services/foo/__tests__/alpha.test.ts',
      ],
      uncoveredBasenames: [],
      uncoveredCount: 0,
      uncoveredPaths: [],
    };

    const current: InventorySnapshot = {
      ...baseline,
      lanes: [
        {
          basenames: ['alpha.test.ts', 'alpha.test.ts'],
          count: 2,
          duplicateBasenames: ['alpha.test.ts'],
          label: 'fast',
          paths: [
            'apps/runtime/src/__tests__/execution/alpha.test.ts',
            'apps/runtime/src/services/foo/__tests__/alpha.test.ts',
          ],
        },
      ],
      onDiskBasenames: ['alpha.test.ts', 'alpha.test.ts'],
      onDiskPaths: [
        'apps/runtime/src/__tests__/execution/alpha.test.ts',
        'apps/runtime/src/services/foo/__tests__/alpha.test.ts',
      ],
    };

    const diff = compareSnapshots(baseline, current);
    expect(diff.ok).toBe(true);
    expect(diff.problems).toEqual([]);
    expect(diff.warnings).toContain('Lane "fast" has duplicate basenames: alpha.test.ts');
  });

  it('parses CLI args for capture and verify modes', () => {
    expect(parseCliArgs(['--capture', '--app', 'runtime'])).toEqual({
      app: 'runtime',
      mode: 'capture',
    });
    expect(parseCliArgs(['--verify', '--app', 'studio'])).toEqual({
      app: 'studio',
      mode: 'verify',
    });
  });

  it('throws on invalid CLI arg combinations', () => {
    expect(() => parseCliArgs(['--capture', '--verify', '--app', 'runtime'])).toThrow(
      'Expected exactly one of --capture or --verify',
    );
    expect(() => parseCliArgs(['--capture'])).toThrow('Expected --app runtime|studio');
    expect(() => parseCliArgs(['--capture', '--app', 'search-ai'])).toThrow(
      'Expected --app runtime|studio',
    );
  });

  it('returns the expected baseline directory and lane shapes', () => {
    expect(getBaselineDir(ROOT, 'runtime')).toBe(`${BASELINES_ROOT}/runtime`);
    expect(getLaneDefinitions(ROOT, 'runtime').map((lane) => lane.label)).toEqual([
      'default',
      'fast',
      'smoke',
      'integration',
      'e2e',
      'flaky',
      'sdk-auth',
      'connector-e2e',
      'afg-e2e',
    ]);
    expect(getLaneDefinitions(ROOT, 'studio').map((lane) => lane.label)).toEqual([
      'full',
      'light',
      'unit',
      'node',
    ]);
    expect(
      getLaneDefinitions(ROOT, 'runtime')
        .filter((lane) => ['flaky', 'sdk-auth', 'connector-e2e', 'afg-e2e'].includes(lane.label))
        .map((lane) => lane.kind),
    ).toEqual(['script-alias', 'script-alias', 'script-alias', 'script-alias']);
  });

  it('formats a compact snapshot summary', () => {
    const summary = formatSnapshotSummary({
      app: 'studio',
      capturedAt: '2026-03-27T00:00:00.000Z',
      laneCount: 1,
      lanes: [
        {
          basenames: ['run-tests-plan.test.ts'],
          count: 1,
          duplicateBasenames: [],
          label: 'light',
          paths: ['apps/studio/src/__tests__/run-tests-plan.test.ts'],
        },
      ],
      onDiskBasenames: ['run-tests-plan.test.ts'],
      onDiskCount: 1,
      onDiskPaths: ['apps/studio/src/__tests__/run-tests-plan.test.ts'],
      uncoveredBasenames: [],
      uncoveredCount: 0,
      uncoveredPaths: [],
    });

    expect(summary).toContain('App: studio');
    expect(summary).toContain('- light: 1 files');
    expect(summary).toContain('Uncovered tests: 0');
  });

  it('recognizes vitest test files only', () => {
    expect(isTestFile('alpha.test.ts')).toBe(true);
    expect(isTestFile('beta.test.tsx')).toBe(true);
    expect(isTestFile('setup.ts')).toBe(false);
    expect(isTestFile('TEST_INDEX.md')).toBe(false);
  });

  it('extracts sorted basenames and duplicate warnings from path lists', () => {
    const paths = [
      'apps/runtime/src/__tests__/execution/auth.test.ts',
      'apps/runtime/src/__tests__/auth/auth.test.ts',
      'apps/runtime/src/__tests__/routing/zeta.test.ts',
    ];

    expect(getBasenameList(paths)).toEqual(['auth.test.ts', 'auth.test.ts', 'zeta.test.ts']);
    expect(getDuplicateBasenames(paths)).toEqual(['auth.test.ts']);
  });
});
