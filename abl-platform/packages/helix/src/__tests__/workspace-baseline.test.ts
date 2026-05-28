import { describe, expect, it } from 'vitest';

import { detectStaleWorkspaceBaseline } from '../workspace-baseline.js';

describe('workspace-baseline', () => {
  it('skips stale baseline detection for detached git worktree sessions', async () => {
    const drift = await detectStaleWorkspaceBaseline(
      {
        workDir: '/tmp/helix-worktree',
        invocationDir: '/tmp/helix-source',
        workspaceContext: {
          mode: 'git-worktree',
          sourceWorkDir: '/tmp/helix-source',
          worktreeDir: '/tmp/helix-worktree',
        },
      },
      {
        workspaceBaseline: {
          workDir: '/tmp/helix-worktree',
          headSha: 'abc123',
          capturedAt: '2026-04-06T00:00:00.000Z',
        },
        workspaceContext: {
          mode: 'git-worktree',
          sourceWorkDir: '/tmp/helix-source',
          worktreeDir: '/tmp/helix-worktree',
        },
      },
    );

    expect(drift).toBeNull();
  });
});
