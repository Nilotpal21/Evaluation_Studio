import { describe, test, expect } from 'vitest';
import { evaluateConditionDual, resolveValueDual } from '@abl/compiler';

describe('CEL Runtime Integration', () => {
  const sessionContext = {
    user: { name: 'John', age: 25, email: 'john@example.com' },
    claim: { status: 'pending', amount: 1500 },
    gathered: { policy_number: 'POL-123' },
  };

  test('evaluates CEL constraint conditions with nested paths', () => {
    expect(
      evaluateConditionDual('user.age >= 18 && has(gathered.policy_number)', sessionContext),
    ).toBe(true);
  });

  test('evaluates CEL with abl.* functions in runtime context', () => {
    expect(evaluateConditionDual('abl.upper(claim.status) == "PENDING"', sessionContext)).toBe(
      true,
    );
  });

  test('resolves CEL value expressions for SET assignments', () => {
    expect(resolveValueDual('abl.format_currency(claim.amount, "USD")', sessionContext)).toContain(
      '1,500',
    );
  });

  test('legacy ABL expressions still work via migration', () => {
    expect(
      evaluateConditionDual('user.age >= 18 AND gathered.policy_number IS SET', sessionContext),
    ).toBe(true);
    expect(resolveValueDual('UPPER(user.name)', sessionContext)).toBe('JOHN');
  });

  test('evaluates comparisons with context numbers', () => {
    expect(evaluateConditionDual('claim.amount > 1000', sessionContext)).toBe(true);
    expect(evaluateConditionDual('claim.amount < 500', sessionContext)).toBe(false);
  });

  test('evaluates string methods on nested paths', () => {
    expect(evaluateConditionDual('user.email.contains("@")', sessionContext)).toBe(true);
    expect(evaluateConditionDual('user.name.startsWith("Jo")', sessionContext)).toBe(true);
  });

  test('evaluates in operator with nested values', () => {
    expect(evaluateConditionDual('claim.status in ["pending", "approved"]', sessionContext)).toBe(
      true,
    );
    expect(evaluateConditionDual('claim.status in ["approved", "denied"]', sessionContext)).toBe(
      false,
    );
  });

  // --- Error path and fallback tests ---

  test('falls back to legacy evaluator for CEL-unsupported expressions', () => {
    // Complex legacy expression that might not parse in CEL but works in legacy
    const result = evaluateConditionDual('user.age >= 18 AND user.name != ""', sessionContext);
    expect(result).toBe(true);
  });

  test('handles missing context variables gracefully', () => {
    // Accessing a field that does not exist in context
    expect(evaluateConditionDual('nonexistent == null', {})).toBe(true);
    expect(evaluateConditionDual('nonexistent != null', {})).toBe(false);
  });

  test('handles IS SET / IS NOT SET for missing fields via has() preprocessing', () => {
    // Legacy IS SET with bare identifier (migrated to has() then preprocessed to != null)
    expect(evaluateConditionDual('name IS SET', { name: 'Alice' })).toBe(true);
    expect(evaluateConditionDual('name IS NOT SET', { name: 'Alice' })).toBe(false);
    expect(evaluateConditionDual('name IS SET', {})).toBe(false);
    expect(evaluateConditionDual('name IS NOT SET', {})).toBe(true);
  });

  test('resolveValueDual falls back for legacy function expressions', () => {
    // LOWER is a legacy ABL function -> migrated to abl.lower()
    expect(resolveValueDual('LOWER(user.name)', sessionContext)).toBe('john');
  });

  test('resolveValueDual handles arithmetic migration', () => {
    // ADD(a, b) -> a + b
    expect(resolveValueDual('ADD(claim.amount, 500)', sessionContext)).toBe(2000);
  });

  test('evaluates boolean logic with mixed CEL and migrated expressions', () => {
    // CEL ternary
    expect(resolveValueDual('claim.amount > 1000 ? "high" : "low"', sessionContext)).toBe('high');
  });

  test('handles empty string context values', () => {
    expect(evaluateConditionDual('val == ""', { val: '' })).toBe(true);
    expect(evaluateConditionDual('val != ""', { val: '' })).toBe(false);
    expect(evaluateConditionDual('size(val) == 0', { val: '' })).toBe(true);
  });

  test('handles null context values', () => {
    expect(evaluateConditionDual('val == null', { val: null })).toBe(true);
    expect(evaluateConditionDual('val != null', { val: 'x' })).toBe(true);
  });

  // --- Routing executor CEL support tests ---

  describe('Routing executor CEL support', () => {
    test('evaluates CEL completion condition', () => {
      expect(
        evaluateConditionDual('has(gathered.policy_number) && claim.amount > 1000', sessionContext),
      ).toBe(true);
    });

    test('evaluates CEL handoff condition', () => {
      expect(
        evaluateConditionDual('claim.status == "escalated" || claim.amount > 10000', {
          claim: { status: 'escalated', amount: 500 },
        }),
      ).toBe(true);
    });

    test('evaluates CEL delegate WHEN condition', () => {
      expect(
        evaluateConditionDual(
          'user.age >= 18 && claim.status in ["pending", "review"]',
          sessionContext,
        ),
      ).toBe(true);
    });

    test('evaluates legacy syntax in routing conditions via migration', () => {
      expect(evaluateConditionDual('claim.amount > 1000 AND user.age >= 18', sessionContext)).toBe(
        true,
      );
    });
  });
});
