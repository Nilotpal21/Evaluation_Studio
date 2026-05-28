import { describe, expect, it } from 'vitest';

import {
  decideDeterministicStageContinuation,
  isDeterministicStageContinuationStage,
} from '../pipeline/stage-continuation-advisor.js';
import type { StageDefinition, StageResult } from '../types.js';

function makeStage(
  overrides: Partial<Pick<StageDefinition, 'type'>> = {},
): Pick<StageDefinition, 'type'> {
  return {
    type: 'deep-scan',
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<
    Pick<StageResult, 'status' | 'error' | 'output' | 'findings' | 'decisions' | 'executionSummary'>
  > = {},
): Pick<
  StageResult,
  'status' | 'error' | 'output' | 'findings' | 'decisions' | 'executionSummary'
> {
  return {
    status: 'failed',
    error: 'Codex issued 11 shell commands without producing a model turn',
    output: '',
    findings: [],
    decisions: [],
    executionSummary: {
      progressEvents: 0,
      outputEvents: 0,
      toolUseEvents: 0,
      errorEvents: 1,
      shellCommandEvents: 11,
      recentMessages: ['Bash: /bin/bash -lc "sed -n \'1,240p\' src/feature.ts"'],
    },
    ...overrides,
  };
}

describe('stage-continuation-advisor', () => {
  it('marks replay analysis stages as deterministic continuation candidates', () => {
    expect(isDeterministicStageContinuationStage(makeStage({ type: 'deep-scan' }))).toBe(true);
    expect(isDeterministicStageContinuationStage(makeStage({ type: 'reproduce' }))).toBe(true);
    expect(isDeterministicStageContinuationStage(makeStage({ type: 'root-cause' }))).toBe(true);
    expect(isDeterministicStageContinuationStage(makeStage({ type: 'plan-generation' }))).toBe(
      false,
    );
  });

  it('retries broad replay analysis from gathered evidence once', () => {
    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult(),
        priorFailures: 0,
        isBroadReplayTask: true,
      }),
    ).toMatchObject({
      decision: 'retry',
      mode: 'synthesize-from-evidence',
    });
  });

  it('stops deterministic continuation after two prior failures', () => {
    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult(),
        priorFailures: 2,
        isBroadReplayTask: true,
      }),
    ).toEqual({ decision: 'stop' });
  });

  it('still retries with synthesis on the second prior failure', () => {
    const decision = decideDeterministicStageContinuation({
      stage: makeStage(),
      result: makeResult(),
      priorFailures: 1,
      isBroadReplayTask: true,
    });
    expect(decision.decision).toBe('retry');
    expect(decision.mode).toBe('synthesize-from-evidence');
  });

  it('stops when the replay is not broad or no seam evidence exists', () => {
    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult(),
        priorFailures: 0,
        isBroadReplayTask: false,
      }),
    ).toEqual({ decision: 'stop' });

    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult({
          error: 'Codex stalled after 20s of inactivity',
          executionSummary: {
            progressEvents: 0,
            outputEvents: 0,
            toolUseEvents: 0,
            errorEvents: 1,
            shellCommandEvents: 0,
            recentMessages: [],
          },
        }),
        priorFailures: 0,
        isBroadReplayTask: true,
      }),
    ).toEqual({ decision: 'stop' });
  });

  it('retries one non-replay analysis pass when HELIX itself stopped a shell-heavy exploration after substantial evidence', () => {
    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult({
          error:
            "Codex issued 17 exploratory shell commands, exceeding HELIX's shell exploration budget. Stop this shell-heavy trajectory and continue from the evidence already gathered.",
          executionSummary: {
            progressEvents: 18,
            outputEvents: 18,
            toolUseEvents: 17,
            errorEvents: 1,
            shellCommandEvents: 17,
            recentMessages: [
              'Bash: /bin/bash -lc "sed -n \'1,260p\' packages/compiler/src/platform/nlu/engine.ts"',
            ],
          },
        }),
        priorFailures: 0,
        isBroadReplayTask: false,
      }),
    ).toMatchObject({
      decision: 'retry',
      mode: 'synthesize-from-evidence',
    });
  });

  it('does not retry non-replay startup stalls with no evidence', () => {
    expect(
      decideDeterministicStageContinuation({
        stage: makeStage(),
        result: makeResult({
          error: 'Codex stalled after 45s of inactivity (45s total elapsed, 0 turns)',
          executionSummary: {
            progressEvents: 4,
            outputEvents: 0,
            toolUseEvents: 0,
            errorEvents: 1,
            shellCommandEvents: 0,
            recentMessages: [],
          },
        }),
        priorFailures: 0,
        isBroadReplayTask: false,
      }),
    ).toEqual({ decision: 'stop' });
  });
});
