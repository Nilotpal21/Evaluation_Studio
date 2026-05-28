/**
 * Error Resilience Tests
 *
 * Validates that Redis failures, timeouts, and edge cases
 * are handled gracefully without crashing callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransferSessionStore } from '../../session/transfer-session-store.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('error resilience', () => {
  describe('TransferSessionStore with failing Redis', () => {
    let store: TransferSessionStore;
    let mockRedis: any;

    beforeEach(() => {
      mockRedis = {
        eval: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        hgetall: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        exists: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        hmset: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        get: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        pipeline: vi.fn().mockReturnValue({
          expire: vi.fn().mockReturnThis(),
          hmset: vi.fn().mockReturnThis(),
          exec: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
        }),
        smembers: vi.fn().mockRejectedValue(new Error('REDIS CONNECTION REFUSED')),
      };
      store = new TransferSessionStore(mockRedis);
    });

    it('create returns error result on Redis failure', async () => {
      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REDIS_ERROR');
    });

    it('get returns null on Redis failure', async () => {
      const result = await store.get('agent_transfer:t:c:chat');
      expect(result).toBeNull();
    });

    it('update returns false on Redis failure', async () => {
      const result = await store.update('agent_transfer:t:c:chat', { state: 'active' });
      expect(result).toBe(false);
    });

    it('end returns false on Redis failure', async () => {
      // end calls get first, which returns null on failure
      const result = await store.end('agent_transfer:t:c:chat');
      expect(result).toBe(false);
    });

    it('getByProvider returns null on Redis failure', async () => {
      const result = await store.getByProvider('kore', 'tenant-1', 'conv-1');
      expect(result).toBeNull();
    });

    it('claimOrphanedSession returns failure on Redis error', async () => {
      const result = await store.claimOrphanedSession('key', 'old-pod', 'new-pod');
      expect(result.success).toBe(false);
    });
  });

  describe('TransferSessionStore with timeout', () => {
    it('times out after configured duration', async () => {
      const mockRedis = {
        eval: vi
          .fn()
          .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 60000))),
      };
      const store = new TransferSessionStore(mockRedis as any);

      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REDIS_ERROR');
      expect(result.error?.message).toContain('timed out');
    }, 10_000);
  });

  describe('TransferSessionStore with failing encryption', () => {
    it('create returns a structured encryption error and skips Redis', async () => {
      const mockRedis = {
        eval: vi.fn(),
      };
      const encryptor = {
        encryptField: vi.fn().mockRejectedValue(new Error('kms unavailable')),
        decryptField: vi.fn(),
        isEncrypted: vi.fn().mockReturnValue(false),
      };
      const store = new TransferSessionStore(mockRedis as any, encryptor);

      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'ENCRYPTION_ERROR',
          message: 'kms unavailable',
        },
      });
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe('TransferSessionStore with empty data', () => {
    it('parseSessionHash handles missing fields gracefully', async () => {
      const mockRedis = {
        hgetall: vi.fn().mockResolvedValue({
          // Missing most fields
          tenantId: 'tenant-1',
        }),
      };
      const store = new TransferSessionStore(mockRedis as any);
      const session = await store.get('some-key');

      expect(session).not.toBeNull();
      expect(session!.tenantId).toBe('tenant-1');
      expect(session!.contactId).toBe('');
      expect(session!.channel).toBe('');
      expect(session!.state).toBe('pending');
      expect(session!.metadata).toEqual({});
      expect(session!.lastHeartbeat).toBe(0);
    });

    it('parseSessionHash handles corrupted JSON in metadata', async () => {
      const mockRedis = {
        hgetall: vi.fn().mockResolvedValue({
          tenantId: 'tenant-1',
          metadata: 'not-valid-json{{{',
          providerData: '{"valid": true}',
        }),
      };
      const store = new TransferSessionStore(mockRedis as any);
      const session = await store.get('some-key');

      expect(session!.metadata).toEqual({});
      expect(session!.providerData).toEqual({ valid: true });
    });
  });
});
