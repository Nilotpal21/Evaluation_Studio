/**
 * Dual-Mode Expression Evaluator
 *
 * Supports both legacy ABL expression syntax and new CEL syntax.
 * Auto-detects format and routes to the appropriate evaluator.
 *
 * During the ABL-to-CEL transition, both formats are accepted:
 * - Legacy: `age >= 18 AND UPPER(name) == "JOHN"`
 * - CEL:    `age >= 18 && abl.upper(name) == "JOHN"`
 *
 * Strategy:
 * 1. Detect whether expression uses legacy ABL syntax (via `isLegacyExpression`)
 * 2. If legacy, migrate to CEL via `migrateExpression`
 * 3. Preprocess `has(bareIdent)` patterns that CEL cannot handle
 * 4. Evaluate with CEL evaluator
 * 5. On CEL failure, fall back to legacy evaluator
 *
 * ## `has()` Handling
 *
 * CEL's `has()` macro only works with member access: `has(obj.field)`.
 * The expression migrator converts `name IS SET` to `has(name)`, which
 * fails in CEL for bare identifiers (no dot). This module preprocesses
 * those cases:
 * - `has(bareIdent)`  -> `bareIdent != null`
 * - `!has(bareIdent)` -> `bareIdent == null`
 * - `has(obj.field)`  is left unchanged (valid CEL)
 */

import { isLegacyExpression, migrateExpression } from './expression-migrator.js';
import { evaluateCel, evaluateCelCondition } from './cel-evaluator.js';
import {
  evaluateCondition as legacyEvaluateCondition,
  evaluateConditionDetailed as legacyEvaluateConditionDetailed,
  resolveValue as legacyResolveValue,
  splitByOperator,
} from './evaluator.js';
import type { ConditionEvalDetail } from './evaluator.js';

export type { ConditionEvalDetail };

import { createLogger } from '../logger.js';

type EvaluationContext = Record<string, unknown>;

const log = createLogger('dual-evaluator');

/**
 * CEL evaluation counters for observability.
 * Used to track migration progress and decide when to deprecate the legacy evaluator.
 *
 * These are process-local counters. In production, they should be exported
 * to a metrics system (Prometheus, OpenTelemetry) via periodic scraping.
 */
export const celMetrics = {
  /** CEL evaluation succeeded without fallback */
  celSuccess: 0,
  /** CEL evaluation failed, fell back to legacy */
  celFallback: 0,
  /** Null injection occurred (identifiers injected) */
  nullInjections: 0,
  /** Reset counters (for testing) */
  reset() {
    this.celSuccess = 0;
    this.celFallback = 0;
    this.nullInjections = 0;
  },
};

/**
 * Preprocess CEL expression to handle `has(bareIdentifier)` which CEL doesn't support.
 *
 * CEL's `has()` macro requires member access syntax: `has(obj.field)`.
 * Bare identifiers like `has(name)` are not valid CEL. This function
 * replaces:
 * - `!has(simpleIdent)` -> `simpleIdent == null`
 * - `has(simpleIdent)`  -> `simpleIdent != null`
 *
 * Dotted paths like `has(ctx.name)` are left unchanged since they are
 * valid CEL member access.
 */
function preprocessHas(expr: string): string {
  // Replace !has(bareIdent) -> bareIdent == null
  // Only match simple identifiers (word chars, no dots)
  let result = expr.replace(/!\s*has\((\w+)\)/g, '$1 == null');
  // Replace has(bareIdent) -> bareIdent != null
  // Only match simple identifiers without dots (dotted paths are valid CEL has())
  result = result.replace(/has\((\w+)\)/g, '$1 != null');
  return result;
}

/**
 * CEL reserved words and built-in identifiers that must NOT be injected
 * as null when missing from context. Prevents shadowing CEL language constructs.
 */
const CEL_RESERVED = new Set([
  // CEL reserved words
  'true',
  'false',
  'null',
  'in',
  'this',
  // CEL standard functions / types
  'size',
  'has',
  'type',
  'int',
  'uint',
  'double',
  'string',
  'bool',
  'bytes',
  'list',
  'map',
  'duration',
  'timestamp',
  // CEL string methods (not bare identifiers, but safe to exclude)
  'matches',
  'contains',
  'startsWith',
  'endsWith',
  // ABL namespace prefix
  'abl',
  // CEL macros
  'all',
  'exists',
  'exists_one',
  'filter',
]);

/**
 * Strip quoted strings from expression before identifier extraction.
 * Prevents matching identifiers inside string literals.
 */
function stripQuotedStrings(expr: string): string {
  return expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/**
 * Inject null for identifiers referenced in the expression but absent
 * from the context. Allows CEL to evaluate `name != null` natively
 * instead of throwing "Unknown variable" and falling back to legacy.
 *
 * Only injects for bare identifiers (not CEL keywords, not function names).
 * Uses lazy clone: no allocation when all identifiers are present.
 *
 * @returns The original context if no injection needed, or a shallow clone with nulls added.
 */
function injectMissingAsNull(
  expr: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripQuotedStrings(expr);
  const identifiers = stripped.match(/\b[a-zA-Z_]\w*\b/g);
  if (!identifiers) return context;

  let augmented: Record<string, unknown> | null = null;

  for (const id of identifiers) {
    if (!(id in context) && !CEL_RESERVED.has(id)) {
      if (!augmented) augmented = { ...context };
      augmented[id] = null;
    }
  }

  if (augmented) {
    celMetrics.nullInjections++;
    const injected = Object.keys(augmented).filter((k) => !(k in context));
    if (injected.length > 0) {
      log.debug('Injected null for missing identifiers', {
        injectedCount: injected.length,
        identifiers: injected.slice(0, 10),
        expression: expr.slice(0, 100),
      });
    }
  }

  return augmented ?? context;
}

/**
 * Evaluate a condition supporting both ABL and CEL syntax.
 *
 * Strategy:
 * 1. If legacy ABL syntax, migrate to CEL via `migrateExpression`
 * 2. Preprocess `has()` for bare identifiers
 * 3. Evaluate with CEL evaluator
 * 4. If CEL fails, fall back to legacy evaluator
 *
 * @param expression - The condition expression (legacy ABL or CEL)
 * @param context - The context object containing variable values
 * @returns boolean result of the condition evaluation
 *
 * @example
 * // Legacy ABL
 * evaluateConditionDual('age >= 18 AND name != ""', { age: 25, name: 'John' }) // true
 *
 * @example
 * // CEL
 * evaluateConditionDual('age >= 18 && name != ""', { age: 25, name: 'John' }) // true
 *
 * @example
 * // Legacy IS SET (migrated and preprocessed)
 * evaluateConditionDual('name IS SET', { name: 'John' }) // true
 */
export function evaluateConditionDual(expression: string, context: EvaluationContext): boolean {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;
  const preprocessed = preprocessHas(celExpr);

  try {
    const augmentedContext = injectMissingAsNull(preprocessed, context);
    const result = evaluateCelCondition(preprocessed, augmentedContext);
    celMetrics.celSuccess++;
    return result;
  } catch (err) {
    celMetrics.celFallback++;
    // Fallback to legacy evaluator for expressions CEL cannot handle.
    log.debug('CEL evaluation failed, falling back to legacy', {
      expression: expression.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    // Temporary: trace caller for unresolvable dotted-path expressions
    if (expression.includes('wants_human') || expression.includes('session_ended')) {
      log.warn('TRACE: evaluateConditionDual caller for dotted-path expression', {
        expression: expression.slice(0, 200),
        stack: new Error().stack?.split('\n').slice(1, 6).join(' | '),
      });
    }
    return legacyEvaluateCondition(expression, context);
  }
}

/**
 * Evaluate a condition and return a structured ConditionEvalDetail for tracing.
 *
 * Uses CEL-first evaluation (via evaluateConditionDual/resolveValueDual) for
 * boolean results and value resolution, but performs structural parsing to
 * produce rich trace metadata (conditionType, operator, leftValue, rightValue).
 *
 * Supports: compound AND/OR, variable comparison, contains, IS SET/IS NOT SET,
 * regex matches, and a fallback for complex expressions.
 *
 * The `input` parameter is merged into `context` as `context.input` for
 * compatibility with the 3-arg signature used by callers (e.g. evaluateOnInput).
 */
export function evaluateConditionDetailedDual(
  condition: string,
  input: string,
  context: EvaluationContext,
): ConditionEvalDetail {
  const mergedContext: EvaluationContext = { ...context, input };

  // Helper: propagate regex capture groups back to original context
  const propagateMatch = () => {
    if (mergedContext['match']) context['match'] = mergedContext['match'];
  };

  const cond = condition.trim();

  // --- Compound AND ---
  if (cond.includes(' AND ') || cond.includes(' && ')) {
    const op = cond.includes(' AND ') ? ' AND ' : ' && ';
    const parts = splitByOperator(cond, op);
    if (parts.length > 1) {
      const results = parts.map((p) => evaluateConditionDetailedDual(p.trim(), input, context));
      const allMatched = evaluateConditionDual(cond, mergedContext);
      return {
        matched: allMatched,
        conditionType: 'compound_and',
        leftValue: input,
        operator: 'AND',
        rightValue: parts,
        explanation: `(${results.map((r) => r.explanation).join(' AND ')}) = ${allMatched}`,
      };
    }
  }

  // --- Compound OR ---
  if (cond.includes(' OR ') || cond.includes(' || ')) {
    const op = cond.includes(' OR ') ? ' OR ' : ' || ';
    const parts = splitByOperator(cond, op);
    if (parts.length > 1) {
      const results = parts.map((p) => evaluateConditionDetailedDual(p.trim(), input, context));
      const anyMatched = evaluateConditionDual(cond, mergedContext);
      return {
        matched: anyMatched,
        conditionType: 'compound_or',
        leftValue: input,
        operator: 'OR',
        rightValue: parts,
        explanation: `(${results.map((r) => r.explanation).join(' OR ')}) = ${anyMatched}`,
      };
    }
  }

  // --- IS SET / IS NOT SET ---
  if (cond.endsWith(' IS NOT SET') || cond.endsWith(' IS SET')) {
    const isNotSet = cond.endsWith(' IS NOT SET');
    const path = cond.slice(0, isNotSet ? -' IS NOT SET'.length : -' IS SET'.length).trim();
    const value = resolveValueDual(path, mergedContext);
    const matched = evaluateConditionDual(cond, mergedContext);
    return {
      matched,
      conditionType: isNotSet ? 'is_not_set' : 'is_set',
      leftValue: value,
      operator: isNotSet ? 'IS NOT SET' : 'IS SET',
      rightValue: null,
      explanation: `${path}(=${JSON.stringify(value)}) ${isNotSet ? 'IS NOT SET' : 'IS SET'} → ${matched}`,
    };
  }

  // --- Variable comparison: var op value ---
  const varMatch = cond.match(/^(\w+(?:\.\w+)*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (varMatch) {
    const [, varPath, op, valueStr] = varMatch;
    const leftValue = resolveValueDual(varPath, mergedContext);
    const rightValue = resolveValueDual(valueStr.trim(), mergedContext);
    const matched = evaluateConditionDual(cond, mergedContext);
    return {
      matched,
      conditionType: 'variable_comparison',
      leftValue,
      operator: op,
      rightValue,
      explanation: `${varPath}(=${JSON.stringify(leftValue)}) ${op} ${JSON.stringify(rightValue)} → ${matched}`,
    };
  }

  // --- Contains ---
  const containsMatch = cond.match(/^(\w+(?:\.\w+)*)\s+contains\s+(.+)$/i);
  if (containsMatch) {
    const leftValue = resolveValueDual(containsMatch[1].trim(), mergedContext);
    const rightValue = resolveValueDual(containsMatch[2].trim(), mergedContext);
    const matched = evaluateConditionDual(cond, mergedContext);
    return {
      matched,
      conditionType: 'contains',
      leftValue,
      operator: 'contains',
      rightValue,
      explanation: `${JSON.stringify(leftValue)} ${matched ? 'contains' : 'does not contain'} ${JSON.stringify(rightValue)}`,
    };
  }

  // --- Regex matches: input matches "pattern" ---
  const matchesMatch = cond.match(/^(\w+(?:\.\w+)*)\s+matches\s+(.+)$/i);
  if (matchesMatch) {
    const leftValue = resolveValueDual(matchesMatch[1].trim(), mergedContext);
    const rightValue = resolveValueDual(matchesMatch[2].trim(), mergedContext);
    const matched = evaluateConditionDual(cond, mergedContext);
    if (matched) propagateMatch();
    return {
      matched,
      conditionType: 'matches',
      leftValue,
      operator: 'matches',
      rightValue,
      explanation: `${JSON.stringify(leftValue)} ${matched ? 'matches' : 'does not match'} ${JSON.stringify(rightValue)}`,
    };
  }

  // --- Fallback: evaluate with dual, return generic detail ---
  const matched = evaluateConditionDual(cond, mergedContext);
  if (matched) propagateMatch();
  return {
    matched,
    conditionType: 'other',
    leftValue: input,
    operator: 'eval',
    rightValue: condition,
    explanation: `Condition "${condition}" evaluated to ${matched}`,
  };
}

/**
 * Resolve a value expression supporting both ABL and CEL syntax.
 *
 * Strategy:
 * 1. If legacy ABL syntax, migrate to CEL via `migrateExpression`
 * 2. Preprocess `has()` for bare identifiers
 * 3. Evaluate with CEL evaluator
 * 4. If CEL fails, fall back to legacy `resolveValue`
 *
 * @param expression - The value expression (legacy ABL or CEL)
 * @param context - The context object containing variable values
 * @returns The resolved value
 *
 * @example
 * // Legacy ABL function
 * resolveValueDual('UPPER(name)', { name: 'John' }) // 'JOHN'
 *
 * @example
 * // CEL expression
 * resolveValueDual('abl.upper(name)', { name: 'John' }) // 'JOHN'
 */
export function resolveValueDual(expression: string, context: EvaluationContext): unknown {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;
  const preprocessed = preprocessHas(celExpr);

  try {
    const augmentedContext = injectMissingAsNull(preprocessed, context);
    const result = evaluateCel(preprocessed, augmentedContext);
    celMetrics.celSuccess++;
    return result;
  } catch (err) {
    celMetrics.celFallback++;
    // Fallback to legacy resolveValue for expressions CEL cannot handle.
    log.debug('CEL value resolution failed, falling back to legacy', {
      expression: expression.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return legacyResolveValue(expression, context);
  }
}
