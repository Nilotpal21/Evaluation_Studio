/**
 * Workflow Memory Constants (FR-20)
 *
 * Per-write quota ceilings, TTL ceiling, and reserved-prefix list shared by:
 * - The runtime memory route (`/api/internal/memory`) — enforces quotas + TTL clamp
 * - `MongoDBFactStore._setInternal` — deep guard for the `wf:` reserved prefix
 * - `FactStoreWorkflowAdapter` — translates `key → wf:<workflowId>:<key>`
 *
 * D-7: TTL ceiling lives at the route layer (NOT fact-store) so the generic
 * fact-store stays ceiling-unaware. The fact-store only enforces the
 * reserved-prefix guard.
 */

/** Maximum TTL applied to any workflow memory fact (1 year). */
export const MAX_FACT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Maximum byte length of a JSON-serialized fact value (64 KiB). */
export const MAX_VALUE_SIZE_BYTES = 64 * 1024;

/** Maximum byte length of a fact key. */
export const MAX_KEY_LENGTH = 256;

/** Maximum number of writes per workflow run. */
export const MAX_WRITES_PER_RUN = 100;

/** Reserved key prefixes — workflow author writes that match are rejected. */
export const RESERVED_KEY_PREFIXES: readonly string[] = ['wf:', '_meta:', '_system:', '_audit:'];

/** Workflow-scope prefix marker. Translated by `FactStoreWorkflowAdapter`. */
export const WORKFLOW_KEY_PREFIX = 'wf:';

/**
 * Build the workflow-scope storage key for a given workflowId + author key.
 * The translated key is the value persisted in MongoDB.
 */
export function buildWorkflowKey(workflowId: string, key: string): string {
  return `${WORKFLOW_KEY_PREFIX}${workflowId}:${key}`;
}

/**
 * Returns true when the supplied key starts with any reserved prefix.
 * Used by the route layer (rejects author writes) and by the deep guard
 * in `MongoDBFactStore._setInternal`.
 */
export function startsWithReservedPrefix(key: string): boolean {
  return RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p));
}
