import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../types.js';
import { ensureVerificationBootstrap } from '../pipeline/verification-bootstrap.js';

const tempDirs: string[] = [];

describe('ensureVerificationBootstrap', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  it('reuses a cached clean-worktree bootstrap record when the lockfile and scope match', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'helix-bootstrap-cache-'));
    tempDirs.push(workDir);

    await mkdir(join(workDir, '.helix', 'cache'), { recursive: true });
    await mkdir(join(workDir, 'packages', 'shared-auth', 'dist'), { recursive: true });
    const lockfileContents = 'lockfileVersion: 9.0\n';
    await writeFile(join(workDir, 'pnpm-lock.yaml'), lockfileContents);

    const cachedRecord = {
      version: 1 as const,
      generatedAt: '2026-04-15T00:00:00.000Z',
      trustLevel: 'clean-worktree' as const,
      scopeEntries: ['apps/studio'],
      scopedPackageDirs: ['apps/studio'],
      dirtyWorkspaceFiles: [],
      cleanedPaths: [],
      builtPackages: ['packages/shared-auth'],
      notes: ['Captured clean bootstrap.'],
      typecheckBaseline: {
        criterionType: 'typecheck' as const,
        command: 'pnpm --dir apps/studio typecheck',
        passed: true,
        signatures: [],
      },
    };

    await writeFile(
      join(workDir, '.helix', 'cache', 'verification-bootstrap.json'),
      JSON.stringify(
        {
          version: 1,
          lockHash: createHash('sha256').update(lockfileContents).digest('hex'),
          scopeKey: 'apps/studio::apps/studio',
          record: cachedRecord,
        },
        null,
        2,
      ),
    );

    const session = {
      workItem: {
        scope: ['apps/studio'],
      },
    } as Session;

    const record = await ensureVerificationBootstrap(workDir, session, {});

    expect(record.builtPackages).toEqual(['packages/shared-auth']);
    expect(record.notes).toContain('Reused cached verification bootstrap state.');
    expect(record.typecheckBaseline?.passed).toBe(true);
  });
});
