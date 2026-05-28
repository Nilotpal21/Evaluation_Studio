/**
 * Unit tests for the pure `validateAndCoerceInput` function.
 *
 * Zero mocks — this is a pure function over plain objects. Every coercion
 * branch and every error classification has explicit coverage.
 */

import { describe, it, expect } from 'vitest';
import { validateAndCoerceInput, type FieldError } from '../validation/start-input-validator.js';
import type { StartInputVariable } from '../handlers/canvas-to-steps.js';

// Convenience helpers
const req = (name: string, type: StartInputVariable['type']): StartInputVariable => ({
  name,
  type,
  required: true,
});
const opt = (name: string, type: StartInputVariable['type']): StartInputVariable => ({
  name,
  type,
  required: false,
});

function expectOk(r: ReturnType<typeof validateAndCoerceInput>): Extract<typeof r, { ok: true }> {
  if (!r.ok) {
    throw new Error(`expected ok:true, got errors=${JSON.stringify(r.errors)}`);
  }
  return r;
}

function expectErrors(r: ReturnType<typeof validateAndCoerceInput>): FieldError[] {
  if (r.ok) {
    throw new Error(`expected ok:false, got coerced=${JSON.stringify(r.coerced)}`);
  }
  return r.errors;
}

describe('validateAndCoerceInput — pass-through cases', () => {
  it('returns ok with empty coerced when declarations AND payload are empty', () => {
    const r = validateAndCoerceInput([], {});
    expect(expectOk(r).coerced).toEqual({});
  });

  it('returns ok with the payload as coerced when startInputVariables is undefined', () => {
    const r = validateAndCoerceInput(undefined, { a: 1, b: 'x' });
    expect(expectOk(r).coerced).toEqual({ a: 1, b: 'x' });
  });

  it('returns ok with {} when both declarations and payload are undefined', () => {
    const r = validateAndCoerceInput(undefined, undefined);
    expect(expectOk(r).coerced).toEqual({});
  });

  it('no declarations — extra payload keys pass through unchanged', () => {
    const r = validateAndCoerceInput([], { random: 'kept', n: 42 });
    expect(expectOk(r).coerced).toEqual({ random: 'kept', n: 42 });
  });

  it('does not mutate the input payload', () => {
    const payload = { email: 'a@b', amount: '100' };
    const frozen = Object.freeze({ ...payload });
    validateAndCoerceInput([req('email', 'string'), req('amount', 'number')], frozen);
    expect(frozen).toEqual({ email: 'a@b', amount: '100' });
  });
});

describe('validateAndCoerceInput — REQUIRED errors', () => {
  it('reports REQUIRED for a declared required field missing from payload', () => {
    const errs = expectErrors(validateAndCoerceInput([req('email', 'string')], {}));
    expect(errs).toEqual([{ name: 'email', reason: 'REQUIRED' }]);
  });

  it('treats null as missing (REQUIRED fires)', () => {
    const errs = expectErrors(validateAndCoerceInput([req('email', 'string')], { email: null }));
    expect(errs).toEqual([{ name: 'email', reason: 'REQUIRED' }]);
  });

  it('treats undefined as missing (REQUIRED fires)', () => {
    const errs = expectErrors(
      validateAndCoerceInput([req('email', 'string')], { email: undefined }),
    );
    expect(errs).toEqual([{ name: 'email', reason: 'REQUIRED' }]);
  });

  it('optional + missing → no error, field absent in coerced', () => {
    const r = validateAndCoerceInput([opt('email', 'string')], {});
    expect(expectOk(r).coerced).toEqual({});
  });

  it('accumulates REQUIRED errors for multiple missing fields (no short-circuit)', () => {
    const errs = expectErrors(
      validateAndCoerceInput([req('a', 'string'), req('b', 'number'), req('c', 'json')], {}),
    );
    expect(errs).toEqual([
      { name: 'a', reason: 'REQUIRED' },
      { name: 'b', reason: 'REQUIRED' },
      { name: 'c', reason: 'REQUIRED' },
    ]);
  });
});

describe('validateAndCoerceInput — number coercion', () => {
  it('native number passes through', () => {
    const r = validateAndCoerceInput([req('n', 'number')], { n: 42 });
    expect(expectOk(r).coerced).toEqual({ n: 42 });
  });

  it('string "42" coerces to number 42', () => {
    const r = validateAndCoerceInput([req('n', 'number')], { n: '42' });
    expect(expectOk(r).coerced).toEqual({ n: 42 });
  });

  it('string "abc" → TYPE_MISMATCH with expected=number, got=string', () => {
    const errs = expectErrors(validateAndCoerceInput([req('n', 'number')], { n: 'abc' }));
    expect(errs).toEqual([
      { name: 'n', reason: 'TYPE_MISMATCH', expected: 'number', got: 'string' },
    ]);
  });

  it('NaN (as native number) → TYPE_MISMATCH (treats NaN as not-a-number)', () => {
    const errs = expectErrors(validateAndCoerceInput([req('n', 'number')], { n: NaN }));
    expect(errs).toEqual([
      { name: 'n', reason: 'TYPE_MISMATCH', expected: 'number', got: 'number' },
    ]);
  });

  it('boolean true → TYPE_MISMATCH (does not coerce bools to numbers)', () => {
    const errs = expectErrors(validateAndCoerceInput([req('n', 'number')], { n: true }));
    expect(errs).toEqual([
      { name: 'n', reason: 'TYPE_MISMATCH', expected: 'number', got: 'boolean' },
    ]);
  });

  it('empty string "" → TYPE_MISMATCH (does NOT silently coerce to 0)', () => {
    // `Number("")` returns 0, which would silently turn a blank payload
    // field into a valid zero. The validator must reject explicitly.
    const errs = expectErrors(validateAndCoerceInput([req('n', 'number')], { n: '' }));
    expect(errs).toEqual([
      { name: 'n', reason: 'TYPE_MISMATCH', expected: 'number', got: 'string' },
    ]);
  });

  it('whitespace-only string "   " → TYPE_MISMATCH', () => {
    const errs = expectErrors(validateAndCoerceInput([req('n', 'number')], { n: '   ' }));
    expect(errs).toEqual([
      { name: 'n', reason: 'TYPE_MISMATCH', expected: 'number', got: 'string' },
    ]);
  });

  it('string with leading/trailing whitespace "  42  " coerces to 42 (trimmed)', () => {
    const r = validateAndCoerceInput([req('n', 'number')], { n: '  42  ' });
    expect(expectOk(r).coerced).toEqual({ n: 42 });
  });
});

describe('validateAndCoerceInput — boolean coercion (broadened set)', () => {
  it('native boolean passes through', () => {
    expect(expectOk(validateAndCoerceInput([req('b', 'boolean')], { b: true })).coerced).toEqual({
      b: true,
    });
    expect(expectOk(validateAndCoerceInput([req('b', 'boolean')], { b: false })).coerced).toEqual({
      b: false,
    });
  });

  it('string truthy set: "true"/"1"/"yes" (case-insensitive) → true', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'YES', 'Yes']) {
      const r = validateAndCoerceInput([req('b', 'boolean')], { b: v });
      expect(expectOk(r).coerced).toEqual({ b: true });
    }
  });

  it('string falsy set: "false"/"0"/"no" (case-insensitive) → false', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'NO', 'No']) {
      const r = validateAndCoerceInput([req('b', 'boolean')], { b: v });
      expect(expectOk(r).coerced).toEqual({ b: false });
    }
  });

  it('string "maybe" → TYPE_MISMATCH', () => {
    const errs = expectErrors(validateAndCoerceInput([req('b', 'boolean')], { b: 'maybe' }));
    expect(errs).toEqual([
      { name: 'b', reason: 'TYPE_MISMATCH', expected: 'boolean', got: 'string' },
    ]);
  });

  it('number 1 (native) → TYPE_MISMATCH (only strings are coerced)', () => {
    const errs = expectErrors(validateAndCoerceInput([req('b', 'boolean')], { b: 1 }));
    expect(errs).toEqual([
      { name: 'b', reason: 'TYPE_MISMATCH', expected: 'boolean', got: 'number' },
    ]);
  });
});

describe('validateAndCoerceInput — json coercion', () => {
  it('string JSON object coerces to parsed object', () => {
    const r = validateAndCoerceInput([req('j', 'json')], { j: '{"a":1,"b":[2]}' });
    expect(expectOk(r).coerced).toEqual({ j: { a: 1, b: [2] } });
  });

  it('string JSON array coerces to parsed array', () => {
    const r = validateAndCoerceInput([req('j', 'json')], { j: '[1,2,3]' });
    expect(expectOk(r).coerced).toEqual({ j: [1, 2, 3] });
  });

  it('plain object pass-through (webhook body already parsed)', () => {
    const r = validateAndCoerceInput([req('j', 'json')], { j: { a: 1 } });
    expect(expectOk(r).coerced).toEqual({ j: { a: 1 } });
  });

  it('invalid JSON string → JSON_PARSE_ERROR', () => {
    const errs = expectErrors(validateAndCoerceInput([req('j', 'json')], { j: 'not json' }));
    expect(errs).toHaveLength(1);
    expect(errs[0].name).toBe('j');
    expect(errs[0].reason).toBe('JSON_PARSE_ERROR');
    expect(errs[0].expected).toBe('json');
  });

  it('number → TYPE_MISMATCH', () => {
    const errs = expectErrors(validateAndCoerceInput([req('j', 'json')], { j: 42 }));
    expect(errs).toEqual([{ name: 'j', reason: 'TYPE_MISMATCH', expected: 'json', got: 'number' }]);
  });
});

describe('validateAndCoerceInput — string coercion', () => {
  it('string pass-through', () => {
    const r = validateAndCoerceInput([req('s', 'string')], { s: 'hello' });
    expect(expectOk(r).coerced).toEqual({ s: 'hello' });
  });

  it('number → TYPE_MISMATCH (strings are not coerced from numbers)', () => {
    const errs = expectErrors(validateAndCoerceInput([req('s', 'string')], { s: 42 }));
    expect(errs).toEqual([
      { name: 's', reason: 'TYPE_MISMATCH', expected: 'string', got: 'number' },
    ]);
  });
});

describe('validateAndCoerceInput — extra/undeclared payload fields', () => {
  it('declared + undeclared fields coexist; undeclared pass through unchanged', () => {
    const r = validateAndCoerceInput([req('email', 'string'), req('amount', 'number')], {
      email: 'a@b',
      amount: '100',
      extraMeta: { source: 'webhook' },
      noise: 42,
    });
    expect(expectOk(r).coerced).toEqual({
      email: 'a@b',
      amount: 100,
      extraMeta: { source: 'webhook' },
      noise: 42,
    });
  });
});

describe('validateAndCoerceInput — error accumulation (no short-circuit)', () => {
  it('reports every failing declared field in a single call', () => {
    const errs = expectErrors(
      validateAndCoerceInput(
        [
          req('email', 'string'), // missing
          req('amount', 'number'), // type mismatch
          req('config', 'json'), // parse error
        ],
        { amount: 'abc', config: 'not json' },
      ),
    );
    expect(errs).toEqual([
      { name: 'email', reason: 'REQUIRED' },
      { name: 'amount', reason: 'TYPE_MISMATCH', expected: 'number', got: 'string' },
      expect.objectContaining({ name: 'config', reason: 'JSON_PARSE_ERROR' }),
    ]);
  });
});

describe('validateAndCoerceInput — D-13 regression: no defaultValue application', () => {
  it('ignores canvas-shape defaultValue on a required declaration; REQUIRED still fires', () => {
    // The engine-consumed type `StartInputVariable` omits defaultValue/description,
    // but a careless caller could still pass an object literal with a
    // `defaultValue` field — the validator must ignore it per LLD D-13.
    const withDefault = {
      name: 'x',
      type: 'number' as const,
      required: true,
      // @ts-expect-error — intentionally passing canvas-shape extras
      defaultValue: 10,
    };
    const errs = expectErrors(validateAndCoerceInput([withDefault as StartInputVariable], {}));
    expect(errs).toEqual([{ name: 'x', reason: 'REQUIRED' }]);
  });

  it('ignores defaultValue on an optional declaration too; field simply absent', () => {
    const withDefault = {
      name: 'x',
      type: 'number' as const,
      required: false,
      // @ts-expect-error — intentionally passing canvas-shape extras
      defaultValue: 10,
    };
    const r = validateAndCoerceInput([withDefault as StartInputVariable], {});
    expect(expectOk(r).coerced).toEqual({});
  });
});
