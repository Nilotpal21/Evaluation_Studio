/**
 * Condition Evaluator
 *
 * Enhanced condition evaluation with support for:
 * - Basic comparisons (==, !=, >, <, >=, <=)
 * - Logical operators (AND, OR, NOT)
 * - Nested conditions with parentheses
 * - Path expressions (obj.nested.value)
 * - Type coercion
 * - Null/undefined checks
 * - Array operations (contains, isEmpty)
 */

import { createLogger } from '../logger.js';
const log = createLogger('evaluator');

// =============================================================================
// TYPES
// =============================================================================

export type ComparisonOperator =
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matches';
export type LogicalOperator = 'AND' | 'OR' | 'NOT';

export interface ParsedCondition {
  type: 'comparison' | 'logical' | 'unary' | 'literal';
  operator?: ComparisonOperator | LogicalOperator;
  left?: string | ParsedCondition;
  right?: string | ParsedCondition;
  operand?: ParsedCondition;
  value?: boolean;
}

export interface EvaluationContext {
  [key: string]: unknown;
}

// =============================================================================
// MAIN EVALUATOR
// =============================================================================

/**
 * Evaluate a condition string against a context
 *
 * @deprecated Use `evaluateConditionDual` from `dual-evaluator.ts`. Kept as internal fallback.
 *
 * ## Coercion Rules
 *
 * **Equality (==):**
 * - null/undefined == null/undefined → true
 * - string == string → exact match (case-sensitive)
 * - boolean == string → compares `bool` with `str === "true"`
 * - number == number → exact match
 * - number == string → `parseFloat(str)` comparison
 *
 * **Inequality (!=):**
 * - If either side is undefined/null → true (can't compare yet)
 * - If both sides are undefined/null → true (constraint not applicable)
 *
 * **Numeric comparisons (>, <, >=, <=):**
 * - `toNumber()` coerces: number→itself, string→parseFloat, boolean→0/1, array→length
 * - undefined → 0
 *
 * **Truthiness (bare variable):**
 * - null/undefined → false
 * - boolean → itself
 * - number → false if 0
 * - string → false if empty or "false"
 * - array → false if empty
 * - object → false if no keys
 *
 * **IS SET / IS NOT SET:**
 * - Checks for null/undefined only (empty string IS SET)
 *
 * @param condition - The condition expression to evaluate
 * @param context - The context object containing values
 * @returns boolean result of evaluation
 *
 * @example
 * evaluateCondition('user.age >= 18', { user: { age: 21 } }) // true
 * evaluateCondition('status == "active" AND verified == true', { status: 'active', verified: true }) // true
 * evaluateCondition('items.length > 0 OR hasDefault == true', { items: [], hasDefault: true }) // true
 */
export function evaluateCondition(condition: string, context: EvaluationContext): boolean {
  if (!condition || condition.trim() === '') {
    return true; // Empty condition is always true
  }

  try {
    const trimmed = condition.trim();

    // Handle boolean literals
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Handle parentheses
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      // Find matching closing paren
      const inner = extractParenContent(trimmed);
      if (inner !== null) {
        return evaluateCondition(inner, context);
      }
    }

    // Handle NOT operator
    if (trimmed.startsWith('NOT ') || trimmed.startsWith('!')) {
      const operand = trimmed.startsWith('NOT ')
        ? trimmed.slice(4).trim()
        : trimmed.slice(1).trim();
      return !evaluateCondition(operand, context);
    }

    // Handle AND (higher precedence than OR)
    const andParts = splitByOperator(trimmed, ' AND ');
    if (andParts.length > 1) {
      return andParts.every((part) => evaluateCondition(part.trim(), context));
    }

    // Handle OR
    const orParts = splitByOperator(trimmed, ' OR ');
    if (orParts.length > 1) {
      return orParts.some((part) => evaluateCondition(part.trim(), context));
    }

    // Handle comparison operators
    return evaluateComparison(trimmed, context);
  } catch (error) {
    log.warn(`Condition evaluation error: ${error}`, {
      condition,
      context: context as Record<string, unknown>,
    });
    return false;
  }
}

// =============================================================================
// COMPARISON EVALUATION
// =============================================================================

/**
 * Evaluate a simple comparison expression
 */
function evaluateComparison(expression: string, context: EvaluationContext): boolean {
  // Handle "path IS NOT SET" (check before IS SET to avoid partial match)
  if (expression.endsWith(' IS NOT SET')) {
    const path = expression.slice(0, -' IS NOT SET'.length).trim();
    const value = resolveValue(path, context);
    return value === undefined || value === null;
  }
  // Handle "path IS SET"
  if (expression.endsWith(' IS SET')) {
    const path = expression.slice(0, -' IS SET'.length).trim();
    const value = resolveValue(path, context);
    return value !== undefined && value !== null;
  }

  // Handle "path is_number" or "path IS_NUMBER"
  const isNumberMatch = expression.match(/^(.+)\s+is_number$/i);
  if (isNumberMatch) {
    const value = resolveValue(isNumberMatch[1].trim(), context);
    if (value === null || value === undefined) return false;
    const str = String(value).trim();
    return str !== '' && !isNaN(Number(str));
  }

  // Try each operator in order of specificity.
  // Word-bounded operators (with spaces) are checked before single-char operators
  // to prevent '<' or '>' inside regex patterns (e.g. (?<name>)) from matching first.
  const operators: Array<[string, ComparisonOperator]> = [
    [' matches ', 'matches'],
    [' contains ', 'contains'],
    [' startsWith ', 'startsWith'],
    [' endsWith ', 'endsWith'],
    ['>=', '>='],
    ['<=', '<='],
    ['!=', '!='],
    ['==', '=='],
    ['>', '>'],
    ['<', '<'],
  ];

  for (const [opStr, op] of operators) {
    const parts = expression.split(opStr);
    if (parts.length >= 2) {
      const left = resolveValue(parts[0].trim(), context);
      const right = resolveValue(parts.slice(1).join(opStr).trim(), context);
      return compareValues(left, right, op, context);
    }
  }

  // No operator found - treat as truthy check
  const value = resolveValue(expression, context);
  return isTruthy(value);
}

/**
 * Compare two values using the specified operator.
 * When operator is 'matches' and context is provided, capture groups are stored
 * on context.match (named: match.group_name, numbered: match.1, full: match.0).
 */
function compareValues(
  left: unknown,
  right: unknown,
  operator: ComparisonOperator,
  context?: EvaluationContext,
): boolean {
  switch (operator) {
    case '==':
      return isEqual(left, right);

    case '!=':
      // Special case: if either value is undefined/null, != should return true
      // (they are "not equal" in the sense that we can't compare them yet)
      if (left === undefined || left === null || right === undefined || right === null) {
        // If BOTH are undefined/null, we consider them "not meaningfully different"
        // so != returns false only if both are undefined/null
        // If only ONE is undefined, they ARE different, so return true
        if ((left === undefined || left === null) && (right === undefined || right === null)) {
          return false; // Both undefined/null - not meaningfully different, so != is false
        }
        return true; // One is defined, one isn't - they're different
      }
      return !isEqual(left, right);

    case '>':
      return toNumber(left) > toNumber(right);

    case '<':
      return toNumber(left) < toNumber(right);

    case '>=':
      return toNumber(left) >= toNumber(right);

    case '<=':
      return toNumber(left) <= toNumber(right);

    case 'contains':
      return containsCheck(left, right);

    case 'startsWith':
      return String(left).startsWith(String(right));

    case 'endsWith':
      return String(left).endsWith(String(right));

    case 'matches':
      try {
        const regex = right instanceof RegExp ? right : new RegExp(String(right));
        const str = String(left);
        const matchResult = str.match(regex);
        if (!matchResult) return false;

        // Store capture groups on context.match if context is available
        if (context) {
          const matchData: Record<string, string> = { '0': matchResult[0] };

          // Numbered captures: match.1, match.2, ...
          for (let i = 1; i < matchResult.length; i++) {
            if (matchResult[i] !== undefined) {
              matchData[String(i)] = matchResult[i];
            }
          }

          // Named captures: match.room_id, match.name, ...
          if (matchResult.groups) {
            for (const [name, value] of Object.entries(matchResult.groups)) {
              if (value !== undefined) {
                matchData[name] = value;
              }
            }
          }

          context['match'] = matchData;
        }

        return true;
      } catch {
        return false;
      }

    default:
      return false;
  }
}

// =============================================================================
// BUILT-IN FUNCTION REGISTRY
// =============================================================================

/**
 * Extract content between balanced parentheses.
 * @param str - full expression string
 * @param openIndex - index of the opening '('
 * @returns the content between the outermost balanced parens
 */
function extractBalancedParens(str: string, openIndex: number): string {
  let depth = 0;
  let i = openIndex;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return str.slice(openIndex + 1, i);
    } else if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < str.length && str[i] !== q) {
        if (str[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return str.slice(openIndex + 1);
}

/**
 * Split function arguments by comma, respecting nested parens and quotes.
 */
function splitFunctionArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote: string | null = null;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && i + 1 < argsStr.length) {
        current += argsStr[++i];
        continue;
      }
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current);
  return args;
}

/**
 * Module-scoped cache for Intl.NumberFormat instances (used by FORMAT_CURRENCY).
 * Keyed by "locale:currency". Capped at 64 entries to bound memory.
 */
const _currencyFormatters = new Map<string, Intl.NumberFormat>();
const _FORMATTER_CACHE_MAX = 64;

/**
 * Maximum output length for string-generating built-in functions (REPEAT, PAD_START, PAD_END).
 * Prevents OOM from adversarial or buggy count values.
 */
const MAX_BUILTIN_STRING_LENGTH = 100_000;

/**
 * Registry of built-in functions available in resolveValue() expressions.
 * All functions are pure (except NOW/UNIQUE_ID) and take resolved values.
 */
export const BUILTIN_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  // --- Math (8) ---
  ADD: (a, b) => Number(a) + Number(b),
  SUB: (a, b) => Number(a) - Number(b),
  MUL: (a, b) => Number(a) * Number(b),
  DIV: (a, b) => {
    const d = Number(b);
    return d === 0 ? null : Number(a) / d;
  },
  ROUND: (n, decimals?) => {
    const d = decimals != null ? Number(decimals) : 0;
    return Math.round(Number(n) * 10 ** d) / 10 ** d;
  },
  ABS: (n) => Math.abs(Number(n)),
  MIN: (a, b) => Math.min(Number(a), Number(b)),
  MAX: (a, b) => Math.max(Number(a), Number(b)),

  // --- String (10) ---
  UPPER: (s) => String(s ?? '').toUpperCase(),
  LOWER: (s) => String(s ?? '').toLowerCase(),
  TRIM: (s) => String(s ?? '').trim(),
  SUBSTRING: (s, start, end?) => {
    const str = String(s ?? '');
    return end != null ? str.substring(Number(start), Number(end)) : str.substring(Number(start));
  },
  REPLACE: (s, find, repl) =>
    String(s ?? '')
      .split(String(find))
      .join(String(repl)),
  SPLIT: (s, delim) => String(s ?? '').split(String(delim)),
  JOIN: (arr, delim) => (Array.isArray(arr) ? arr.join(String(delim ?? ',')) : String(arr)),
  PAD_START: (s, len, ch) =>
    String(s ?? '').padStart(Math.min(Number(len), MAX_BUILTIN_STRING_LENGTH), String(ch ?? ' ')),
  PAD_END: (s, len, ch) =>
    String(s ?? '').padEnd(Math.min(Number(len), MAX_BUILTIN_STRING_LENGTH), String(ch ?? ' ')),
  REPEAT: (s, count) =>
    String(s ?? '').repeat(Math.max(0, Math.min(Number(count), MAX_BUILTIN_STRING_LENGTH))),

  // --- Formatting (4) ---
  MASK: (s, pattern, ch?) => {
    const str = String(s ?? '');
    const maskChar = String(ch ?? '*');
    const pat = String(pattern ?? '');
    // Pattern "last4" = mask all but last 4
    if (pat === 'last4') {
      return str.length <= 4 ? str : maskChar.repeat(str.length - 4) + str.slice(-4);
    }
    // Pattern "first4" = mask all but first 4
    if (pat === 'first4') {
      return str.length <= 4 ? str : str.slice(0, 4) + maskChar.repeat(str.length - 4);
    }
    // Pattern "N*N" = show N chars, mask middle, show N chars
    const nStarN = pat.match(/^(\d+)\*(\d+)$/);
    if (nStarN) {
      const showStart = Number(nStarN[1]);
      const showEnd = Number(nStarN[2]);
      if (str.length <= showStart + showEnd) return str;
      return (
        str.slice(0, showStart) +
        maskChar.repeat(str.length - showStart - showEnd) +
        str.slice(-showEnd)
      );
    }
    return str;
  },
  FORMAT_CURRENCY: (n, cur, locale?) => {
    try {
      const loc = String(locale ?? 'en-US');
      const currency = String(cur ?? 'USD');
      const cacheKey = `${loc}:${currency}`;
      let fmt = _currencyFormatters.get(cacheKey);
      if (!fmt) {
        fmt = new Intl.NumberFormat(loc, { style: 'currency', currency });
        _currencyFormatters.set(cacheKey, fmt);
        if (_currencyFormatters.size > _FORMATTER_CACHE_MAX) {
          // Evict oldest entry (first inserted)
          const firstKey = _currencyFormatters.keys().next().value;
          if (firstKey !== undefined) _currencyFormatters.delete(firstKey);
        }
      }
      return fmt.format(Number(n));
    } catch {
      return String(n);
    }
  },
  FORMAT_DATE: (d, fmt, _tz?) => {
    try {
      const date = new Date(String(d));
      if (isNaN(date.getTime())) return String(d);
      const fmtStr = String(fmt ?? 'YYYY-MM-DD');
      const pad = (v: number) => String(v).padStart(2, '0');
      return fmtStr
        .replace('YYYY', String(date.getFullYear()))
        .replace('MM', pad(date.getMonth() + 1))
        .replace('DD', pad(date.getDate()))
        .replace('HH', pad(date.getHours()))
        .replace('mm', pad(date.getMinutes()))
        .replace('ss', pad(date.getSeconds()));
    } catch {
      return String(d);
    }
  },
  ORDINAL: (n) => {
    const num = Number(n);
    const s = ['th', 'st', 'nd', 'rd'];
    const v = num % 100;
    return num + (s[(v - 20) % 10] || s[v] || s[0]);
  },

  // --- Type checking & coercion (5) ---
  IS_ARRAY: (x) => Array.isArray(x),
  IS_NUMBER: (x) => typeof x === 'number' && !isNaN(x),
  IS_STRING: (x) => typeof x === 'string',
  TO_NUMBER: (x) => {
    const n = Number(x);
    return isNaN(n) ? null : n;
  },
  TO_STRING: (x) => (x == null ? '' : String(x)),

  // --- Array (3) ---
  LENGTH: (x) => (Array.isArray(x) ? x.length : typeof x === 'string' ? x.length : 0),
  ARRAY_FIND: (arr, field, value) => {
    if (!Array.isArray(arr)) return null;
    return (
      arr.find((item) => item && (item as Record<string, unknown>)[String(field)] == value) ?? null
    );
  },
  ARRAY_FIND_INDEX: (arr, field, value) => {
    if (!Array.isArray(arr)) return -1;
    return arr.findIndex(
      (item) => item && (item as Record<string, unknown>)[String(field)] == value,
    );
  },

  // --- Object (3) ---
  OBJECT_KEYS: (obj) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [],
  OBJECT_VALUES: (obj) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj) : [],
  OBJECT_MERGE: (...objs) => {
    const result: Record<string, unknown> = {};
    for (const obj of objs) {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) Object.assign(result, obj);
    }
    return result;
  },

  // --- Utility (3) ---
  COALESCE: (...args) => args.find((a) => a !== null && a !== undefined) ?? null,
  NOW: () => new Date().toISOString(),
  UNIQUE_ID: (len?) => {
    const n = Number(len) || 6;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < n; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  },
};

// =============================================================================
// VALUE RESOLUTION
// =============================================================================

/**
 * Maximum nesting depth for function calls in resolveValue().
 * Prevents stack overflow from deeply nested expressions like ADD(ADD(ADD(...))).
 */
const MAX_RESOLVE_DEPTH = 32;

/**
 * Resolve a value from expression or context
 *
 * @deprecated Use `resolveValueDual` from `dual-evaluator.ts`. Kept as internal fallback.
 */
export function resolveValue(
  expression: string,
  context: EvaluationContext,
  _depth: number = 0,
): unknown {
  if (_depth > MAX_RESOLVE_DEPTH) {
    log.warn('resolveValue: max nesting depth exceeded, returning undefined', {
      expression: expression.slice(0, 100),
      depth: _depth,
    });
    return undefined;
  }

  const trimmed = expression.trim();

  // String literal
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Boolean literal
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null/undefined
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;

  // Regex literal (e.g., /pattern/ or /pattern/flags)
  const regexMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]);
    } catch (e) {
      // Log warning for invalid regex patterns instead of silently returning string
      log.warn('Invalid regex pattern in expression, treating as literal string', {
        expression: trimmed,
        error: e instanceof Error ? e.message : String(e),
      });
      return trimmed;
    }
  }

  // Array literal (simple)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  // Function call: NAME(arg1, arg2, ...)
  const funcMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*\(/);
  if (funcMatch) {
    const funcName = funcMatch[1].toUpperCase();
    if (BUILTIN_FUNCTIONS[funcName]) {
      const argsContent = extractBalancedParens(trimmed, funcMatch[0].length - 1);
      const args = splitFunctionArgs(argsContent).map((a) =>
        resolveValue(a.trim(), context, _depth + 1),
      );
      return BUILTIN_FUNCTIONS[funcName](...args);
    }
  }

  // Path expression - get value from context
  return getNestedValue(context, trimmed);
}

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(obj: EvaluationContext, path: string): unknown {
  if (!path) return undefined;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    // Handle array index notation: items[0]
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      const arr = (current as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        current = arr[parseInt(index, 10)];
      } else {
        return undefined;
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Set a nested value in an object using dot notation
 */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Split expression by operator, respecting parentheses
 */
export function splitByOperator(expression: string, operator: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  while (i < expression.length) {
    if (expression[i] === '(') {
      depth++;
      current += expression[i];
      i++;
    } else if (expression[i] === ')') {
      depth--;
      current += expression[i];
      i++;
    } else if (depth === 0 && expression.slice(i).startsWith(operator)) {
      results.push(current);
      current = '';
      i += operator.length;
    } else {
      current += expression[i];
      i++;
    }
  }

  if (current) {
    results.push(current);
  }

  return results;
}

/**
 * Extract content from parentheses
 */
function extractParenContent(expression: string): string | null {
  if (!expression.startsWith('(')) return null;

  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '(') depth++;
    if (expression[i] === ')') depth--;
    if (depth === 0 && i === expression.length - 1) {
      return expression.slice(1, -1);
    }
  }

  return null;
}

/**
 * Check if two values are equal (with type coercion)
 */
function isEqual(a: unknown, b: unknown): boolean {
  // Handle null/undefined
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  if (b === null || b === undefined) {
    return false;
  }

  // String comparison (case-insensitive for common cases)
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }

  // Boolean comparison with string
  if (typeof a === 'boolean' && typeof b === 'string') {
    return a === (b === 'true');
  }
  if (typeof a === 'string' && typeof b === 'boolean') {
    return (a === 'true') === b;
  }

  // Number comparison
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b;
  }

  // Number with string
  if (typeof a === 'number' && typeof b === 'string') {
    return a === parseFloat(b);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return parseFloat(a) === b;
  }

  // Default string comparison
  return String(a) === String(b);
}

/**
 * Convert value to number
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

/**
 * Check if a value is truthy
 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0 && value !== 'false';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Check if left contains right
 */
function containsCheck(left: unknown, right: unknown): boolean {
  if (typeof left === 'string') {
    return left.includes(String(right));
  }
  if (Array.isArray(left)) {
    return left.includes(right) || left.some((item) => isEqual(item, right));
  }
  return false;
}

// =============================================================================
// CONSTRAINT-AWARE EVALUATOR
// =============================================================================

/**
 * Evaluate a condition with IS SET guard semantics for constraints.
 *
 * @deprecated Default evaluator is now `evaluateConditionDual`. This function is unused.
 *
 * In AND chains, `X IS SET` clauses act as guards (preconditions).
 * If any guard is not met, the expression is "not applicable" (returns true).
 * Pure IS SET chains (no value assertions) evaluate normally.
 *
 * @example
 * // origin not set → true (not applicable)
 * evaluateConstraintCondition('destination IS SET AND origin IS SET AND destination != origin',
 *   { destination: 'Paris' })
 *
 * // both set and equal → false (violation)
 * evaluateConstraintCondition('destination IS SET AND origin IS SET AND destination != origin',
 *   { destination: 'Paris', origin: 'Paris' })
 */
export function evaluateConstraintCondition(
  condition: string,
  context: EvaluationContext,
): boolean {
  const trimmed = condition.trim();
  const andParts = splitByOperator(trimmed, ' AND ');

  if (andParts.length > 1) {
    const guards: string[] = [];
    const assertions: string[] = [];

    for (const part of andParts) {
      const p = part.trim();
      if (p.endsWith(' IS SET')) {
        guards.push(p);
      } else {
        assertions.push(p);
      }
    }

    // Mixed IS SET guards + value assertions: guards act as preconditions
    if (guards.length > 0 && assertions.length > 0) {
      const allGuardsPass = guards.every((g) => evaluateCondition(g, context));
      if (!allGuardsPass) return true; // Not applicable
      return assertions.every((a) => evaluateCondition(a, context));
    }
  }

  return evaluateCondition(condition, context);
}

// =============================================================================
// SPECIALIZED EVALUATORS
// =============================================================================

/**
 * Evaluate multiple conditions and return detailed results
 *
 * @deprecated Use `evaluateConditionDual` in a loop.
 */
export function evaluateConditions(
  conditions: string[],
  context: EvaluationContext,
): Record<string, boolean> {
  const results: Record<string, boolean> = {};

  for (const condition of conditions) {
    results[condition] = evaluateCondition(condition, context);
  }

  return results;
}

/**
 * Evaluate a condition and return the first matching result
 *
 * @deprecated Use `evaluateConditionDual` in a loop.
 */
export function evaluateConditionList<T>(
  conditions: Array<{ when: string; result: T }>,
  context: EvaluationContext,
  defaultResult?: T,
): T | undefined {
  for (const { when, result } of conditions) {
    if (evaluateCondition(when, context)) {
      return result;
    }
  }
  return defaultResult;
}

/**
 * Evaluate a condition with input as a context variable.
 *
 * @deprecated Use `evaluateConditionDual(cond, { ...ctx, input })`. Kept as internal fallback.
 *
 * Convenience wrapper for runtime use: merges `input` into context so
 * conditions like `input == "value"` or `input contains "text"` work
 * via the standard evaluator.
 */
export function evaluateConditionWithInput(
  condition: string,
  input: string,
  context: EvaluationContext,
): boolean {
  return evaluateCondition(condition, { ...context, input });
}

/**
 * Detailed condition evaluation result for debugging/tracing
 */
export interface ConditionEvalDetail {
  matched: boolean;
  conditionType: string;
  leftValue: unknown;
  operator: string;
  rightValue: unknown;
  explanation: string;
}

/**
 * Evaluate a condition and return detailed info for debugging.
 *
 * @deprecated Use `evaluateConditionDetailedDual` from `dual-evaluator.ts`.
 *
 * Provides structured trace information about how the condition was evaluated.
 */
export function evaluateConditionDetailed(
  condition: string,
  input: string,
  context: EvaluationContext,
): ConditionEvalDetail {
  const cond = condition.trim();
  const mergedContext: EvaluationContext = { ...context, input };

  // Helper: after evaluation, propagate regex capture groups back to original context
  const propagateMatch = () => {
    if (mergedContext['match']) {
      context['match'] = mergedContext['match'];
    }
  };

  // Handle compound AND conditions
  if (cond.includes(' AND ')) {
    const parts = splitByOperator(cond, ' AND ');
    if (parts.length > 1) {
      const results = parts.map((part) => evaluateConditionDetailed(part.trim(), input, context));
      const allMatched = results.every((r) => r.matched);
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

  // Handle compound OR conditions
  if (cond.includes(' OR ')) {
    const parts = splitByOperator(cond, ' OR ');
    if (parts.length > 1) {
      const results = parts.map((part) => evaluateConditionDetailed(part.trim(), input, context));
      const anyMatched = results.some((r) => r.matched);
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

  // Detect the condition type for structured reporting
  // Variable comparison: var op value
  const varMatch = cond.match(/^(\w+(?:\.\w+)*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (varMatch) {
    const [, varPath, op, valueStr] = varMatch;
    const leftValue = resolveValue(varPath, mergedContext);
    const rightValue = resolveValue(valueStr.trim(), mergedContext);
    const matched = evaluateCondition(cond, mergedContext);
    return {
      matched,
      conditionType: 'variable_comparison',
      leftValue,
      operator: op,
      rightValue,
      explanation: `${varPath}(=${JSON.stringify(leftValue)}) ${op} ${JSON.stringify(rightValue)} → ${matched}`,
    };
  }

  // Contains check
  const containsMatch = cond.match(/^(\w+(?:\.\w+)*)\s+contains\s+(.+)$/i);
  if (containsMatch) {
    const leftValue = resolveValue(containsMatch[1].trim(), mergedContext);
    const rightValue = resolveValue(containsMatch[2].trim(), mergedContext);
    const matched = evaluateCondition(cond, mergedContext);
    return {
      matched,
      conditionType: 'contains',
      leftValue,
      operator: 'contains',
      rightValue,
      explanation: `${JSON.stringify(leftValue)} ${matched ? 'contains' : 'does not contain'} ${JSON.stringify(rightValue)}`,
    };
  }

  // IS SET / IS NOT SET
  if (cond.endsWith(' IS SET') || cond.endsWith(' IS NOT SET')) {
    const isNotSet = cond.endsWith(' IS NOT SET');
    const path = cond.slice(0, isNotSet ? -' IS NOT SET'.length : -' IS SET'.length).trim();
    const value = resolveValue(path, mergedContext);
    const matched = evaluateCondition(cond, mergedContext);
    return {
      matched,
      conditionType: isNotSet ? 'is_not_set' : 'is_set',
      leftValue: value,
      operator: isNotSet ? 'IS NOT SET' : 'IS SET',
      rightValue: null,
      explanation: `${path}(=${JSON.stringify(value)}) ${isNotSet ? 'IS NOT SET' : 'IS SET'} → ${matched}`,
    };
  }

  // Matches check (regex): input matches /pattern/
  const matchesMatch = cond.match(/^(\w+(?:\.\w+)*)\s+matches\s+(.+)$/i);
  if (matchesMatch) {
    const leftValue = resolveValue(matchesMatch[1].trim(), mergedContext);
    const rightValue = resolveValue(matchesMatch[2].trim(), mergedContext);
    const matched = evaluateCondition(cond, mergedContext);
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

  // Fallback: evaluate and return generic detail
  const matched = evaluateCondition(cond, mergedContext);
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
 * Create a condition evaluator bound to a specific context
 * @deprecated Use evaluateConditionDual/resolveValueDual directly.
 */
export function createConditionEvaluator(context: EvaluationContext) {
  return {
    evaluate: (condition: string) => evaluateCondition(condition, context),
    evaluateAll: (conditions: string[]) => evaluateConditions(conditions, context),
    resolve: (expression: string) => resolveValue(expression, context),
    get: (path: string) => getNestedValue(context, path),
    set: (path: string, value: unknown) =>
      setNestedValue(context as Record<string, unknown>, path, value),
  };
}

// =============================================================================
// TEMPLATE INTERPOLATION
// =============================================================================

/**
 * Interpolate variables in a message template.
 * Supports both ${var} and {{var}} syntax for compatibility with ABL templates.
 *
 * @example
 * interpolateMessage('Hello ${user.name}!', { user: { name: 'John' } })
 * // Returns: 'Hello John!'
 *
 * @example
 * interpolateMessage('Hello {{user.name}}!', { user: { name: 'John' } })
 * // Returns: 'Hello John!'
 */
export function interpolateMessage(template: string, context: EvaluationContext): string {
  // First handle ${var} syntax
  let result = template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = getNestedValue(context, path.trim());
    return value !== undefined && value !== null ? String(value) : '';
  });

  // Then handle {{var}} syntax (skip block helpers like {{#each}}, {{#if}}, {{/...}}, {{@...}})
  result = result.replace(/\{\{([^#@/}][^}]*)\}\}/g, (_, path) => {
    const trimmedPath = path.trim();
    // Skip helper expressions
    if (trimmedPath.startsWith('add ') || trimmedPath.startsWith('sub ')) {
      return '';
    }
    const value = getNestedValue(context, trimmedPath);
    return value !== undefined && value !== null ? String(value) : '';
  });

  return result;
}

/**
 * Interpolate with fallback values
 *
 * @example
 * interpolateWithFallback('Hello ${user.name|Guest}!', { user: {} })
 * // Returns: 'Hello Guest!'
 */
export function interpolateWithFallback(template: string, context: EvaluationContext): string {
  return template.replace(/\$\{([^}|]+)(?:\|([^}]*))?\}/g, (_, path, fallback) => {
    const value = getNestedValue(context, path.trim());
    if (value !== undefined && value !== null && value !== '') {
      return String(value);
    }
    return fallback !== undefined ? fallback : '';
  });
}

// =============================================================================
// RICH TEMPLATE INTERPOLATION (Handlebars-style)
// =============================================================================

/**
 * Interpolate a template with rich syntax support (Handlebars-style)
 *
 * Supports:
 * - {{variable}} - Basic variable interpolation
 * - {{path.to.value}} - Nested path access
 * - {{#each array}}...{{/each}} - Array iteration
 * - {{#if condition}}...{{else}}...{{/if}} - Conditional blocks
 * - {{@index}} - Current iteration index (inside #each)
 * - {{add @index N}} - Add N to current index
 *
 * @example
 * interpolateRichTemplate('Hello {{name}}!', { name: 'John' })
 * // Returns: 'Hello John!'
 *
 * @example
 * interpolateRichTemplate('{{#each items}}{{add @index 1}}. {{name}}\n{{/each}}', { items: [{name: 'A'}, {name: 'B'}] })
 * // Returns: '1. A\n2. B\n'
 */
export function interpolateRichTemplate(template: string, context: EvaluationContext): string {
  let result = template;

  // Handle {{#each array}}...{{/each}} blocks
  result = processEachBlocks(result, context);

  // Handle {{#if condition}}...{{else}}...{{/if}} blocks
  result = processIfBlocks(result, context);

  // Handle simple variable interpolation {{variable}} and {{path.to.value}}
  result = result.replace(/\{\{([^#@/}][^}]*)\}\}/g, (_, path) => {
    const trimmedPath = path.trim();
    // Skip helper expressions that weren't handled
    if (trimmedPath.startsWith('add ') || trimmedPath.startsWith('sub ')) {
      return '';
    }
    const value = getNestedValue(context, trimmedPath);
    return value !== undefined && value !== null ? String(value) : '';
  });

  return result;
}

/**
 * Interpolate voice config fields (SSML, instructions, plain_text) using the rich template engine.
 * Returns undefined if input is undefined.
 */
export function interpolateVoiceConfig(
  vc: import('../ir/schema.js').VoiceConfigIR | undefined,
  context: EvaluationContext,
): import('../ir/schema.js').VoiceConfigIR | undefined {
  if (!vc) return undefined;
  return {
    ssml: vc.ssml ? interpolateRichTemplate(vc.ssml, context) : undefined,
    instructions: vc.instructions ? interpolateRichTemplate(vc.instructions, context) : undefined,
    plain_text: vc.plain_text ? interpolateRichTemplate(vc.plain_text, context) : undefined,
  };
}

/**
 * Process {{#each array}}...{{/each}} blocks
 */
function processEachBlocks(template: string, context: EvaluationContext): string {
  const eachRegex = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

  return template.replace(eachRegex, (_, arrayPath, content) => {
    const arr = getNestedValue(context, arrayPath.trim());
    if (!Array.isArray(arr)) {
      return '';
    }

    return arr
      .map((item, index) => {
        let itemContent = content;

        // Replace {{@index}}
        itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));

        // Replace {{add @index N}} - add helper for index arithmetic
        itemContent = itemContent.replace(
          /\{\{add\s+@index\s+(\d+)\}\}/g,
          (_m: string, num: string) => {
            return String(index + parseInt(num, 10));
          },
        );

        // Replace {{sub @index N}} - subtract helper
        itemContent = itemContent.replace(
          /\{\{sub\s+@index\s+(\d+)\}\}/g,
          (_m: string, num: string) => {
            return String(index - parseInt(num, 10));
          },
        );

        // Create item context with 'this' and direct property access
        const itemContext: EvaluationContext = {
          ...context,
          this: item,
          '@index': index,
          '@first': index === 0,
          '@last': index === arr.length - 1,
        };

        // If item is an object, spread its properties at top level for easy access
        if (typeof item === 'object' && item !== null) {
          Object.assign(itemContext, item);
        }

        // Recursively process nested templates (including nested #each and #if)
        itemContent = processEachBlocks(itemContent, itemContext);
        itemContent = processIfBlocks(itemContent, itemContext);

        // Replace item properties {{name}}, {{price}}, etc.
        itemContent = itemContent.replace(/\{\{([^#@/}][^}]*)\}\}/g, (_m: string, prop: string) => {
          const trimmedProp = prop.trim();
          // Handle this.property syntax
          if (trimmedProp.startsWith('this.')) {
            const subPath = trimmedProp.slice(5);
            if (typeof item === 'object' && item !== null) {
              const val = getNestedValue(item as EvaluationContext, subPath);
              return val !== undefined && val !== null ? String(val) : '';
            }
            return '';
          }
          // Direct property access
          const val = getNestedValue(itemContext, trimmedProp);
          return val !== undefined && val !== null ? String(val) : '';
        });

        return itemContent;
      })
      .join('');
  });
}

/**
 * Process {{#if condition}}...{{else}}...{{/if}} blocks
 */
function processIfBlocks(template: string, context: EvaluationContext): string {
  // Match {{#if condition}}...{{else}}...{{/if}} or {{#if condition}}...{{/if}}
  const ifRegex = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  return template.replace(ifRegex, (_, condition, content) => {
    // Split content by {{else}}
    const elseParts = content.split(/\{\{else\}\}/);
    const trueBranch = elseParts[0];
    const falseBranch = elseParts.length > 1 ? elseParts[1] : '';

    // Evaluate the condition
    const conditionResult = evaluateTemplateCondition(condition.trim(), context);

    let branchContent = conditionResult ? trueBranch : falseBranch;

    // Recursively process nested templates
    branchContent = processEachBlocks(branchContent, context);
    branchContent = processIfBlocks(branchContent, context);

    // Replace variables in the chosen branch
    branchContent = branchContent.replace(/\{\{([^#@/}][^}]*)\}\}/g, (_m: string, path: string) => {
      const val = getNestedValue(context, path.trim());
      return val !== undefined && val !== null ? String(val) : '';
    });

    return branchContent;
  });
}

/**
 * Evaluate a condition for template {{#if}} blocks
 * Supports: truthiness check, comparison operators, logical operators
 */
function evaluateTemplateCondition(condition: string, context: EvaluationContext): boolean {
  // Handle comparison operators
  if (
    condition.includes('==') ||
    condition.includes('!=') ||
    condition.includes('>') ||
    condition.includes('<') ||
    condition.includes(' AND ') ||
    condition.includes(' OR ')
  ) {
    return evaluateCondition(condition, context);
  }

  // Handle NOT prefix
  if (condition.startsWith('!') || condition.startsWith('NOT ')) {
    const operand = condition.startsWith('NOT ')
      ? condition.slice(4).trim()
      : condition.slice(1).trim();
    const value = getNestedValue(context, operand);
    return !isTruthyValue(value);
  }

  // Simple truthiness check
  const value = getNestedValue(context, condition);
  return isTruthyValue(value);
}

/**
 * Check if a value is truthy for template conditions
 */
function isTruthyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0 && value !== 'false';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
