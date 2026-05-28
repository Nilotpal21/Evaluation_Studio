import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveMasterKey } from '../index.js';

const originalEnv = process.env.ENCRYPTION_MASTER_KEY;

beforeEach(() => {
  delete process.env.ENCRYPTION_MASTER_KEY;
});
afterEach(() => {
  if (originalEnv) process.env.ENCRYPTION_MASTER_KEY = originalEnv;
  else delete process.env.ENCRYPTION_MASTER_KEY;
});

describe('resolveMasterKey', () => {
  it('returns key from vault when available', async () => {
    const vault = {
      isAvailable: () => true,
      get: vi.fn().mockResolvedValue('a'.repeat(64)),
    };
    const key = await resolveMasterKey(vault);
    expect(key).toBe('a'.repeat(64));
  });

  it('falls back to env var when vault has no key', async () => {
    process.env.ENCRYPTION_MASTER_KEY = 'b'.repeat(64);
    const vault = {
      isAvailable: () => true,
      get: vi.fn().mockResolvedValue(undefined),
    };
    const key = await resolveMasterKey(vault);
    expect(key).toBe('b'.repeat(64));
  });

  it('uses env var when no vault provider', async () => {
    process.env.ENCRYPTION_MASTER_KEY = 'c'.repeat(64);
    const key = await resolveMasterKey();
    expect(key).toBe('c'.repeat(64));
  });

  it('throws when neither vault nor env var has the key', async () => {
    await expect(resolveMasterKey()).rejects.toThrow('ENCRYPTION_MASTER_KEY not found');
  });

  it('returns env key even in production (with warn path)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_MASTER_KEY = 'd'.repeat(64);
    try {
      const key = await resolveMasterKey();
      expect(key).toBe('d'.repeat(64));
    } finally {
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('falls back to env var when vault provider is not available', async () => {
    process.env.ENCRYPTION_MASTER_KEY = 'e'.repeat(64);
    const vault = {
      isAvailable: () => false,
      get: vi.fn(),
    };
    const key = await resolveMasterKey(vault);
    expect(key).toBe('e'.repeat(64));
    expect(vault.get).not.toHaveBeenCalled();
  });
});
