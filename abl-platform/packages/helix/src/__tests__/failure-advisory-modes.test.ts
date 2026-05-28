import { describe, expect, it } from 'vitest';

import {
  applyDeterministicStageSynthesisMode,
  applyFailureAdvisoryEvidenceOnlyRetryMode,
  applyFailureAdvisorySynthesisMode,
} from '../pipeline/engine/failure-advisory-modes.js';
import type { FailureAdvisoryRecord, Session, StageDefinition } from '../types.js';

describe('failure-advisory retry modes', () => {
  it('keeps reproduce synthesis retries write-capable so they can create the failing test artifact', () => {
    const stage = createReproduceStage();

    applyDeterministicStageSynthesisMode(stage, createSession());

    expect(stage.tools).toEqual(expect.arrayContaining(['Read', 'Bash', 'Write', 'Edit']));
    expect(stage.model.primary.efficiencyBudget?.disableToolUse).not.toBe(true);
    expect(stage.model.primary.efficiencyBudget?.shellAbortFloor).toBe(4);
  });

  it('does not disable reproduce tools during failure-advisory synthesis retries', () => {
    const stage = createReproduceStage();

    applyFailureAdvisorySynthesisMode(stage, createSession(), createAdvisory());

    expect(stage.tools).toEqual(expect.arrayContaining(['Read', 'Bash', 'Write', 'Edit']));
    expect(stage.model.primary.efficiencyBudget?.disableToolUse).not.toBe(true);
    expect(stage.model.primary.efficiencyBudget?.shellAbortFloor).toBe(4);
  });

  it('keeps evidence-only reproduce retries able to write the scoped test', () => {
    const stage = createReproduceStage();

    applyFailureAdvisoryEvidenceOnlyRetryMode(stage, createSession({ changedFiles: ['src/a.ts'] }));

    expect(stage.tools).toEqual(expect.arrayContaining(['Read', 'Bash', 'Write', 'Edit']));
    expect(stage.model.primary.efficiencyBudget?.disableToolUse).not.toBe(true);
    expect(stage.model.primary.efficiencyBudget?.shellAbortFloor).toBe(4);
  });
});

function createReproduceStage(): StageDefinition {
  return {
    name: 'Reproduce',
    type: 'reproduce',
    description: 'Write a failing test',
    model: {
      primary: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 8,
        efficiencyBudget: {
          targetTurns: 8,
          explorationTurns: 2,
        },
      },
    },
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
    canLoop: true,
    maxLoopIterations: 3,
  };
}

function createSession(replayContext?: Session['replayContext']): Session {
  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'bug-fix',
      title: 'Bug',
      description: 'Bug',
      scope: ['src/bug.test.ts'],
      targetBranch: 'current',
      createdAt: '2026-04-27T00:00:00.000Z',
    },
    pipelineName: 'Bug Fix',
    pipelineVersion: 'Bug Fix@test',
    replayContext,
    state: 'executing',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  };
}

function createAdvisory(): FailureAdvisoryRecord {
  return {
    id: 'advisory-1',
    stageName: 'Reproduce',
    stageType: 'reproduce',
    failureCategory: 'quality-gate',
    failureSignature: 'Reproduce:error:Declared reproduction test file was not modified',
    summary: 'The model described the test but did not write it.',
    suspectedCause: 'Tool use was disabled during reproduce recovery.',
    recommendedAction: 'synthesize-stage',
    promptGuidance: 'Write the scoped failing test before emitting the report.',
    operatorActions: [],
    retryCount: 0,
    sourceError: 'Declared reproduction test file was not modified',
    generatedAt: '2026-04-27T00:00:00.000Z',
  };
}
