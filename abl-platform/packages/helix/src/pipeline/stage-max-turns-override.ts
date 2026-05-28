/**
 * --stage-max-turns CLI flag support.
 *
 * Lets the operator override the maxTurns budget on specific pipeline
 * stages without forking the pipeline template. Format:
 *
 *   --stage-max-turns regression=40,implementation=200
 *
 * Each comma-separated entry is `<stageType>=<positiveInt>`. Stage types
 * match the StageType enum in types.ts. The override applies to every
 * model spec in the matching stage(s) — primary, fallback, and each
 * layered entry.
 *
 * Mutates the pipeline in-place; safe to call after resolveRuntimeReadinessPolicy
 * but before engine.run. Pure parser/applier — no I/O, no state.
 */
import type { ModelSpec, PipelineTemplate, StageType } from '../types.js';

export interface StageMaxTurnsOverride {
  stageType: StageType;
  maxTurns: number;
}

export interface ParseStageMaxTurnsResult {
  overrides: StageMaxTurnsOverride[];
  errors: string[];
}

const STAGE_TYPES_VALID = new Set<StageType>([
  'bootstrap',
  'deep-scan',
  'oracle-analysis',
  'plan-generation',
  'manifest-compilation',
  'user-checkpoint',
  'implementation',
  'testing',
  'review',
  'bulk-review',
  'commit-checkpoint',
  'regression',
  'doc-sync',
  'reproduce',
  'root-cause',
  'concerns-audit',
  'custom',
]);

export function parseStageMaxTurnsFlag(value: string | undefined): ParseStageMaxTurnsResult {
  const overrides: StageMaxTurnsOverride[] = [];
  const errors: string[] = [];

  if (!value || value === 'true') {
    return { overrides, errors };
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) {
      errors.push(
        `--stage-max-turns: missing '=' in entry "${entry}" (expected "<stageType>=<N>")`,
      );
      continue;
    }
    const rawType = entry.slice(0, eqIdx).trim();
    const rawCount = entry.slice(eqIdx + 1).trim();
    if (!rawType || !rawCount) {
      errors.push(`--stage-max-turns: empty key or value in entry "${entry}"`);
      continue;
    }
    if (!STAGE_TYPES_VALID.has(rawType as StageType)) {
      errors.push(
        `--stage-max-turns: unknown stage type "${rawType}" — valid types: ${[...STAGE_TYPES_VALID].sort().join(', ')}`,
      );
      continue;
    }
    const parsed = Number.parseInt(rawCount, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(
        `--stage-max-turns: maxTurns must be a positive integer for "${rawType}", got "${rawCount}"`,
      );
      continue;
    }
    overrides.push({ stageType: rawType as StageType, maxTurns: parsed });
  }

  return { overrides, errors };
}

export function applyStageMaxTurnsOverrides(
  pipeline: PipelineTemplate,
  overrides: ReadonlyArray<StageMaxTurnsOverride>,
): { applied: Array<{ stageName: string; stageType: StageType; maxTurns: number }> } {
  const applied: Array<{ stageName: string; stageType: StageType; maxTurns: number }> = [];
  if (overrides.length === 0) {
    return { applied };
  }

  const byType = new Map<StageType, number>();
  for (const override of overrides) {
    byType.set(override.stageType, override.maxTurns);
  }

  const applyToSpec = (spec: ModelSpec | undefined, maxTurns: number): void => {
    if (!spec) return;
    spec.maxTurns = maxTurns;
  };

  for (const stage of pipeline.stages) {
    const override = byType.get(stage.type);
    if (override == null) continue;
    applyToSpec(stage.model.primary, override);
    applyToSpec(stage.model.fallback, override);
    if (stage.model.layered) {
      for (const layer of stage.model.layered) {
        applyToSpec(layer, override);
      }
    }
    applied.push({ stageName: stage.name, stageType: stage.type, maxTurns: override });
  }

  return { applied };
}
