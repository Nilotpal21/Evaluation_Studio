/**
 * Condition Step Executor
 *
 * Evaluates a boolean expression and executes either the `then` or `else` branch.
 * Supports two expression formats:
 *   1. Operator expressions: `{{path}} operator value` (from canvas condition UI)
 *   2. Simple expressions: `{{path}}` (evaluated via JavaScript truthiness)
 *
 * Returns expression traces for debugging.
 */

import {
  resolveExpressionWithTrace,
  type ExpressionTrace,
} from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';

/** A single branch in a multi-condition node (If / Else If). */
export interface ConditionBranch {
  id: string;
  expression: string;
  targetSteps: string[];
}

export interface ConditionStep {
  id: string;
  type: 'condition';
  expression: string;
  thenSteps: string[];
  elseSteps?: string[];
  /** Ordered list of condition branches for multi-condition (If / Else If) nodes. */
  conditions?: ConditionBranch[];
  /** Set by canvas-to-steps to indicate this condition came from the canvas editor */
  canvasRouted?: boolean;
}

/** Per-condition evaluation detail for multi-condition nodes. */
export interface EvaluatedCondition {
  id: string;
  expression: string;
  result: boolean;
  traces: ExpressionTrace[];
}

export interface ConditionResult {
  conditionMet: boolean;
  nextSteps: string[];
  traces: ExpressionTrace[];
  /** Which branch was taken — 'then'/'else' for legacy, or the condition id (e.g. 'if_0') for multi-condition */
  branchTaken: string;
  /** The matched condition's expression (multi-condition), or the step expression (legacy) */
  expression?: string;
  /** Per-condition evaluation details — present only in multi-condition mode */
  evaluatedConditions?: EvaluatedCondition[];
}

const SUPPORTED_OPERATORS = new Set([
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'matches_regex',
]);

/** Maximum allowed regex pattern length to mitigate ReDoS */
const MAX_REGEX_LENGTH = 256;

/**
 * Detect common ReDoS-prone patterns: nested quantifiers like (a+)+, (a*)*,
 * (a+|b)+ and overlapping alternations. This is a heuristic, not exhaustive.
 */
const REDOS_PATTERN = /(\+|\*|\{)\)(\+|\*|\{)|(\(.*\|.*\))(\+|\*|\{)/;

function isSafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  if (REDOS_PATTERN.test(pattern)) return false;
  return true;
}

/**
 * Pattern to detect operator-based expressions from the canvas condition UI.
 * Format: `{{field}} operator [value]`
 * The value is optional for is_empty/is_not_empty operators.
 */
const OPERATOR_EXPRESSION_PATTERN = /^(\{\{.+?\}\})\s+(\S+?)(?:\s+(.*))?$/;

/**
 * Parse a comparison value string to its typed representation.
 * "2" → 2, "true" → true, "null" → null, etc.
 */
function parseCompareValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (raw === '') return '';
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return num;
  return raw;
}

/**
 * Apply a comparison operator to a resolved field value and a compare value.
 */
function applyOperator(fieldValue: unknown, operator: string, compareValue: unknown): boolean {
  switch (operator) {
    case 'equals':
      // eslint-disable-next-line eqeqeq
      return fieldValue == compareValue;
    case 'not_equals':
      // eslint-disable-next-line eqeqeq
      return fieldValue != compareValue;
    case 'greater_than':
      return Number(fieldValue) > Number(compareValue);
    case 'less_than':
      return Number(fieldValue) < Number(compareValue);
    case 'contains':
      return String(fieldValue ?? '').includes(String(compareValue));
    case 'not_contains':
      return !String(fieldValue ?? '').includes(String(compareValue));
    case 'is_empty':
      return (
        fieldValue == null ||
        fieldValue === '' ||
        (Array.isArray(fieldValue) && fieldValue.length === 0)
      );
    case 'is_not_empty':
      return (
        fieldValue != null &&
        fieldValue !== '' &&
        !(Array.isArray(fieldValue) && fieldValue.length === 0)
      );
    case 'matches_regex':
      try {
        const pattern = String(compareValue);
        if (!isSafeRegex(pattern)) return false;
        return new RegExp(pattern).test(String(fieldValue ?? ''));
      } catch {
        return false;
      }
    default:
      return Boolean(fieldValue);
  }
}

/**
 * Evaluate a single expression string and return whether it is met plus traces.
 */
function evaluateSingleExpression(
  expression: string,
  ctx: WorkflowContextData,
): { conditionMet: boolean; traces: ExpressionTrace[] } {
  const trimmed = (expression ?? '').trim();

  // Try to parse as an operator expression: {{field}} operator [value]
  const operatorMatch = OPERATOR_EXPRESSION_PATTERN.exec(trimmed);
  if (operatorMatch && SUPPORTED_OPERATORS.has(operatorMatch[2])) {
    const fieldTemplate = operatorMatch[1];
    const operator = operatorMatch[2];
    const rawCompareValue = operatorMatch[3] ?? '';

    const { value: fieldValue, traces } = resolveExpressionWithTrace(fieldTemplate, ctx);
    const compareValue = parseCompareValue(rawCompareValue);
    const conditionMet = applyOperator(fieldValue, operator, compareValue);

    return { conditionMet, traces };
  }

  // Fall back to simple boolean evaluation
  const { value, traces } = resolveExpressionWithTrace(trimmed, ctx);
  return { conditionMet: Boolean(value), traces };
}

/**
 * Evaluate a condition step and return which branch to execute.
 *
 * **Multi-condition mode** (If / Else If / Else):
 *   When `step.conditions` is present, evaluates each condition in order.
 *   The first condition whose expression is truthy wins — its `targetSteps`
 *   become `nextSteps`. If no condition matches, falls through to `elseSteps`.
 *
 * **Legacy single-expression mode**:
 *   Evaluates `step.expression` and routes to `thenSteps` or `elseSteps`.
 *
 * For operator expressions (`{{path}} greater_than 5`):
 *   - Resolves the field expression to its typed value
 *   - Applies the operator with proper type coercion
 *
 * For simple expressions (`{{path}}`):
 *   - Truthy evaluation follows JavaScript semantics
 *   - `false`, `0`, `""`, `null`, `undefined` → falsy
 *   - Everything else → truthy
 *
 * Also returns expression traces showing what each {{path}} resolved to.
 */
export function evaluateCondition(step: ConditionStep, ctx: WorkflowContextData): ConditionResult {
  // Multi-condition mode: evaluate conditions in order (If → Else If → … → Else)
  if (step.conditions && step.conditions.length > 0) {
    const allTraces: ExpressionTrace[] = [];
    const evaluated: EvaluatedCondition[] = [];

    for (const branch of step.conditions) {
      const { conditionMet, traces } = evaluateSingleExpression(branch.expression, ctx);
      allTraces.push(...traces);
      evaluated.push({
        id: branch.id,
        expression: branch.expression,
        result: conditionMet,
        traces,
      });

      if (conditionMet) {
        // Return only the matched condition's traces and expression
        return {
          conditionMet: true,
          nextSteps: branch.targetSteps,
          traces,
          branchTaken: branch.id,
          expression: branch.expression,
          evaluatedConditions: evaluated,
        };
      }
    }

    // No condition matched — fall through to else; include all traces
    return {
      conditionMet: false,
      nextSteps: step.elseSteps ?? [],
      traces: allTraces,
      branchTaken: 'else',
      evaluatedConditions: evaluated,
    };
  }

  // Legacy single-expression mode
  const { conditionMet, traces } = evaluateSingleExpression(step.expression, ctx);

  return {
    conditionMet,
    nextSteps: conditionMet ? step.thenSteps : (step.elseSteps ?? []),
    traces,
    branchTaken: conditionMet ? 'then' : 'else',
  };
}
