import { describe, expect, it } from 'vitest';

import {
  resolveCliWorkspaceContext,
  resolveInitialLiveContext,
  resolveReplayContext,
} from '../workspace-context.js';

describe('resolveCliWorkspaceContext', () => {
  it('defaults to in-place mode when no replay worktree environment is provided', () => {
    expect(resolveCliWorkspaceContext('/tmp/helix-worktree', {})).toEqual({
      mode: 'in-place',
    });
  });

  it('returns git-worktree mode when source and execution workdirs differ', () => {
    expect(
      resolveCliWorkspaceContext('/tmp/helix-worktree', {
        HELIX_SOURCE_WORKDIR: '/Users/prasannaarikala/projects/agent-platform',
        HELIX_WORKTREE_DIR: '/tmp/helix-worktree',
      }),
    ).toEqual({
      mode: 'git-worktree',
      sourceWorkDir: '/Users/prasannaarikala/projects/agent-platform',
      worktreeDir: '/tmp/helix-worktree',
    });
  });

  it('falls back to in-place mode when the source workdir resolves to the same path', () => {
    expect(
      resolveCliWorkspaceContext('/tmp/helix-worktree', {
        HELIX_SOURCE_WORKDIR: '/tmp/helix-worktree',
      }),
    ).toEqual({
      mode: 'in-place',
    });
  });
});

describe('resolveInitialLiveContext', () => {
  it('returns an empty array when no initial live context env is provided', () => {
    expect(resolveInitialLiveContext({})).toEqual([]);
  });

  it('parses JSON arrays and trims empty entries', () => {
    expect(
      resolveInitialLiveContext({
        HELIX_INITIAL_LIVE_CONTEXT_JSON: JSON.stringify([
          '  stay narrow  ',
          '',
          'start with UserMenu.tsx',
        ]),
      }),
    ).toEqual(['stay narrow', 'start with UserMenu.tsx']);
  });

  it('accepts a plain string payload when the env is not valid JSON', () => {
    expect(
      resolveInitialLiveContext({
        HELIX_INITIAL_LIVE_CONTEXT_JSON: 'Prefer the scoped regression file first.',
      }),
    ).toEqual(['Prefer the scoped regression file first.']);
  });
});

describe('resolveReplayContext', () => {
  it('returns undefined when no replay context env is provided', () => {
    expect(resolveReplayContext({})).toBeUndefined();
  });

  it('parses replay context arrays and trims empty entries', () => {
    expect(
      resolveReplayContext({
        HELIX_REPLAY_CONTEXT_JSON: JSON.stringify({
          changedFiles: ['  apps/studio/src/foo.ts  ', '', 'packages/database/src/bar.ts'],
          historicalFileHints: {
            ' apps/studio/src/future.ts ': [' apps/studio/src/present.ts ', ''],
          },
          avoidPaths: [' apps/studio/src/components/settings/ProjectMembersTab.tsx ', ''],
          tags: ['rbac', ' service-extraction ', ''],
        }),
      }),
    ).toEqual({
      changedFiles: ['apps/studio/src/foo.ts', 'packages/database/src/bar.ts'],
      historicalFileHints: {
        'apps/studio/src/future.ts': ['apps/studio/src/present.ts'],
      },
      avoidPaths: ['apps/studio/src/components/settings/ProjectMembersTab.tsx'],
      tags: ['rbac', 'service-extraction'],
    });
  });
});
