/**
 * Tests for Construct Evaluator
 *
 * Tests condition evaluation, value resolution, and message interpolation.
 */

import { describe, test, expect } from 'vitest';
import {
  evaluateCondition,
  evaluateConditions,
  evaluateConditionList,
  evaluateConditionWithInput,
  evaluateConditionDetailed,
  resolveValue,
  getNestedValue,
  setNestedValue,
  interpolateMessage,
  interpolateWithFallback,
  interpolateRichTemplate,
  splitByOperator,
} from '../../platform/constructs/evaluator.js';

describe('Evaluator', () => {
  describe('evaluateCondition', () => {
    const context = {
      name: 'John',
      age: 30,
      verified: true,
      user: {
        id: '123',
        email: 'john@example.com',
        profile: {
          tier: 'gold',
        },
      },
      items: [1, 2, 3],
      count: 5,
    };

    describe('Comparison Operators', () => {
      test('should evaluate equality (==)', () => {
        expect(evaluateCondition('name == "John"', context)).toBe(true);
        expect(evaluateCondition('name == "Jane"', context)).toBe(false);
        expect(evaluateCondition('age == 30', context)).toBe(true);
        expect(evaluateCondition('age == 25', context)).toBe(false);
      });

      test('should evaluate inequality (!=)', () => {
        expect(evaluateCondition('name != "Jane"', context)).toBe(true);
        expect(evaluateCondition('name != "John"', context)).toBe(false);
      });

      test('should evaluate greater than (>)', () => {
        expect(evaluateCondition('age > 25', context)).toBe(true);
        expect(evaluateCondition('age > 30', context)).toBe(false);
        expect(evaluateCondition('age > 35', context)).toBe(false);
      });

      test('should evaluate greater than or equal (>=)', () => {
        expect(evaluateCondition('age >= 30', context)).toBe(true);
        expect(evaluateCondition('age >= 25', context)).toBe(true);
        expect(evaluateCondition('age >= 35', context)).toBe(false);
      });

      test('should evaluate less than (<)', () => {
        expect(evaluateCondition('age < 35', context)).toBe(true);
        expect(evaluateCondition('age < 30', context)).toBe(false);
        expect(evaluateCondition('age < 25', context)).toBe(false);
      });

      test('should evaluate less than or equal (<=)', () => {
        expect(evaluateCondition('age <= 30', context)).toBe(true);
        expect(evaluateCondition('age <= 35', context)).toBe(true);
        expect(evaluateCondition('age <= 25', context)).toBe(false);
      });
    });

    describe('Boolean Operators', () => {
      test('should evaluate boolean true check', () => {
        expect(evaluateCondition('verified', context)).toBe(true);
        expect(evaluateCondition('verified == true', context)).toBe(true);
      });

      test('should evaluate AND conditions', () => {
        expect(evaluateCondition('name == "John" AND age == 30', context)).toBe(true);
        expect(evaluateCondition('name == "John" AND age == 25', context)).toBe(false);
      });

      test('should evaluate OR conditions', () => {
        expect(evaluateCondition('name == "Jane" OR age == 30', context)).toBe(true);
        expect(evaluateCondition('name == "Jane" OR age == 25', context)).toBe(false);
      });

      test('should evaluate NOT conditions', () => {
        expect(evaluateCondition('NOT name == "Jane"', context)).toBe(true);
        expect(evaluateCondition('!name == "John"', context)).toBe(false);
      });
    });

    describe('Nested Property Access', () => {
      test('should access nested properties', () => {
        expect(evaluateCondition('user.id == "123"', context)).toBe(true);
        expect(evaluateCondition('user.profile.tier == "gold"', context)).toBe(true);
      });

      test('should handle missing nested properties', () => {
        expect(evaluateCondition('user.missing == "value"', context)).toBe(false);
        expect(evaluateCondition('user.deep.missing == "value"', context)).toBe(false);
      });
    });

    describe('Contains Operator', () => {
      test('should evaluate contains for arrays', () => {
        expect(evaluateCondition('items contains 2', context)).toBe(true);
        expect(evaluateCondition('items contains 5', context)).toBe(false);
      });

      test('should evaluate contains for strings', () => {
        expect(evaluateCondition('name contains "oh"', context)).toBe(true);
        expect(evaluateCondition('name contains "xyz"', context)).toBe(false);
      });
    });

    describe('Edge Cases', () => {
      test('should handle empty condition as true', () => {
        // Empty condition is truthy by default in this implementation
        expect(evaluateCondition('', context)).toBe(true);
      });

      test('should handle whitespace', () => {
        expect(evaluateCondition('  name == "John"  ', context)).toBe(true);
      });

      test('should handle special characters in strings', () => {
        const ctx = { email: 'test@example.com' };
        expect(evaluateCondition('email == "test@example.com"', ctx)).toBe(true);
      });
    });
  });

  describe('evaluateConditions', () => {
    const context = { a: 1, b: 2, c: 3 };

    test('should evaluate multiple conditions and return results object', () => {
      const results = evaluateConditions(['a == 1', 'b == 2', 'c == 4'], context);

      expect(results['a == 1']).toBe(true);
      expect(results['b == 2']).toBe(true);
      expect(results['c == 4']).toBe(false);
    });

    test('should handle empty conditions', () => {
      const results = evaluateConditions([], context);
      expect(Object.keys(results)).toHaveLength(0);
    });
  });

  describe('evaluateConditionList', () => {
    const context = { status: 'active', count: 10 };

    test('should find first matching condition result', () => {
      const conditions = [
        { when: 'status == "inactive"', result: 'first' },
        { when: 'status == "active"', result: 'second' },
        { when: 'count > 5', result: 'third' },
      ];
      expect(evaluateConditionList(conditions, context)).toBe('second');
    });

    test('should return undefined if no match and no default', () => {
      const conditions = [
        { when: 'status == "inactive"', result: 'first' },
        { when: 'count < 5', result: 'second' },
      ];
      expect(evaluateConditionList(conditions, context)).toBeUndefined();
    });

    test('should return default if provided and no match', () => {
      const conditions = [{ when: 'status == "inactive"', result: 'first' }];
      expect(evaluateConditionList(conditions, context, 'default')).toBe('default');
    });
  });

  describe('getNestedValue', () => {
    const obj = {
      a: {
        b: {
          c: 'deep',
        },
        arr: [1, 2, 3],
      },
      simple: 'value',
    };

    test('should get simple property', () => {
      expect(getNestedValue(obj, 'simple')).toBe('value');
    });

    test('should get nested property', () => {
      expect(getNestedValue(obj, 'a.b.c')).toBe('deep');
    });

    test('should return undefined for missing path', () => {
      expect(getNestedValue(obj, 'a.missing.path')).toBeUndefined();
    });

    test('should handle array access', () => {
      expect(getNestedValue(obj, 'a.arr')).toEqual([1, 2, 3]);
    });

    test('should handle array index notation', () => {
      expect(getNestedValue(obj, 'a.arr[0]')).toBe(1);
      expect(getNestedValue(obj, 'a.arr[2]')).toBe(3);
    });
  });

  describe('setNestedValue', () => {
    test('should set simple property', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'name', 'John');
      expect(obj.name).toBe('John');
    });

    test('should set nested property creating intermediate objects', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'user.profile.name', 'John');
      expect(obj.user as Record<string, unknown>).toBeDefined();
      expect(((obj.user as Record<string, unknown>).profile as Record<string, unknown>).name).toBe(
        'John',
      );
    });

    test('should overwrite existing values', () => {
      const obj = { name: 'Jane' };
      setNestedValue(obj, 'name', 'John');
      expect(obj.name).toBe('John');
    });
  });

  describe('resolveValue', () => {
    const context = {
      name: 'John',
      user: { id: '123' },
    };

    test('should resolve path from context', () => {
      expect(resolveValue('name', context)).toBe('John');
      expect(resolveValue('user.id', context)).toBe('123');
    });

    test('should resolve string literals', () => {
      expect(resolveValue('"literal"', context)).toBe('literal');
      expect(resolveValue("'literal'", context)).toBe('literal');
    });

    test('should resolve number literals', () => {
      expect(resolveValue('123', context)).toBe(123);
      expect(resolveValue('3.14', context)).toBe(3.14);
    });

    test('should resolve boolean literals', () => {
      expect(resolveValue('true', context)).toBe(true);
      expect(resolveValue('false', context)).toBe(false);
    });

    test('should return undefined for missing path', () => {
      expect(resolveValue('missing', context)).toBeUndefined();
    });
  });

  describe('interpolateMessage', () => {
    const context = {
      name: 'John',
      user: { email: 'john@example.com' },
      count: 5,
    };

    test('should interpolate single variable using ${} syntax', () => {
      expect(interpolateMessage('Hello, ${name}!', context)).toBe('Hello, John!');
    });

    test('should interpolate multiple variables', () => {
      expect(interpolateMessage('${name} has ${count} items', context)).toBe('John has 5 items');
    });

    test('should interpolate nested variables', () => {
      expect(interpolateMessage('Email: ${user.email}', context)).toBe('Email: john@example.com');
    });

    test('should replace missing variables with empty string', () => {
      expect(interpolateMessage('Hello, ${missing}!', context)).toBe('Hello, !');
    });

    test('should handle no variables', () => {
      expect(interpolateMessage('No variables here', context)).toBe('No variables here');
    });
  });

  describe('interpolateWithFallback', () => {
    const context = { name: 'John' };

    test('should use value when variable exists', () => {
      expect(interpolateWithFallback('Hello, ${name|Guest}!', context)).toBe('Hello, John!');
    });

    test('should use fallback when variable missing', () => {
      expect(interpolateWithFallback('Hello, ${missing|friend}!', context)).toBe('Hello, friend!');
    });

    test('should use empty string as fallback if not provided', () => {
      expect(interpolateWithFallback('Hello, ${missing}!', context)).toBe('Hello, !');
    });
  });

  describe('Boolean String Parsing', () => {
    test('should compare boolean true with string "true"', () => {
      const ctx = { verified: true };
      expect(evaluateCondition('verified == "true"', ctx)).toBe(true);
    });

    test('should compare boolean false with string "false"', () => {
      const ctx = { verified: false };
      expect(evaluateCondition('verified == "false"', ctx)).toBe(true);
    });

    test('should compare string "true" with boolean true', () => {
      const ctx = { status: 'true' };
      expect(evaluateCondition('status == true', ctx)).toBe(true);
    });

    test('should compare string "false" with boolean false', () => {
      const ctx = { status: 'false' };
      expect(evaluateCondition('status == false', ctx)).toBe(true);
    });

    test('should not equate boolean true with string "false"', () => {
      const ctx = { verified: true };
      expect(evaluateCondition('verified == "false"', ctx)).toBe(false);
    });
  });

  describe('Numeric Coercion', () => {
    test('should compare number with numeric string using >', () => {
      const ctx = { age: 30 };
      expect(evaluateCondition('age > "25"', ctx)).toBe(true);
    });

    test('should compare number with numeric string using <', () => {
      const ctx = { age: 20 };
      expect(evaluateCondition('age < "25"', ctx)).toBe(true);
    });

    test('should equate numeric string with number using ==', () => {
      const ctx = { count: 10 };
      expect(evaluateCondition('"10" == count', ctx)).toBe(true);
    });

    test('should equate float string with float number using ==', () => {
      const ctx = { price: '99.99' };
      expect(evaluateCondition('price == 99.99', ctx)).toBe(true);
    });

    test('should handle number-to-number equality', () => {
      const ctx = { score: 42 };
      expect(evaluateCondition('score == 42', ctx)).toBe(true);
      expect(evaluateCondition('score == 43', ctx)).toBe(false);
    });
  });

  describe('Undefined Variable Behavior', () => {
    test('should return false for missing == "value"', () => {
      const ctx = { other: 'data' };
      expect(evaluateCondition('missing == "value"', ctx)).toBe(false);
    });

    test('should return true for missing != "value" (one undefined, one defined)', () => {
      const ctx = { other: 'data' };
      expect(evaluateCondition('missing != "value"', ctx)).toBe(true);
    });

    test('should handle numeric comparison with undefined (toNumber returns 0)', () => {
      const ctx = {};
      // undefined -> toNumber returns 0, so 0 > 5 is false
      expect(evaluateCondition('missing > 5', ctx)).toBe(false);
    });

    test('should handle undefined == undefined (null/undefined equality)', () => {
      const ctx = {};
      // Both sides resolve to undefined; isEqual(undefined, undefined) -> true
      expect(evaluateCondition('missing == nothere', ctx)).toBe(true);
    });
  });

  describe('IS SET / IS NOT SET Operators', () => {
    test('should return true for IS SET when variable exists', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name IS SET', ctx)).toBe(true);
    });

    test('should return false for IS NOT SET when variable exists', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name IS NOT SET', ctx)).toBe(false);
    });

    test('should return false for IS SET when variable is missing', () => {
      const ctx = {};
      expect(evaluateCondition('missing IS SET', ctx)).toBe(false);
    });

    test('should return true for IS NOT SET when variable is missing', () => {
      const ctx = {};
      expect(evaluateCondition('missing IS NOT SET', ctx)).toBe(true);
    });

    test('should return false for IS SET when variable is null', () => {
      const ctx = { nullVal: null };
      expect(evaluateCondition('nullVal IS SET', ctx)).toBe(false);
    });

    test('should return true for IS NOT SET when variable is null', () => {
      const ctx = { nullVal: null };
      expect(evaluateCondition('nullVal IS NOT SET', ctx)).toBe(true);
    });

    test('should return true for IS SET when variable is empty string', () => {
      // Empty string is not null/undefined, so IS SET should be true
      const ctx = { val: '' };
      expect(evaluateCondition('val IS SET', ctx)).toBe(true);
    });
  });

  describe('Case Sensitivity Tests', () => {
    test('should perform case-sensitive string equality', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name == "John"', ctx)).toBe(true);
      expect(evaluateCondition('name == "john"', ctx)).toBe(false);
      expect(evaluateCondition('name == "JOHN"', ctx)).toBe(false);
    });

    test('lowercase "and" should not split as logical AND operator', () => {
      // ' AND ' is recognized but ' and ' is not; it should be treated as a single expression
      const ctx = { name: 'John', age: 30 };
      // 'name == "John" and age == 30' should NOT evaluate as two conditions joined by AND
      // Instead it tries to parse as single comparison which fails, returning false
      expect(evaluateCondition('name == "John" and age == 30', ctx)).toBe(false);
    });

    test('uppercase OR works as logical operator', () => {
      const ctx = { name: 'John', age: 30 };
      expect(evaluateCondition('name == "Jane" OR age == 30', ctx)).toBe(true);
    });
  });

  describe('Array-to-Number Coercion', () => {
    test('should use array length in numeric comparison >', () => {
      const ctx = { items: [1, 2, 3] };
      // toNumber([1,2,3]) returns 3 (length), so 3 > 2 is true
      expect(evaluateCondition('items > 2', ctx)).toBe(true);
    });

    test('should use array length in numeric comparison ==', () => {
      const ctx = { items: [1, 2, 3] };
      // toNumber returns length=3, but == uses isEqual which does String comparison
      // For == operator, isEqual is used, not toNumber
      // Array vs number goes to String(arr) === String(num) -> "1,2,3" === "3" -> false
      expect(evaluateCondition('items == 3', ctx)).toBe(false);
    });

    test('should use array length in numeric comparison >=', () => {
      const ctx = { items: ['a', 'b'] };
      // toNumber(['a','b']) returns 2 (length), so 2 >= 2 is true
      expect(evaluateCondition('items >= 2', ctx)).toBe(true);
    });

    test('should return false when array length is less', () => {
      const ctx = { items: [1] };
      // toNumber([1]) returns 1 (length), so 1 > 2 is false
      expect(evaluateCondition('items > 2', ctx)).toBe(false);
    });
  });

  describe('Nested Paths with Missing Intermediates', () => {
    test('should return false for deeply missing nested path equality', () => {
      const ctx = { a: { x: 1 } };
      // a.b doesn't exist, so a.b.c.d resolves to undefined
      expect(evaluateCondition('a.b.c.d == "deep"', ctx)).toBe(false);
    });

    test('should return false for IS SET on nested path with missing intermediate', () => {
      const ctx = { a: { x: 1 } };
      // a exists but b doesn't, so a.b resolves to undefined
      expect(evaluateCondition('a.b IS SET', ctx)).toBe(false);
    });

    test('should return true for IS NOT SET on nested path with missing intermediate', () => {
      const ctx = { a: { x: 1 } };
      expect(evaluateCondition('a.b IS NOT SET', ctx)).toBe(true);
    });

    test('should return true for valid deeply nested path', () => {
      const ctx = { a: { b: { c: { d: 'deep' } } } };
      expect(evaluateCondition('a.b.c.d == "deep"', ctx)).toBe(true);
    });
  });

  describe('Parenthesized Expressions', () => {
    test('should evaluate simple parenthesized AND expression', () => {
      const ctx = { age: 30, name: 'John' };
      // Note: wrapping with outer parens that start with ( and end with ) triggers
      // extractParenContent which strips them. Use a form that avoids ambiguity.
      expect(evaluateCondition('(age > 25) AND name == "John"', ctx)).toBe(true);
    });

    test('should evaluate parenthesized AND with failing condition', () => {
      const ctx = { age: 20, name: 'John' };
      expect(evaluateCondition('(age > 25) AND name == "John"', ctx)).toBe(false);
    });

    test('should evaluate complex parenthesized OR within AND', () => {
      const ctx = { age: 55, name: 'John' };
      expect(evaluateCondition('(age < 20 OR age > 50) AND name == "John"', ctx)).toBe(true);
    });

    test('should return false for complex parenthesized expression with no match', () => {
      const ctx = { age: 30, name: 'Jane' };
      // (30 < 20 OR 30 > 50) -> false AND name == "John" -> false regardless
      expect(evaluateCondition('(age < 20 OR age > 50) AND name == "John"', ctx)).toBe(false);
    });

    test('should handle nested parentheses', () => {
      const ctx = { x: 10 };
      expect(evaluateCondition('(x > 5)', ctx)).toBe(true);
      expect(evaluateCondition('(x < 5)', ctx)).toBe(false);
    });
  });

  describe('Matches Operator (regex)', () => {
    test('should match beginning of string with ^', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name matches "^J"', ctx)).toBe(true);
      expect(evaluateCondition('name matches "^X"', ctx)).toBe(false);
    });

    test('should match email pattern', () => {
      const ctx = { user: { email: 'john@example.com' } };
      // The condition string contains "\\w+@\\w+" which resolveValue strips quotes from,
      // yielding the regex string \w+@\w+ for new RegExp()
      expect(evaluateCondition('user.email matches "\\w+@\\w+"', ctx)).toBe(true);
    });

    test('should match end of string with $', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name matches "hn$"', ctx)).toBe(true);
      expect(evaluateCondition('name matches "xx$"', ctx)).toBe(false);
    });

    test('should return false for invalid regex', () => {
      const ctx = { name: 'John' };
      // An invalid regex pattern should return false (caught by try/catch)
      expect(evaluateCondition('name matches "["', ctx)).toBe(false);
    });
  });

  describe('startsWith / endsWith Operators', () => {
    test('should evaluate startsWith correctly', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name startsWith "Jo"', ctx)).toBe(true);
      expect(evaluateCondition('name startsWith "ja"', ctx)).toBe(false);
    });

    test('should evaluate endsWith correctly', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name endsWith "hn"', ctx)).toBe(true);
      expect(evaluateCondition('name endsWith "ne"', ctx)).toBe(false);
    });

    test('should handle startsWith with full string', () => {
      const ctx = { greeting: 'Hello World' };
      expect(evaluateCondition('greeting startsWith "Hello World"', ctx)).toBe(true);
    });

    test('should handle endsWith with full string', () => {
      const ctx = { greeting: 'Hello World' };
      expect(evaluateCondition('greeting endsWith "Hello World"', ctx)).toBe(true);
    });
  });

  describe('Boolean Literal Evaluation', () => {
    test('should evaluate "true" literal as true', () => {
      expect(evaluateCondition('true', {})).toBe(true);
    });

    test('should evaluate "false" literal as false', () => {
      expect(evaluateCondition('false', {})).toBe(false);
    });

    test('should evaluate "true" literal with non-empty context', () => {
      expect(evaluateCondition('true', { a: 1 })).toBe(true);
    });

    test('should evaluate "false" literal with non-empty context', () => {
      expect(evaluateCondition('false', { a: 1 })).toBe(false);
    });
  });

  describe('interpolateRichTemplate', () => {
    test('should interpolate {{variable}} syntax', () => {
      const ctx = { name: 'Alice', age: 25 };
      expect(interpolateRichTemplate('Hello {{name}}, you are {{age}}!', ctx)).toBe(
        'Hello Alice, you are 25!',
      );
    });

    test('should interpolate nested paths {{path.to.value}}', () => {
      const ctx = { user: { profile: { city: 'NYC' } } };
      expect(interpolateRichTemplate('City: {{user.profile.city}}', ctx)).toBe('City: NYC');
    });

    test('should replace missing variables with empty string', () => {
      const ctx = {};
      expect(interpolateRichTemplate('Hello {{missing}}!', ctx)).toBe('Hello !');
    });

    test('should handle {{#each items}}...{{/each}} blocks', () => {
      const ctx = { items: [{ name: 'Apple' }, { name: 'Banana' }] };
      const template = '{{#each items}}{{name}}, {{/each}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('Apple, Banana, ');
    });

    test('should handle {{@index}} inside each blocks', () => {
      const ctx = { items: ['a', 'b', 'c'] };
      const template = '{{#each items}}{{@index}}{{/each}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('012');
    });

    test('should handle {{add @index 1}} inside each blocks', () => {
      const ctx = { items: ['x', 'y', 'z'] };
      const template = '{{#each items}}{{add @index 1}} {{/each}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('1 2 3 ');
    });

    test('should handle {{#if condition}}...{{else}}...{{/if}} with truthy condition', () => {
      const ctx = { loggedIn: true };
      const template = '{{#if loggedIn}}Welcome!{{else}}Please log in.{{/if}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('Welcome!');
    });

    test('should handle {{#if condition}}...{{else}}...{{/if}} with falsy condition', () => {
      const ctx = { loggedIn: false };
      const template = '{{#if loggedIn}}Welcome!{{else}}Please log in.{{/if}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('Please log in.');
    });

    test('should handle {{#if}} without {{else}}', () => {
      const ctx = { show: true };
      const template = 'Before {{#if show}}VISIBLE{{/if}} After';
      expect(interpolateRichTemplate(template, ctx)).toBe('Before VISIBLE After');
    });

    test('should handle {{#if}} with missing variable (falsy)', () => {
      const ctx = {};
      const template = '{{#if missing}}YES{{else}}NO{{/if}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('NO');
    });

    test('should handle empty array in {{#each}}', () => {
      const ctx = { items: [] };
      const template = 'Items: {{#each items}}{{name}}{{/each}}Done';
      expect(interpolateRichTemplate(template, ctx)).toBe('Items: Done');
    });

    test('should handle non-array value in {{#each}}', () => {
      const ctx = { items: 'not-an-array' };
      const template = '{{#each items}}{{this}}{{/each}}';
      expect(interpolateRichTemplate(template, ctx)).toBe('');
    });
  });

  describe('is_number operator', () => {
    test('should return true for numeric string', () => {
      expect(evaluateCondition('input is_number', { input: '42' })).toBe(true);
    });

    test('should return true for numeric value', () => {
      expect(evaluateCondition('count is_number', { count: 5 })).toBe(true);
    });

    test('should return false for non-numeric string', () => {
      expect(evaluateCondition('input is_number', { input: 'hello' })).toBe(false);
    });

    test('should return false for empty string', () => {
      expect(evaluateCondition('input is_number', { input: '' })).toBe(false);
    });

    test('should return false for undefined variable', () => {
      expect(evaluateCondition('missing is_number', {})).toBe(false);
    });

    test('should be case-insensitive', () => {
      expect(evaluateCondition('val IS_NUMBER', { val: '3.14' })).toBe(true);
    });

    test('should handle float strings', () => {
      expect(evaluateCondition('input is_number', { input: '3.14' })).toBe(true);
    });

    test('should handle negative numbers', () => {
      expect(evaluateCondition('input is_number', { input: '-7' })).toBe(true);
    });
  });

  describe('evaluateConditionWithInput', () => {
    test('should merge input into context for evaluation', () => {
      expect(evaluateConditionWithInput('input == "hello"', 'hello', {})).toBe(true);
    });

    test('should handle input comparison with context', () => {
      expect(
        evaluateConditionWithInput('input == "yes" AND confirmed == true', 'yes', {
          confirmed: true,
        }),
      ).toBe(true);
    });

    test('should pass input through for contains check', () => {
      expect(evaluateConditionWithInput('input contains "book"', 'I want to book a room', {})).toBe(
        true,
      );
    });

    test('should handle empty input', () => {
      expect(evaluateConditionWithInput('count > 0', '', { count: 5 })).toBe(true);
    });

    test('should handle input is_number', () => {
      expect(evaluateConditionWithInput('input is_number', '42', {})).toBe(true);
      expect(evaluateConditionWithInput('input is_number', 'abc', {})).toBe(false);
    });
  });

  describe('evaluateConditionDetailed', () => {
    test('should return structured detail for variable comparison', () => {
      const detail = evaluateConditionDetailed('count == 5', '', { count: 5 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('variable_comparison');
      expect(detail.operator).toBe('==');
    });

    test('should return detail for AND compound condition', () => {
      const detail = evaluateConditionDetailed('a == 1 AND b == 2', '', { a: 1, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_and');
    });

    test('should return detail for OR compound condition', () => {
      const detail = evaluateConditionDetailed('a == 1 OR b == 2', '', { a: 0, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_or');
    });

    test('should return detail for contains', () => {
      const detail = evaluateConditionDetailed('input contains "hello"', 'say hello world', {});
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('contains');
    });

    test('should return detail for IS SET', () => {
      const detail = evaluateConditionDetailed('name IS SET', '', { name: 'Alice' });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('is_set');
    });

    test('should return detail for IS NOT SET', () => {
      const detail = evaluateConditionDetailed('missing IS NOT SET', '', {});
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('is_not_set');
    });

    test('should provide explanation in detail', () => {
      const detail = evaluateConditionDetailed('x == 10', '', { x: 10 });
      expect(detail.explanation).toContain('x');
      expect(detail.explanation).toContain('10');
    });
  });

  // =========================================================================
  // EXPANDED TESTS: inequality operators, IS NOT SET edge cases,
  // whitespace, match propagation, built-in functions, constraint evaluator
  // =========================================================================

  describe('Inequality (!=) with null/undefined — expanded', () => {
    test('both undefined → != returns false (not meaningfully different)', () => {
      expect(evaluateCondition('a != b', {})).toBe(false);
    });

    test('left undefined, right defined → != returns true', () => {
      expect(evaluateCondition('missing != "value"', { other: 1 })).toBe(true);
    });

    test('left defined, right undefined → != returns true', () => {
      expect(evaluateCondition('name != missing', { name: 'John' })).toBe(true);
    });

    test('left null, right null → != returns false', () => {
      expect(evaluateCondition('a != b', { a: null, b: null })).toBe(false);
    });

    test('left null, right undefined → != returns false (both nullish)', () => {
      expect(evaluateCondition('a != b', { a: null })).toBe(false);
    });

    test('left null, right defined → != returns true', () => {
      expect(evaluateCondition('a != "hello"', { a: null })).toBe(true);
    });

    test('left 0, right 0 → != returns false', () => {
      expect(evaluateCondition('a != 0', { a: 0 })).toBe(false);
    });

    test('left empty string, right empty string → != returns false', () => {
      expect(evaluateCondition('a != ""', { a: '' })).toBe(false);
    });

    test('left false, right false → != returns false', () => {
      expect(evaluateCondition('a != false', { a: false })).toBe(false);
    });

    test('different string values → != returns true', () => {
      expect(evaluateCondition('name != "Jane"', { name: 'John' })).toBe(true);
    });

    test('same string values → != returns false', () => {
      expect(evaluateCondition('name != "John"', { name: 'John' })).toBe(false);
    });
  });

  describe('IS NOT SET with present variable — expanded', () => {
    test('IS NOT SET on empty string returns false (empty string IS SET)', () => {
      expect(evaluateCondition('val IS NOT SET', { val: '' })).toBe(false);
    });

    test('IS NOT SET on 0 returns false (0 IS SET)', () => {
      expect(evaluateCondition('val IS NOT SET', { val: 0 })).toBe(false);
    });

    test('IS NOT SET on false returns false (false IS SET)', () => {
      expect(evaluateCondition('val IS NOT SET', { val: false })).toBe(false);
    });

    test('IS NOT SET on empty array returns false ([] IS SET)', () => {
      expect(evaluateCondition('val IS NOT SET', { val: [] })).toBe(false);
    });

    test('IS NOT SET on empty object returns false ({} IS SET)', () => {
      expect(evaluateCondition('val IS NOT SET', { val: {} })).toBe(false);
    });

    test('IS SET on empty string returns true', () => {
      expect(evaluateCondition('val IS SET', { val: '' })).toBe(true);
    });

    test('IS SET on 0 returns true', () => {
      expect(evaluateCondition('val IS SET', { val: 0 })).toBe(true);
    });

    test('IS SET on false returns true', () => {
      expect(evaluateCondition('val IS SET', { val: false })).toBe(true);
    });

    test('IS NOT SET on nested path with null intermediate', () => {
      expect(evaluateCondition('a.b IS NOT SET', { a: null })).toBe(true);
    });

    test('IS SET on nested path with undefined intermediate', () => {
      expect(evaluateCondition('a.b IS SET', { a: {} })).toBe(false);
    });
  });

  describe('Whitespace handling — expanded', () => {
    test('leading/trailing whitespace around condition', () => {
      expect(evaluateCondition('   name == "John"   ', { name: 'John' })).toBe(true);
    });

    test('extra whitespace around AND operator', () => {
      expect(evaluateCondition('a == 1  AND  b == 2', { a: 1, b: 2 })).toBe(true);
    });

    test('extra whitespace around comparison operator', () => {
      expect(evaluateCondition('age  ==  30', { age: 30 })).toBe(true);
    });

    test('tabs and multiple spaces in condition', () => {
      // The operator split handles tabs since it splits on '==' which matches
      // The left side 'name\t' is trimmed by resolveValue, so it works
      expect(evaluateCondition('name\t== "John"', { name: 'John' })).toBe(true);
    });

    test('whitespace-only condition treated as empty (returns true)', () => {
      expect(evaluateCondition('   ', {})).toBe(true);
    });

    test('whitespace around IS SET operator', () => {
      expect(evaluateCondition('  name IS SET  ', { name: 'val' })).toBe(true);
    });

    test('whitespace around IS NOT SET operator', () => {
      expect(evaluateCondition('  missing IS NOT SET  ', {})).toBe(true);
    });
  });

  describe('Match propagation (regex capture groups)', () => {
    test('stores full match in context.match.0', () => {
      const ctx: Record<string, unknown> = { input: 'Room 42' };
      const result = evaluateCondition('input matches "Room \\d+"', ctx);
      expect(result).toBe(true);
      expect(ctx.match).toBeDefined();
      expect((ctx.match as Record<string, string>)['0']).toBe('Room 42');
    });

    test('stores numbered capture groups', () => {
      const ctx: Record<string, unknown> = { input: 'order-123-abc' };
      const result = evaluateCondition('input matches "order-(\\d+)-(\\w+)"', ctx);
      expect(result).toBe(true);
      const match = ctx.match as Record<string, string>;
      expect(match['1']).toBe('123');
      expect(match['2']).toBe('abc');
    });

    test('stores named capture groups', () => {
      const ctx: Record<string, unknown> = { input: 'room 42' };
      const result = evaluateCondition('input matches "room (?<room_id>\\d+)"', ctx);
      expect(result).toBe(true);
      const match = ctx.match as Record<string, string>;
      expect(match['room_id']).toBe('42');
      expect(match['1']).toBe('42');
    });

    test('does not set match on context when regex fails', () => {
      const ctx: Record<string, unknown> = { input: 'no match' };
      evaluateCondition('input matches "^xyz$"', ctx);
      expect(ctx.match).toBeUndefined();
    });

    test('propagates match groups via evaluateConditionDetailed', () => {
      const ctx: Record<string, unknown> = {};
      const detail = evaluateConditionDetailed('input matches "ref-(\\d+)"', 'ref-456', ctx);
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('matches');
      const match = ctx.match as Record<string, string>;
      expect(match['0']).toBe('ref-456');
      expect(match['1']).toBe('456');
    });

    test('does not propagate match via evaluateConditionDetailed on failure', () => {
      const ctx: Record<string, unknown> = {};
      const detail = evaluateConditionDetailed('input matches "^zzz"', 'abc', ctx);
      expect(detail.matched).toBe(false);
      expect(ctx.match).toBeUndefined();
    });
  });

  describe('Truthiness (bare variable) — expanded', () => {
    test('empty object is falsy', () => {
      expect(evaluateCondition('val', { val: {} })).toBe(false);
    });

    test('non-empty object is truthy', () => {
      expect(evaluateCondition('val', { val: { a: 1 } })).toBe(true);
    });

    test('empty array is falsy', () => {
      expect(evaluateCondition('val', { val: [] })).toBe(false);
    });

    test('non-empty array is truthy', () => {
      expect(evaluateCondition('val', { val: [1] })).toBe(true);
    });

    test('string "false" is falsy', () => {
      expect(evaluateCondition('val', { val: 'false' })).toBe(false);
    });

    test('string "true" is truthy', () => {
      expect(evaluateCondition('val', { val: 'true' })).toBe(true);
    });

    test('string "0" is truthy (non-empty string)', () => {
      expect(evaluateCondition('val', { val: '0' })).toBe(true);
    });

    test('NaN is falsy (number !== 0 but NaN !== 0 is true, so isTruthy returns true)', () => {
      // isTruthy for number checks value !== 0; NaN !== 0 is true, so NaN is truthy
      expect(evaluateCondition('val', { val: NaN })).toBe(true);
    });

    test('negative number is truthy', () => {
      expect(evaluateCondition('val', { val: -1 })).toBe(true);
    });
  });

  describe('Contains — expanded edge cases', () => {
    test('array contains with type coercion (number in array, string comparison)', () => {
      // isEqual(1, '1') via parseFloat coercion → true
      expect(evaluateCondition('items contains "1"', { items: [1, 2, 3] })).toBe(true);
    });

    test('array does not contain value of different type without coercion match', () => {
      expect(evaluateCondition('items contains "abc"', { items: [1, 2, 3] })).toBe(false);
    });

    test('string contains empty string', () => {
      expect(evaluateCondition('name contains ""', { name: 'John' })).toBe(true);
    });

    test('empty string does not contain non-empty string', () => {
      expect(evaluateCondition('name contains "x"', { name: '' })).toBe(false);
    });

    test('contains on null/undefined returns false', () => {
      expect(evaluateCondition('missing contains "x"', {})).toBe(false);
    });

    test('contains on number returns false (not string or array)', () => {
      expect(evaluateCondition('val contains "1"', { val: 123 })).toBe(false);
    });
  });

  describe('Numeric coercion (toNumber) — expanded', () => {
    test('boolean true coerces to 1 in numeric comparison', () => {
      expect(evaluateCondition('val > 0', { val: true })).toBe(true);
      expect(evaluateCondition('val == 1', { val: true })).toBe(false); // == uses isEqual, not toNumber
    });

    test('boolean false coerces to 0 in numeric comparison', () => {
      expect(evaluateCondition('val >= 0', { val: false })).toBe(true);
      expect(evaluateCondition('val > 0', { val: false })).toBe(false);
    });

    test('undefined coerces to 0 in numeric comparison', () => {
      expect(evaluateCondition('missing >= 0', {})).toBe(true);
      expect(evaluateCondition('missing > 0', {})).toBe(false);
    });

    test('non-numeric string coerces to 0 in numeric comparison', () => {
      expect(evaluateCondition('val > 0', { val: 'abc' })).toBe(false);
    });

    test('numeric string coerces correctly in numeric comparison', () => {
      expect(evaluateCondition('val > 10', { val: '20' })).toBe(true);
      expect(evaluateCondition('val < 10', { val: '5' })).toBe(true);
    });

    test('array coerces to length in numeric comparison', () => {
      expect(evaluateCondition('items > 2', { items: [1, 2, 3] })).toBe(true);
      expect(evaluateCondition('items < 2', { items: [1, 2, 3] })).toBe(false);
    });
  });

  describe('Built-in functions — expanded', () => {
    test('UPPER converts to uppercase', () => {
      expect(resolveValue('UPPER("hello")', {})).toBe('HELLO');
    });

    test('LOWER converts to lowercase', () => {
      expect(resolveValue('LOWER("HELLO")', {})).toBe('hello');
    });

    test('TRIM removes whitespace', () => {
      expect(resolveValue('TRIM("  hello  ")', {})).toBe('hello');
    });

    test('ADD adds two numbers', () => {
      expect(resolveValue('ADD(10, 20)', {})).toBe(30);
    });

    test('SUB subtracts two numbers', () => {
      expect(resolveValue('SUB(20, 5)', {})).toBe(15);
    });

    test('MUL multiplies two numbers', () => {
      expect(resolveValue('MUL(4, 5)', {})).toBe(20);
    });

    test('DIV divides two numbers', () => {
      expect(resolveValue('DIV(20, 4)', {})).toBe(5);
    });

    test('DIV by zero returns null', () => {
      expect(resolveValue('DIV(10, 0)', {})).toBeNull();
    });

    test('ROUND rounds to integer by default', () => {
      expect(resolveValue('ROUND(3.7)', {})).toBe(4);
    });

    test('ROUND rounds to specified decimals', () => {
      expect(resolveValue('ROUND(3.14159, 2)', {})).toBeCloseTo(3.14);
    });

    test('ABS returns absolute value', () => {
      expect(resolveValue('ABS(-5)', {})).toBe(5);
      expect(resolveValue('ABS(5)', {})).toBe(5);
    });

    test('MIN returns minimum', () => {
      expect(resolveValue('MIN(3, 7)', {})).toBe(3);
    });

    test('MAX returns maximum', () => {
      expect(resolveValue('MAX(3, 7)', {})).toBe(7);
    });

    test('LENGTH returns array length', () => {
      expect(resolveValue('LENGTH(items)', { items: [1, 2, 3] })).toBe(3);
    });

    test('LENGTH returns string length', () => {
      expect(resolveValue('LENGTH("hello")', {})).toBe(5);
    });

    test('LENGTH returns 0 for non-array non-string', () => {
      expect(resolveValue('LENGTH(val)', { val: 42 })).toBe(0);
    });

    test('COALESCE returns first non-null value', () => {
      expect(resolveValue('COALESCE(a, b, "default")', { b: 'found' })).toBe('found');
    });

    test('COALESCE returns null when all null/undefined', () => {
      expect(resolveValue('COALESCE(a, b)', {})).toBeNull();
    });

    test('SUBSTRING extracts substring', () => {
      expect(resolveValue('SUBSTRING("Hello World", 0, 5)', {})).toBe('Hello');
    });

    test('REPLACE replaces all occurrences', () => {
      expect(resolveValue('REPLACE("aabaa", "a", "x")', {})).toBe('xxbxx');
    });

    test('SPLIT splits string into array', () => {
      expect(resolveValue('SPLIT("a,b,c", ",")', {})).toEqual(['a', 'b', 'c']);
    });

    test('JOIN joins array with delimiter', () => {
      expect(resolveValue('JOIN(items, "-")', { items: ['a', 'b', 'c'] })).toBe('a-b-c');
    });

    test('IS_ARRAY returns true for arrays', () => {
      expect(resolveValue('IS_ARRAY(items)', { items: [1] })).toBe(true);
    });

    test('IS_ARRAY returns false for non-arrays', () => {
      expect(resolveValue('IS_ARRAY(val)', { val: 'str' })).toBe(false);
    });

    test('IS_NUMBER returns true for numbers', () => {
      expect(resolveValue('IS_NUMBER(val)', { val: 42 })).toBe(true);
    });

    test('IS_NUMBER returns false for NaN', () => {
      expect(resolveValue('IS_NUMBER(val)', { val: NaN })).toBe(false);
    });

    test('IS_STRING returns true for strings', () => {
      expect(resolveValue('IS_STRING(val)', { val: 'hello' })).toBe(true);
    });

    test('TO_NUMBER converts string to number', () => {
      expect(resolveValue('TO_NUMBER("42")', {})).toBe(42);
    });

    test('TO_NUMBER returns null for non-numeric', () => {
      expect(resolveValue('TO_NUMBER("abc")', {})).toBeNull();
    });

    test('TO_STRING converts number to string', () => {
      expect(resolveValue('TO_STRING(42)', {})).toBe('42');
    });

    test('TO_STRING converts null to empty string', () => {
      expect(resolveValue('TO_STRING(val)', {})).toBe('');
    });

    test('OBJECT_KEYS returns keys of object', () => {
      expect(resolveValue('OBJECT_KEYS(obj)', { obj: { a: 1, b: 2 } })).toEqual(['a', 'b']);
    });

    test('OBJECT_VALUES returns values of object', () => {
      expect(resolveValue('OBJECT_VALUES(obj)', { obj: { a: 1, b: 2 } })).toEqual([1, 2]);
    });

    test('OBJECT_MERGE merges objects', () => {
      expect(resolveValue('OBJECT_MERGE(a, b)', { a: { x: 1 }, b: { y: 2 } })).toEqual({
        x: 1,
        y: 2,
      });
    });

    test('MASK with last4 pattern', () => {
      expect(resolveValue('MASK("1234567890", "last4")', {})).toBe('******7890');
    });

    test('MASK with first4 pattern', () => {
      expect(resolveValue('MASK("1234567890", "first4")', {})).toBe('1234******');
    });

    test('MASK with N*N pattern', () => {
      expect(resolveValue('MASK("1234567890", "2*2")', {})).toBe('12******90');
    });

    test('ORDINAL formats ordinal numbers', () => {
      expect(resolveValue('ORDINAL(1)', {})).toBe('1st');
      expect(resolveValue('ORDINAL(2)', {})).toBe('2nd');
      expect(resolveValue('ORDINAL(3)', {})).toBe('3rd');
      expect(resolveValue('ORDINAL(4)', {})).toBe('4th');
      expect(resolveValue('ORDINAL(11)', {})).toBe('11th');
      expect(resolveValue('ORDINAL(21)', {})).toBe('21st');
    });

    test('nested function calls: ADD(MUL(2, 3), 4)', () => {
      expect(resolveValue('ADD(MUL(2, 3), 4)', {})).toBe(10);
    });

    test('ARRAY_FIND finds matching item', () => {
      const ctx = {
        items: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
        ],
      };
      expect(resolveValue('ARRAY_FIND(items, "id", 2)', ctx)).toEqual({ id: 2, name: 'B' });
    });

    test('ARRAY_FIND returns null when not found', () => {
      expect(resolveValue('ARRAY_FIND(items, "id", 99)', { items: [{ id: 1 }] })).toBeNull();
    });

    test('ARRAY_FIND_INDEX returns index', () => {
      const ctx = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      expect(resolveValue('ARRAY_FIND_INDEX(items, "id", 2)', ctx)).toBe(1);
    });

    test('ARRAY_FIND_INDEX returns -1 when not found', () => {
      expect(resolveValue('ARRAY_FIND_INDEX(items, "id", 99)', { items: [{ id: 1 }] })).toBe(-1);
    });

    test('PAD_START pads string from left', () => {
      expect(resolveValue('PAD_START("42", 5, "0")', {})).toBe('00042');
    });

    test('PAD_END pads string from right', () => {
      expect(resolveValue('PAD_END("hi", 5, ".")', {})).toBe('hi...');
    });

    test('REPEAT repeats a string', () => {
      expect(resolveValue('REPEAT("ab", 3)', {})).toBe('ababab');
    });
  });

  describe('resolveValue — expanded edge cases', () => {
    test('resolves null literal', () => {
      expect(resolveValue('null', {})).toBeNull();
    });

    test('resolves undefined literal', () => {
      expect(resolveValue('undefined', {})).toBeUndefined();
    });

    test('resolves array literal', () => {
      expect(resolveValue('[1, 2, 3]', {})).toEqual([1, 2, 3]);
    });

    test('resolves regex literal', () => {
      const result = resolveValue('/^hello/i', {});
      expect(result).toBeInstanceOf(RegExp);
      expect((result as RegExp).test('Hello World')).toBe(true);
    });

    test('returns undefined for missing context key', () => {
      expect(resolveValue('missing', {})).toBeUndefined();
    });

    test('handles function with context variable as argument', () => {
      expect(resolveValue('UPPER(name)', { name: 'alice' })).toBe('ALICE');
    });

    test('handles deeply nested function calls up to max depth', () => {
      // 3 levels deep — should work fine
      expect(resolveValue('ADD(ADD(ADD(1, 2), 3), 4)', {})).toBe(10);
    });

    test('handles array index notation in getNestedValue', () => {
      expect(getNestedValue({ items: ['a', 'b', 'c'] }, 'items[1]')).toBe('b');
    });

    test('handles array index out of bounds', () => {
      expect(getNestedValue({ items: ['a'] }, 'items[5]')).toBeUndefined();
    });
  });

  describe('evaluateConditionWithInput — expanded', () => {
    test('input matches regex with capture groups', () => {
      const ctx: Record<string, unknown> = {};
      const result = evaluateConditionWithInput('input matches "order-(\\d+)"', 'order-789', ctx);
      expect(result).toBe(true);
    });

    test('input contains substring check', () => {
      expect(
        evaluateConditionWithInput('input contains "booking"', 'make a booking please', {}),
      ).toBe(true);
    });

    test('input == comparison', () => {
      expect(evaluateConditionWithInput('input == "yes"', 'yes', {})).toBe(true);
      expect(evaluateConditionWithInput('input == "yes"', 'no', {})).toBe(false);
    });

    test('input != comparison', () => {
      expect(evaluateConditionWithInput('input != "cancel"', 'continue', {})).toBe(true);
    });

    test('input with context variable in AND', () => {
      expect(
        evaluateConditionWithInput('input == "confirm" AND step == "review"', 'confirm', {
          step: 'review',
        }),
      ).toBe(true);
    });

    test('input startsWith check', () => {
      expect(evaluateConditionWithInput('input startsWith "Hello"', 'Hello World', {})).toBe(true);
      expect(evaluateConditionWithInput('input startsWith "World"', 'Hello World', {})).toBe(false);
    });

    test('input endsWith check', () => {
      expect(evaluateConditionWithInput('input endsWith "World"', 'Hello World', {})).toBe(true);
    });

    test('empty input with IS SET', () => {
      // empty string is truthy for IS SET (not null/undefined)
      expect(evaluateConditionWithInput('input IS SET', '', {})).toBe(true);
    });
  });

  describe('evaluateConditionDetailed — expanded with matches', () => {
    test('matches type returns conditionType matches', () => {
      const detail = evaluateConditionDetailed('input matches "^hello"', 'hello world', {});
      expect(detail.conditionType).toBe('matches');
      expect(detail.matched).toBe(true);
    });

    test('failed match returns conditionType matches with matched=false', () => {
      const detail = evaluateConditionDetailed('input matches "^xyz"', 'hello', {});
      expect(detail.conditionType).toBe('matches');
      expect(detail.matched).toBe(false);
    });

    test('IS SET detail includes value and conditionType', () => {
      const detail = evaluateConditionDetailed('name IS SET', '', { name: 'Alice' });
      expect(detail.conditionType).toBe('is_set');
      expect(detail.leftValue).toBe('Alice');
      expect(detail.operator).toBe('IS SET');
    });

    test('IS NOT SET detail for missing variable', () => {
      const detail = evaluateConditionDetailed('x IS NOT SET', '', {});
      expect(detail.conditionType).toBe('is_not_set');
      expect(detail.matched).toBe(true);
    });

    test('IS NOT SET detail for null variable', () => {
      const detail = evaluateConditionDetailed('x IS NOT SET', '', { x: null });
      expect(detail.conditionType).toBe('is_not_set');
      expect(detail.matched).toBe(true);
    });

    test('variable comparison detail for != operator', () => {
      const detail = evaluateConditionDetailed('a != "hello"', '', { a: 'world' });
      expect(detail.conditionType).toBe('variable_comparison');
      expect(detail.operator).toBe('!=');
      expect(detail.matched).toBe(true);
    });

    test('compound AND with partial failure', () => {
      const detail = evaluateConditionDetailed('a == 1 AND b == 99', '', { a: 1, b: 2 });
      expect(detail.conditionType).toBe('compound_and');
      expect(detail.matched).toBe(false);
    });

    test('compound OR with partial success', () => {
      const detail = evaluateConditionDetailed('a == 99 OR b == 2', '', { a: 1, b: 2 });
      expect(detail.conditionType).toBe('compound_or');
      expect(detail.matched).toBe(true);
    });

    test('fallback (other) for complex expression', () => {
      const detail = evaluateConditionDetailed('true', '', {});
      expect(detail.conditionType).toBe('other');
      expect(detail.matched).toBe(true);
    });
  });

  describe('setNestedValue — expanded', () => {
    test('should create deeply nested path from scratch', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'a.b.c.d', 'value');
      expect(getNestedValue(obj, 'a.b.c.d')).toBe('value');
    });

    test('should overwrite intermediate non-object', () => {
      const obj: Record<string, unknown> = { a: 'string' };
      setNestedValue(obj, 'a.b', 'value');
      expect(getNestedValue(obj, 'a.b')).toBe('value');
    });

    test('should set null value', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'x', null);
      expect(obj.x).toBeNull();
    });

    test('should set array value', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'items', [1, 2, 3]);
      expect(obj.items).toEqual([1, 2, 3]);
    });
  });

  describe('splitByOperator — expanded', () => {
    test('returns single element for no operator', () => {
      expect(splitByOperator('a == 1', ' AND ')).toEqual(['a == 1']);
    });

    test('splits by AND respecting parens', () => {
      expect(splitByOperator('(a OR b) AND c', ' AND ')).toEqual(['(a OR b)', 'c']);
    });

    test('splits by OR respecting parens', () => {
      expect(splitByOperator('a OR (b AND c)', ' OR ')).toEqual(['a', '(b AND c)']);
    });

    test('handles multiple AND operators', () => {
      expect(splitByOperator('a AND b AND c', ' AND ')).toEqual(['a', 'b', 'c']);
    });

    test('handles nested parens in complex expression', () => {
      const result = splitByOperator('(a AND (b OR c)) AND d', ' AND ');
      expect(result).toEqual(['(a AND (b OR c))', 'd']);
    });
  });

  describe('Error handling and resilience', () => {
    test('nonsensical condition string is treated as bare variable truthiness', () => {
      // '!@#$%^' — starts with '!' so NOT is applied to '@#$%^'
      // '@#$%^' resolves to undefined via getNestedValue, undefined is falsy
      // NOT(false) = true
      expect(evaluateCondition('!@#$%^', {})).toBe(true);
    });

    test('operator-only condition "==" splits into empty parts, both resolve undefined (equal)', () => {
      // '==' splits on '==' to ['', ''], both resolve to undefined
      // isEqual(undefined, undefined) = true
      expect(evaluateCondition('==', {})).toBe(true);
    });

    test('handles condition with missing right operand', () => {
      // 'name ==' splits to ['name', ''], name='John', ''=undefined
      // isEqual('John', undefined) = false
      expect(evaluateCondition('name ==', { name: 'John' })).toBe(false);
    });

    test('evaluates complex nested AND/OR/parentheses', () => {
      const ctx = { a: 1, b: 2, c: 3 };
      expect(evaluateCondition('(a == 1 OR b == 99) AND c == 3', ctx)).toBe(true);
      expect(evaluateCondition('(a == 99 OR b == 99) AND c == 3', ctx)).toBe(false);
    });
  });
});
