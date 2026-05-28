import { describe, test, expect } from 'vitest';
import { migrateAgentExpressions } from '../../tools/migrate-expressions.js';

describe('Agent Expression Migration', () => {
  // =========================================================================
  // CONSTRAINT CONDITIONS (REQUIRE)
  // =========================================================================

  test('migrates quoted REQUIRE constraint conditions', () => {
    const dsl = [
      'AGENT: TestAgent',
      'GOAL: "Help"',
      'CONSTRAINTS:',
      '  - REQUIRE: "age >= 18 AND verified IS SET"',
      '    ON_FAIL: RESPOND "Must be 18+"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('age >= 18 && has(verified)');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('constraint condition');
    expect(result.changes[0].original).toBe('age >= 18 AND verified IS SET');
    expect(result.changes[0].migrated).toBe('age >= 18 && has(verified)');
    expect(result.errors).toHaveLength(0);
  });

  test('migrates unquoted REQUIRE constraint conditions', () => {
    const dsl = [
      'AGENT: TestAgent',
      'CONSTRAINTS:',
      '  - REQUIRE num_guests <= 10 AND destination IS SET',
      '    ON_FAIL: RESPOND "Invalid"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('num_guests <= 10 && has(destination)');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('constraint condition');
  });

  test('migrates IS NOT SET in constraints', () => {
    const dsl = [
      'CONSTRAINTS:',
      '  - REQUIRE: "email IS NOT SET"',
      '    ON_FAIL: RESPOND "Email required"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('!has(email)');
    expect(result.changes).toHaveLength(1);
  });

  // =========================================================================
  // COMPLETION CONDITIONS (WHEN)
  // =========================================================================

  test('migrates completion conditions with WHEN', () => {
    const dsl = [
      'AGENT: TestAgent',
      'GOAL: "Help"',
      'COMPLETE:',
      '  - WHEN: task_done AND UPPER(status) == "COMPLETE"',
      '    RESPOND: "Done"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('task_done && abl.upper(status) == "COMPLETE"');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('completion condition');
  });

  test('migrates WHEN with CONTAINS', () => {
    const dsl = [
      'HANDOFF:',
      '  - TO: Hotel_Search',
      '    WHEN: intent CONTAINS "hotel" OR intent CONTAINS "stay"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('intent.contains("hotel") || intent.contains("stay")');
    expect(result.changes).toHaveLength(1);
  });

  test('migrates WHEN with MATCHES', () => {
    const dsl = ['HANDOFF:', '  - TO: Support', '    WHEN: email MATCHES "^[a-z]+@"'].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('email.matches("^[a-z]+@")');
    expect(result.changes).toHaveLength(1);
  });

  // =========================================================================
  // SET EXPRESSIONS
  // =========================================================================

  test('migrates SET expressions with arithmetic functions', () => {
    const dsl = [
      'AGENT: TestAgent',
      'GOAL: "Help"',
      'FLOW:',
      '  1. welcome',
      '    SET: total = ADD(price, tax)',
      '    THEN: next',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('total = price + tax');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('set expression');
    expect(result.changes[0].original).toBe('ADD(price, tax)');
    expect(result.changes[0].migrated).toBe('price + tax');
  });

  test('migrates SET with SUB function', () => {
    const dsl = '    SET: remaining = SUB(budget, spent)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('remaining = budget - spent');
    expect(result.changes).toHaveLength(1);
  });

  test('migrates SET with MUL function', () => {
    const dsl = '    SET: total = MUL(quantity, unit_price)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('total = quantity * unit_price');
  });

  test('migrates SET with DIV function', () => {
    const dsl = '    SET: average = DIV(total, count)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('average = total / count');
  });

  test('migrates SET with ABL namespace functions', () => {
    const dsl = '    SET: name = UPPER(first_name)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('name = abl.upper(first_name)');
  });

  test('migrates SET with LENGTH function', () => {
    const dsl = '    SET: count = LENGTH(items)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('count = size(items)');
  });

  // =========================================================================
  // CHECK EXPRESSIONS
  // =========================================================================

  test('migrates CHECK expressions', () => {
    const dsl = [
      '  collect_trip_info:',
      '    CHECK: num_guests <= 10 AND destination IS SET',
      '    ON_FAIL: collect_trip_info',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('num_guests <= 10 && has(destination)');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('check expression');
  });

  // =========================================================================
  // IF CONDITIONS
  // =========================================================================

  test('migrates IF conditions in ON_INPUT', () => {
    const dsl = [
      '  ON_INPUT:',
      '    - IF: input CONTAINS "confirm" OR input CONTAINS "yes"',
      '      THEN: confirm_booking',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('input.contains("confirm") || input.contains("yes")');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].context).toBe('if condition');
  });

  // =========================================================================
  // PRESERVATION (no changes)
  // =========================================================================

  test('preserves non-expression lines', () => {
    const dsl = ['AGENT: TestAgent', 'GOAL: "Help users"', 'PERSONA: "A helper"'].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toBe(dsl);
    expect(result.changes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('preserves already-migrated CEL expressions', () => {
    const dsl = [
      'CONSTRAINTS:',
      '  - REQUIRE: "age >= 18 && has(verified)"',
      '    ON_FAIL: RESPOND "Must be 18+"',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toBe(dsl);
    expect(result.changes).toHaveLength(0);
  });

  test('preserves WHEN conditions that are already CEL', () => {
    const dsl = ['COMPLETE:', '  - WHEN: booking_confirmed == true', '    RESPOND: "Done"'].join(
      '\n',
    );

    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toBe(dsl);
    expect(result.changes).toHaveLength(0);
  });

  // =========================================================================
  // MULTI-EXPRESSION FILES
  // =========================================================================

  test('migrates multiple expressions in one file', () => {
    const dsl = [
      'AGENT: MultiExpr',
      'GOAL: "Test"',
      '',
      'CONSTRAINTS:',
      '  - REQUIRE: "age >= 18 AND name IS SET"',
      '    ON_FAIL: RESPOND "Invalid"',
      '',
      'COMPLETE:',
      '  - WHEN: done AND LENGTH(results) > 0',
      '    RESPOND: "Complete"',
      '',
      'FLOW:',
      '  calc:',
      '    SET: total = ADD(price, tax)',
      '    CHECK: total <= 5000 AND budget IS SET',
      '    THEN: confirm',
    ].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.changes).toHaveLength(4);

    // Verify each context was migrated
    const contexts = result.changes.map((c) => c.context);
    expect(contexts).toContain('constraint condition');
    expect(contexts).toContain('completion condition');
    expect(contexts).toContain('set expression');
    expect(contexts).toContain('check expression');

    // Verify actual content
    expect(result.migratedContent).toContain('age >= 18 && has(name)');
    expect(result.migratedContent).toContain('done && size(results) > 0');
    expect(result.migratedContent).toContain('total = price + tax');
    expect(result.migratedContent).toContain('total <= 5000 && has(budget)');
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================

  test('handles empty DSL content', () => {
    const result = migrateAgentExpressions('');
    expect(result.migratedContent).toBe('');
    expect(result.changes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('handles DSL with only comments', () => {
    const dsl = '# This is a comment\n# Another comment';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toBe(dsl);
    expect(result.changes).toHaveLength(0);
  });

  test('preserves indentation in migrated lines', () => {
    const dsl = '      SET: total = ADD(a, b)';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toBe('      SET: total = a + b');
  });

  test('migrates NOT operator in conditions', () => {
    const dsl = '    WHEN: NOT cancelled AND active';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('!cancelled && active');
  });

  test('migrates FORMAT_CURRENCY in SET', () => {
    const dsl = '    SET: display = FORMAT_CURRENCY(total, "USD")';
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('display = abl.format_currency(total, "USD")');
  });

  test('change line numbers are 1-based', () => {
    const dsl = ['AGENT: Test', 'GOAL: "Help"', '  - REQUIRE: "x IS SET"'].join('\n');

    const result = migrateAgentExpressions(dsl);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].line).toBe(3); // 1-based line number
  });
});
