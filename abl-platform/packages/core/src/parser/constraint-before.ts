import type { ConstraintBeforeTarget } from '../types/agent-based.js';

const BEFORE_KEYWORD = 'BEFORE';
const WHEN_KEYWORD = 'WHEN';
const IMPLIES_KEYWORD = 'IMPLIES';

export function parseConstraintBeforeTarget(raw: string): ConstraintBeforeTarget {
  const trimmed = raw.trim();
  const toolMatch = trimmed.match(/^(?:calling|call|tool)\s+([A-Za-z_]\w*)(?:\(\))?$/i);
  if (toolMatch) {
    return {
      kind: 'tool_call',
      raw: trimmed,
      target: toolMatch[1],
    };
  }

  if (/^(?:returning(?:\s+the)?\s+results?|respond|response|return_results)$/i.test(trimmed)) {
    return {
      kind: 'respond',
      raw: trimmed,
    };
  }

  return {
    kind: 'unsupported',
    raw: trimmed,
  };
}

export function splitConstraintBeforeClause(expression: string): {
  condition: string;
  before?: ConstraintBeforeTarget;
} {
  const beforeIndex = findTopLevelKeyword(expression, BEFORE_KEYWORD);
  if (beforeIndex < 0) {
    return { condition: expression.trim() };
  }

  const condition = expression.slice(0, beforeIndex).trim();
  const rawTarget = expression.slice(beforeIndex + BEFORE_KEYWORD.length).trim();

  if (!condition || !rawTarget) {
    return { condition: expression.trim() };
  }

  return {
    condition,
    before: parseConstraintBeforeTarget(rawTarget),
  };
}

export function splitConstraintInlineClauses(expression: string): {
  condition: string;
  when?: string;
  before?: ConstraintBeforeTarget;
} {
  const whenIndex = findTopLevelKeyword(expression, WHEN_KEYWORD);
  const conditionSource =
    whenIndex >= 0 ? expression.slice(0, whenIndex).trim() : expression.trim();
  const rawWhen =
    whenIndex >= 0
      ? expression
          .slice(whenIndex + WHEN_KEYWORD.length)
          .replace(/^:/, '')
          .trim()
      : '';

  const beforeSplit =
    conditionSource && rawWhen
      ? splitConstraintBeforeClause(conditionSource)
      : splitConstraintBeforeClause(expression);

  // Lower IMPLIES: "A IMPLIES B" → "NOT (A) OR (B)"
  const condition = lowerImplies(beforeSplit.condition);

  return {
    condition,
    ...(rawWhen ? { when: rawWhen } : {}),
    ...(beforeSplit.before ? { before: beforeSplit.before } : {}),
  };
}

/**
 * Lower IMPLIES keyword: "A IMPLIES B" → "NOT (A) OR (B)"
 * If no IMPLIES keyword found, returns the condition unchanged.
 */
function lowerImplies(condition: string): string {
  const impliesIndex = findTopLevelKeyword(condition, IMPLIES_KEYWORD);
  if (impliesIndex < 0) return condition;

  const antecedent = condition.slice(0, impliesIndex).trim();
  const consequent = condition.slice(impliesIndex + IMPLIES_KEYWORD.length).trim();

  if (!antecedent || !consequent) return condition;

  return `NOT (${antecedent}) OR (${consequent})`;
}

function findTopLevelKeyword(expression: string, keyword: string): number {
  const upperKeyword = keyword.toUpperCase();
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i <= expression.length - upperKeyword.length; i++) {
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

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth > 0) {
      continue;
    }

    if (
      expression.slice(i, i + upperKeyword.length).toUpperCase() === upperKeyword &&
      !isIdentifierChar(expression[i - 1]) &&
      !isIdentifierChar(expression[i + upperKeyword.length])
    ) {
      return i;
    }
  }

  return -1;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}
