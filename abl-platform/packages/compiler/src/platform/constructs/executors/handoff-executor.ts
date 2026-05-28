/**
 * Handoff Executor
 *
 * Pure decision layer for handoff validation. Evaluates handoff preconditions
 * (self-handoff prevention, cycle detection, target validation, routing
 * configuration checks) without side effects.
 *
 * The runtime is responsible for thread management, LLM wiring, context
 * merging, guardrails, and recursive executeMessage calls. This executor
 * only answers: "Should this handoff proceed, and if not, why?"
 *
 * This is the strangler-pattern replacement for the inline validation logic
 * in RoutingExecutor.handleHandoff(). During shadow mode the runtime calls
 * both this executor and the old path, compares decisions, and logs mismatches.
 */

import type { AgentIR } from '../../ir/schema.js';
import { resolveAllowedHandoffTargets } from './handoff-authority.js';

// =============================================================================
// TYPES
// =============================================================================

/** Minimal thread info needed for handoff validation */
export interface HandoffThreadInfo {
  agentName: string;
}

/** Minimal session info needed for handoff validation */
export interface HandoffSessionInfo {
  handoffStack: string[];
  handoffReturnInfo?: Record<string, boolean>;
  agentIR: AgentIR | null;
}

/** Input for handoff validation */
export interface HandoffInput {
  target: string;
  context?: Record<string, unknown>;
  message?: string;
}

/** Result of handoff validation */
export interface HandoffValidationResult {
  /** Whether the handoff should proceed */
  allowed: boolean;
  /** If disallowed, the reason */
  reason?: string;
  /** The resolved return-expected flag for this target */
  returnExpected?: boolean;
}

// =============================================================================
// HANDOFF EXECUTOR
// =============================================================================

export class HandoffExecutor {
  /**
   * Validate whether a handoff should proceed.
   *
   * Checks (in order):
   * 1. Routing/handoff configuration exists on current agent
   * 2. Self-handoff prevention
   * 3. Cycle detection (A -> B -> A)
   * 4. Target agent exists in registry
   * 5. Target is in the allowed handoff targets (if targets are defined)
   */
  validate(
    currentThread: HandoffThreadInfo,
    session: HandoffSessionInfo,
    input: HandoffInput,
    hasTargetInRegistry: boolean,
  ): HandoffValidationResult {
    const targetAgent = input.target;
    const currentIR = session.agentIR;

    const allowedTargets = resolveAllowedHandoffTargets(currentIR);

    // 1. Check IR-defined handoff authority
    if (allowedTargets.size === 0) {
      return {
        allowed: false,
        reason: `Agent "${currentThread.agentName}" is not configured for handoffs. Only supervisors with routing rules or handoff configuration can hand off to other agents.`,
      };
    }

    // 2. Prevent self-handoff
    if (currentThread.agentName === targetAgent) {
      return {
        allowed: false,
        reason: `Cannot hand off to yourself (${targetAgent}). Either help the user directly or choose a different target.`,
      };
    }

    // 3. Prevent recursion cycles (A -> B -> A)
    if (session.handoffStack.includes(targetAgent)) {
      return {
        allowed: false,
        reason: `Handoff cycle detected: ${[...session.handoffStack, targetAgent].join(' → ')}. Agent "${targetAgent}" is already in the active handoff chain.`,
      };
    }

    // 4. Target agent must exist in registry
    if (!hasTargetInRegistry) {
      return {
        allowed: false,
        reason: `Agent not found: ${targetAgent}`,
      };
    }

    // 5. Validate target is in IR-defined allowed handoff targets (source of truth)
    if (!allowedTargets.has(targetAgent)) {
      return {
        allowed: false,
        reason: `Invalid handoff target: '${targetAgent}' is not in the allowed handoff targets`,
        returnExpected: false,
      };
    }

    // All checks passed
    const returnExpected = allowedTargets.get(targetAgent)?.returnExpected ?? false;
    return {
      allowed: true,
      returnExpected,
    };
  }
}
