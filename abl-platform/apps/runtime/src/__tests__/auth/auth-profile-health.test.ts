import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { checkAuthProfileHealth } from '../../health/auth-profile-health.js';

describe('AuthProfile health probe', () => {
  test('returns healthy when all probes pass', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => true,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(true);
    expect(result.mongo).toBe(true);
    expect(result.decryption).toBe(true);
    expect(result.redisLock).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('returns unhealthy when mongo fails', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => {
        throw new Error('connection refused');
      },
      decryptionProbe: async () => true,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(false);
    expect(result.mongo).toBe(false);
  });

  test('returns unhealthy when decryption fails', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => false,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(false);
    expect(result.decryption).toBe(false);
  });

  test('returns unhealthy when redis lock unreachable', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => true,
      redisProbe: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.healthy).toBe(false);
    expect(result.redisLock).toBe(false);
  });
});
