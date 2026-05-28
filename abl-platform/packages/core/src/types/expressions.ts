/**
 * Expression types for Agent ABL conditions and values
 */

/**
 * Comparison operators for conditions
 */
export type ComparisonOperator =
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'in'
  | 'not_in'
  | 'matches'
  | 'contains';

/**
 * Logical operators
 */
export type LogicalOperator = 'and' | 'or' | 'not';

/**
 * String literal value
 */
export interface StringLiteral {
  kind: 'string';
  value: string;
}

/**
 * Number literal value
 */
export interface NumberLiteral {
  kind: 'number';
  value: number;
}

/**
 * Boolean literal value
 */
export interface BooleanLiteral {
  kind: 'boolean';
  value: boolean;
}

/**
 * Null literal value
 */
export interface NullLiteral {
  kind: 'null';
}

/**
 * Array literal value
 */
export interface ArrayLiteral {
  kind: 'array';
  values: LiteralValue[];
}

/**
 * Union of all literal values
 */
export type LiteralValue =
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | ArrayLiteral;

/**
 * Variable reference (dot-notation path)
 */
export interface VariableRef {
  kind: 'variable';
  path: string[]; // e.g., ['user', 'is_validated'] for user.is_validated
}

/**
 * Function call expression
 */
export interface FunctionCall {
  kind: 'function';
  name: string;
  arguments: Expression[];
}

/**
 * Binary expression
 */
export interface BinaryExpression {
  kind: 'binary';
  operator: ComparisonOperator | LogicalOperator;
  left: Expression;
  right: Expression;
}

/**
 * Unary expression
 */
export interface UnaryExpression {
  kind: 'unary';
  operator: 'not' | 'exists' | 'empty';
  operand: Expression;
}

/**
 * Template string with interpolation
 */
export interface TemplateString {
  kind: 'template';
  parts: (string | Expression)[];
}

/**
 * Wildcard expression (matches anything)
 */
export interface WildcardExpression {
  kind: 'wildcard';
}

/**
 * Union of all expression types
 */
export type Expression =
  | LiteralValue
  | VariableRef
  | FunctionCall
  | BinaryExpression
  | UnaryExpression
  | TemplateString
  | WildcardExpression;

/**
 * Condition is an expression that evaluates to boolean
 */
export type Condition = Expression;

/**
 * Helper to create a variable reference
 */
export function varRef(path: string | string[]): VariableRef {
  return {
    kind: 'variable',
    path: typeof path === 'string' ? path.split('.') : path,
  };
}

/**
 * Helper to create a string literal
 */
export function str(value: string): StringLiteral {
  return { kind: 'string', value };
}

/**
 * Helper to create a number literal
 */
export function num(value: number): NumberLiteral {
  return { kind: 'number', value };
}

/**
 * Helper to create a boolean literal
 */
export function bool(value: boolean): BooleanLiteral {
  return { kind: 'boolean', value };
}

/**
 * Helper to create an equality comparison
 */
export function eq(left: Expression, right: Expression): BinaryExpression {
  return { kind: 'binary', operator: '==', left, right };
}

/**
 * Helper to create an AND expression
 */
export function and(left: Expression, right: Expression): BinaryExpression {
  return { kind: 'binary', operator: 'and', left, right };
}

/**
 * Helper to create an OR expression
 */
export function or(left: Expression, right: Expression): BinaryExpression {
  return { kind: 'binary', operator: 'or', left, right };
}

/**
 * Helper to create a NOT expression
 */
export function not(operand: Expression): UnaryExpression {
  return { kind: 'unary', operator: 'not', operand };
}

/**
 * Helper to create an EXISTS check
 */
export function exists(operand: Expression): UnaryExpression {
  return { kind: 'unary', operator: 'exists', operand };
}

/**
 * Check if expression is a wildcard
 */
export function isWildcard(expr: Expression): expr is WildcardExpression {
  return expr.kind === 'wildcard';
}

/**
 * Convert expression to human-readable string
 */
export function expressionToString(expr: Expression): string {
  switch (expr.kind) {
    case 'string':
      return `"${expr.value}"`;
    case 'number':
      return String(expr.value);
    case 'boolean':
      return String(expr.value);
    case 'null':
      return 'null';
    case 'array':
      return `[${expr.values.map(expressionToString).join(', ')}]`;
    case 'variable':
      return expr.path.join('.');
    case 'function':
      return `${expr.name}(${expr.arguments.map(expressionToString).join(', ')})`;
    case 'binary':
      return `(${expressionToString(expr.left)} ${expr.operator.toUpperCase()} ${expressionToString(expr.right)})`;
    case 'unary':
      return `${expr.operator.toUpperCase()} ${expressionToString(expr.operand)}`;
    case 'template':
      return expr.parts
        .map((p) => (typeof p === 'string' ? p : `\${${expressionToString(p)}}`))
        .join('');
    case 'wildcard':
      return '*';
    default:
      return '<?>';
  }
}
