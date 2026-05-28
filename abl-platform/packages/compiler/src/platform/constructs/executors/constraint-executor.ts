/**
 * Constraint Executor
 *
 * Handles CONSTRAINTS construct for guardrails and flat constraints.
 * Supports:
 * - Global guardrails (checked every turn, before constraints)
 * - Flat constraints (all checked every turn — IS SET guards handle partial data)
 * - On-fail actions (respond, escalate, handoff, block)
 */

import type {
  ExecutionContext,
  ConstructResult,
  ConstructAction,
  ConstraintCheckResult,
} from '../types.js';
import {
  continueAction,
  respondAction,
  escalateAction,
  handoffAction,
  blockAction,
} from '../types.js';
import { interpolateMessage } from '../evaluator.js';
import { evaluateConditionDual } from '../dual-evaluator.js';
import type { ConstraintConfig, Guardrail, ConstraintAction } from '../../ir/schema.js';
import { DEFAULT_ESCALATION_TARGET } from '../../constants.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ConstraintOptions {
  /** Skip guardrails */
  skipGuardrails?: boolean;

  /** Skip constraints */
  skipConstraints?: boolean;

  /** Continue even on failure (just record) */
  recordOnly?: boolean;
}

/** Info about a single constraint check (pass or fail) */
export interface ConstraintCheckInfo {
  type: 'guardrail' | 'constraint';
  name?: string;
  condition: string;
  passed: boolean;
  /** True when an IS SET guard caused this constraint to be skipped as "not applicable". */
  guardSkipped: boolean;
  action: ConstraintAction;
  /** 'error' (default) blocks execution; 'warning' emits a warning but continues */
  severity?: 'error' | 'warning';
}

export interface CheckConstraintsCoreOptions {
  /** Callback fired for every constraint check */
  onCheck?: (info: ConstraintCheckInfo) => void;
  /** Expression evaluator function. Defaults to evaluateConditionDual (CEL-first with legacy fallback). */
  evaluateCondition?: (condition: string, context: Record<string, unknown>) => boolean;
  /** If false, check all constraints even after first failure. Default: true. */
  shortCircuit?: boolean;
}

// =============================================================================
// GUARD DETECTION (constraint-layer semantics)
// =============================================================================

/**
 * Split a constraint condition by AND (legacy) or && (CEL), respecting parentheses.
 * Only splits at the top level — nested AND/&& inside parens are preserved.
 */
function splitConstraintByAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) {
      // Check for ' AND ' (legacy)
      if (expr.slice(i, i + 5) === ' AND ') {
        parts.push(current.trim());
        current = '';
        i += 4;
        continue;
      }
      // Check for ' && ' (CEL)
      if (expr.slice(i, i + 4) === ' && ') {
        parts.push(current.trim());
        current = '';
        i += 3;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Pre-compiled patterns for guard expression detection */
const IS_SET_SUFFIX = /\bIS\s+SET$/i;
const HAS_PATTERN = /^has\(.+\)$/;
const NOT_NULL_GUARD_PATTERN = /^([\w.]+)\s*!=\s*null$/;

/**
 * Detect whether a sub-expression is an IS SET / has() guard.
 *
 * A guard is a precondition that checks whether a variable exists.
 * Only positive existence checks are guards:
 * - `varName IS SET`
 * - `has(varName)` / `has(obj.field)`
 * - `varName != null` ONLY when varName also appears in a value assertion
 *
 * IS NOT SET and == null are NOT guards — they are value assertions.
 */
function isGuardExpression(expr: string, assertionIdentifiers?: Set<string>): boolean {
  const trimmed = expr.trim();
  if (IS_SET_SUFFIX.test(trimmed)) return true;
  if (HAS_PATTERN.test(trimmed)) return true;
  if (assertionIdentifiers) {
    const match = trimmed.match(NOT_NULL_GUARD_PATTERN);
    if (match && assertionIdentifiers.has(match[1])) return true;
  }
  return false;
}

/**
 * Extract identifiers (including dotted paths like `user.name`) from an
 * expression for guard cross-referencing.
 */
function extractIdentifiers(expr: string): Set<string> {
  const matches = expr.match(/\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/g);
  return new Set(matches || []);
}

/**
 * Evaluate a constraint condition with IS SET guard semantics.
 *
 * Guard semantics: In AND chains, `IS SET` / `has()` clauses act as
 * preconditions. If any guard fails (variable not set), the constraint
 * is "not applicable" (returns true). Only when all guards pass are
 * the value assertions evaluated.
 *
 * @returns { passed: boolean, guardSkipped: boolean }
 */
function evaluateWithGuardSemantics(
  condition: string,
  context: Record<string, unknown>,
  evaluate: (cond: string, ctx: Record<string, unknown>) => boolean,
): { passed: boolean; guardSkipped: boolean } {
  const trimmed = condition.trim();
  const andParts = splitConstraintByAnd(trimmed);

  if (andParts.length > 1) {
    // First pass: collect all assertion identifiers for cross-referencing
    const potentialAssertions = andParts.filter(
      (p) => !IS_SET_SUFFIX.test(p.trim()) && !HAS_PATTERN.test(p.trim()),
    );
    const assertionIds = new Set<string>();
    for (const a of potentialAssertions) {
      for (const id of extractIdentifiers(a)) assertionIds.add(id);
    }

    const guards: string[] = [];
    const assertions: string[] = [];

    for (const part of andParts) {
      if (isGuardExpression(part, assertionIds)) {
        guards.push(part);
      } else {
        assertions.push(part);
      }
    }

    // Mixed guards + assertions: guards are preconditions
    if (guards.length > 0 && assertions.length > 0) {
      const allGuardsPass = guards.every((g) => evaluate(g, context));
      if (!allGuardsPass) {
        return { passed: true, guardSkipped: true }; // Not applicable
      }
      const assertionsPass = assertions.every((a) => evaluate(a, context));
      return { passed: assertionsPass, guardSkipped: false };
    }
  }

  // No guard pattern: evaluate entire expression directly
  return { passed: evaluate(condition, context), guardSkipped: false };
}

// =============================================================================
// STANDALONE CORE FUNCTION
// =============================================================================

/**
 * Core constraint checking logic — iterate guardrails then constraints,
 * return the first failure or null if all pass.
 *
 * This is the single source of truth used by both ConstraintExecutor
 * and the runtime-executor.
 *
 * Guard semantics (IS SET / has()) are applied at this layer via
 * evaluateWithGuardSemantics. The evaluator function itself (legacy or
 * dual) is injected via options.evaluateCondition.
 */
export function checkConstraintsCore(
  constraintConfig: ConstraintConfig,
  context: Record<string, unknown>,
  options?: CheckConstraintsCoreOptions,
): ConstraintCheckInfo | null {
  const onCheck = options?.onCheck;
  const evaluate = options?.evaluateCondition ?? evaluateConditionDual;
  const shortCircuit = options?.shortCircuit !== false; // default true
  let firstFailure: ConstraintCheckInfo | null = null;

  // Check guardrails first (always active)
  if (constraintConfig.guardrails && constraintConfig.guardrails.length > 0) {
    for (const guardrail of constraintConfig.guardrails) {
      const checkExpr = guardrail.check ?? 'true'; // Default to true if no check (model/llm tiers)
      const { passed: rawPassed, guardSkipped } = evaluateWithGuardSemantics(
        checkExpr,
        context,
        evaluate,
      );
      // Guardrail check semantics: check=true means "violation detected" (same as Tier-1 pipeline).
      // evaluateWithGuardSemantics returns passed=true when the expression is true, but for guardrails
      // that means a violation was detected — so we invert. Guard-skipped constraints are always safe.
      const passed = guardSkipped ? true : !rawPassed;
      // Adapt GuardrailAction to ConstraintAction for backward compat
      const adaptedAction: ConstraintAction = {
        type:
          guardrail.action.type === 'warn'
            ? 'respond'
            : guardrail.action.type === 'fix'
              ? 'respond'
              : guardrail.action.type === 'reask'
                ? 'respond'
                : guardrail.action.type === 'filter'
                  ? 'respond'
                  : (guardrail.action.type as ConstraintAction['type']),
        message: guardrail.action.message,
      };
      const info: ConstraintCheckInfo = {
        type: 'guardrail',
        name: guardrail.name,
        condition: checkExpr,
        passed,
        guardSkipped,
        action: adaptedAction,
      };
      onCheck?.(info);
      if (!passed) {
        if (shortCircuit) return info;
        if (!firstFailure) firstFailure = info;
      }
    }
  }

  // Check constraints (all checked every turn)
  if (constraintConfig.constraints && constraintConfig.constraints.length > 0) {
    for (const constraint of constraintConfig.constraints) {
      const { passed, guardSkipped } = evaluateWithGuardSemantics(
        constraint.condition,
        context,
        evaluate,
      );
      const info: ConstraintCheckInfo = {
        type: 'constraint',
        condition: constraint.condition,
        passed,
        guardSkipped,
        action: constraint.on_fail,
        severity: constraint.severity,
      };
      onCheck?.(info);
      // Warnings are non-blocking — report via onCheck but don't treat as failures
      if (!passed && constraint.severity !== 'warning') {
        if (shortCircuit) return info;
        if (!firstFailure) firstFailure = info;
      }
    }
  }

  return firstFailure;
}

// =============================================================================
// CONSTRAINT EXECUTOR
// =============================================================================

export class ConstraintExecutor {
  /**
   * Execute all constraint checks.
   *
   * In non-recordOnly mode, delegates to checkConstraintsCore for
   * short-circuit-on-first-failure semantics. In recordOnly mode,
   * iterates all checks to collect full results.
   */
  async execute(
    context: ExecutionContext,
    options: ConstraintOptions = {},
  ): Promise<ConstructResult> {
    const { agentIR, state, trace } = context;
    const constraintConfig = agentIR.constraints;

    // Fast path: non-recordOnly delegates to checkConstraintsCore
    if (!options.recordOnly) {
      // Build a filtered config honoring skip options
      const filteredConfig: ConstraintConfig = {
        guardrails: options.skipGuardrails ? [] : constraintConfig.guardrails || [],
        constraints: options.skipConstraints ? [] : constraintConfig.constraints || [],
      };

      const allResults: Record<string, boolean> = {};
      const failure = checkConstraintsCore(filteredConfig, state.context, {
        onCheck: (info) => {
          const key =
            info.type === 'guardrail' ? `guardrail:${info.name}` : `constraint:${info.condition}`;
          allResults[key] = info.passed;
          // Fire-and-forget: checkConstraintsCore calls onCheck synchronously,
          // so the returned promise is not awaited. Trace is best-effort.
          trace.logConstraintCheck(
            key,
            info.passed,
            info.type === 'guardrail'
              ? {
                  description: constraintConfig.guardrails?.find((g) => g.name === info.name)
                    ?.description,
                }
              : {},
          );
        },
      });

      if (failure) {
        const action = this.convertConstraintAction(failure.action, state.context);
        if (failure.type === 'guardrail') {
          return {
            action,
            stateUpdates: { constraintResults: allResults },
            metadata: {
              failedGuardrail: failure.name,
              failedAt: 'guardrail',
            },
          };
        } else {
          return {
            action,
            stateUpdates: { constraintResults: allResults },
            metadata: {
              failedConstraint: failure.condition,
            },
          };
        }
      }

      return {
        action: continueAction(),
        stateUpdates: { constraintResults: allResults },
        metadata: {
          checksPerformed: Object.keys(allResults).length,
          failures: 0,
        },
      };
    }

    // recordOnly path: collect all results without short-circuiting
    const allResults: Record<string, boolean> = {};
    const failures: Array<{
      constraint: string;
      action: ConstructAction;
    }> = [];

    const filteredConfig: ConstraintConfig = {
      guardrails: options.skipGuardrails ? [] : constraintConfig.guardrails || [],
      constraints: options.skipConstraints ? [] : constraintConfig.constraints || [],
    };

    checkConstraintsCore(filteredConfig, state.context, {
      shortCircuit: false,
      onCheck: (info) => {
        const key =
          info.type === 'guardrail' ? `guardrail:${info.name}` : `constraint:${info.condition}`;
        allResults[key] = info.passed;
        // Note: trace.logConstraintCheck is async but we don't await in the sync callback.
        // The trace is best-effort for recordOnly mode.
        trace.logConstraintCheck(
          key,
          info.passed,
          info.type === 'guardrail'
            ? {
                description: constraintConfig.guardrails?.find((g) => g.name === info.name)
                  ?.description,
              }
            : {},
        );
        if (!info.passed) {
          failures.push({
            constraint: info.type === 'guardrail' ? info.name || info.condition : info.condition,
            action: this.convertConstraintAction(info.action, state.context),
          });
        }
      },
    });

    return {
      action: failures.length > 0 ? failures[0].action : continueAction(),
      stateUpdates: { constraintResults: allResults },
      metadata: {
        checksPerformed: Object.keys(allResults).length,
        failures: failures.length,
        failureDetails: failures.length > 0 ? failures : undefined,
      },
    };
  }

  /**
   * Check only guardrails
   */
  async checkGuardrails(context: ExecutionContext): Promise<ConstraintCheckResult> {
    const result = await this.execute(context, { skipConstraints: true, recordOnly: true });

    const passed = result.metadata?.failures === 0;
    const failures =
      (result.metadata?.failureDetails as Array<{
        constraint: string;
        action: ConstructAction;
      }>) || [];

    return {
      passed,
      failures,
      results: result.stateUpdates?.constraintResults || {},
    };
  }

  /**
   * Convert IR constraint action to ConstructAction
   */
  private convertConstraintAction(
    irAction: ConstraintAction,
    context: Record<string, unknown>,
  ): ConstructAction {
    const message = irAction.message ? interpolateMessage(irAction.message, context) : undefined;

    const irMessages = (context as Record<string, unknown>)?._agentMessages as
      | Record<string, string>
      | undefined;
    const defaultBlockedMsg =
      irMessages?.constraint_blocked || 'I cannot proceed with that request.';

    switch (irAction.type) {
      case 'respond':
        return respondAction(message || defaultBlockedMsg, false);

      case 'escalate':
        return escalateAction(irAction.reason || 'Constraint violation', 'high', context);

      case 'handoff':
        return handoffAction(
          irAction.target || DEFAULT_ESCALATION_TARGET,
          context,
          false,
          irAction.reason,
        );

      case 'block':
        return blockAction(irAction.reason || 'Action blocked by constraint', irAction.message);

      case 'redact':
        return respondAction(message || defaultBlockedMsg, false);

      default:
        return blockAction('Unknown constraint action');
    }
  }
}
