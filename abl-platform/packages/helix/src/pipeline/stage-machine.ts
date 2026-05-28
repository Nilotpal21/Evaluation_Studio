import type { StageDefinition, StageExecutionRole } from '../types.js';

export type StageContinuationFailureKind =
  | 'structured-output'
  | 'artifact-contract'
  | 'quality-gate';

export type StageContinuationDecision = 'advance' | 'retry-with-feedback' | 'stop';

export interface StageContinuationInput {
  stage: Pick<StageDefinition, 'type' | 'role' | 'canLoop' | 'maxLoopIterations'>;
  attempt: number;
  failureKind?: StageContinuationFailureKind;
}

export function resolveStageExecutionRole(
  stage: Pick<StageDefinition, 'type' | 'role'>,
): StageExecutionRole {
  if (stage.role) {
    return stage.role;
  }

  switch (stage.type) {
    case 'bootstrap':
      return 'bootstrap';
    case 'deep-scan':
    case 'reproduce':
    case 'root-cause':
      return 'explore';
    case 'plan-generation':
    case 'manifest-compilation':
      return 'plan';
    case 'implementation':
      return 'implement';
    case 'testing':
    case 'regression':
    case 'concerns-audit':
      return 'verify';
    case 'review':
    case 'bulk-review':
    case 'user-checkpoint':
    case 'commit-checkpoint':
    case 'doc-sync':
      return 'review';
    case 'oracle-analysis':
    case 'custom':
    default:
      return 'synthesize';
  }
}

export function resolveStageMaxAttempts(
  stage: Pick<StageDefinition, 'canLoop' | 'maxLoopIterations'>,
): number {
  if (!stage.canLoop) {
    return 1;
  }

  return Math.max(stage.maxLoopIterations, 1);
}

export function decideStageContinuation(input: StageContinuationInput): StageContinuationDecision {
  if (!input.failureKind) {
    return 'advance';
  }

  return input.attempt < resolveStageMaxAttempts(input.stage) ? 'retry-with-feedback' : 'stop';
}
