import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectMoves,
  parseCliArgs,
  rewriteRelativeSpecifiers,
  updateRelativeSpecifier,
} from './migrate-test-files';

describe('migrate-test-files', () => {
  it('rewrites relative imports when only the importing test moves', () => {
    const oldFile = '/repo/apps/runtime/src/__tests__/flow-execution-coverage.test.ts';
    const newFile = '/repo/apps/runtime/src/__tests__/execution/flow-execution-coverage.test.ts';

    expect(
      updateRelativeSpecifier('../services/runtime-executor.js', oldFile, newFile, new Map()),
    ).toBe('../../services/runtime-executor.js');
  });

  it('keeps sibling helper imports stable when both files move together', () => {
    const lookup = new Map<string, string>([
      [
        '/repo/apps/runtime/src/__tests__/pre-refactor/helpers/test-session-factory.js',
        '/repo/apps/runtime/src/__tests__/execution/pre-refactor/helpers/test-session-factory.js',
      ],
      [
        '/repo/apps/runtime/src/__tests__/pre-refactor/helpers/test-session-factory',
        '/repo/apps/runtime/src/__tests__/execution/pre-refactor/helpers/test-session-factory',
      ],
    ]);

    const oldFile = '/repo/apps/runtime/src/__tests__/pre-refactor/gather-execution.test.ts';
    const newFile =
      '/repo/apps/runtime/src/__tests__/execution/pre-refactor/gather-execution.test.ts';

    expect(
      updateRelativeSpecifier('./helpers/test-session-factory.js', oldFile, newFile, lookup),
    ).toBe('./helpers/test-session-factory.js');
  });

  it('rewrites import and vi.mock module specifiers in source text', () => {
    const oldFile = '/repo/apps/runtime/src/__tests__/channel-adapter.test.ts';
    const newFile = '/repo/apps/runtime/src/__tests__/channels/channel-adapter.test.ts';
    const source = [
      "import { createThing } from '../services/channel/create-thing.js';",
      "vi.mock('./helpers/mock-thing.js', () => ({ mocked: true }));",
    ].join('\n');

    const rewritten = rewriteRelativeSpecifiers(source, oldFile, newFile, new Map());
    expect(rewritten).toContain('../../services/channel/create-thing.js');
    expect(rewritten).toContain('../helpers/mock-thing.js');
  });

  it('accepts all supported migration plans', () => {
    expect(parseCliArgs(['--plan', 'runtime-phase2'])).toEqual({
      apply: false,
      plan: 'runtime-phase2',
    });
    expect(parseCliArgs(['--plan', 'runtime-phase3', '--apply'])).toEqual({
      apply: true,
      plan: 'runtime-phase3',
    });
    expect(parseCliArgs(['--plan', 'studio-phase4'])).toEqual({
      apply: false,
      plan: 'studio-phase4',
    });
  });

  it('collects exact file moves for nested route and service tests', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'migrate-test-files-'));
    const testRoot = join(tempRoot, 'src', '__tests__');
    const routeFile = join(testRoot, 'routes', 'contacts-history.test.ts');
    const serviceFile = join(testRoot, 'services', 'snapshot-service.test.ts');

    await mkdir(join(testRoot, 'routes'), { recursive: true });
    await mkdir(join(testRoot, 'services'), { recursive: true });
    await writeFile(routeFile, 'export {};\n', 'utf8');
    await writeFile(serviceFile, 'export {};\n', 'utf8');

    const moves = await collectMoves({
      appRoot: tempRoot,
      name: 'runtime-phase3',
      referenceFiles: [],
      rules: [
        {
          from: 'routes/contacts-history.test.ts',
          kind: 'file',
          to: 'sessions/routes/contacts-history.test.ts',
        },
        {
          from: 'services/snapshot-service.test.ts',
          kind: 'file',
          to: 'tools-deployment/services/snapshot-service.test.ts',
        },
      ],
      testRoot,
    });

    expect(moves).toHaveLength(2);
    expect(moves.map((move) => move.fromAbsolute)).toEqual([routeFile, serviceFile]);
    expect(moves.map((move) => move.toAbsolute)).toEqual([
      join(testRoot, 'sessions', 'routes', 'contacts-history.test.ts'),
      join(testRoot, 'tools-deployment', 'services', 'snapshot-service.test.ts'),
    ]);

    await rm(tempRoot, { force: true, recursive: true });
  });
});
