/**
 * Fallback failure-advisory builder.
 *
 * Pure helper extracted verbatim from `pipeline-engine.ts`. Assembles
 * a `FailureAdvisoryRecord` from the stage, session, failure category,
 * signature, retry count, source-error text, and an optional
 * `StageResult`. Used when a model-generated advisory is unavailable or
 * invalid and HELIX needs to synthesize one from deterministic
 * defaults.
 *
 * No engine state, no I/O beyond deterministic helpers. Behavior
 * unchanged.
 */
import { randomUUID } from 'node:crypto';

import type {
  FailureAdvisoryCategory,
  FailureAdvisoryRecord,
  Session,
  StageDefinition,
  StageResult,
} from '../../types.js';
import { now } from '../stage-execution-shared.js';
import {
  defaultFailureAdvisoryAction,
  defaultFailureAdvisoryOperatorActions,
  defaultFailureAdvisoryPromptGuidance,
  maybePromoteFailureAdvisoryAction,
} from './failure-advisory-actions.js';
import { buildFailureAdvisoryEvidenceDigest } from './failure-advisory-evidence.js';
import { defaultFailureAdvisorySummary } from './failure-advisory-summary.js';

export function buildFallbackFailureAdvisory(
  session: Session,
  stage: StageDefinition,
  failureCategory: FailureAdvisoryCategory,
  failureSignature: string,
  priorRetryCount: number,
  sourceError: string,
  result?: StageResult,
): FailureAdvisoryRecord {
  const recommendedAction = maybePromoteFailureAdvisoryAction(
    session,
    stage,
    result,
    defaultFailureAdvisoryAction(stage, failureCategory, sourceError, priorRetryCount),
    '',
    '',
    sourceError,
  );

  return {
    id: randomUUID().slice(0, 8),
    stageName: stage.name,
    stageType: stage.type,
    failureCategory,
    failureSignature,
    retryCount: priorRetryCount,
    sourceError,
    generatedAt: now(),
    evidenceDigest: result ? buildFailureAdvisoryEvidenceDigest(stage, result) : undefined,
    summary: defaultFailureAdvisorySummary(stage, failureCategory, sourceError, recommendedAction),
    suspectedCause: sourceError,
    recommendedAction,
    promptGuidance:
      recommendedAction === 'retry-stage' ||
      recommendedAction === 'synthesize-stage' ||
      recommendedAction === 'switch-model' ||
      recommendedAction === 'continue-immediate-only'
        ? defaultFailureAdvisoryPromptGuidance(
            failureCategory,
            sourceError,
            stage,
            recommendedAction,
          )
        : null,
    operatorActions: defaultFailureAdvisoryOperatorActions(failureCategory, sourceError),
    budgetRecommendation: null,
  };
}
