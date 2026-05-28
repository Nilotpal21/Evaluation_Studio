import { BUILTIN_FIELD_REFERENCE_VARS } from '../contract-source-data.js';
import type { CelContext } from './types.js';

/**
 * Per-context CEL variable allowlist (Option gamma from Arch v5 design).
 *
 * The current compiler validator builds one global knownVars set per agent.
 * Until validator-level context partitioning exists, this registry is the
 * compiler-owned grammar Arch AI can query for context-specific proposals.
 */
export const PER_CONTEXT_CEL_ALLOWLIST: Record<CelContext, readonly string[]> = {
  handoff_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  delegate_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  flow_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  complete_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  constraint_condition: [...BUILTIN_FIELD_REFERENCE_VARS],
  guardrail_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  routing_rule_when: [...BUILTIN_FIELD_REFERENCE_VARS],
  recall_condition: [...BUILTIN_FIELD_REFERENCE_VARS],
  digression_condition: [...BUILTIN_FIELD_REFERENCE_VARS],
};

export function unionAllContexts(): Set<string> {
  const union = new Set<string>();
  for (const vars of Object.values(PER_CONTEXT_CEL_ALLOWLIST)) {
    for (const variable of vars) {
      union.add(variable);
    }
  }
  return union;
}
