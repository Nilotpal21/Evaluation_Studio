import type {
  ExecutorEfficiencyBudget,
  HelixStageModelPolicy,
  ModelAssignment,
  ModelEngine,
  ModelSpec,
  Session,
  StageDefinition,
  StageOutputSchemaConfig,
} from '../types.js';
import { resolveStageExecutionRole } from './stage-machine.js';

export interface StageExecutionEnvelope {
  prompt: string;
  assignment: ModelAssignment;
  tools: string[];
  outputSchema?: StageOutputSchemaConfig;
  timeoutMs?: number;
}

export interface BuildStageExecutionEnvelopeInput {
  stage: StageDefinition;
  session: Pick<Session, 'pipelineName' | 'replayContext'>;
  prompt: string;
  timeoutMs?: number;
  efficiencyBudget?: ExecutorEfficiencyBudget;
  stallThresholdMs?: number;
  policy: HelixStageModelPolicy;
  allowFallbacks: boolean;
  isBroadReplayTask?: boolean;
}

export function buildStageExecutionEnvelope(
  input: BuildStageExecutionEnvelopeInput,
): StageExecutionEnvelope {
  let assignment = input.stage.respectStageModelSelection
    ? input.stage.model
    : resolveStageExecutionAssignmentForSession(
        input.stage,
        input.session,
        input.policy,
        input.allowFallbacks,
        input.isBroadReplayTask ?? false,
      );

  if (input.efficiencyBudget) {
    assignment = withExecutorEfficiencyBudget(assignment, input.efficiencyBudget);
  }

  if (input.stallThresholdMs != null) {
    assignment = withExecutionRuntimeHints(assignment, input.stallThresholdMs);
  }

  return {
    prompt: input.prompt,
    assignment,
    tools: resolveStageExecutionTools(input.stage, assignment, input.isBroadReplayTask ?? false),
    outputSchema: input.stage.outputSchema,
    timeoutMs: input.timeoutMs,
  };
}

export function resolveStageExecutionAssignmentForSession(
  stage: StageDefinition,
  session: Pick<Session, 'pipelineName' | 'replayContext'>,
  policy: HelixStageModelPolicy,
  allowFallbacks: boolean,
  isBroadReplayTask: boolean,
): ModelAssignment {
  if (stage.role) {
    return resolveStageExecutionAssignment(stage, policy, allowFallbacks);
  }

  if (
    stage.type === 'deep-scan' &&
    session.pipelineName === 'Holistic Feature Audit' &&
    isBroadReplayTask
  ) {
    return preferAssignmentEngine(
      stage.model,
      'claude-code',
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
      allowFallbacks,
    );
  }

  if (stage.type === 'plan-generation' && isBroadReplayTask) {
    return preferAssignmentEngine(
      stage.model,
      'claude-api',
      {
        engine: 'claude-api',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
      allowFallbacks,
    );
  }

  return resolveStageExecutionAssignment(stage, policy, allowFallbacks);
}

export function resolveStageExecutionAssignment(
  stage: StageDefinition,
  policy: HelixStageModelPolicy,
  allowFallbacks: boolean,
): ModelAssignment {
  const resolvedRole = stage.role ?? resolveStageExecutionRole(stage);
  const explicitRoleRule = stage.role ? policy.roles?.[stage.role] : undefined;
  const rule = explicitRoleRule ?? policy.stages?.[stage.type] ?? policy.roles?.[resolvedRole];
  if (!rule) {
    return stage.model;
  }

  return preferAssignmentEngine(
    stage.model,
    rule.preferredEngine ?? rule.defaultPrimary?.engine ?? stage.model.primary.engine,
    rule.defaultPrimary,
    resolvedRole === 'synthesize' ? false : allowFallbacks,
  );
}

export function resolveStageExecutionTools(
  stage: StageDefinition,
  assignment: ModelAssignment,
  isBroadReplayTask: boolean,
): string[] {
  const disableToolUse =
    assignment.primary.efficiencyBudget?.disableToolUse ||
    assignment.fallback?.efficiencyBudget?.disableToolUse ||
    assignment.layered?.some((spec) => spec.efficiencyBudget?.disableToolUse);
  if (disableToolUse) {
    return [];
  }

  if (stage.type === 'plan-generation' && isBroadReplayTask) {
    return [];
  }

  return stage.tools ?? [];
}

export function preferAssignmentEngine(
  assignment: ModelAssignment | undefined,
  preferredEngine: ModelEngine,
  defaultPrimary: ModelSpec | undefined,
  allowFallbacks: boolean,
): ModelAssignment {
  const preferredSpecs = assignment ? collectSpecsByEngine(assignment, preferredEngine) : [];
  const preferred =
    preferredSpecs[0] ??
    (defaultPrimary
      ? mergeModelSpecWithExecutionHints(defaultPrimary, assignment?.primary)
      : undefined);

  if (!preferred) {
    if (!assignment) {
      throw new Error(`No model assignment available for preferred engine ${preferredEngine}`);
    }

    return assignment;
  }

  if (assignment && assignment.primary === preferred) {
    return assignment;
  }

  const fallbackCandidates = assignment
    ? [assignment.primary, assignment.fallback, ...(assignment.layered ?? [])]
        .filter((candidate): candidate is ModelSpec => Boolean(candidate))
        .filter((candidate) => !preferredSpecs.includes(candidate))
    : [];
  const sameEngineLayers = preferredSpecs.slice(1);

  return {
    primary: preferred,
    ...(allowFallbacks && fallbackCandidates.length > 0 ? { fallback: fallbackCandidates[0] } : {}),
    ...(sameEngineLayers.length > 0 ? { layered: sameEngineLayers } : {}),
  };
}

function mergeModelSpecWithExecutionHints(base: ModelSpec, template?: ModelSpec): ModelSpec {
  if (!template) {
    return base;
  }

  return {
    ...template,
    ...base,
    engine: base.engine,
    ...(base.model ? { model: base.model } : {}),
  };
}

export function withExecutorEfficiencyBudget(
  assignment: ModelAssignment,
  efficiencyBudget: ExecutorEfficiencyBudget,
): ModelAssignment {
  return {
    ...assignment,
    primary: {
      ...assignment.primary,
      efficiencyBudget: mergeExecutorEfficiencyBudget(
        efficiencyBudget,
        assignment.primary.efficiencyBudget,
      ),
    },
    fallback: assignment.fallback
      ? {
          ...assignment.fallback,
          efficiencyBudget: mergeExecutorEfficiencyBudget(
            efficiencyBudget,
            assignment.fallback.efficiencyBudget,
          ),
        }
      : undefined,
    layered:
      assignment.layered?.map((spec) => ({
        ...spec,
        efficiencyBudget: mergeExecutorEfficiencyBudget(efficiencyBudget, spec.efficiencyBudget),
      })) ?? undefined,
  };
}

/**
 * Decides whether the layered architecture-review pass should be skipped
 * for a given slice. Layered review is only meaningfully signal-rich when
 * the slice changes exported behavior or carries a non-trivial risk
 * profile; routine low-risk slices (e.g. CLI commands, doc generators,
 * config additions) tend to produce review-loop oscillation more than
 * actual quality signal.
 */
export function shouldSkipLayeredReviewForSlice(slice: {
  impactAnalysis: { riskLevel: string };
  manifest: { exportContracts?: ReadonlyArray<unknown> };
}): boolean {
  if (slice.impactAnalysis.riskLevel !== 'low') {
    return false;
  }
  const exportContracts = slice.manifest.exportContracts ?? [];
  return exportContracts.length === 0;
}

/**
 * Returns a model assignment with the layered review pass dropped when
 * the slice is low-risk and changes no exported symbols. Caller passes
 * the slice that is about to execute; if the slice doesn't qualify the
 * assignment is returned unchanged.
 */
export function stripLayeredForLowRiskSlice(
  assignment: ModelAssignment,
  slice: {
    impactAnalysis: { riskLevel: string };
    manifest: { exportContracts?: ReadonlyArray<unknown> };
  },
): ModelAssignment {
  if (!shouldSkipLayeredReviewForSlice(slice)) {
    return assignment;
  }
  if (!assignment.layered || assignment.layered.length === 0) {
    return assignment;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { layered: _layered, ...rest } = assignment;
  return rest;
}

export function withExecutionRuntimeHints(
  assignment: ModelAssignment,
  stallThresholdMs?: number,
): ModelAssignment {
  if (stallThresholdMs == null) {
    return assignment;
  }

  const applyToSpec = (spec: ModelSpec): ModelSpec => ({
    ...spec,
    stallThresholdMs:
      spec.stallThresholdMs != null
        ? Math.min(spec.stallThresholdMs, stallThresholdMs)
        : stallThresholdMs,
  });

  return {
    ...assignment,
    primary: applyToSpec(assignment.primary),
    fallback: assignment.fallback ? applyToSpec(assignment.fallback) : undefined,
    layered: assignment.layered?.map((spec) => applyToSpec(spec)) ?? undefined,
  };
}

export function mergeExecutorEfficiencyBudget(
  base: ExecutorEfficiencyBudget,
  override?: Partial<ExecutorEfficiencyBudget> | null,
): ExecutorEfficiencyBudget {
  if (!override) {
    return base;
  }

  return {
    targetTurns: Math.max(base.targetTurns, override.targetTurns ?? base.targetTurns),
    explorationTurns: Math.max(
      base.explorationTurns,
      override.explorationTurns ?? base.explorationTurns,
    ),
    ...(base.disableToolUse || override.disableToolUse
      ? { disableToolUse: override.disableToolUse ?? base.disableToolUse }
      : {}),
    ...(base.hardTurnCap != null || override.hardTurnCap != null
      ? {
          hardTurnCap: Math.max(
            base.hardTurnCap ?? 0,
            override.hardTurnCap ?? base.hardTurnCap ?? 0,
          ),
        }
      : {}),
    ...(base.shellWarnFloor != null || override.shellWarnFloor != null
      ? {
          shellWarnFloor: Math.max(
            base.shellWarnFloor ?? 0,
            override.shellWarnFloor ?? base.shellWarnFloor ?? 0,
          ),
        }
      : {}),
    ...(base.shellAbortFloor != null || override.shellAbortFloor != null
      ? {
          shellAbortFloor: Math.max(
            base.shellAbortFloor ?? 0,
            override.shellAbortFloor ?? base.shellAbortFloor ?? 0,
          ),
        }
      : {}),
    ...(base.abortExploratoryToolUseAfterTargetTurns ||
    override.abortExploratoryToolUseAfterTargetTurns
      ? {
          abortExploratoryToolUseAfterTargetTurns:
            override.abortExploratoryToolUseAfterTargetTurns ??
            base.abortExploratoryToolUseAfterTargetTurns,
        }
      : {}),
    ...(base.zeroTurnShellAbortFloor != null || override.zeroTurnShellAbortFloor != null
      ? {
          zeroTurnShellAbortFloor: Math.max(
            base.zeroTurnShellAbortFloor ?? 0,
            override.zeroTurnShellAbortFloor ?? base.zeroTurnShellAbortFloor ?? 0,
          ),
        }
      : {}),
    ...(base.zeroTurnElapsedAbortMs != null || override.zeroTurnElapsedAbortMs != null
      ? {
          zeroTurnElapsedAbortMs: Math.max(
            base.zeroTurnElapsedAbortMs ?? 0,
            override.zeroTurnElapsedAbortMs ?? base.zeroTurnElapsedAbortMs ?? 0,
          ),
        }
      : {}),
    ...(base.allowScopedShellInspection || override.allowScopedShellInspection
      ? {
          allowScopedShellInspection:
            override.allowScopedShellInspection ?? base.allowScopedShellInspection,
        }
      : {}),
    ...(base.abortScopedShellInspectionAfterLimit || override.abortScopedShellInspectionAfterLimit
      ? {
          abortScopedShellInspectionAfterLimit:
            override.abortScopedShellInspectionAfterLimit ??
            base.abortScopedShellInspectionAfterLimit,
        }
      : {}),
    ...(base.abortScopedToolInspectionAfterLimit || override.abortScopedToolInspectionAfterLimit
      ? {
          abortScopedToolInspectionAfterLimit:
            override.abortScopedToolInspectionAfterLimit ??
            base.abortScopedToolInspectionAfterLimit,
        }
      : {}),
    ...(base.forbiddenShellPatterns?.length || override.forbiddenShellPatterns?.length
      ? {
          forbiddenShellPatterns: Array.from(
            new Set([
              ...(base.forbiddenShellPatterns ?? []),
              ...(override.forbiddenShellPatterns ?? []),
            ]),
          ),
        }
      : {}),
    ...(base.summary ? { summary: base.summary } : {}),
    ...(base.scopedShellInspectionCountLimit != null ||
    override.scopedShellInspectionCountLimit != null
      ? {
          scopedShellInspectionCountLimit: Math.max(
            base.scopedShellInspectionCountLimit ?? 0,
            override.scopedShellInspectionCountLimit ?? base.scopedShellInspectionCountLimit ?? 0,
          ),
        }
      : {}),
    ...(base.scopedToolInspectionCountLimit != null ||
    override.scopedToolInspectionCountLimit != null
      ? {
          scopedToolInspectionCountLimit: Math.max(
            base.scopedToolInspectionCountLimit ?? 0,
            override.scopedToolInspectionCountLimit ?? base.scopedToolInspectionCountLimit ?? 0,
          ),
        }
      : {}),
  };
}

function collectSpecsByEngine(
  assignment: ModelAssignment,
  preferredEngine: ModelEngine,
): ModelSpec[] {
  return [assignment.primary, assignment.fallback, ...(assignment.layered ?? [])].filter(
    (spec): spec is ModelSpec => spec != null && spec.engine === preferredEngine,
  );
}
