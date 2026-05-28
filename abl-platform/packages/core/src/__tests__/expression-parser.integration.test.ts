import { describe, expect, test } from 'vitest';
import { expressionToPython, parseExpression } from '../parser/expression-parser.js';

describe('expression parser integration', () => {
  test('preserves NOT IN through Python emission', () => {
    const expr = parseExpression('user.role NOT IN ["admin", "moderator"]');

    expect(expressionToPython(expr)).toBe('(state["user"]["role"] not in ["admin", "moderator"])');
  });

  test('does not split AND and OR tokens inside quoted strings', () => {
    const expr = parseExpression(
      'message.title == "A OR B" AND ticket.status == "ready AND waiting"',
    );

    expect(expressionToPython(expr)).toBe(
      '((state["message"]["title"] == "A OR B") and (state["ticket"]["status"] == "ready AND waiting"))',
    );
  });
});
