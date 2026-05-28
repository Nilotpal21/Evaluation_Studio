import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceCredentialCache } from '../../services/voice/voice-credential-cache.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('VoiceCredentialCache', () => {
  let cache: VoiceCredentialCache;
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new VoiceCredentialCache(mockRedis as never);
  });

  describe('set', () => {
    it('caches decrypted credentials with call-scoped key', async () => {
      await cache.set({
        tenantId: 't1',
        callId: 'call-123',
        credentials: { apiKey: 'secret' },
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth-profile:voice:t1:call-123',
        JSON.stringify({ apiKey: 'secret' }),
        'PX',
        14400000, // 4 hours max TTL
      );
    });

    it('respects custom TTL capped at max', async () => {
      await cache.set({
        tenantId: 't1',
        callId: 'call-456',
        credentials: { token: 'abc' },
        ttlMs: 60000,
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth-profile:voice:t1:call-456',
        expect.any(String),
        'PX',
        60000,
      );
    });

    it('caps TTL at 4 hours maximum', async () => {
      await cache.set({
        tenantId: 't1',
        callId: 'call-789',
        credentials: { token: 'abc' },
        ttlMs: 999999999, // way over max
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'PX',
        14400000,
      );
    });
  });

  describe('get', () => {
    it('retrieves cached credentials', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ apiKey: 'secret' }));

      const result = await cache.get({ tenantId: 't1', callId: 'call-123' });
      expect(result).toEqual({ apiKey: 'secret' });
      expect(mockRedis.get).toHaveBeenCalledWith('auth-profile:voice:t1:call-123');
    });

    it('returns null on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await cache.get({ tenantId: 't1', callId: 'call-123' });
      expect(result).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('invalidates on call end', async () => {
      await cache.invalidate({ tenantId: 't1', callId: 'call-123' });
      expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:voice:t1:call-123');
    });
  });

  describe('invalidateByTenant', () => {
    it('invalidates all calls for a tenant on rotation', async () => {
      mockRedis.scan.mockResolvedValueOnce([
        '0',
        ['auth-profile:voice:t1:call-1', 'auth-profile:voice:t1:call-2'],
      ]);
      mockRedis.del.mockResolvedValue(1);

      const deleted = await cache.invalidateByTenant('t1');
      expect(deleted).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:voice:t1:call-1');
      expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:voice:t1:call-2');
    });

    it('handles empty scan result', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const deleted = await cache.invalidateByTenant('t1');
      expect(deleted).toBe(0);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles multiple scan iterations', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['auth-profile:voice:t1:call-1']])
        .mockResolvedValueOnce(['0', ['auth-profile:voice:t1:call-2']]);
      mockRedis.del.mockResolvedValue(1);

      const deleted = await cache.invalidateByTenant('t1');
      expect(deleted).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });
  });
});
