/**
 * Null-safe condition evaluation for deterministic routing.
 *
 * JavaScript coerces `null` to `0` in numeric comparisons, so null-injected
 * missing variables produce wrong results: `null < 80` becomes `0 < 80 -> true`.
 *
 * This module provides `nullSafeEvaluateCondition` which adds `!= null` guards
 * around relational comparisons (`<`, `>`, `<=`, `>=`) involving variables
 * missing from the context. The guard short-circuits to `false` when the
 * variable is null, preventing the JS coercion.
 *
 * Equality (`==`, `!=`), IN, IS SET, and IS NOT SET patterns are unaffected --
 * they handle null correctly.
 *
 * Shared between the pipeline routing-resolver and the legacy routing-executor
 * to ensure consistent null-safety across both routing paths.
 */

import { evaluateConditionDual, extractVariableReferences } from '@abl/compiler';

/**
 * CEL reserved words -- must not be treated as context variables.
 * Mirrors the set in dual-evaluator.ts.
 * Static constant set (MAX_SIZE = 30, immutable after init -- no eviction needed).
 */
const RELATIONAL_GUARD_RESERVED = new Set([
  'true',
  'false',
  'null',
  'in',
  'this',
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
  'matches',
  'contains',
  'startsWith',
  'endsWith',
  'abl',
  'all',
  'exists',
  'exists_one',
  'filter',
  // ABL/CEL logical operators that appear as identifiers after migration
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  'IN',
]);

/**
 * Null-safe condition evaluation for deterministic routing.
 *
 * JavaScript coerces null to 0 in numeric comparisons, so null-injected
 * missing variables produce wrong results: `null < 80` becomes `0 < 80 -> true`.
 *
 * This wrapper adds `!= null` guards around relational comparisons (`<`,
 * `>`, `<=`, `>=`) that involve variables missing from the context. The
 * guard short-circuits to `false` when the variable is null, preventing
 * the JS coercion. Equality (`==`, `!=`), IN, IS SET, and IS NOT SET
 * patterns are unaffected -- they handle null correctly.
 *
 * Example:
 *   expression: `diagnosis.severity == "hardware" OR battery_health_pct < 80`
 *   missing:    battery_health_pct
 *   rewritten:  `diagnosis.severity == "hardware" OR (battery_health_pct != null && battery_health_pct < 80)`
 *   result:     false OR false -> false  (instead of false OR true)
 */
export function nullSafeEvaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const vars = extractVariableReferences(expression);

  // Find variables missing from context (these will be null-injected by the evaluator)
  const missingVars = vars.filter((v) => {
    const topKey = v.split('.')[0];
    return !(topKey in context);
  });

  // No missing variables -- evaluate as-is
  if (missingVars.length === 0) {
    return evaluateConditionDual(expression, context);
  }

  // Strip quoted strings for safe pattern matching (don't modify identifiers inside strings)
  const stripped = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  // Collect missing variables that participate in relational comparisons
  const relationalMissing = new Set<string>();
  for (const v of missingVars) {
    if (RELATIONAL_GUARD_RESERVED.has(v)) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // var <op> operand  OR  operand <op> var
    const pattern = new RegExp(
      `\\b${escaped}\\s*(?:<|>|<=|>=)\\s*(?:\\d|\\w)|(?:\\d|\\w)\\S*\\s*(?:<|>|<=|>=)\\s*${escaped}\\b`,
    );
    if (pattern.test(stripped)) {
      relationalMissing.add(v);
    }
  }

  // No relational comparisons with missing vars -- evaluate as-is
  if (relationalMissing.size === 0) {
    return evaluateConditionDual(expression, context);
  }

  // Rewrite expression: wrap each relational comparison involving a missing
  // variable with a null guard so null doesn't coerce to 0.
  //
  // Pattern: `varName <op> <number_or_ident>` becomes `(varName != null && varName <op> <number_or_ident>)`
  //          `<number_or_ident> <op> varName` becomes `(varName != null && <number_or_ident> <op> varName)`
  let safeExpr = expression;
  for (const v of relationalMissing) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // var on left side of relational operator
    safeExpr = safeExpr.replace(
      new RegExp(
        `\\b(${esc}\\s*(?:<=|>=|<|>)\\s*(?:\\d+(?:\\.\\d+)?|[a-zA-Z_]\\w*(?:\\.\\w+)*))\\b`,
        'g',
      ),
      `(${v} != null && $1)`,
    );

    // var on right side of relational operator
    safeExpr = safeExpr.replace(
      new RegExp(
        `\\b((?:\\d+(?:\\.\\d+)?|[a-zA-Z_]\\w*(?:\\.\\w+)*)\\s*(?:<=|>=|<|>)\\s*${esc})\\b`,
        'g',
      ),
      `(${v} != null && $1)`,
    );
  }

  return evaluateConditionDual(safeExpr, context);
}
