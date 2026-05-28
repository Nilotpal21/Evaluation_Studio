/**
 * Lexer for Agent ABL using Chevrotain
 */

import { createToken, Lexer } from 'chevrotain';

// ============================================================================
// Whitespace and Comments
// ============================================================================

export const WhiteSpace = createToken({
  name: 'WhiteSpace',
  pattern: /[ \t]+/,
  group: Lexer.SKIPPED,
});

export const NewLine = createToken({
  name: 'NewLine',
  pattern: /\r?\n/,
});

export const Comment = createToken({
  name: 'Comment',
  pattern: /#[^\n\r]*/,
  group: Lexer.SKIPPED,
});

// ============================================================================
// Section Headers
// ============================================================================

export const SupervisorKeyword = createToken({ name: 'SupervisorKeyword', pattern: /SUPERVISOR:/ });
export const AgentKeyword = createToken({ name: 'AgentKeyword', pattern: /AGENT:/ });
export const StateKeyword = createToken({ name: 'StateKeyword', pattern: /STATE:/ });
export const AgentsKeyword = createToken({ name: 'AgentsKeyword', pattern: /AGENTS:/ });
export const IntentsKeyword = createToken({ name: 'IntentsKeyword', pattern: /INTENTS:/ });
export const PoliciesKeyword = createToken({ name: 'PoliciesKeyword', pattern: /POLICIES:/ });
export const CommunicationKeyword = createToken({
  name: 'CommunicationKeyword',
  pattern: /COMMUNICATION:/,
});
export const BehaviorKeyword = createToken({ name: 'BehaviorKeyword', pattern: /BEHAVIOR:/ });
export const IdentityKeyword = createToken({ name: 'IdentityKeyword', pattern: /IDENTITY:/ });
export const ContractKeyword = createToken({ name: 'ContractKeyword', pattern: /CONTRACT:/ });
export const ToolsKeyword = createToken({ name: 'ToolsKeyword', pattern: /TOOLS:/ });
export const StepsKeyword = createToken({ name: 'StepsKeyword', pattern: /STEPS:/ });
export const GuardrailsKeyword = createToken({ name: 'GuardrailsKeyword', pattern: /GUARDRAILS:/ });
export const TestsKeyword = createToken({ name: 'TestsKeyword', pattern: /TESTS:/ });

// ============================================================================
// Table Elements
// ============================================================================

export const Pipe = createToken({ name: 'Pipe', pattern: /\|/ });
export const TableSeparator = createToken({ name: 'TableSeparator', pattern: /\|[-:]+\|/ });

// ============================================================================
// Operators and Punctuation
// ============================================================================

export const Arrow = createToken({ name: 'Arrow', pattern: /→|->/ });
export const FatArrow = createToken({ name: 'FatArrow', pattern: /=>/ });
export const Colon = createToken({ name: 'Colon', pattern: /:/ });
export const Comma = createToken({ name: 'Comma', pattern: /,/ });
export const Dot = createToken({ name: 'Dot', pattern: /\./ });
export const Equals = createToken({ name: 'Equals', pattern: /==/ });
export const NotEquals = createToken({ name: 'NotEquals', pattern: /!=/ });
export const GreaterThanOrEqual = createToken({ name: 'GreaterThanOrEqual', pattern: />=/ });
export const LessThanOrEqual = createToken({ name: 'LessThanOrEqual', pattern: /<=/ });
export const GreaterThan = createToken({ name: 'GreaterThan', pattern: />/ });
export const LessThan = createToken({ name: 'LessThan', pattern: /</ });
export const Assignment = createToken({ name: 'Assignment', pattern: /=/ });
export const LParen = createToken({ name: 'LParen', pattern: /\(/ });
export const RParen = createToken({ name: 'RParen', pattern: /\)/ });
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ });
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ });
export const LBrace = createToken({ name: 'LBrace', pattern: /\{/ });
export const RBrace = createToken({ name: 'RBrace', pattern: /\}/ });
export const At = createToken({ name: 'At', pattern: /@/ });
export const Question = createToken({ name: 'Question', pattern: /\?/ });
export const Asterisk = createToken({ name: 'Asterisk', pattern: /\*/ });

// ============================================================================
// Identifiers (defined early so keywords can reference it for longer_alt)
// ============================================================================

export const Identifier = createToken({
  name: 'Identifier',
  pattern: /[a-zA-Z_][a-zA-Z0-9_]*/,
});

// ============================================================================
// Keywords (must come before Identifier in token list)
// Keywords are UPPERCASE only - lowercase words are identifiers
// Word boundary check (?![a-zA-Z0-9_]) prevents matching inside words
// ============================================================================

export const And = createToken({
  name: 'And',
  pattern: /AND(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Or = createToken({
  name: 'Or',
  pattern: /OR(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Not = createToken({
  name: 'Not',
  pattern: /NOT(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Is = createToken({
  name: 'Is',
  pattern: /IS(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Set = createToken({
  name: 'Set',
  pattern: /SET(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const In = createToken({
  name: 'In',
  pattern: /IN(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Contains = createToken({
  name: 'Contains',
  pattern: /CONTAINS(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Matches = createToken({
  name: 'Matches',
  pattern: /MATCHES(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// Action keywords - UPPERCASE only, word boundary check
export const Call = createToken({
  name: 'Call',
  pattern: /CALL(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Respond = createToken({
  name: 'Respond',
  pattern: /RESPOND(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const WaitInput = createToken({
  name: 'WaitInput',
  pattern: /WAIT_INPUT(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Goto = createToken({
  name: 'Goto',
  pattern: /GOTO(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Signal = createToken({
  name: 'Signal',
  pattern: /SIGNAL(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Classify = createToken({
  name: 'Classify',
  pattern: /CLASSIFY(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Intent = createToken({
  name: 'Intent',
  pattern: /INTENT(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Pattern = createToken({
  name: 'Pattern',
  pattern: /PATTERN(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// Route keywords
export const OnSuccess = createToken({
  name: 'OnSuccess',
  pattern: /ON_SUCCESS(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const OnFailure = createToken({
  name: 'OnFailure',
  pattern: /ON_FAILURE(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const MaxAttempts = createToken({
  name: 'MaxAttempts',
  pattern: /MAX_ATTEMPTS(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Default = createToken({
  name: 'Default',
  pattern: /DEFAULT(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// Input classifications
export const Positive = createToken({
  name: 'Positive',
  pattern: /POSITIVE(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Negative = createToken({
  name: 'Negative',
  pattern: /NEGATIVE(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// Boolean and null literals - lowercase for readability
export const True = createToken({
  name: 'True',
  pattern: /true(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const False = createToken({
  name: 'False',
  pattern: /false(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const Null = createToken({
  name: 'Null',
  pattern: /null(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// Type keywords - lowercase for readability
export const StringType = createToken({
  name: 'StringType',
  pattern: /string(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const NumberType = createToken({
  name: 'NumberType',
  pattern: /number(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const BooleanType = createToken({
  name: 'BooleanType',
  pattern: /boolean(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const DateType = createToken({
  name: 'DateType',
  pattern: /date(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const DatetimeType = createToken({
  name: 'DatetimeType',
  pattern: /datetime(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const ArrayType = createToken({
  name: 'ArrayType',
  pattern: /array(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});
export const EnumType = createToken({
  name: 'EnumType',
  pattern: /enum(?![a-zA-Z0-9_])/,
  longer_alt: Identifier,
});

// ============================================================================
// Literals
// ============================================================================

export const StepNumber = createToken({
  name: 'StepNumber',
  pattern: /\d+(?=\.(?!\d))/,
});

export const NumberLiteral = createToken({
  name: 'NumberLiteral',
  pattern: /-?\d+(\.\d+)?/,
});

export const StringLiteral = createToken({
  name: 'StringLiteral',
  pattern: /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/,
});

export const RegexLiteral = createToken({
  name: 'RegexLiteral',
  pattern: /\/([^\/\\]|\\.)+\/[gimsuy]*/,
});

// ============================================================================
// All Tokens (ORDER MATTERS!)
// ============================================================================

export const allTokens = [
  // Whitespace and comments first
  WhiteSpace,
  NewLine,
  Comment,

  // Section headers
  SupervisorKeyword,
  AgentKeyword,
  StateKeyword,
  AgentsKeyword,
  IntentsKeyword,
  PoliciesKeyword,
  CommunicationKeyword,
  BehaviorKeyword,
  IdentityKeyword,
  ContractKeyword,
  ToolsKeyword,
  StepsKeyword,
  GuardrailsKeyword,
  TestsKeyword,
  // Table elements
  TableSeparator,
  Pipe,

  // Multi-char operators first
  FatArrow,
  Arrow,
  Equals,
  NotEquals,
  GreaterThanOrEqual,
  LessThanOrEqual,
  GreaterThan,
  LessThan,
  Assignment,

  // Punctuation
  Colon,
  Comma,
  Dot,
  LParen,
  RParen,
  LBracket,
  RBracket,
  LBrace,
  RBrace,
  At,
  Question,
  Asterisk,

  // Keywords (before identifier)
  // Note: longer keywords must come before shorter prefixes
  // All keywords now have longer_alt: Identifier to prevent matching inside words
  And,
  Or,
  Not,
  Is,
  Set,
  Intent, // Must come before In
  In,
  Contains,
  Matches,
  Call,
  Respond,
  WaitInput,
  Goto,
  Signal,
  Classify,
  Pattern,

  // Route keywords
  OnSuccess,
  OnFailure,
  MaxAttempts,
  Default,
  // Input classifications
  Positive,
  Negative,
  True,
  False,
  Null,
  StringType,
  NumberType,
  BooleanType,
  DatetimeType, // Must come before DateType
  DateType,
  ArrayType,
  EnumType,

  // Literals
  StepNumber,
  NumberLiteral,
  StringLiteral,
  RegexLiteral,

  // Identifier last
  Identifier,
];

export const AgentDSLLexer = new Lexer(allTokens);

/**
 * Get the line content from input at a given offset
 */
function getLineContent(input: string, line: number): string {
  const lines = input.split('\n');
  if (line >= 1 && line <= lines.length) {
    return lines[line - 1];
  }
  return '';
}

/**
 * Create a pointer string showing where the error is
 */
function createPointer(column: number): string {
  return ' '.repeat(Math.max(0, column - 1)) + '^';
}

/**
 * Format a lexer error with helpful context
 */
function formatLexerError(
  input: string,
  error: { message: string; line?: number; column?: number; offset: number; length: number },
): string {
  const line = error.line || 1;
  const column = error.column || 1;
  const lineContent = getLineContent(input, line);
  const charAtOffset = input.charAt(error.offset);

  // Determine what kind of character caused the error
  let suggestion = '';
  // Unicode arrow
  if (charAtOffset === '\u2192') {
    suggestion = '\n  Hint: Use ASCII arrow "->" instead of Unicode arrow';
    // En-dash or em-dash
  } else if (charAtOffset === '\u2013' || charAtOffset === '\u2014') {
    suggestion = '\n  Hint: Use regular hyphen "-" instead of special dash character';
    // Curly double quotes
  } else if (charAtOffset === '\u201C' || charAtOffset === '\u201D') {
    suggestion = '\n  Hint: Use straight quotes (") instead of curly quotes';
    // Curly single quotes
  } else if (charAtOffset === '\u2018' || charAtOffset === '\u2019') {
    suggestion = "\n  Hint: Use straight apostrophe (') instead of curly quotes";
  } else if (
    charAtOffset === '-' &&
    input.substring(error.offset, error.offset + 3).match(/^-+$/)
  ) {
    suggestion =
      '\n  Hint: Markdown table separators are not supported. Use simple list syntax instead.';
  } else if (/[^\x00-\x7F]/.test(charAtOffset)) {
    suggestion = '\n  Hint: Non-ASCII character detected. Use only ASCII characters in ABL.';
  }

  return `Line ${line}, Column ${column}: Unexpected character '${charAtOffset}'
  ${lineContent}
  ${createPointer(column)}${suggestion}`;
}

/**
 * Tokenize ABL input
 */
export function tokenize(input: string) {
  const result = AgentDSLLexer.tokenize(input);

  if (result.errors.length > 0) {
    const errors = result.errors.map((e) => ({
      message: formatLexerError(input, e),
      line: e.line,
      column: e.column,
      offset: e.offset,
      length: e.length,
    }));
    return { tokens: result.tokens, errors };
  }

  return { tokens: result.tokens, errors: [] };
}

/**
 * Format a parser error with helpful context
 */
export function formatParserError(
  input: string,
  error: { message: string; token?: { startLine?: number; startColumn?: number; image?: string } },
): string {
  const line = error.token?.startLine || 1;
  const column = error.token?.startColumn || 1;
  const lineContent = getLineContent(input, line);
  const tokenImage = error.token?.image || '';

  // Clean up Chevrotain's error message
  let message = error.message;

  // Make "Expecting token of type" errors more readable
  if (message.includes('Expecting token of type')) {
    const match = message.match(
      /Expecting token of type --> (\w+) <-- but found --> '([^']+)' <--/,
    );
    if (match) {
      const expectedToken = match[1];
      const foundToken = match[2];
      message = `Expected ${expectedToken} but found '${foundToken}'`;
    }
  }

  // Make "Expecting one of these possible Token sequences" errors more readable
  if (message.includes('Expecting: one of these possible Token sequences')) {
    const parts = message.split('but found:');
    if (parts.length === 2) {
      const foundToken = parts[1].trim().replace(/^'|'$/g, '');
      message = `Unexpected token '${foundToken}'. This keyword may not be allowed here.`;
    }
  }

  // Make "Redundant input" errors more readable
  if (message.includes('Redundant input, expecting EOF')) {
    const match = message.match(/found: (\w+)/);
    if (match) {
      message = `Unexpected '${match[1]}' - check if this belongs inside a CLASSIFY block instead of WAIT_INPUT`;
    }
  }

  return `Line ${line}, Column ${column}: ${message}
  ${lineContent}
  ${createPointer(column)}`;
}
