/**
 * Stage-execution resolution helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `resolveStageExecutionEfficiencyBudget(stage, session)` — merges the
 *     stage-type-specific estimated efficiency budget with the stage's
 *     primary-model efficiency budget. Returns the model budget directly
 *     for stage types that don't have a per-type estimator.
 *   - `resolveStageExecutionStallThresholdMs(stage, session, budget)` —
 *     derives a replay-aware stall threshold for exploratory stage types
 *     when the replay context has changed files and an efficiency budget
 *     is known; otherwise defers to the stage's primary-model threshold.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { Session, StageDefinition } from '../../types.js';
import type { ExecutorEfficiencyBudget } from '../../types.js';
import { mergeExecutorEfficiencyBudget } from '../execution-envelope.js';
import {
  estimateDeepScanEfficiencyBudget,
  estimatePlanningEfficiencyBudget,
  estimateReproduceEfficiencyBudget,
  estimateRootCauseEfficiencyBudget,
} from '../stage-runner.js';
import { clamp } from './text-utils.js';

export function resolveStageExecutionEfficiencyBudget(
  stage: StageDefinition,
  session: Session,
): ExecutorEfficiencyBudget | undefined {
  switch (stage.type) {
    case 'deep-scan':
      return mergeExecutorEfficiencyBudget(
        estimateDeepScanEfficiencyBudget(session),
        stage.model.primary.efficiencyBudget,
      );
    case 'plan-generation':
      return mergeExecutorEfficiencyBudget(
        estimatePlanningEfficiencyBudget(session),
        stage.model.primary.efficiencyBudget,
      );
    case 'reproduce':
      return mergeExecutorEfficiencyBudget(
        estimateReproduceEfficiencyBudget(session),
        stage.model.primary.efficiencyBudget,
      );
    case 'root-cause':
      return mergeExecutorEfficiencyBudget(
        estimateRootCauseEfficiencyBudget(session),
        stage.model.primary.efficiencyBudget,
      );
    default:
      return stage.model.primary.efficiencyBudget;
  }
}

export function resolveStageExecutionStallThresholdMs(
  stage: StageDefinition,
  session: Session,
  efficiencyBudget?: ExecutorEfficiencyBudget,
): number | undefined {
  const replayChangedFiles = session.replayContext?.changedFiles?.length ?? 0;
  if (replayChangedFiles === 0 || !efficiencyBudget) {
    return stage.model.primary.stallThresholdMs;
  }

  switch (stage.type) {
    case 'deep-scan':
    case 'oracle-analysis':
    case 'plan-generation':
    case 'reproduce':
    case 'root-cause': {
      const derived = clamp(efficiencyBudget.explorationTurns * 6_000 + 20_000, 45_000, 120_000);
      return stage.model.primary.stallThresholdMs != null
        ? Math.min(stage.model.primary.stallThresholdMs, derived)
        : derived;
    }
    default:
      return stage.model.primary.stallThresholdMs;
  }
}
