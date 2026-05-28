/**
 * CEL (Common Expression Language) Evaluator
 *
 * Wraps @marcbachmann/cel-js to provide the same evaluation interface
 * as the legacy ABL expression evaluator. CEL is an industry standard
 * used in Kubernetes, Firebase, and Envoy.
 *
 * Design notes:
 * - CEL integer literals produce BigInt values (e.g., `42` -> `42n`).
 *   This wrapper normalizes BigInt results to regular JS numbers when safe
 *   (within Number.MAX_SAFE_INTEGER range) so downstream ABL code doesn't
 *   need to handle BigInt.
 * - CEL's `has()` macro requires member access syntax: `has(obj.field)`,
 *   not bare identifiers like `has(name)`. This matches the CEL spec.
 * - Context values passed as JS numbers are treated as `double` by CEL.
 *   Avoid mixing context numbers with integer literals in arithmetic
 *   (e.g., `price + 10` fails; use `price + 10.0` or pass 10 via context).
 * - ABL custom functions are available under the `abl` namespace:
 *   e.g., `abl.upper(name)`, `abl.mask(ssn, "last4")`, `abl.round(price, 2)`.
 *   See cel-functions.ts for the full list of 35 registered functions.
 */

import { getAblCelEnvironment } from './cel-functions.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

/** Maximum expression length accepted for CEL evaluation (bytes). */
const MAX_EXPRESSION_LENGTH = 4096;

/**
 * Recursively normalize BigInt values to regular JS numbers.
 * Values outside Number.MAX_SAFE_INTEGER range are left as BigInt.
 */
function normalizeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
      return Number(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeBigInts);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizeBigInts(v);
    }
    return result;
  }
  return value;
}

/**
 * Evaluate a CEL expression and return the result.
 * Used for value resolution (SET assignments, computed values).
 *
 * The expression is evaluated in the shared ABL CEL environment which provides
 * 35 custom functions under the `abl` namespace (e.g., `abl.upper(name)`).
 * BigInt results are automatically normalized to JS numbers when safe.
 */
export interface EvaluateCelOptions {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

export function evaluateCel(
  expression: string,
  context: Record<string, unknown>,
  options?: EvaluateCelOptions,
): unknown {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(
      `CEL expression exceeds maximum length (${expression.length} > ${MAX_EXPRESSION_LENGTH})`,
    );
  }
  try {
    const result = getAblCelEnvironment({
      piiRecognizerRegistry: options?.piiRecognizerRegistry,
    }).evaluate(expression, context);
    return normalizeBigInts(result);
  } catch (err) {
    const truncated = expression.length > 100 ? expression.slice(0, 100) + '...' : expression;
    throw new Error(
      `CEL evaluation failed for "${truncated}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Evaluate a CEL expression as a boolean condition.
 * Used for constraint conditions, flow branching, completion checks.
 */
export function evaluateCelCondition(
  expression: string,
  context: Record<string, unknown>,
  options?: EvaluateCelOptions,
): boolean {
  const result = evaluateCel(expression, context, options);
  return Boolean(result);
}
