import { describe, expect, it } from 'vitest';

import type { StageDefinition } from '../types.js';
import {
  decideStageContinuation,
  resolveStageExecutionRole,
  resolveStageMaxAttempts,
} from '../pipeline/stage-machine.js';

function makeStage(
  overrides: Partial<StageDefinition> = {},
): Pick<StageDefinition, 'type' | 'role' | 'canLoop' | 'maxLoopIterations'> {
  return {
    type: 'deep-scan',
    canLoop: true,
    maxLoopIterations: 3,
    ...overrides,
  };
}

describe('stage-machine', () => {
  it('derives execution roles from stage types', () => {
    expect(resolveStageExecutionRole(makeStage({ type: 'deep-scan' }))).toBe('explore');
    expect(resolveStageExecutionRole(makeStage({ type: 'plan-generation' }))).toBe('plan');
    expect(resolveStageExecutionRole(makeStage({ type: 'implementation' }))).toBe('implement');
    expect(resolveStageExecutionRole(makeStage({ type: 'review' }))).toBe('review');
    expect(resolveStageExecutionRole(makeStage({ type: 'regression' }))).toBe('verify');
  });

  it('prefers an explicit role override', () => {
    expect(resolveStageExecutionRole(makeStage({ type: 'deep-scan', role: 'synthesize' }))).toBe(
      'synthesize',
    );
  });

  it('resolves max attempts from loop configuration', () => {
    expect(resolveStageMaxAttempts(makeStage({ canLoop: false, maxLoopIterations: 4 }))).toBe(1);
    expect(resolveStageMaxAttempts(makeStage({ canLoop: true, maxLoopIterations: 0 }))).toBe(1);
    expect(resolveStageMaxAttempts(makeStage({ canLoop: true, maxLoopIterations: 4 }))).toBe(4);
  });

  it('retries recoverable failures while attempts remain', () => {
    expect(
      decideStageContinuation({
        stage: makeStage({ maxLoopIterations: 2 }),
        attempt: 1,
        failureKind: 'quality-gate',
      }),
    ).toBe('retry-with-feedback');
  });

  it('stops once the final attempt has been used', () => {
    expect(
      decideStageContinuation({
        stage: makeStage({ maxLoopIterations: 2 }),
        attempt: 2,
        failureKind: 'structured-output',
      }),
    ).toBe('stop');
  });

  it('advances when there is no failure to recover', () => {
    expect(
      decideStageContinuation({
        stage: makeStage(),
        attempt: 1,
      }),
    ).toBe('advance');
  });
});
