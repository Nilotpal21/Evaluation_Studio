/**
 * Expression Syntax Migrator: ABL Custom -> CEL
 *
 * Converts legacy ABL expression syntax to CEL syntax.
 * Used during the transition period to support both old and new formats.
 *
 * Conversion rules:
 * - Logical operators: AND -> &&, OR -> ||, NOT -> !
 * - Existence checks: `x IS SET` -> `has(x)`, `x IS NOT SET` -> `!has(x)`
 * - String operators: `x CONTAINS "y"` -> `x.contains("y")`, `x MATCHES "y"` -> `x.matches("y")`
 * - String functions: STARTS_WITH(x, "y") -> x.startsWith("y"), ENDS_WITH(x, "y") -> x.endsWith("y")
 * - Arithmetic functions: ADD(a,b) -> a + b, SUB -> -, MUL -> *, DIV -> /
 * - CEL builtins: LENGTH(x) -> size(x)
 * - ABL namespace: UPPER(x) -> abl.upper(x), FORMAT_CURRENCY(...) -> abl.format_currency(...), etc.
 *
 * Note on `has()`: CEL's `has()` macro requires member access syntax (`has(obj.field)`),
 * not bare identifiers (`has(name)`). The dual evaluator (Task 4) handles this by wrapping
 * context variables so bare `has(name)` calls work at runtime.
 */

/** ABL built-in functions that map directly to arithmetic operators */
const ARITHMETIC_MAP: Record<string, string> = { ADD: '+', SUB: '-', MUL: '*', DIV: '/' };

/** ABL functions that map to CEL built-ins */
const CEL_BUILTIN_MAP: Record<string, string> = { LENGTH: 'size' };

/**
 * ABL function-call form that maps to a CEL string method:
 *   STARTS_WITH(x, "y") -> x.startsWith("y")
 *   ENDS_WITH(x, "y")   -> x.endsWith("y")
 *
 * The first argument becomes the receiver of the method call. We wrap it in
 * parentheses so dotted paths (`user.profile.name`) and parenthesised
 * sub-expressions both serialise correctly.
 */
const STRING_METHOD_MAP: Record<string, string> = {
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
};

/** ABL functions that map to abl.* namespace */
const ABL_NAMESPACE_FUNCTIONS = new Set([
  'UPPER',
  'LOWER',
  'TRIM',
  'SUBSTRING',
  'REPLACE',
  'SPLIT',
  'JOIN',
  'PAD_START',
  'PAD_END',
  'REPEAT',
  'ROUND',
  'ABS',
  'MIN',
  'MAX',
  'MASK',
  'FORMAT_CURRENCY',
  'FORMAT_DATE',
  'ORDINAL',
  'IS_ARRAY',
  'IS_NUMBER',
  'IS_STRING',
  'TO_NUMBER',
  'TO_STRING',
  'ARRAY_FIND',
  'ARRAY_FIND_INDEX',
  'OBJECT_KEYS',
  'OBJECT_VALUES',
  'OBJECT_MERGE',
  'COALESCE',
  'NOW',
  'UNIQUE_ID',
]);

/** All known ABL function names */
const ALL_ABL_FUNCTIONS = new Set([
  ...Object.keys(ARITHMETIC_MAP),
  ...Object.keys(CEL_BUILTIN_MAP),
  ...Object.keys(STRING_METHOD_MAP),
  ...ABL_NAMESPACE_FUNCTIONS,
]);

// ---------------------------------------------------------------------------
// Pre-compiled regex patterns for performance (avoids per-call RegExp creation)
// ---------------------------------------------------------------------------

/** Combined pattern matching any ABL function call: FUNC_NAME( */
const ABL_FUNCTION_CALL_PATTERN = new RegExp(`\\b(?:${[...ALL_ABL_FUNCTIONS].join('|')})\\s*\\(`);

/** Pre-compiled arithmetic patterns: FUNC(a, b) -> a OP b */
const ARITHMETIC_PATTERNS = Object.entries(ARITHMETIC_MAP).map(([fn, op]) => ({
  regex: new RegExp(`\\b${fn}\\s*\\(\\s*([^,]+?)\\s*,\\s*([^)]+?)\\s*\\)`, 'g'),
  replacement: `$1 ${op} $2`,
}));

/**
 * Pre-compiled string-method patterns: FUNC(receiver, arg) -> (receiver).celMethod(arg).
 * Receiver is wrapped so dotted paths and parenthesised sub-expressions both
 * serialise correctly under CEL.
 */
const STRING_METHOD_PATTERNS = Object.entries(STRING_METHOD_MAP).map(([fn, celMethod]) => ({
  regex: new RegExp(`\\b${fn}\\s*\\(\\s*([^,]+?)\\s*,\\s*([^)]+?)\\s*\\)`, 'g'),
  replacement: `($1).${celMethod}($2)`,
}));

/** Pre-compiled CEL builtin patterns: FUNC( -> celFunc( */
const CEL_BUILTIN_PATTERNS = Object.entries(CEL_BUILTIN_MAP).map(([fn, celFn]) => ({
  regex: new RegExp(`\\b${fn}\\s*\\(`, 'g'),
  replacement: `${celFn}(`,
}));

/** Pre-compiled namespace patterns: FUNC( -> abl.func( */
const NAMESPACE_PATTERNS = [...ABL_NAMESPACE_FUNCTIONS].map((fn) => ({
  regex: new RegExp(`\\b${fn}\\s*\\(`, 'g'),
  replacement: `abl.${fn.toLowerCase()}(`,
}));

/**
 * Replace pattern matches only outside quoted strings.
 * Splits the expression into quoted and unquoted segments,
 * applies the replacement only to unquoted segments, then reassembles.
 */
function replaceOutsideQuotes(expr: string, pattern: RegExp, replacement: string): string {
  // Split into alternating segments: unquoted, quoted, unquoted, quoted, ...
  const segments = expr.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  for (let i = 0; i < segments.length; i += 2) {
    // Even indices are unquoted segments
    segments[i] = segments[i].replace(pattern, replacement);
  }
  return segments.join('');
}

/**
 * Check whether an expression uses legacy ABL syntax.
 * Returns false for already-valid CEL expressions.
 */
export function isLegacyExpression(expr: string): boolean {
  // Strip quoted strings to avoid false positives on keywords inside string literals
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  // Check for ABL logical operators (word-boundary match)
  if (/\bAND\b/.test(stripped) || /\bOR\b/.test(stripped) || /\bNOT\b/.test(stripped)) return true;

  // Check for ABL-style CONTAINS/MATCHES (not method syntax)
  if (/\bCONTAINS\b/.test(stripped) || /\bMATCHES\b/.test(stripped)) return true;

  // Check for ABL-style IN operator (CEL uses lowercase 'in')
  if (/\bIN\b/.test(stripped)) return true;

  // Check for IS SET / IS NOT SET
  if (/\bIS\s+(NOT\s+)?SET\b/.test(stripped)) return true;

  // Check for ABL function calls using single pre-compiled pattern
  if (ABL_FUNCTION_CALL_PATTERN.test(stripped)) return true;

  return false;
}

/**
 * Migrate an ABL expression to CEL syntax.
 * If already valid CEL, returns it unchanged.
 */
export function migrateExpression(expr: string): string {
  let result = expr;

  // 1. IS NOT SET -> !has(x) / IS SET -> has(x)
  //    Must handle IS NOT SET before IS SET to avoid partial matches
  result = result.replace(/(\w+(?:\.\w+)*)\s+IS\s+NOT\s+SET\b/g, '!has($1)');
  result = result.replace(/(\w+(?:\.\w+)*)\s+IS\s+SET\b/g, 'has($1)');

  // 2. CONTAINS -> .contains()
  result = result.replace(
    /(\w+(?:\.\w+)*)\s+CONTAINS\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    '$1.contains($2)',
  );

  // 3. MATCHES -> .matches()
  result = result.replace(
    /(\w+(?:\.\w+)*)\s+MATCHES\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    '$1.matches($2)',
  );

  // 4. Arithmetic functions: ADD(a, b) -> a + b
  for (const { regex, replacement } of ARITHMETIC_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }

  // 4b. String methods: STARTS_WITH(x, "y") -> (x).startsWith("y")
  for (const { regex, replacement } of STRING_METHOD_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }

  // 5. CEL-builtin mapped: LENGTH(x) -> size(x)
  for (const { regex, replacement } of CEL_BUILTIN_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }

  // 6. ABL namespace functions: UPPER(x) -> abl.upper(x)
  for (const { regex, replacement } of NAMESPACE_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }

  // 7. Logical operators (outside quotes)
  //    Order matters: NOT before AND/OR to avoid mangling "IS NOT SET" (already handled above)
  //    We must skip quoted strings to avoid corrupting e.g. status == "NOT FOUND"
  result = replaceOutsideQuotes(result, /\bNOT\s+/g, '!');
  result = replaceOutsideQuotes(result, /\s+AND\s+/g, ' && ');
  result = replaceOutsideQuotes(result, /\s+OR\s+/g, ' || ');

  // 8. IN operator (CEL uses lowercase 'in')
  result = replaceOutsideQuotes(result, /\bIN\b/g, 'in');

  return result;
}

/**
 * Auto-detect and normalize. If legacy ABL syntax, migrate to CEL.
 * If already valid CEL, returns it unchanged.
 */
export function normalizeExpression(expr: string): string {
  return isLegacyExpression(expr) ? migrateExpression(expr) : expr;
}
