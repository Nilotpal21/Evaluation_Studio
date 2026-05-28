/**
 * Safe expression evaluator for pipeline step conditions.
 *
 * Evaluates condition expressions like:
 *   "steps.eval-safety.output.scores.toxicity > 0.7"
 *   "steps.check-policy.output.status == 'FAIL' && steps.eval.output.score > 0.5"
 *
 * Security: No eval(), no Function(), no bracket access, no arithmetic.
 * Only supports comparisons, logical operators, and dot-path property access.
 */
import type { StepOutput } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keywords that are never allowed in expressions. */
const BANNED_KEYWORDS = [
  'function',
  'eval',
  'require',
  'import',
  'constructor',
  '__proto__',
  'prototype',
  'this',
  'window',
  'global',
  'process',
] as const;

/** Banned characters: bracket access, braces. */
const BANNED_CHARS_RE = /[\[\]{}]/;

/**
 * Banned arithmetic operators: +, *, /
 * Note: - is allowed inside identifiers (e.g., step IDs like "check-policy")
 * so we only ban + * / as they have no valid use in expressions.
 * Minus as arithmetic is banned via the BANNED_ARITHMETIC_MINUS pattern.
 */
const BANNED_ARITHMETIC_RE = /[+*/]/;

/**
 * Detects `-` used as arithmetic operator (surrounded by whitespace).
 * Hyphens within dot-path identifiers (no surrounding spaces) are allowed.
 */
const BANNED_ARITHMETIC_MINUS_RE = /\s-\s/;

/**
 * Detects lone assignment `=` that is NOT part of `==`, `!=`, `>=`, `<=`.
 * Matches a `=` that is neither preceded by [!<>=] nor followed by `=`.
 */
const LONE_ASSIGNMENT_RE = /(?<![!<>=])=(?!=)/;

/**
 * Whitelist pattern for the full expression.
 * Only allows: word chars, dots, hyphens, spaces, single-quoted strings,
 * comparison operators, logical operators, negation, parentheses, numbers.
 */
const SAFE_TOKEN_RE = /^[\w.\-\s'<>=!&|()0-9]+$/;

const COMPARISON_OPERATORS = ['==', '!=', '>=', '<=', '>', '<'] as const;

type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

interface TopLevelComparisonSplit {
  leftExpr: string;
  op: ComparisonOperator;
  rightExpr: string;
}

// ---------------------------------------------------------------------------
// resolveExpression
// ---------------------------------------------------------------------------

/**
 * Resolves a dot-path expression against step outputs.
 *
 * Path format: `steps.<stepId>.output.<nested.path...>`
 *
 * The `output` segment in the expression maps to `StepOutput.data`.
 *
 * @param path - Dot-path expression (e.g. `steps.eval-safety.output.scores.toxicity`)
 * @param stepOutputs - Map of step ID to StepOutput
 * @returns The resolved value, or `undefined` if any segment is missing
 */
export function resolveExpression(
  path: string,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): unknown {
  const segments = splitDotPath(path);

  // Handle pipelineInput.* prefix — uses simple dot splitting (no hyphenated IDs)
  if (segments[0] === 'pipelineInput') {
    if (!pipelineInput) return undefined;
    const parts = path.split('.');
    let current: unknown = pipelineInput;
    for (let i = 1; i < parts.length; i++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[parts[i]];
    }
    return current;
  }

  // Must start with "steps"
  if (segments[0] !== 'steps' || segments.length < 3) {
    return undefined;
  }

  const stepId = segments[1];
  const stepOutput = stepOutputs[stepId];
  if (!stepOutput) {
    return undefined;
  }

  // segments[2] should be "output" — maps to stepOutput.data
  if (segments[2] !== 'output') {
    return undefined;
  }

  // Traverse into stepOutput.data with remaining segments
  let current: unknown = stepOutput.data;
  for (let i = 3; i < segments.length; i++) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segments[i]];
  }

  return current;
}

// ---------------------------------------------------------------------------
// evaluateExpression
// ---------------------------------------------------------------------------

/**
 * Evaluates a condition expression against step outputs.
 *
 * Supported operators: ==, !=, >, <, >=, <=, &&, ||, !
 * Left side: dot-path reference resolved via resolveExpression
 * Right side: string literal ('quoted'), number, boolean (true/false)
 *
 * Returns `false` on any error or missing data (safe default).
 *
 * @param expression - The condition expression string
 * @param stepOutputs - Map of step ID to StepOutput
 * @returns Boolean result of the expression evaluation
 */
export function evaluateExpression(
  expression: string,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): boolean {
  try {
    const tokens = tokenize(expression);
    const ast = parseExpression(tokens, 0);
    return Boolean(evaluate(ast.node, stepOutputs, pipelineInput));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// isSafeExpression
// ---------------------------------------------------------------------------

/**
 * Returns true if the expression only contains allowed operations.
 *
 * Allowed: dot property access, single-quoted strings, numbers, booleans,
 *          comparison operators (==, !=, >, <, >=, <=),
 *          logical operators (&&, ||), negation (!), whitespace.
 *
 * Rejected: function, eval, require, import, constructor, __proto__, prototype,
 *           this, window, global, process, bracket access, arithmetic (+,-,*,/),
 *           assignment (single =), curly braces.
 */
export function isSafeExpression(expression: string): boolean {
  // Check for banned keywords (word-boundary match)
  for (const keyword of BANNED_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`);
    if (re.test(expression)) {
      return false;
    }
  }

  // Check for banned characters (brackets, braces)
  if (BANNED_CHARS_RE.test(expression)) {
    return false;
  }

  // Check for arithmetic operators (+, *, /)
  if (BANNED_ARITHMETIC_RE.test(expression)) {
    return false;
  }

  // Check for minus as arithmetic operator (space-separated)
  if (BANNED_ARITHMETIC_MINUS_RE.test(expression)) {
    return false;
  }

  // Check for lone assignment = (not part of ==, !=, >=, <=)
  if (LONE_ASSIGNMENT_RE.test(expression)) {
    return false;
  }

  // Check overall structure is within our whitelist
  if (!SAFE_TOKEN_RE.test(expression)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// extractStepReferences
// ---------------------------------------------------------------------------

/**
 * Extracts step IDs referenced in the expression.
 *
 * Matches the pattern `steps.<stepId>.output` and returns deduplicated,
 * sorted array of step IDs.
 *
 * @param expression - The condition expression string
 * @returns Array of unique step IDs, sorted alphabetically
 */
export function extractStepReferences(expression: string): string[] {
  const re = /steps\.([a-zA-Z0-9_-]+)\.output/g;
  const ids = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = re.exec(expression)) !== null) {
    ids.add(match[1]);
  }

  return [...ids].sort();
}

/**
 * Splits a comparison expression at the first top-level comparison operator.
 *
 * Operators inside quoted strings or nested brackets/parentheses are ignored.
 */
export function splitTopLevelComparison(expression: string): TopLevelComparisonSplit | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];

    if (quote) {
      if (char === quote && expression[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth > 0) {
      continue;
    }

    const operatorMatch = matchComparisonOperatorAt(expression, i);
    if (operatorMatch) {
      return {
        leftExpr: expression.slice(0, i).trim(),
        op: operatorMatch,
        rightExpr: expression.slice(i + operatorMatch.length).trim(),
      };
    }
  }

  return null;
}

function matchComparisonOperatorAt(expression: string, index: number): ComparisonOperator | null {
  const remaining = expression.slice(index);

  for (const operator of COMPARISON_OPERATORS) {
    if (remaining.startsWith(operator)) {
      return operator;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal: Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'DOT_PATH'
  | 'STRING_LITERAL'
  | 'NUMBER_LITERAL'
  | 'BOOLEAN_LITERAL'
  | 'COMPARISON_OP'
  | 'LOGICAL_OP'
  | 'NOT'
  | 'LPAREN'
  | 'RPAREN';

interface Token {
  type: TokenType;
  value: string;
}

/**
 * Tokenizes the expression string into a flat array of tokens.
 */
function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const src = expression.trim();

  while (pos < src.length) {
    // Skip whitespace
    if (/\s/.test(src[pos])) {
      pos++;
      continue;
    }

    // Logical AND
    if (src[pos] === '&' && src[pos + 1] === '&') {
      tokens.push({ type: 'LOGICAL_OP', value: '&&' });
      pos += 2;
      continue;
    }

    // Logical OR
    if (src[pos] === '|' && src[pos + 1] === '|') {
      tokens.push({ type: 'LOGICAL_OP', value: '||' });
      pos += 2;
      continue;
    }

    // Comparison operators (must check two-char before one-char)
    if (
      (src[pos] === '=' || src[pos] === '!' || src[pos] === '>' || src[pos] === '<') &&
      src[pos + 1] === '='
    ) {
      tokens.push({ type: 'COMPARISON_OP', value: src[pos] + '=' });
      pos += 2;
      continue;
    }
    if (src[pos] === '>' || src[pos] === '<') {
      tokens.push({ type: 'COMPARISON_OP', value: src[pos] });
      pos += 1;
      continue;
    }

    // Negation (standalone !)
    if (src[pos] === '!') {
      tokens.push({ type: 'NOT', value: '!' });
      pos += 1;
      continue;
    }

    // Parentheses
    if (src[pos] === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      pos += 1;
      continue;
    }
    if (src[pos] === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      pos += 1;
      continue;
    }

    // Single-quoted string literal
    if (src[pos] === "'") {
      const start = pos + 1;
      pos++;
      while (pos < src.length && src[pos] !== "'") {
        pos++;
      }
      tokens.push({ type: 'STRING_LITERAL', value: src.slice(start, pos) });
      pos++; // skip closing quote
      continue;
    }

    // Number literal (including decimals)
    if (
      /[0-9]/.test(src[pos]) ||
      (src[pos] === '-' && pos + 1 < src.length && /[0-9]/.test(src[pos + 1]))
    ) {
      const start = pos;
      if (src[pos] === '-') pos++;
      while (pos < src.length && /[0-9.]/.test(src[pos])) {
        pos++;
      }
      tokens.push({ type: 'NUMBER_LITERAL', value: src.slice(start, pos) });
      continue;
    }

    // Boolean literal or dot-path identifier
    if (/[a-zA-Z_]/.test(src[pos])) {
      const start = pos;
      while (pos < src.length && /[a-zA-Z0-9_.\-]/.test(src[pos])) {
        pos++;
      }
      const value = src.slice(start, pos);
      if (value === 'true' || value === 'false') {
        tokens.push({ type: 'BOOLEAN_LITERAL', value });
      } else {
        tokens.push({ type: 'DOT_PATH', value });
      }
      continue;
    }

    // Unknown character — skip (will be caught by safety check if needed)
    pos++;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Internal: Parser (recursive descent, simple precedence)
// ---------------------------------------------------------------------------

/**
 * AST node types for the expression tree.
 */
type ASTNode =
  | { type: 'comparison'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'logical'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'not'; operand: ASTNode }
  | { type: 'dot_path'; value: string }
  | { type: 'string_literal'; value: string }
  | { type: 'number_literal'; value: number }
  | { type: 'boolean_literal'; value: boolean };

interface ParseResult {
  node: ASTNode;
  pos: number;
}

/**
 * Parses an expression with logical operator precedence:
 *   Expression → LogicalOr
 *   LogicalOr → LogicalAnd ('||' LogicalAnd)*
 *   LogicalAnd → Unary ('&&' Unary)*
 *   Unary → '!' Unary | Comparison
 *   Comparison → Primary (CompOp Primary)?
 *   Primary → '(' Expression ')' | Literal | DotPath
 */
function parseExpression(tokens: Token[], pos: number): ParseResult {
  return parseLogicalOr(tokens, pos);
}

function parseLogicalOr(tokens: Token[], pos: number): ParseResult {
  let result = parseLogicalAnd(tokens, pos);

  while (
    result.pos < tokens.length &&
    tokens[result.pos].type === 'LOGICAL_OP' &&
    tokens[result.pos].value === '||'
  ) {
    const op = tokens[result.pos].value;
    const right = parseLogicalAnd(tokens, result.pos + 1);
    result = {
      node: { type: 'logical', op, left: result.node, right: right.node },
      pos: right.pos,
    };
  }

  return result;
}

function parseLogicalAnd(tokens: Token[], pos: number): ParseResult {
  let result = parseUnary(tokens, pos);

  while (
    result.pos < tokens.length &&
    tokens[result.pos].type === 'LOGICAL_OP' &&
    tokens[result.pos].value === '&&'
  ) {
    const op = tokens[result.pos].value;
    const right = parseUnary(tokens, result.pos + 1);
    result = {
      node: { type: 'logical', op, left: result.node, right: right.node },
      pos: right.pos,
    };
  }

  return result;
}

function parseUnary(tokens: Token[], pos: number): ParseResult {
  if (pos < tokens.length && tokens[pos].type === 'NOT') {
    const operand = parseComparison(tokens, pos + 1);
    return {
      node: { type: 'not', operand: operand.node },
      pos: operand.pos,
    };
  }
  return parseComparison(tokens, pos);
}

function parseComparison(tokens: Token[], pos: number): ParseResult {
  const left = parsePrimary(tokens, pos);

  if (left.pos < tokens.length && tokens[left.pos].type === 'COMPARISON_OP') {
    const op = tokens[left.pos].value;
    const right = parsePrimary(tokens, left.pos + 1);
    return {
      node: { type: 'comparison', op, left: left.node, right: right.node },
      pos: right.pos,
    };
  }

  return left;
}

function parsePrimary(tokens: Token[], pos: number): ParseResult {
  if (pos >= tokens.length) {
    throw new Error('Unexpected end of expression');
  }

  const token = tokens[pos];

  if (token.type === 'LPAREN') {
    const inner = parseExpression(tokens, pos + 1);
    if (inner.pos >= tokens.length || tokens[inner.pos].type !== 'RPAREN') {
      throw new Error('Expected closing parenthesis');
    }
    return { node: inner.node, pos: inner.pos + 1 };
  }

  if (token.type === 'STRING_LITERAL') {
    return {
      node: { type: 'string_literal', value: token.value },
      pos: pos + 1,
    };
  }

  if (token.type === 'NUMBER_LITERAL') {
    return {
      node: { type: 'number_literal', value: Number(token.value) },
      pos: pos + 1,
    };
  }

  if (token.type === 'BOOLEAN_LITERAL') {
    return {
      node: { type: 'boolean_literal', value: token.value === 'true' },
      pos: pos + 1,
    };
  }

  if (token.type === 'DOT_PATH') {
    return {
      node: { type: 'dot_path', value: token.value },
      pos: pos + 1,
    };
  }

  throw new Error(`Unexpected token: ${token.type} (${token.value})`);
}

// ---------------------------------------------------------------------------
// Internal: Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates an AST node against step outputs.
 * Returns a primitive value (boolean, number, string, or undefined).
 */
function evaluate(
  node: ASTNode,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): unknown {
  switch (node.type) {
    case 'string_literal':
      return node.value;

    case 'number_literal':
      return node.value;

    case 'boolean_literal':
      return node.value;

    case 'dot_path':
      return resolveExpression(node.value, stepOutputs, pipelineInput);

    case 'not': {
      const operand = evaluate(node.operand, stepOutputs, pipelineInput);
      return !operand;
    }

    case 'comparison': {
      const left = evaluate(node.left, stepOutputs, pipelineInput);
      const right = evaluate(node.right, stepOutputs, pipelineInput);
      return applyComparison(node.op, left, right);
    }

    case 'logical': {
      const left = evaluate(node.left, stepOutputs, pipelineInput);
      if (node.op === '&&') {
        // Short-circuit: if left is falsy, skip right
        if (!left) return false;
        return Boolean(evaluate(node.right, stepOutputs, pipelineInput));
      }
      if (node.op === '||') {
        // Short-circuit: if left is truthy, skip right
        if (left) return true;
        return Boolean(evaluate(node.right, stepOutputs, pipelineInput));
      }
      return false;
    }

    default:
      return undefined;
  }
}

/**
 * Applies a comparison operator to two values.
 */
function applyComparison(op: string, left: unknown, right: unknown): boolean {
  // For == and !=, use loose-ish comparison (string/number coercion)
  switch (op) {
    case '==':
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Internal: Utilities
// ---------------------------------------------------------------------------

/**
 * Splits a dot-path into segments, handling hyphenated step IDs correctly.
 *
 * "steps.eval-safety.output.scores.toxicity" →
 *   ["steps", "eval-safety", "output", "scores", "toxicity"]
 *
 * The step ID (segment 1) may contain hyphens, so we parse it specially:
 *   segments[0] = "steps"
 *   segments[1] = everything between first and second dot
 *   segments[2..] = remaining dot-separated parts
 */
function splitDotPath(path: string): string[] {
  // Find first dot (after "steps")
  const firstDot = path.indexOf('.');
  if (firstDot === -1) return [path];

  const prefix = path.slice(0, firstDot); // "steps"

  // Find second dot (after step ID — which may contain hyphens)
  const rest = path.slice(firstDot + 1);
  const secondDot = rest.indexOf('.');
  if (secondDot === -1) return [prefix, rest];

  const stepId = rest.slice(0, secondDot);
  const remaining = rest.slice(secondDot + 1);

  return [prefix, stepId, ...remaining.split('.')];
}
