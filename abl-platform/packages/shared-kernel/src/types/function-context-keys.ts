/**
 * Function-node context: reserved top-level keys.
 *
 * Top-level identifiers on a function-node `context` proxy whose ASSIGNMENT
 * the workflow-engine blocks at execution time. User code can READ these
 * (e.g. `context.trigger.payload.x`) but cannot write to them
 * (`context.trigger = ...` throws inside the V8 isolate).
 *
 * Split into two policy subsets that the function-executor's Proxy guard
 * distinguishes by error-message prefix:
 *
 *   - IMMUTABLE: structural host projections (trigger payload, steps map,
 *     workflow/tenant metadata). Throws "Cannot overwrite immutable
 *     context property: <key>".
 *   - READONLY: feature projections (agent identity, conversational
 *     context, persistent memory). Throws "Cannot overwrite read-only
 *     context property: <key>".
 *
 * User-facing behaviour is identical: the assignment fails. The split exists
 * so function-executor tests can assert on the error prefix.
 *
 * Studio reads the combined RESERVED set to filter parsed function-output
 * schemas — the Expression Browser must not suggest fields the engine
 * would reject. The workflow-engine reads the two subsets to enforce the
 * write ban inside the V8 isolate's Proxy traps.
 *
 * Keep loop-variable aliases OUT of these static lists. Loop aliases are
 * added per-execution by `getFunctionContextImmutableKeys()` in
 * `apps/workflow-engine/src/context/step-context-schema.ts`, because the
 * alias names come from runtime configuration and aren't statically known.
 */

export const FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS = [
  'trigger',
  'steps',
  'workflow',
  'tenant',
] as const;

export const FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS = [
  'agentSession',
  'agentContext',
  'memory',
] as const;

/**
 * Union of immutable + readonly top-level keys. Use this when the consumer
 * only cares "would the engine reject a write to this key" and doesn't need
 * the error-prefix distinction. Studio's parsed-output-schema filter is the
 * canonical caller.
 */
export const FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS = [
  ...FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS,
  ...FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS,
] as const;

export type FunctionContextImmutableTopLevelKey =
  (typeof FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS)[number];

export type FunctionContextReadonlyTopLevelKey =
  (typeof FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS)[number];

export type FunctionContextReservedTopLevelKey =
  | FunctionContextImmutableTopLevelKey
  | FunctionContextReadonlyTopLevelKey;
