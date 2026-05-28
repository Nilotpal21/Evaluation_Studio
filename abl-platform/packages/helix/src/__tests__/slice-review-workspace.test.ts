import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectSliceReviewWorkspaceState } from '../pipeline/engine/slice-review-workspace.js';
import type { Slice } from '../types.js';

describe('slice-review-workspace', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('ignores baseline-dirty out-of-scope files while keeping in-scope changes', async () => {
    workDir = await createWorkspace();
    await writeFile(
      join(workDir, 'apps', 'runtime', 'src', '__tests__', 'helpers', 'runtime-api-harness.ts'),
      'export const harness = 2;\n',
      'utf-8',
    );
    await writeFile(
      join(workDir, 'packages', 'helix', 'src', 'pipeline.ts'),
      'export const pipeline = 2;\n',
      'utf-8',
    );

    const state = await inspectSliceReviewWorkspaceState(createRuntimeSlice(), workDir, {
      baselineDirtyFiles: ['packages/helix/src/pipeline.ts'],
    });

    expect(state.actualChangedFiles).toContain(
      'apps/runtime/src/__tests__/helpers/runtime-api-harness.ts',
    );
    expect(state.actualChangedFiles).not.toContain('packages/helix/src/pipeline.ts');
    expect(state.outOfScopeChanges).toEqual([]);
    expect(state.ignoredOutOfScopeChanges).toEqual(['packages/helix/src/pipeline.ts']);
  });

  it('keeps baseline-dirty files when they are part of the slice review scope', async () => {
    workDir = await createWorkspace();
    await writeFile(
      join(workDir, 'apps', 'runtime', 'src', '__tests__', 'helpers', 'runtime-api-harness.ts'),
      'export const harness = 2;\n',
      'utf-8',
    );

    const state = await inspectSliceReviewWorkspaceState(createRuntimeSlice(), workDir, {
      baselineDirtyFiles: ['apps/runtime/src/__tests__/helpers/runtime-api-harness.ts'],
    });

    expect(state.actualChangedFiles).toEqual([
      'apps/runtime/src/__tests__/helpers/runtime-api-harness.ts',
    ]);
    expect(state.outOfScopeChanges).toEqual([]);
    expect(state.ignoredOutOfScopeChanges).toEqual([]);
  });
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-slice-review-'));
  await mkdir(join(dir, 'apps', 'runtime', 'src', '__tests__', 'helpers'), { recursive: true });
  await mkdir(join(dir, 'packages', 'helix', 'src'), { recursive: true });
  await writeFile(
    join(dir, 'apps', 'runtime', 'src', '__tests__', 'helpers', 'runtime-api-harness.ts'),
    'export const harness = 1;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'packages', 'helix', 'src', 'pipeline.ts'),
    'export const pipeline = 1;\n',
    'utf-8',
  );

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'seed workspace'], { cwd: dir });

  return dir;
}

function createRuntimeSlice(): Slice {
  return {
    index: 0,
    title: 'Runtime slice',
    description: 'Runtime gather interrupt test slice',
    status: 'planned',
    findings: [],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'apps/runtime/src/__tests__/helpers/runtime-api-harness.ts',
          action: 'modify',
          reason: 'Expose test seam',
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['apps/runtime/src/__tests__/helpers/runtime-api-harness.ts'],
      dependentFiles: [],
      affectedTests: [],
      riskLevel: 'low',
      notes: 'Runtime package-local drift',
    },
    legacyPaths: [],
    exitCriteria: [],
  };
}
