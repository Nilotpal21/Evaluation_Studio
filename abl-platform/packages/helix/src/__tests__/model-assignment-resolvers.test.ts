import { describe, expect, it } from 'vitest';

import { resolveWorkspaceReconcileAssignment } from '../pipeline/engine/model-assignment-resolvers.js';
import type { HelixConfig, StageDefinition } from '../types.js';

function buildConfig(): HelixConfig {
  return {
    workDir: '/tmp/helix-worktree',
    defaultModel: { engine: 'claude-code', model: 'opus' },
  } as HelixConfig;
}

function buildStage(): StageDefinition {
  return {
    name: 'implementation',
    model: { engine: 'claude-code', model: 'opus' },
  } as StageDefinition;
}

describe('resolveWorkspaceReconcileAssignment', () => {
  it('falls back to the baseline 6-turn budget when no slice context is provided', () => {
    const assignment = resolveWorkspaceReconcileAssignment(buildConfig(), buildStage());
    expect(assignment.primary.maxTurns).toBe(6);
  });

  it('scales the budget with the out-of-scope blocking-file count', () => {
    const assignment = resolveWorkspaceReconcileAssignment(buildConfig(), buildStage(), {
      blockingFileCount: 2,
      sliceFileCount: 4,
    });
    // 6 + 2*3 + ceil(4/2) = 14
    expect(assignment.primary.maxTurns).toBe(14);
  });

  it('caps the budget at 24 turns even for large slices', () => {
    const assignment = resolveWorkspaceReconcileAssignment(buildConfig(), buildStage(), {
      blockingFileCount: 10,
      sliceFileCount: 20,
    });
    expect(assignment.primary.maxTurns).toBe(24);
  });

  it('does not drop below the baseline when slice context reports no blocking files', () => {
    const assignment = resolveWorkspaceReconcileAssignment(buildConfig(), buildStage(), {
      blockingFileCount: 0,
      sliceFileCount: 0,
    });
    expect(assignment.primary.maxTurns).toBe(6);
  });
});
