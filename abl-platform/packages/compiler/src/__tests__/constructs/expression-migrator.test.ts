import { describe, test, expect } from 'vitest';
import {
  migrateExpression,
  isLegacyExpression,
  normalizeExpression,
} from '../../platform/constructs/expression-migrator.js';

describe('Expression Migrator', () => {
  describe('isLegacyExpression', () => {
    test('detects ABL-style logical operators', () => {
      expect(isLegacyExpression('age >= 18 AND name != ""')).toBe(true);
      expect(isLegacyExpression('a OR b')).toBe(true);
      expect(isLegacyExpression('NOT active')).toBe(true);
    });

    test('detects ABL-style functions', () => {
      expect(isLegacyExpression('UPPER(name)')).toBe(true);
      expect(isLegacyExpression('FORMAT_CURRENCY(amount, "USD")')).toBe(true);
    });

    test('does not flag CEL expressions', () => {
      expect(isLegacyExpression('age >= 18 && name != ""')).toBe(false);
      expect(isLegacyExpression('abl.upper(name)')).toBe(false);
      expect(isLegacyExpression('has(name)')).toBe(false);
    });

    test('does not flag AND/OR inside quoted strings', () => {
      expect(isLegacyExpression('"value AND other"')).toBe(false);
    });

    test('detects IS SET / IS NOT SET', () => {
      expect(isLegacyExpression('name IS SET')).toBe(true);
      expect(isLegacyExpression('name IS NOT SET')).toBe(true);
    });

    test('detects CONTAINS / MATCHES', () => {
      expect(isLegacyExpression('email CONTAINS "@"')).toBe(true);
      expect(isLegacyExpression('phone MATCHES "^\\d{10}$"')).toBe(true);
    });

    test('detects STARTS_WITH / ENDS_WITH function form', () => {
      expect(isLegacyExpression('STARTS_WITH(utterance, "__feedback__")')).toBe(true);
      expect(isLegacyExpression('ENDS_WITH(filename, ".pdf")')).toBe(true);
    });

    test('detects arithmetic functions', () => {
      expect(isLegacyExpression('ADD(price, tax)')).toBe(true);
      expect(isLegacyExpression('SUB(a, b)')).toBe(true);
      expect(isLegacyExpression('MUL(a, b)')).toBe(true);
      expect(isLegacyExpression('DIV(a, b)')).toBe(true);
    });

    test('detects LENGTH function', () => {
      expect(isLegacyExpression('LENGTH(items)')).toBe(true);
    });

    test('does not flag size() as legacy', () => {
      expect(isLegacyExpression('size(items) > 0')).toBe(false);
    });

    test('does not flag simple comparisons', () => {
      expect(isLegacyExpression('x > 5')).toBe(false);
      expect(isLegacyExpression('status == "active"')).toBe(false);
    });
  });

  describe('migrateExpression', () => {
    test('converts logical operators', () => {
      expect(migrateExpression('age >= 18 AND name != ""')).toBe('age >= 18 && name != ""');
      expect(migrateExpression('a OR b')).toBe('a || b');
      expect(migrateExpression('NOT active')).toBe('!active');
    });

    test('converts CONTAINS to method syntax', () => {
      expect(migrateExpression('email CONTAINS "@"')).toBe('email.contains("@")');
    });

    test('converts MATCHES to method syntax', () => {
      expect(migrateExpression('phone MATCHES "^\\d{10}$"')).toBe('phone.matches("^\\d{10}$")');
    });

    test('converts IS SET to has()', () => {
      expect(migrateExpression('policy_number IS SET')).toBe('has(policy_number)');
    });

    test('converts IS NOT SET to !has()', () => {
      expect(migrateExpression('policy_number IS NOT SET')).toBe('!has(policy_number)');
    });

    test('converts arithmetic functions to infix operators', () => {
      expect(migrateExpression('ADD(price, tax)')).toBe('price + tax');
      expect(migrateExpression('SUB(a, b)')).toBe('a - b');
      expect(migrateExpression('MUL(a, b)')).toBe('a * b');
      expect(migrateExpression('DIV(a, b)')).toBe('a / b');
    });

    test('converts LENGTH to size()', () => {
      expect(migrateExpression('LENGTH(items)')).toBe('size(items)');
    });

    test('converts built-in functions to abl.* namespace', () => {
      expect(migrateExpression('UPPER(name)')).toBe('abl.upper(name)');
      expect(migrateExpression('FORMAT_CURRENCY(amount, "USD")')).toBe(
        'abl.format_currency(amount, "USD")',
      );
      expect(migrateExpression('MASK(ssn, "last4")')).toBe('abl.mask(ssn, "last4")');
      expect(migrateExpression('COALESCE(a, b)')).toBe('abl.coalesce(a, b)');
      expect(migrateExpression('OBJECT_MERGE(a, b)')).toBe('abl.object_merge(a, b)');
    });

    test('handles compound expressions', () => {
      expect(
        migrateExpression('age >= 18 AND UPPER(status) == "ACTIVE" AND email CONTAINS "@"'),
      ).toBe('age >= 18 && abl.upper(status) == "ACTIVE" && email.contains("@")');
    });

    test('preserves already-valid CEL', () => {
      expect(migrateExpression('age >= 18 && name != ""')).toBe('age >= 18 && name != ""');
      expect(migrateExpression('has(name)')).toBe('has(name)');
    });

    test('converts nested path IS SET', () => {
      expect(migrateExpression('user.profile IS SET')).toBe('has(user.profile)');
      expect(migrateExpression('user.profile IS NOT SET')).toBe('!has(user.profile)');
    });

    test('handles multiple IS SET checks combined with AND', () => {
      expect(migrateExpression('name IS SET AND email IS SET')).toBe('has(name) && has(email)');
    });

    test('handles NOT combined with other operators', () => {
      expect(migrateExpression('NOT active AND status == "pending"')).toBe(
        '!active && status == "pending"',
      );
    });

    test('converts LOWER function', () => {
      expect(migrateExpression('LOWER(name)')).toBe('abl.lower(name)');
    });

    test('converts TRIM function', () => {
      expect(migrateExpression('TRIM(input)')).toBe('abl.trim(input)');
    });

    test('converts ROUND function', () => {
      expect(migrateExpression('ROUND(price, 2)')).toBe('abl.round(price, 2)');
    });

    test('converts ABS function', () => {
      expect(migrateExpression('ABS(diff)')).toBe('abl.abs(diff)');
    });

    test('converts MIN and MAX functions', () => {
      expect(migrateExpression('MIN(a, b)')).toBe('abl.min(a, b)');
      expect(migrateExpression('MAX(a, b)')).toBe('abl.max(a, b)');
    });

    test('converts type-check functions', () => {
      expect(migrateExpression('IS_ARRAY(items)')).toBe('abl.is_array(items)');
      expect(migrateExpression('IS_NUMBER(val)')).toBe('abl.is_number(val)');
      expect(migrateExpression('IS_STRING(val)')).toBe('abl.is_string(val)');
    });

    test('converts type-conversion functions', () => {
      expect(migrateExpression('TO_NUMBER(str)')).toBe('abl.to_number(str)');
      expect(migrateExpression('TO_STRING(num)')).toBe('abl.to_string(num)');
    });

    test('converts NOW and UNIQUE_ID', () => {
      expect(migrateExpression('NOW()')).toBe('abl.now()');
      expect(migrateExpression('UNIQUE_ID()')).toBe('abl.unique_id()');
    });

    test('converts CONTAINS with single-quoted string', () => {
      expect(migrateExpression("email CONTAINS '@'")).toBe("email.contains('@')");
    });

    test('converts STARTS_WITH function form to CEL string method', () => {
      expect(migrateExpression('STARTS_WITH(utterance, "__feedback__")')).toBe(
        '(utterance).startsWith("__feedback__")',
      );
    });

    test('converts ENDS_WITH function form to CEL string method', () => {
      expect(migrateExpression('ENDS_WITH(filename, ".pdf")')).toBe('(filename).endsWith(".pdf")');
    });

    test('converts STARTS_WITH with dotted path receiver', () => {
      expect(migrateExpression('STARTS_WITH(user.profile.name, "Mr.")')).toBe(
        '(user.profile.name).startsWith("Mr.")',
      );
    });

    test('converts STARTS_WITH inside compound AND expression', () => {
      expect(
        migrateExpression('intent == "feedback" AND STARTS_WITH(utterance, "__feedback__")'),
      ).toBe('intent == "feedback" && (utterance).startsWith("__feedback__")');
    });
  });

  describe('normalizeExpression', () => {
    test('migrates legacy expressions', () => {
      expect(normalizeExpression('age >= 18 AND active')).toBe('age >= 18 && active');
    });

    test('passes through CEL expressions unchanged', () => {
      expect(normalizeExpression('age >= 18 && active')).toBe('age >= 18 && active');
    });

    test('passes through has() expressions unchanged', () => {
      expect(normalizeExpression('has(ctx.name)')).toBe('has(ctx.name)');
    });
  });
});
