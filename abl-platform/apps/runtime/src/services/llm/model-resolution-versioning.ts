import { createHash } from 'node:crypto';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

/**
 * Runtime model/config caches need narrower identities than the full AgentIR.
 *
 * We intentionally split the cache identity into two parts:
 * 1. Request scope: tenant/project/agent/operation/user dimensions that control
 *    which DB rows, credential policies, or operation-level overrides apply.
 * 2. Snapshot fingerprint: versioned inputs that change the resolved model or
 *    merged execution parameters for a fixed scope.
 *
 * Full AgentIR hashes (`SessionService.computeIRHash()`, `session.configHash`)
 * are broader and should stay broader: they represent the whole executable
 * agent shape for session caches and observability. Model resolution must only
 * invalidate when fields it actually reads change.
 *
 * The runtime has two related but distinct cache contracts:
 * - Full model resolution (`ModelResolutionService.resolve`) is credential-aware
 *   and user-scoped, so its cache key includes `userId`.
 * - Reasoning settings resolution (`ModelResolutionService.resolveReasoningSettings`)
 *   is the settings-only contract used by prompt-builder/thinking pre-resolution.
 *   It intentionally excludes `userId` because it stops before user-scoped
 *   credential policy and per-call budget enforcement.
 *
 * If ModelResolutionService starts consulting new fields, add them here and
 * update the tests in `model-resolution-versioning.test.ts`.
 */

type ResolutionAwareExecutionConfig = AgentIR['execution'] & {
  thought_description?: string | null;
};

/**
 * AgentIR.execution paths that currently participate in model resolution.
 *
 * Changes outside this list must not invalidate model-resolution caches unless
 * the resolution pipeline starts reading those fields in the future.
 */
export const MODEL_RESOLUTION_EXECUTION_FIELD_PATHS = [
  'execution.model',
  'execution.operation_models',
  'execution.temperature',
  'execution.max_tokens',
  'execution.reasoning_effort',
  'execution.enable_thinking',
  'execution.thinking_budget',
  'execution.thought_description',
  'execution.compaction_threshold',
] as const;

export interface ModelResolutionScopeInput {
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  operationType: string;
  userId?: string;
}

export interface ModelResolutionSnapshotInput {
  agentIR?: AgentIR;
  settingsVersionId?: string;
  /**
   * Fingerprint the full payload rather than cherry-picking fields so new
   * deployment override parameters automatically participate in invalidation.
   */
  deploymentModelOverride?: object;
}

export interface ModelResolutionCacheKeyInput
  extends ModelResolutionScopeInput, ModelResolutionSnapshotInput {}

export interface ReasoningSettingsScopeInput {
  tenantId?: string;
  projectId?: string;
  agentName?: string;
}

export interface ReasoningSettingsCacheKeyInput
  extends ReasoningSettingsScopeInput, ModelResolutionSnapshotInput {}

function normalizeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSnapshotValue(item));
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        normalized[key] = normalizeSnapshotValue(entry);
      }
    }

    return normalized;
  }

  return value;
}

function hashSnapshotValue(value: unknown): string {
  const normalized = JSON.stringify(normalizeSnapshotValue(value));
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Extract only the AgentIR.execution fields that affect model resolution.
 *
 * This intentionally excludes identity/tools/gather/constraints/flow/routing
 * and other runtime-only config. Behavior profiles currently mutate those
 * areas, not `execution`, so profile-only changes should not churn these
 * caches.
 */
export function getModelResolutionExecutionSnapshot(
  agentIR?: AgentIR,
): Record<string, unknown> | null {
  if (!agentIR) return null;

  const exec = agentIR.execution as ResolutionAwareExecutionConfig;
  return {
    model: exec.model ?? null,
    operation_models: exec.operation_models ?? null,
    temperature: exec.temperature ?? null,
    max_tokens: exec.max_tokens ?? null,
    reasoning_effort: exec.reasoning_effort ?? null,
    enable_thinking: exec.enable_thinking ?? null,
    thinking_budget: exec.thinking_budget ?? null,
    thought_description: exec.thought_description ?? null,
    compaction_threshold: exec.compaction_threshold ?? null,
  };
}

/**
 * Fingerprint the versioned snapshot inputs for model resolution.
 *
 * This hash changes when the resolved model/thinking parameters can change for
 * a fixed request scope. It intentionally ignores request-scope dimensions like
 * tenantId/userId so callers can reason about "what is versioned" separately
 * from "who is asking".
 */
export function buildModelResolutionSnapshotFingerprint(
  input: ModelResolutionSnapshotInput,
): string {
  return hashSnapshotValue({
    settingsVersionId: input.settingsVersionId ?? null,
    deploymentModelOverride: input.deploymentModelOverride ?? null,
    execution: getModelResolutionExecutionSnapshot(input.agentIR),
  });
}

/**
 * Build the request-scope portion of the cache key.
 *
 * `userId` is scope-significant even though it is not snapshot-versioned:
 * credential policy and user-scoped credential availability can change whether
 * a given request can successfully complete resolution.
 */
export function buildModelResolutionScopeKey(input: ModelResolutionScopeInput): string {
  return [
    input.tenantId || '_',
    input.projectId || '_',
    input.agentName || '_',
    input.operationType,
    input.userId || '_',
  ].join('::');
}

/**
 * Full cache key used by resolution caches whose results depend on both
 * request scope and versioned snapshot inputs.
 */
export function buildModelResolutionCacheKey(input: ModelResolutionCacheKeyInput): string {
  return `${buildModelResolutionScopeKey(input)}::${buildModelResolutionSnapshotFingerprint(input)}`;
}

/**
 * Build the scope key for reasoning settings resolution.
 *
 * Unlike full model resolution, this contract intentionally excludes `userId`
 * because prompt-builder only needs the versioned reasoning snapshot. It does
 * not depend on user-scoped credential policy or budget reservation.
 */
export function buildReasoningSettingsScopeKey(input: ReasoningSettingsScopeInput): string {
  return [input.tenantId || '_', input.projectId || '_', input.agentName || '_', 'reasoning'].join(
    '::',
  );
}

/**
 * Cache key for the settings-only reasoning resolution contract.
 */
export function buildReasoningSettingsCacheKey(input: ReasoningSettingsCacheKeyInput): string {
  return `${buildReasoningSettingsScopeKey(input)}::${buildModelResolutionSnapshotFingerprint(input)}`;
}

/**
 * Backwards-compatible alias while call sites migrate to the explicit contract name.
 */
export const buildThinkingResolutionCacheKey = buildReasoningSettingsCacheKey;
