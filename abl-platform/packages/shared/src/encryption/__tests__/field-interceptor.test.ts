import { describe, it, expect, vi } from 'vitest';
import { encryptFields, decryptFields, ENC_VALUE_PREFIX } from '../index.js';

const mockEncService = {
  encryptForTenant: vi.fn((text: string, _tid: string) => `encrypted_${text}`),
  decryptForTenant: vi.fn((text: string, _tid: string) => text.replace('encrypted_', '')),
} as any;

const TENANT = 'tenant-1';

describe('encryptFields', () => {
  it('encrypts specified fields and stamps _enc = v3', async () => {
    const row = { name: 'Alice', email: 'alice@example.com', age: 30 };
    const result = await encryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result.name).toBe(`${ENC_VALUE_PREFIX}encrypted_Alice`);
    expect(result.email).toBe(`${ENC_VALUE_PREFIX}encrypted_alice@example.com`);
    expect(result.age).toBe(30);
    expect(result._enc).toBe('v3');
  });

  it('skips null/undefined fields', async () => {
    const row = { name: null, email: undefined, other: 'keep' };
    const result = await encryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result.name).toBeNull();
    expect(result.email).toBeUndefined();
    expect(result._enc).toBe('v3');
  });

  it('throws on already-encrypted row (_enc present)', async () => {
    const row = { _enc: 'v3', name: 'Alice' };
    await expect(encryptFields(row, ['name'], TENANT, mockEncService)).rejects.toThrow(
      'Row already encrypted',
    );
  });

  it('throws on field with ENC_VALUE_PREFIX — double encryption detected', async () => {
    const row = { name: `${ENC_VALUE_PREFIX}something` };
    await expect(encryptFields(row, ['name'], TENANT, mockEncService)).rejects.toThrow(
      'double encryption detected',
    );
  });

  it('serializes non-string fields to JSON before encrypting', async () => {
    const row = { metadata: { foo: 'bar' } };
    const result = await encryptFields(row, ['metadata'], TENANT, mockEncService);

    expect(mockEncService.encryptForTenant).toHaveBeenCalledWith(
      JSON.stringify({ foo: 'bar' }),
      TENANT,
    );
    expect(result.metadata).toBe(`${ENC_VALUE_PREFIX}encrypted_${JSON.stringify({ foo: 'bar' })}`);
  });

  it('does not mutate original row (returns new object)', async () => {
    const row = { name: 'Alice' };
    const result = await encryptFields(row, ['name'], TENANT, mockEncService);

    expect(result).not.toBe(row);
    expect(row.name).toBe('Alice');
    expect((row as any)._enc).toBeUndefined();
  });
});

describe('decryptFields', () => {
  it('decrypts fields with ENC prefix and strips _enc', async () => {
    const row = {
      name: `${ENC_VALUE_PREFIX}encrypted_Alice`,
      email: `${ENC_VALUE_PREFIX}encrypted_alice@example.com`,
      _enc: 'v3',
    };
    const result = await decryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result.name).toBe('Alice');
    expect(result.email).toBe('alice@example.com');
    expect(result._enc).toBeUndefined();
  });

  it('passes through rows without _enc marker (migration compat)', async () => {
    const row = { name: 'Alice', email: 'alice@example.com' };
    const result = await decryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result).toBe(row); // same reference, no processing
    expect(result.name).toBe('Alice');
  });

  it('skips null/undefined fields', async () => {
    const row = { name: null, email: undefined, _enc: 'v3' };
    const result = await decryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result.name).toBeNull();
    expect(result.email).toBeUndefined();
  });

  it('skips fields without ENC prefix (partial encryption)', async () => {
    const row = {
      name: `${ENC_VALUE_PREFIX}encrypted_Alice`,
      email: 'plain-text-email',
      _enc: 'v3',
    };
    const result = await decryptFields(row, ['name', 'email'], TENANT, mockEncService);

    expect(result.name).toBe('Alice');
    expect(result.email).toBe('plain-text-email');
  });
});
