/**
 * Completion Detector
 *
 * Evaluates COMPLETE WHEN conditions from the agent IR against the current
 * session context. Returns a result indicating whether the session should
 * complete and which condition matched.
 *
 * This is a pure function of (AgentIR, context) — no side effects.
 * The runtime is responsible for acting on the result (marking session
 * complete, emitting traces, interpolating messages, executing STORE).
 */

import { evaluateConditionDual } from '../dual-evaluator.js';
import type { AgentIR, CompletionCondition } from '../../ir/schema.js';

// =============================================================================
// TYPES
// =============================================================================

/** Result of checking a single completion condition */
export interface CompletionCheckResult {
  condition: string;
  passed: boolean;
}

/** Options for the completion check */
export interface CompletionCheckOptions {
  /** Callback fired for each condition evaluated */
  onCheck?: (info: CompletionCheckResult) => void;
  /** Custom condition evaluator (defaults to evaluateConditionDual) */
  evaluateCondition?: (condition: string, context: Record<string, unknown>) => boolean;
}

/** Result of the overall completion detection */
export interface CompletionDetectionResult {
  /** Whether the session should complete */
  shouldComplete: boolean;
  /** The condition that matched (if any) */
  matchedCondition?: CompletionCondition;
}

// =============================================================================
// COMPLETION DETECTOR
// =============================================================================

export class CompletionDetector {
  /**
   * Check all COMPLETE WHEN conditions against the given context.
   * Returns on the first matching condition (first-match-wins semantics).
   */
  check(
    agentIR: AgentIR,
    context: Record<string, unknown>,
    options?: CompletionCheckOptions,
  ): CompletionDetectionResult {
    const conditions = agentIR.completion?.conditions;
    if (!conditions || conditions.length === 0) {
      return { shouldComplete: false };
    }

    const evaluate = options?.evaluateCondition ?? evaluateConditionDual;

    for (const condition of conditions) {
      const passed = evaluate(condition.when, context);

      if (options?.onCheck) {
        options.onCheck({ condition: condition.when, passed });
      }

      if (passed) {
        return {
          shouldComplete: true,
          matchedCondition: condition,
        };
      }
    }

    return { shouldComplete: false };
  }
}
