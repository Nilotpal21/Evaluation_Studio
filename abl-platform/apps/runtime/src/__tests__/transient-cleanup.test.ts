import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GatherField } from '@abl/compiler';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => mockLog,
}));

import { cleanupTransientFields } from '../services/execution/transient-cleanup';

function makeField(name: string, overrides?: Partial<GatherField>): GatherField {
  return {
    name,
    prompt: `Enter ${name}`,
    type: 'string',
    required: true,
    ...overrides,
  };
}

describe('cleanupTransientFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes transient fields from data', () => {
    const data: Record<string, unknown> = { cvv: '123', cardNumber: '4111' };
    const fields = [makeField('cvv', { transient: true }), makeField('cardNumber')];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual(['cvv']);
    expect(data).toEqual({ cardNumber: '4111' });
  });

  it('returns empty array when no transient fields', () => {
    const data: Record<string, unknown> = { name: 'Alice', email: 'a@b.com' };
    const fields = [makeField('name'), makeField('email')];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual([]);
    expect(data).toEqual({ name: 'Alice', email: 'a@b.com' });
  });

  it('handles multiple transient fields', () => {
    const data: Record<string, unknown> = { cvv: '123', otp: '9999', name: 'Alice' };
    const fields = [
      makeField('cvv', { transient: true }),
      makeField('otp', { transient: true }),
      makeField('name'),
    ];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual(['cvv', 'otp']);
    expect(data).toEqual({ name: 'Alice' });
  });

  it('skips fields not present in data', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const fields = [makeField('cvv', { transient: true }), makeField('name')];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual([]);
    expect(data).toEqual({ name: 'Alice' });
  });

  it('handles empty fields array', () => {
    const data: Record<string, unknown> = { name: 'Alice' };

    const removed = cleanupTransientFields(data, []);

    expect(removed).toEqual([]);
    expect(data).toEqual({ name: 'Alice' });
  });

  it('does not modify non-transient fields', () => {
    const data: Record<string, unknown> = {
      cvv: '123',
      cardNumber: '4111',
      expiry: '12/28',
    };
    const fields = [
      makeField('cvv', { transient: true }),
      makeField('cardNumber'),
      makeField('expiry'),
    ];

    cleanupTransientFields(data, fields);

    expect(data.cardNumber).toBe('4111');
    expect(data.expiry).toBe('12/28');
    expect(data.cvv).toBeUndefined();
  });

  it('handles empty data object with transient fields defined', () => {
    const data: Record<string, unknown> = {};
    const fields = [makeField('cvv', { transient: true }), makeField('otp', { transient: true })];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual([]);
    expect(data).toEqual({});
  });

  it('handles field with transient=false explicitly', () => {
    const data: Record<string, unknown> = { cardNumber: '4111', cvv: '123' };
    const fields = [makeField('cardNumber', { transient: false }), makeField('cvv')];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual([]);
    expect(data).toEqual({ cardNumber: '4111', cvv: '123' });
  });

  it('handles field with transient=undefined', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const fields = [makeField('name', { transient: undefined })];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual([]);
    expect(data).toEqual({ name: 'Alice' });
  });

  it('returns removed field names in iteration order', () => {
    const data: Record<string, unknown> = { otp: '9999', cvv: '123', token: 'abc' };
    const fields = [
      makeField('otp', { transient: true }),
      makeField('cvv', { transient: true }),
      makeField('token', { transient: true }),
    ];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual(['otp', 'cvv', 'token']);
  });

  it('mutates the original data object in place', () => {
    const data: Record<string, unknown> = { cvv: '123', name: 'Alice' };
    const fields = [makeField('cvv', { transient: true })];
    const originalRef = data;

    cleanupTransientFields(data, fields);

    expect(data).toBe(originalRef);
    expect('cvv' in data).toBe(false);
  });

  it('handles data with extra fields not in field definitions', () => {
    const data: Record<string, unknown> = {
      cvv: '123',
      name: 'Alice',
      unknownField: 'extra',
    };
    const fields = [makeField('cvv', { transient: true })];

    const removed = cleanupTransientFields(data, fields);

    expect(removed).toEqual(['cvv']);
    expect(data).toEqual({ name: 'Alice', unknownField: 'extra' });
  });

  it('logs when transient fields are removed', () => {
    const data: Record<string, unknown> = { cvv: '123', otp: '9999' };
    const fields = [makeField('cvv', { transient: true }), makeField('otp', { transient: true })];

    cleanupTransientFields(data, fields);

    expect(mockLog.info).toHaveBeenCalledWith('transient-fields-cleaned', {
      fields: ['cvv', 'otp'],
    });
  });

  it('does not log when no transient fields are removed', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const fields = [makeField('name')];

    cleanupTransientFields(data, fields);

    expect(mockLog.info).not.toHaveBeenCalled();
  });
});
