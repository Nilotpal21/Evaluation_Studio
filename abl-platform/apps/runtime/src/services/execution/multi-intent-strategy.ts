/**
 * Multi-Intent Strategy Resolver
 *
 * Pure function that resolves the effective multi-intent handling strategy
 * based on the declared strategy, the agent type, and the relationship
 * between detected intents.
 *
 * The key constraint: `parallel` execution is currently only wired for
 * supervisor agents that can fan out to independent sub-agents. Scripted
 * agents use single-threaded flow execution; reasoning agents go directly
 * to the LLM loop without multi-intent dispatch. Both are downgraded to
 * `sequential` for `parallel` requests.
 *
 * NOTE: Multi-intent detection is currently only invoked from the flow
 * execution path (flow-step-executor.ts). The reasoning path
 * (runtime-executor.ts → reasoning-executor.ts) does not call
 * handleMultiIntent(). This is the current architecture — not a guaranteed
 * product constraint. Future work may wire multi-intent into reasoning agents.
 */

import type {
  MultiIntentStrategy,
  IntentRelationshipType,
} from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Unified agent type for strategy resolution.
 *
 * Derived from IR's `type` ('agent' | 'supervisor') and flow presence:
 * - 'supervisor' — can fan out to sub-agents (parallel-capable)
 * - 'scripted'   — flow-based, single-threaded execution
 * - 'reasoning'  — LLM-driven, single-threaded execution
 */
export type AgentExecutionType = 'supervisor' | 'scripted' | 'reasoning';

// =============================================================================
// STRATEGY RESOLUTION
// =============================================================================

/**
 * Resolve the effective multi-intent strategy given:
 *
 * @param declared     - The strategy declared in the agent's IntentHandlingConfig
 * @param agentType    - The agent's execution type (supervisor | scripted | reasoning)
 * @param relationship - The LLM-assessed relationship between detected intents
 * @returns The effective strategy to use at runtime
 *
 * Rules:
 * 1. `auto` mode — LLM decides based on relationship and agent capabilities:
 *    - independent + supervisor → parallel
 *    - independent + scripted/reasoning → sequential
 *    - dependent → sequential (order matters)
 *    - ambiguous → disambiguate (ask user)
 *
 * 2. `parallel` — only allowed for supervisor agents. Downgraded to sequential
 *    for scripted/reasoning agents (they cannot fan out).
 *
 * 3. `sequential`, `primary_queue`, `disambiguate` — always allowed for any
 *    agent type (safe strategies that don't require fan-out).
 */
export function resolveStrategy(
  declared: MultiIntentStrategy,
  agentType: AgentExecutionType,
  relationship: IntentRelationshipType,
): MultiIntentStrategy {
  // Auto mode: resolve based on relationship and agent capabilities
  if (declared === 'auto') {
    switch (relationship) {
      case 'independent':
        return agentType === 'supervisor' ? 'parallel' : 'sequential';
      case 'dependent':
        return 'sequential';
      case 'ambiguous':
        return 'disambiguate';
    }
  }

  // Parallel is only safe for independent supervisor dispatch. Dependent
  // intents need prior results; ambiguous relationships need user/LLM resolution.
  if (declared === 'parallel') {
    if (relationship === 'dependent') {
      return 'sequential';
    }
    if (relationship === 'ambiguous') {
      return 'disambiguate';
    }
    if (agentType !== 'supervisor') {
      return 'sequential';
    }
  }

  // All other strategies pass through unchanged
  return declared;
}
