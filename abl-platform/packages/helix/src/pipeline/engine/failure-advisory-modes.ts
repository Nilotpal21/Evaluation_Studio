/**
 * Failure-advisory stage-model mode appliers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`. Each applier
 * mutates the supplied `stage` in place to reshape stage.model (primary,
 * fallback, layered), stage.role, stage.respectStageModelSelection, and
 * stage.tools into the posture required by the retry/synthesis mode.
 *
 *   - `applyDeterministicStageSynthesisMode(stage, session)` — minimal
 *     tool-free synthesis budget (4–6 turns) with fallback/layered
 *     cleared, used to deterministically finish a stage from gathered
 *     seam evidence.
 *   - `applyFailureAdvisorySynthesisMode(stage, session, advisory)` —
 *     synthesis budget that optionally swaps the primary model to the
 *     stable replay synthesizer (claude-api/claude-sonnet-4-6) when replay seam
 *     evidence is rich enough, or when the stage is in the
 *     broad-replay / analysis-synthesis class.
 *   - `applyFailureAdvisoryEvidenceOnlyRetryMode(stage, session)` —
 *     evidence-only retry budget that keeps the original model chain
 *     (primary + fallback + layered) but disables tools for analysis
 *     stages when the replay seam is already gathered.
 *   - `applyFailureAdvisoryStableReplayRetryMode(stage)` — pins the
 *     entire model chain to claude-api/claude-sonnet-4-6 for stable
 *     replay recovery.
 *   - `applyFailureAdvisorySwitchModelMode(stage)` — swaps
 *     codex-cli ↔ claude-code on primary and fallback, clears layered.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type {
  ExecutorEfficiencyBudget,
  FailureAdvisoryRecord,
  ModelSpec,
  Session,
  StageDefinition,
} from '../../types.js';
import { mergeExecutorEfficiencyBudget } from '../execution-envelope.js';
import { resolveStageExecutionEfficiencyBudget } from './stage-execution-resolution.js';

const REPRODUCE_RECOVERY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Write',
  'Edit',
  'helix_find_symbol',
  'helix_find_references',
  'helix_get_route_info',
  'helix_get_schema_info',
  'helix_get_impacted_tests',
];

export function applyDeterministicStageSynthesisMode(
  stage: StageDefinition,
  session: Session,
): void {
  const currentBudget = resolveStageExecutionEfficiencyBudget(stage, session);
  const synthesisBudget: ExecutorEfficiencyBudget = {
    targetTurns: Math.max(4, Math.min(currentBudget?.targetTurns ?? 6, 6)),
    explorationTurns: 1,
    shellWarnFloor: 1,
    shellAbortFloor: stage.type === 'reproduce' ? 4 : 1,
    disableToolUse: stage.type === 'reproduce' ? false : true,
    summary:
      stage.type === 'reproduce'
        ? 'Deterministic continuation: use the gathered seam evidence to write the scoped failing test artifact, then emit the structured reproduction report.'
        : 'Deterministic continuation: synthesize the structured artifact from the already gathered seam evidence without more rediscovery.',
  };

  const applyToSpec = (spec: ModelSpec): ModelSpec => ({
    ...spec,
    maxTurns: Math.min(spec.maxTurns ?? 6, 6),
    stallThresholdMs: Math.min(spec.stallThresholdMs ?? 35_000, 35_000),
    efficiencyBudget: spec.efficiencyBudget
      ? mergeExecutorEfficiencyBudget(spec.efficiencyBudget, synthesisBudget)
      : synthesisBudget,
  });

  const shouldUseStableAnalysisSynthesizer = ['deep-scan', 'reproduce', 'root-cause'].includes(
    stage.type,
  );
  const originalPrimary = applyToSpec(stage.model.primary);

  stage.model = {
    ...stage.model,
    primary: shouldUseStableAnalysisSynthesizer
      ? {
          ...originalPrimary,
          engine: 'claude-api',
          model: 'claude-sonnet-4-6',
          effort: originalPrimary.effort ?? 'medium',
        }
      : originalPrimary,
    fallback: undefined,
    layered: undefined,
  };
  stage.role = 'synthesize';
  stage.respectStageModelSelection = false;
  stage.tools = stage.type === 'reproduce' ? mergeTools(stage.tools, REPRODUCE_RECOVERY_TOOLS) : [];
}

export function applyFailureAdvisorySynthesisMode(
  stage: StageDefinition,
  session: Session,
  advisory: FailureAdvisoryRecord,
): void {
  void advisory;
  const currentBudget = resolveStageExecutionEfficiencyBudget(stage, session);
  if (!currentBudget) {
    return;
  }

  const replayChangedFiles = session.replayContext?.changedFiles?.length ?? 0;
  const broadReplaySynthesis =
    replayChangedFiles >= 6 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'rbac', 'route-migration'].includes(tag),
    );
  const isAnalysisSynthesisStage = ['deep-scan', 'reproduce', 'root-cause'].includes(stage.type);
  const useStableReplaySynthesizer =
    replayChangedFiles > 0 &&
    ['deep-scan', 'reproduce', 'root-cause', 'plan-generation'].includes(stage.type);
  const shouldDisableReplayTools =
    replayChangedFiles > 0 &&
    ['deep-scan', 'reproduce', 'root-cause', 'plan-generation'].includes(stage.type);
  const synthesisBudget: ExecutorEfficiencyBudget = {
    targetTurns: Math.max(
      4,
      Math.min(currentBudget.targetTurns, Math.max(6, Math.ceil(currentBudget.targetTurns * 0.5))),
    ),
    explorationTurns: Math.max(1, Math.min(2, Math.ceil(currentBudget.explorationTurns * 0.25))),
    shellWarnFloor: 1,
    shellAbortFloor: stage.type === 'reproduce' ? 4 : 2,
    disableToolUse: stage.type === 'reproduce' ? false : true,
    summary:
      stage.type === 'reproduce'
        ? 'Synthesis retry: rely on the gathered seam evidence, write the scoped failing test artifact, and emit the structured reproduction report.'
        : 'Synthesis retry: rely on the gathered seam evidence and emit the structured result with minimal additional exploration.',
  };

  const applyToSpec = (spec: ModelSpec): ModelSpec => {
    const isAnalysisSynthesisStage = ['deep-scan', 'reproduce', 'root-cause'].includes(stage.type);
    const isPlanningSynthesisStage = stage.type === 'plan-generation';

    return {
      ...spec,
      maxTurns: isAnalysisSynthesisStage
        ? Math.min(spec.maxTurns ?? 6, 6)
        : isPlanningSynthesisStage
          ? Math.min(spec.maxTurns ?? 8, 8)
          : spec.maxTurns,
      stallThresholdMs: isAnalysisSynthesisStage
        ? Math.min(spec.stallThresholdMs ?? 35_000, 35_000)
        : isPlanningSynthesisStage
          ? Math.min(spec.stallThresholdMs ?? 35_000, 35_000)
          : spec.stallThresholdMs,
      efficiencyBudget: spec.efficiencyBudget
        ? mergeExecutorEfficiencyBudget(spec.efficiencyBudget, synthesisBudget)
        : synthesisBudget,
    };
  };

  const originalPrimary = applyToSpec(stage.model.primary);
  stage.model = {
    ...stage.model,
    primary:
      useStableReplaySynthesizer || isAnalysisSynthesisStage || broadReplaySynthesis
        ? {
            ...originalPrimary,
            engine: 'claude-api',
            model: 'claude-sonnet-4-6',
            effort: originalPrimary.effort ?? 'medium',
          }
        : originalPrimary,
    fallback: undefined,
    layered: undefined,
  };
  stage.role = 'synthesize';
  stage.respectStageModelSelection = false;

  if (stage.type === 'reproduce') {
    stage.tools = mergeTools(stage.tools, REPRODUCE_RECOVERY_TOOLS);
  } else if (shouldDisableReplayTools) {
    stage.tools = [];
  }
}

export function applyFailureAdvisoryEvidenceOnlyRetryMode(
  stage: StageDefinition,
  session: Session,
): void {
  const currentBudget = resolveStageExecutionEfficiencyBudget(stage, session);
  if (!currentBudget) {
    return;
  }

  const evidenceRetryBudget: ExecutorEfficiencyBudget = {
    targetTurns: Math.max(
      4,
      Math.min(currentBudget.targetTurns, Math.max(8, Math.ceil(currentBudget.targetTurns * 0.6))),
    ),
    explorationTurns: 1,
    shellWarnFloor: 1,
    shellAbortFloor: stage.type === 'reproduce' ? 4 : 1,
    disableToolUse: stage.type === 'reproduce' ? false : true,
    summary:
      stage.type === 'reproduce'
        ? 'Evidence-only retry: reuse the gathered seam evidence, write the scoped failing test artifact, and emit the structured reproduction report.'
        : 'Evidence-only retry: reuse the gathered seam evidence on the original model and emit the structured result without more rediscovery.',
  };

  const applyToSpec = (spec: ModelSpec): ModelSpec => {
    const isAnalysisRetryStage = ['deep-scan', 'reproduce', 'root-cause'].includes(stage.type);

    return {
      ...spec,
      maxTurns: isAnalysisRetryStage ? Math.min(spec.maxTurns ?? 8, 8) : spec.maxTurns,
      stallThresholdMs: isAnalysisRetryStage
        ? Math.min(spec.stallThresholdMs ?? 45_000, 45_000)
        : spec.stallThresholdMs,
      efficiencyBudget: spec.efficiencyBudget
        ? mergeExecutorEfficiencyBudget(spec.efficiencyBudget, evidenceRetryBudget)
        : evidenceRetryBudget,
    };
  };

  stage.model = {
    ...stage.model,
    primary: applyToSpec(stage.model.primary),
    ...(stage.model.fallback ? { fallback: applyToSpec(stage.model.fallback) } : {}),
    ...(stage.model.layered
      ? { layered: stage.model.layered.map((spec) => applyToSpec(spec)) }
      : {}),
  };
  stage.respectStageModelSelection = true;

  if (stage.type === 'reproduce') {
    stage.tools = mergeTools(stage.tools, REPRODUCE_RECOVERY_TOOLS);
  } else if (
    ['deep-scan', 'root-cause'].includes(stage.type) &&
    (session.replayContext?.changedFiles?.length ?? 0) > 0
  ) {
    stage.tools = [];
  }
}

export function applyFailureAdvisoryStableReplayRetryMode(stage: StageDefinition): void {
  const applyToSpec = (spec: ModelSpec): ModelSpec => ({
    ...spec,
    engine: 'claude-api',
    model: 'claude-sonnet-4-6',
    effort: spec.effort ?? 'medium',
    maxTurns: Math.min(spec.maxTurns ?? 8, 8),
    stallThresholdMs: 45_000,
  });

  stage.model = {
    ...stage.model,
    primary: applyToSpec(stage.model.primary),
    ...(stage.model.fallback ? { fallback: applyToSpec(stage.model.fallback) } : {}),
    ...(stage.model.layered
      ? { layered: stage.model.layered.map((spec) => applyToSpec(spec)) }
      : {}),
  };
  stage.respectStageModelSelection = true;
}

export function applyFailureAdvisorySwitchModelMode(stage: StageDefinition): void {
  const switchSpec = (spec: ModelSpec): ModelSpec => {
    if (spec.engine === 'codex-cli') {
      return {
        ...spec,
        engine: 'claude-api',
        model: 'claude-sonnet-4-6',
        effort: spec.effort ?? 'medium',
      };
    }

    if (spec.engine === 'claude-code' || spec.engine === 'claude-api') {
      return {
        ...spec,
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: spec.effort ?? 'medium',
      };
    }

    return spec;
  };

  stage.model = {
    ...stage.model,
    primary: switchSpec(stage.model.primary),
    ...(stage.model.fallback ? { fallback: switchSpec(stage.model.fallback) } : {}),
    layered: undefined,
  };
  stage.respectStageModelSelection = true;
}

function mergeTools(
  existing: readonly string[] | undefined,
  required: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...required])];
}
