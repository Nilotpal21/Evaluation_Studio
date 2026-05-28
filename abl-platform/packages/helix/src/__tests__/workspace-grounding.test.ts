import { describe, expect, it } from 'vitest';

import {
  findSourceWorkspaceAliasInText,
  rewriteTextToExecutionWorkspace,
} from '../models/workspace-grounding.js';

describe('workspace-grounding', () => {
  it('rewrites source-checkout absolute paths into the replay worktree', () => {
    const sourceDir = '/Users/example/projects/agent-platform';
    const worktreeDir = '/Users/example/projects/agent-platform-replay-working';

    const rewritten = rewriteTextToExecutionWorkspace(
      `Inspect ${sourceDir}/apps/studio/src/repos/project-repo.ts before continuing.`,
      worktreeDir,
      {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
      },
    );

    expect(rewritten).toContain(`${worktreeDir}/apps/studio/src/repos/project-repo.ts`);
    expect(rewritten).not.toContain(`${sourceDir}/apps/studio/src/repos/project-repo.ts`);
  });

  it('does not duplicate paths that are already rooted in the replay worktree', () => {
    const sourceDir = '/Users/example/projects/agent-platform';
    const worktreeDir = '/Users/example/projects/agent-platform-replay-working';
    const worktreePath = `${worktreeDir}/apps/studio/src/repos/project-repo.ts`;

    const rewritten = rewriteTextToExecutionWorkspace(`Replay seam: ${worktreePath}`, worktreeDir, {
      mode: 'git-worktree',
      sourceWorkDir: sourceDir,
      worktreeDir,
    });

    expect(rewritten).toContain(worktreePath);
    expect(rewritten).not.toContain(
      `${worktreeDir}-replay-working/apps/studio/src/repos/project-repo.ts`,
    );
    const worktreeRootMatches = rewritten.match(
      new RegExp(worktreeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    );

    expect(worktreeRootMatches?.length).toBe(1);
  });
});

describe('findSourceWorkspaceAliasInText — boundary-aware match', () => {
  const source = '/Users/example/projects/abl-platform';
  const aliases = [source];

  it('matches the bare source path with end-of-string boundary', () => {
    expect(findSourceWorkspaceAliasInText(source, aliases)).toBe(source);
  });

  it('matches when the source path is followed by a path separator', () => {
    expect(findSourceWorkspaceAliasInText(`cat ${source}/README.md`, aliases)).toBe(source);
  });

  it('matches when the source path is followed by a quote / paren / comma', () => {
    expect(findSourceWorkspaceAliasInText(`"${source}"`, aliases)).toBe(source);
    expect(findSourceWorkspaceAliasInText(`(${source})`, aliases)).toBe(source);
    expect(findSourceWorkspaceAliasInText(`${source},`, aliases)).toBe(source);
  });

  it('does NOT match when the source path is a prefix of an unrelated path', () => {
    // Regression for the helix review-branch worktree false positive: the
    // source `/Users/example/projects/abl-platform` is a prefix of the
    // worktree `/Users/example/projects/abl-platform-wt-branch-review-...`,
    // and the prior naked text.includes() returned the source as a match.
    const worktree = `${source}-wt-branch-review-origin-agent-t`;
    expect(
      findSourceWorkspaceAliasInText(`sed -n '1,220p' ${worktree}/file.md`, aliases),
    ).toBeUndefined();
    expect(findSourceWorkspaceAliasInText(worktree, aliases)).toBeUndefined();
  });

  it('does not match when no alias is present', () => {
    expect(findSourceWorkspaceAliasInText('cat /tmp/other/file', aliases)).toBeUndefined();
  });

  it('returns undefined for empty alias list', () => {
    expect(findSourceWorkspaceAliasInText(`cat ${source}/file`, [])).toBeUndefined();
  });
});
