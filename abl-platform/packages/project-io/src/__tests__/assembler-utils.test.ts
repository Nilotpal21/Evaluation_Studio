import { describe, it, expect } from 'vitest';
import { sanitizeName, stripInternalFields } from '../export/layer-assemblers/assembler-utils.js';

// ─── sanitizeName ────────────────────────────────────────────────────────────

describe('sanitizeName', () => {
  it('should return lowercase name unchanged when already clean', () => {
    expect(sanitizeName('myagent')).toBe('myagent');
  });

  it('should convert uppercase letters to lowercase', () => {
    expect(sanitizeName('MyAgent')).toBe('myagent');
  });

  it('should handle fully uppercase names', () => {
    expect(sanitizeName('BOOKING')).toBe('booking');
  });

  it('should replace spaces with underscores', () => {
    expect(sanitizeName('my agent')).toBe('my_agent');
  });

  it('should replace multiple spaces with underscores', () => {
    expect(sanitizeName('my  long  agent')).toBe('my__long__agent');
  });

  it('should replace special characters with underscores', () => {
    expect(sanitizeName('agent!@#$%')).toBe('agent_____');
  });

  it('should preserve hyphens', () => {
    expect(sanitizeName('booking-agent')).toBe('booking-agent');
  });

  it('should preserve underscores', () => {
    expect(sanitizeName('booking_agent')).toBe('booking_agent');
  });

  it('should preserve digits', () => {
    expect(sanitizeName('agent123')).toBe('agent123');
  });

  it('should handle mixed case with special characters', () => {
    expect(sanitizeName('My Agent! (v2)')).toBe('my_agent___v2_');
  });

  it('should return empty string for empty input', () => {
    expect(sanitizeName('')).toBe('');
  });

  it('should replace leading whitespace with underscores', () => {
    expect(sanitizeName('  agent')).toBe('__agent');
  });

  it('should replace trailing whitespace with underscores', () => {
    expect(sanitizeName('agent  ')).toBe('agent__');
  });

  it('should replace leading and trailing whitespace', () => {
    expect(sanitizeName(' agent ')).toBe('_agent_');
  });

  it('should replace dots with underscores', () => {
    expect(sanitizeName('v2.0.agent')).toBe('v2_0_agent');
  });

  it('should handle name that is only special characters', () => {
    expect(sanitizeName('!@#')).toBe('___');
  });
});

// ─── stripInternalFields ─────────────────────────────────────────────────────

describe('stripInternalFields', () => {
  it('should strip default internal fields', () => {
    const input = {
      _id: 'abc123',
      __v: 0,
      _v: 1,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      name: 'my-agent',
      description: 'A test agent',
    };
    const result = stripInternalFields(input);

    expect(result).toEqual({ name: 'my-agent', description: 'A test agent' });
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
    expect(result).not.toHaveProperty('_v');
    expect(result).not.toHaveProperty('projectId');
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('createdBy');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('should preserve non-internal fields', () => {
    const input = {
      _id: 'abc',
      name: 'test',
      config: { key: 'value' },
      tags: ['a', 'b'],
    };
    const result = stripInternalFields(input);

    expect(result).toHaveProperty('name', 'test');
    expect(result).toHaveProperty('config');
    expect(result).toHaveProperty('tags');
  });

  it('should not strip _id from nested objects', () => {
    const input = {
      _id: 'top-level',
      nested: { _id: 'nested-id', value: 42 },
    };
    const result = stripInternalFields(input);

    expect(result).not.toHaveProperty('_id');
    expect((result as Record<string, unknown>).nested).toEqual({
      _id: 'nested-id',
      value: 42,
    });
  });

  it('should strip additional keys when additionalKeys is provided', () => {
    const input = {
      _id: 'abc',
      name: 'test',
      secret: 'should-be-removed',
      tempFlag: true,
    };
    const result = stripInternalFields(input, ['secret', 'tempFlag']);

    expect(result).toEqual({ name: 'test' });
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('tempFlag');
  });

  it('should behave the same as default when additionalKeys is empty array', () => {
    const input = {
      _id: 'abc',
      __v: 0,
      name: 'test',
    };
    const defaultResult = stripInternalFields(input);
    const emptyAdditionalResult = stripInternalFields(input, []);

    expect(emptyAdditionalResult).toEqual(defaultResult);
  });

  it('should return an unchanged copy when input has no internal fields', () => {
    const input = { name: 'clean', description: 'no internal fields' };
    const result = stripInternalFields(input);

    expect(result).toEqual({ name: 'clean', description: 'no internal fields' });
  });

  it('should NOT mutate the original object', () => {
    const input = {
      _id: 'abc',
      __v: 0,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      name: 'test',
    };
    const inputCopy = { ...input };

    stripInternalFields(input);

    expect(input).toEqual(inputCopy);
  });

  it('should handle object with only internal fields', () => {
    const input = {
      _id: 'abc',
      __v: 0,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    };
    const result = stripInternalFields(input);

    expect(result).toEqual({});
  });

  it('should handle additionalKeys that do not exist on the object', () => {
    const input = { _id: 'abc', name: 'test' };
    const result = stripInternalFields(input, ['nonExistent']);

    expect(result).toEqual({ name: 'test' });
  });
});
