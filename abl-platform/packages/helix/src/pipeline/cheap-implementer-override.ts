/**
 * --cheap-implementer CLI flag support.
 *
 * Implements the cheap-loop + expensive-gate cost-reduction pattern:
 * swap the primary engine on every `implementation` stage to claude-code/sonnet
 * (cheap), and keep the original primary as fallback. The stage's qualityGate
 * model-review checks and any `layered` review specs remain untouched —
 * opus stays the discriminator.
 *
 * Per-loop iteration cost drops from ~$5-15 (gpt-5.5 extra-high) to ~$0.50-2
 * (sonnet); opus only burns budget once per gate, not once per iteration.
 *
 * No-op when an implementation stage's primary is already a sonnet variant.
 * Mutates the pipeline in-place; safe to call after applyStageMaxTurnsOverrides
 * but before engine.run.
 */
import type { ModelSpec, PipelineTemplate } from '../types.js';

const SONNET_MODEL_ID = 'claude-sonnet-4-6';

export interface CheapImplementerApplied {
  stageName: string;
  previousEngine: ModelSpec['engine'];
  previousModel: string | undefined;
}

export function applyCheapImplementerOverride(pipeline: PipelineTemplate): {
  applied: CheapImplementerApplied[];
} {
  const applied: CheapImplementerApplied[] = [];

  for (const stage of pipeline.stages) {
    if (stage.type !== 'implementation') continue;

    const originalPrimary = stage.model.primary;
    if (!originalPrimary) continue;

    if (isSonnetSpec(originalPrimary)) continue;

    const sonnetPrimary: ModelSpec = {
      engine: 'claude-code',
      model: SONNET_MODEL_ID,
      maxTurns: originalPrimary.maxTurns ?? 30,
      maxBudgetUsd: clampBudget(originalPrimary.maxBudgetUsd, 8),
      permissionMode: originalPrimary.permissionMode ?? 'bypassPermissions',
    };

    const previousFallback = stage.model.fallback;
    stage.model.primary = sonnetPrimary;
    stage.model.fallback = previousFallback ?? originalPrimary;

    applied.push({
      stageName: stage.name,
      previousEngine: originalPrimary.engine,
      previousModel: originalPrimary.model,
    });
  }

  return { applied };
}

function isSonnetSpec(spec: ModelSpec): boolean {
  const model = spec.model?.toLowerCase() ?? '';
  return model.includes('sonnet');
}

function clampBudget(value: number | undefined, ceiling: number): number {
  if (value == null) return ceiling;
  return Math.min(value, ceiling);
}
