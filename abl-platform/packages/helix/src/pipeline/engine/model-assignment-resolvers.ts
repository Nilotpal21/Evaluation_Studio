/**
 * Model-assignment resolvers.
 *
 * Pure resolvers extracted from `pipeline-engine.ts`. Each reads the
 * stage-model policy from the passed `HelixConfig` and composes a final
 * `ModelAssignment` by applying review / architecture-review /
 * workspace-reconcile / failure-advisory preferences on top of the
 * incoming caller-supplied assignment. No engine state, no I/O.
 *
 *   - `getStageModelPolicy(config)` — returns `config.stageModelPolicy`
 *     merged against `DEFAULT_STAGE_MODEL_POLICY`. The merge guarantees
 *     `architectureReview.defaultPrimary` and `modelReview.defaultPrimary`
 *     survive even when the caller supplies a partial policy override.
 *   - `selectModelReviewAssignment(config, assignment?)` — applies the
 *     policy's model-review rule to the caller-supplied assignment.
 *   - `lockModelReviewEngine(config, engine, assignment?)` — same as
 *     above but pins the engine to the passed value regardless of the
 *     policy's `preferredEngine`.
 *   - `resolveArchitectureReviewAssignment(config, stage)` — applies the
 *     policy's architecture-review rule to the stage's own model.
 *   - `resolveWorkspaceReconcileAssignment(config, stage, context?)` —
 *     composes the architecture-review assignment and caps `maxTurns` at a
 *     budget scaled with the out-of-scope blocking-file count. The optional
 *     `context` argument carries `{ blockingFileCount, sliceFileCount }`; when
 *     absent, the cap falls back to a small baseline suitable for commit-time
 *     reconcile checkpoints where no blocking files are expected.
 *   - `resolveFailureAdvisoryAssignment(config, stage)` — composes the
 *     architecture-review assignment and clamps `maxTurns` to 8 for both
 *     primary and (optional) fallback.
 *
 * Defaults for the two review surfaces (including `maxTurns` and
 * `maxBudgetUsd`) live in `DEFAULT_STAGE_MODEL_POLICY` — there are no
 * hardcoded per-engine fallbacks in this module.
 */
import type {
  HelixConfig,
  HelixStageModelPolicy,
  ModelAssignment,
  ModelEngine,
  ModelSpec,
  StageDefinition,
  StageModelPolicyRule,
} from '../../types.js';
import { DEFAULT_STAGE_MODEL_POLICY, mergeStageModelPolicy } from '../../runtime-config.js';
import { preferAssignmentEngine } from '../execution-envelope.js';

type ResolvedReviewRule = StageModelPolicyRule & { defaultPrimary: ModelSpec };

export type ResolvedStageModelPolicy = HelixStageModelPolicy & {
  architectureReview: ResolvedReviewRule;
  modelReview: ResolvedReviewRule;
};

export function getStageModelPolicy(config: HelixConfig): ResolvedStageModelPolicy {
  const merged = mergeStageModelPolicy(DEFAULT_STAGE_MODEL_POLICY, config.stageModelPolicy);
  if (!merged?.architectureReview?.defaultPrimary || !merged?.modelReview?.defaultPrimary) {
    throw new Error(
      'Stage model policy is missing architectureReview/modelReview defaultPrimary after merge with DEFAULT_STAGE_MODEL_POLICY',
    );
  }
  return merged as ResolvedStageModelPolicy;
}

export function selectModelReviewAssignment(
  config: HelixConfig,
  assignment?: ModelAssignment,
): ModelAssignment {
  const policy = getStageModelPolicy(config);
  const reviewRule = policy.modelReview;
  return preferAssignmentEngine(
    assignment,
    reviewRule.preferredEngine ?? reviewRule.defaultPrimary.engine,
    reviewRule.defaultPrimary,
    config.allowModelFallbacks ?? false,
  );
}

export function lockModelReviewEngine(
  config: HelixConfig,
  engine: ModelEngine,
  assignment?: ModelAssignment,
): ModelAssignment {
  const policy = getStageModelPolicy(config);
  const reviewRule = policy.modelReview;
  const engineDefaultPrimary = resolveDefaultPrimaryForEngine(
    policy,
    engine,
    reviewRule.defaultPrimary,
  );
  return preferAssignmentEngine(
    assignment,
    engine,
    engineDefaultPrimary,
    config.allowModelFallbacks ?? false,
  );
}

export function resolveArchitectureReviewAssignment(
  config: HelixConfig,
  stage: StageDefinition,
): ModelAssignment {
  const policy = getStageModelPolicy(config);
  const reviewRule = policy.architectureReview;
  return preferAssignmentEngine(
    stage.model,
    reviewRule.preferredEngine ?? reviewRule.defaultPrimary.engine,
    reviewRule.defaultPrimary,
    config.allowModelFallbacks ?? false,
  );
}

export interface WorkspaceReconcileSliceContext {
  blockingFileCount?: number;
  sliceFileCount?: number;
}

const MIN_WORKSPACE_RECONCILE_TURNS = 6;
const MAX_WORKSPACE_RECONCILE_TURNS = 24;

function resolveWorkspaceReconcileMaxTurns(context?: WorkspaceReconcileSliceContext): number {
  const blockingFiles = Math.max(0, context?.blockingFileCount ?? 0);
  const sliceFiles = Math.max(0, context?.sliceFileCount ?? 0);
  // Each blocking file needs ~3 reconcile turns (open, inspect, classify).
  // Slice-context files add read-budget at half-weight.
  const raw = MIN_WORKSPACE_RECONCILE_TURNS + blockingFiles * 3 + Math.ceil(sliceFiles / 2);
  if (raw > MAX_WORKSPACE_RECONCILE_TURNS) return MAX_WORKSPACE_RECONCILE_TURNS;
  if (raw < MIN_WORKSPACE_RECONCILE_TURNS) return MIN_WORKSPACE_RECONCILE_TURNS;
  return raw;
}

export function resolveWorkspaceReconcileAssignment(
  config: HelixConfig,
  stage: StageDefinition,
  context?: WorkspaceReconcileSliceContext,
): ModelAssignment {
  const assignment = resolveArchitectureReviewAssignment(config, stage);
  const budget = resolveWorkspaceReconcileMaxTurns(context);
  return {
    ...assignment,
    primary: {
      ...assignment.primary,
      maxTurns: budget,
    },
    fallback: assignment.fallback
      ? {
          ...assignment.fallback,
          maxTurns: budget,
        }
      : undefined,
  };
}

export function resolveFailureAdvisoryAssignment(
  config: HelixConfig,
  stage: StageDefinition,
): ModelAssignment {
  const assignment = resolveArchitectureReviewAssignment(config, stage);
  return {
    ...assignment,
    primary: {
      ...assignment.primary,
      maxTurns: Math.min(assignment.primary.maxTurns ?? 8, 8),
    },
    fallback: assignment.fallback
      ? {
          ...assignment.fallback,
          maxTurns: Math.min(assignment.fallback.maxTurns ?? 8, 8),
        }
      : undefined,
  };
}

function resolveDefaultPrimaryForEngine(
  policy: ResolvedStageModelPolicy,
  engine: ModelEngine,
  fallback: ModelSpec,
): ModelSpec {
  const candidates: Array<ModelSpec | undefined> = [
    fallback,
    policy.modelReview.defaultPrimary,
    policy.architectureReview.defaultPrimary,
    ...Object.values(policy.roles ?? {}).map((rule) => rule?.defaultPrimary),
    ...Object.values(policy.stages ?? {}).map((rule) => rule?.defaultPrimary),
  ];

  return candidates.find((candidate) => candidate?.engine === engine) ?? fallback;
}
