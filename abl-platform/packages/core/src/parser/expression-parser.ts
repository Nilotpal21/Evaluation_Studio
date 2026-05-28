/**
 * Expression parser utilities
 */

import type {
  Expression,
  Condition,
  BinaryExpression,
  UnaryExpression,
  VariableRef,
  LiteralValue,
  ComparisonOperator,
  LogicalOperator,
} from '../types/expressions.js';

/**
 * Parse a condition string into an Expression AST
 */
export function parseCondition(conditionStr: string): Condition {
  const trimmed = conditionStr.trim();

  // Handle wildcard
  if (trimmed === '*') {
    return { kind: 'wildcard' };
  }

  return parseOrExpression(trimmed);
}

/**
 * Parse an expression string into an Expression AST
 */
export function parseExpression(exprStr: string): Expression {
  return parseOrExpression(exprStr.trim());
}

/**
 * Parse OR expression
 */
function parseOrExpression(str: string): Expression {
  const parts = splitByOperator(str, /\bOR\b/i);

  if (parts.length === 1) {
    return parseAndExpression(parts[0]);
  }

  let result: Expression = parseAndExpression(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    result = {
      kind: 'binary',
      operator: 'or',
      left: result,
      right: parseAndExpression(parts[i]),
    };
  }
  return result;
}

/**
 * Parse AND expression
 */
function parseAndExpression(str: string): Expression {
  const parts = splitByOperator(str, /\bAND\b/i);

  if (parts.length === 1) {
    return parseUnaryExpression(parts[0]);
  }

  let result: Expression = parseUnaryExpression(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    result = {
      kind: 'binary',
      operator: 'and',
      left: result,
      right: parseUnaryExpression(parts[i]),
    };
  }
  return result;
}

/**
 * Parse unary expression (NOT)
 */
function parseUnaryExpression(str: string): Expression {
  const trimmed = str.trim();

  if (trimmed.toUpperCase().startsWith('NOT ')) {
    return {
      kind: 'unary',
      operator: 'not',
      operand: parseComparisonExpression(trimmed.slice(4)),
    };
  }

  return parseComparisonExpression(trimmed);
}

/**
 * Parse comparison expression
 */
function parseComparisonExpression(str: string): Expression {
  const trimmed = str.trim();

  // Handle parentheses - must check for balanced parens, not just start/end
  if (trimmed.startsWith('(') && isBalancedParens(trimmed)) {
    // Extract inner content, handling the case where outer parens wrap the whole expression
    const inner = extractParenContent(trimmed);
    if (inner !== null) {
      return parseOrExpression(inner);
    }
  }

  // Check for IS SET / IS NOT SET
  const isSetMatch = trimmed.match(/^(.+?)\s+IS\s+(NOT\s+)?SET$/i);
  if (isSetMatch) {
    const operand = parsePrimaryExpression(isSetMatch[1]);
    if (isSetMatch[2]) {
      return {
        kind: 'unary',
        operator: 'not',
        operand: { kind: 'unary', operator: 'exists', operand },
      };
    }
    return { kind: 'unary', operator: 'exists', operand };
  }

  const comparisonMatch = findTopLevelComparisonOperator(trimmed);
  if (comparisonMatch) {
    const left = trimmed.slice(0, comparisonMatch.index);
    const right = trimmed.slice(comparisonMatch.index + comparisonMatch.length);
    return {
      kind: 'binary',
      operator: comparisonMatch.op,
      left: parsePrimaryExpression(left),
      right: parsePrimaryExpression(right),
    };
  }

  return parsePrimaryExpression(trimmed);
}

/**
 * Parse primary expression (variable, literal, function call)
 */
function parsePrimaryExpression(str: string): Expression {
  const trimmed = str.trim();

  // Handle parentheses - must check for balanced parens
  if (trimmed.startsWith('(') && isBalancedParens(trimmed)) {
    const inner = extractParenContent(trimmed);
    if (inner !== null) {
      return parseOrExpression(inner);
    }
  }

  // String literal
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return {
      kind: 'string',
      value: trimmed.slice(1, -1),
    };
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return {
      kind: 'number',
      value: parseFloat(trimmed),
    };
  }

  // Boolean literals
  if (trimmed.toLowerCase() === 'true') {
    return { kind: 'boolean', value: true };
  }
  if (trimmed.toLowerCase() === 'false') {
    return { kind: 'boolean', value: false };
  }

  // Null literal
  if (trimmed.toLowerCase() === 'null') {
    return { kind: 'null' };
  }

  // Array literal
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') {
      return { kind: 'array', values: [] };
    }
    const items = splitByComma(inner);
    return {
      kind: 'array',
      values: items.map((item) => parsePrimaryExpression(item)) as LiteralValue[],
    };
  }

  // Function call - use balanced paren matching for nested functions
  const funcMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  if (funcMatch) {
    const name = funcMatch[1];
    const argsStart = funcMatch[0].length;
    const argsContent = extractFunctionArgs(trimmed.slice(argsStart - 1));
    if (argsContent !== null) {
      const argsStr = argsContent.trim();
      const args = argsStr ? splitByComma(argsStr).map((a) => parsePrimaryExpression(a)) : [];
      return {
        kind: 'function',
        name,
        arguments: args,
      };
    }
  }

  // Variable reference (dot notation)
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) {
    return {
      kind: 'variable',
      path: trimmed.split('.'),
    };
  }

  // Fallback: treat as string
  return { kind: 'string', value: trimmed };
}

/**
 * Split by operator while respecting parentheses
 */
function splitByOperator(str: string, pattern: RegExp): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
      current += char;
      i++;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
      current += char;
      i++;
    } else if (!inString && (char === '(' || char === '[')) {
      depth++;
      current += char;
      i++;
    } else if (!inString && (char === ')' || char === ']')) {
      depth--;
      current += char;
      i++;
    } else if (!inString && depth === 0) {
      // Check for operator match
      const remaining = str.slice(i);
      const match = remaining.match(pattern);

      if (match && match.index === 0) {
        parts.push(current.trim());
        current = '';
        i += match[0].length;
      } else {
        current += char;
        i++;
      }
    } else {
      current += char;
      i++;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

interface ComparisonOperatorMatch {
  index: number;
  length: number;
  op: ComparisonOperator;
}

function findTopLevelComparisonOperator(str: string): ComparisonOperatorMatch | null {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
    } else if (!inString && (char === '(' || char === '[' || char === '{')) {
      depth++;
    } else if (!inString && (char === ')' || char === ']' || char === '}')) {
      depth--;
    } else if (!inString && depth === 0) {
      const operatorMatch = matchComparisonOperatorAt(str, i);
      if (operatorMatch) {
        return operatorMatch;
      }
    }
  }

  return null;
}

function matchComparisonOperatorAt(str: string, index: number): ComparisonOperatorMatch | null {
  const remaining = str.slice(index);

  if (remaining.startsWith('==')) {
    return { index, length: 2, op: '==' };
  }
  if (remaining.startsWith('!=')) {
    return { index, length: 2, op: '!=' };
  }
  if (remaining.startsWith('>=')) {
    return { index, length: 2, op: '>=' };
  }
  if (remaining.startsWith('<=')) {
    return { index, length: 2, op: '<=' };
  }
  if (remaining.startsWith('>')) {
    return { index, length: 1, op: '>' };
  }
  if (remaining.startsWith('<')) {
    return { index, length: 1, op: '<' };
  }

  const wordBoundaryBefore = index === 0 || /\s/.test(str[index - 1] ?? '');
  if (!wordBoundaryBefore) {
    return null;
  }

  const wordOperators: Array<{ pattern: RegExp; op: ComparisonOperator }> = [
    { pattern: /^NOT\s+IN(?=\s)/i, op: 'not_in' },
    { pattern: /^IN(?=\s)/i, op: 'in' },
    { pattern: /^CONTAINS(?=\s)/i, op: 'contains' },
    { pattern: /^MATCHES(?=\s)/i, op: 'matches' },
  ];

  for (const { pattern, op } of wordOperators) {
    const match = remaining.match(pattern);
    if (match) {
      return { index, length: match[0].length, op };
    }
  }

  return null;
}

/**
 * Split by comma while respecting parentheses and brackets
 */
function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
      current += char;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
      current += char;
    } else if (!inString && (char === '(' || char === '[' || char === '{')) {
      depth++;
      current += char;
    } else if (!inString && (char === ')' || char === ']' || char === '}')) {
      depth--;
      current += char;
    } else if (!inString && depth === 0 && char === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Convert Expression to Python code
 */
export function expressionToPython(expr: Expression): string {
  switch (expr.kind) {
    case 'string':
      return `"${expr.value.replace(/"/g, '\\"')}"`;
    case 'number':
      return String(expr.value);
    case 'boolean':
      return expr.value ? 'True' : 'False';
    case 'null':
      return 'None';
    case 'array':
      return `[${expr.values.map(expressionToPython).join(', ')}]`;
    case 'variable':
      return `state["${expr.path[0]}"]["${expr.path.slice(1).join('"]["')}"]`;
    case 'function':
      return `${expr.name}(${expr.arguments.map(expressionToPython).join(', ')})`;
    case 'binary': {
      const left = expressionToPython(expr.left);
      const right = expressionToPython(expr.right);
      if (expr.operator === 'contains') {
        return `(${right} in ${left})`;
      }
      const op = pythonOperator(expr.operator);
      return `(${left} ${op} ${right})`;
    }
    case 'unary': {
      const operand = expressionToPython(expr.operand);
      const operator = expr.operator as string;
      switch (expr.operator) {
        case 'not':
          return `not ${operand}`;
        case 'exists':
          return `${operand} is not None`;
        case 'empty':
          return `len(${operand}) == 0`;
        default:
          throw new Error(`Unknown unary operator: ${operator}`);
      }
    }
    case 'template':
      // Convert to f-string
      const parts = expr.parts.map((p) =>
        typeof p === 'string' ? p : `{${expressionToPython(p)}}`,
      );
      return `f"${parts.join('')}"`;
    case 'wildcard':
      return 'True';
    default:
      return 'None';
  }
}

/**
 * Convert operator to Python equivalent
 */
function pythonOperator(op: ComparisonOperator | LogicalOperator): string {
  const mapping: Record<string, string> = {
    '==': '==',
    '!=': '!=',
    '>': '>',
    '<': '<',
    '>=': '>=',
    '<=': '<=',
    in: 'in',
    not_in: 'not in',
    contains: 'in',
    matches: '~',
    and: 'and',
    or: 'or',
  };
  return mapping[op] ?? op;
}

/**
 * Check if parentheses in a string are balanced
 */
function isBalancedParens(str: string): boolean {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
    } else if (!inString) {
      if (char === '(' || char === '[' || char === '{') {
        depth++;
      } else if (char === ')' || char === ']' || char === '}') {
        depth--;
        if (depth < 0) return false;
      }
    }
  }

  return depth === 0;
}

/**
 * Extract content inside outermost balanced parentheses
 * Returns null if the string doesn't start with '(' or parens are unbalanced
 */
function extractParenContent(str: string): string | null {
  if (!str.startsWith('(')) return null;

  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
    } else if (!inString) {
      if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth === 0) {
          // Check if this closing paren is at the end
          if (i === str.length - 1) {
            return str.slice(1, -1);
          }
          // Not at end, so outer parens don't wrap whole expression
          return null;
        }
      }
    }
  }

  return null; // Unbalanced
}

/**
 * Extract function arguments from a string starting with '('
 * Returns the content between balanced parentheses, or null if unbalanced
 */
function extractFunctionArgs(str: string): string | null {
  if (!str.startsWith('(')) return null;

  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && !isEscapedCharacter(str, i)) {
      inString = false;
    } else if (!inString) {
      if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth === 0) {
          return str.slice(1, i);
        }
      }
    }
  }

  return null; // Unbalanced
}

function isEscapedCharacter(str: string, index: number): boolean {
  let backslashCount = 0;

  for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) {
    backslashCount++;
  }

  return backslashCount % 2 === 1;
}
