import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isDeterministicOutOfScopeWorkspacePath,
  isHelixManagedPath,
  listChangedWorkspacePaths,
} from '../pipeline/workspace-status.js';

describe('workspace-status', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('ignores untracked .claire workspace noise', async () => {
    workDir = await createGitRepo();
    await mkdir(join(workDir, '.claire'), { recursive: true });
    await writeFile(join(workDir, '.claire', 'session.json'), '{"scratch":true}\n', 'utf-8');

    await expect(listChangedWorkspacePaths(workDir)).resolves.toEqual([]);
  });

  it('still reports tracked .claire files when they are part of the repository', async () => {
    workDir = await createGitRepo();
    await mkdir(join(workDir, '.claire'), { recursive: true });
    await writeFile(join(workDir, '.claire', 'settings.json'), '{"tracked":true}\n', 'utf-8');
    execFileSync('git', ['add', '.claire/settings.json'], { cwd: workDir });
    execFileSync('git', ['commit', '-m', 'track claire config'], { cwd: workDir });

    await writeFile(join(workDir, '.claire', 'settings.json'), '{"tracked":false}\n', 'utf-8');

    await expect(listChangedWorkspacePaths(workDir)).resolves.toContain('.claire/settings.json');
  });

  it('expands untracked directories into their changed file paths', async () => {
    workDir = await createGitRepo();
    await mkdir(join(workDir, 'src', 'routes', '[memberId]'), { recursive: true });
    await writeFile(
      join(workDir, 'src', 'routes', '[memberId]', 'route.ts'),
      'export const route = true;\n',
      'utf-8',
    );

    await expect(listChangedWorkspacePaths(workDir)).resolves.toContain(
      'src/routes/[memberId]/route.ts',
    );
    await expect(listChangedWorkspacePaths(workDir)).resolves.not.toContain(
      'src/routes/[memberId]',
    );
  });

  it('ignores replay bootstrap marker files as HELIX-managed state', async () => {
    workDir = await createGitRepo();
    await writeFile(
      join(workDir, '.helix-replay-bootstrap.json'),
      '{"lockHash":"abc","bootstrappedAt":"2026-04-15T00:00:00.000Z"}\n',
      'utf-8',
    );

    await expect(listChangedWorkspacePaths(workDir)).resolves.toEqual([]);
  });
});

describe('isHelixManagedPath', () => {
  it('matches top-level .helix/ paths', () => {
    expect(isHelixManagedPath('.helix/sessions/abc/session.json')).toBe(true);
    expect(isHelixManagedPath('.apdas/state.json')).toBe(true);
  });

  it('matches nested .helix/ paths under sub-packages', () => {
    expect(isHelixManagedPath('packages/helix/.helix/sessions/abc/session.json')).toBe(true);
    expect(isHelixManagedPath('packages/helix/.helix/cache/repo-index/x.json')).toBe(true);
    expect(isHelixManagedPath('packages/foo/.apdas/state.json')).toBe(true);
  });

  it('does not match paths that merely contain .helix as substring', () => {
    expect(isHelixManagedPath('src/dot-helix-config.ts')).toBe(false);
    expect(isHelixManagedPath('src/foo.helix.ts')).toBe(false);
  });

  it('matches docs/sdlc-logs/ at top-level only', () => {
    expect(isHelixManagedPath('docs/sdlc-logs/feature/log.md')).toBe(true);
    expect(isHelixManagedPath('packages/x/docs/sdlc-logs/log.md')).toBe(false);
  });

  it('partitions nested helix files as deterministic out-of-scope', () => {
    expect(
      isDeterministicOutOfScopeWorkspacePath('packages/helix/.helix/sessions/x/session.json'),
    ).toBe(true);
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-workspace-status-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'feature.txt'), 'initial\n', 'utf-8');

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}
