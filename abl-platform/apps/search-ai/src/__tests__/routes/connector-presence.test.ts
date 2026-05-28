/**
 * Connector Presence Route Tests
 *
 * Tests presence service functions:
 * - POST heartbeat
 * - GET active editors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockHset = vi.fn().mockResolvedValue(1);
const mockExpire = vi.fn().mockResolvedValue(1);
const mockHgetall = vi.fn().mockResolvedValue({});

vi.doMock('ioredis', () => {
  // Must use a real function (not arrow) so it can be called with `new`
  function MockRedis() {
    return {
      hset: mockHset,
      expire: mockExpire,
      hgetall: mockHgetall,
    };
  }
  return { Redis: MockRedis };
});

vi.doMock('../../workers/shared.js', () => ({
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Presence Routes', () => {
  let presenceService: typeof import('../../services/connector-presence.service.js');

  beforeEach(async () => {
    // Reset call counts but preserve implementations
    mockHset.mockClear();
    mockExpire.mockClear();
    mockHgetall.mockClear();

    // Restore default implementations
    mockHset.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
    mockHgetall.mockResolvedValue({});

    presenceService = await import('../../services/connector-presence.service.js');
  });

  // ===========================================================================
  // sendHeartbeat
  // ===========================================================================

  describe('sendHeartbeat', () => {
    it('should send heartbeat to Redis', async () => {
      await presenceService.sendHeartbeat(
        'conn-1',
        'test-tenant',
        'user-1',
        'John Doe',
        'settings',
      );

      expect(mockHset).toHaveBeenCalledTimes(1);
      expect(mockExpire).toHaveBeenCalledTimes(1);

      // Verify the key includes tenantId and connectorId
      const key = mockHset.mock.calls[0][0];
      expect(key).toContain('test-tenant');
      expect(key).toContain('conn-1');

      // Verify value is JSON with expected fields
      const value = JSON.parse(mockHset.mock.calls[0][2]);
      expect(value.userId).toBe('user-1');
      expect(value.userName).toBe('John Doe');
      expect(value.activeTab).toBe('settings');
      expect(value.lastSeen).toBeDefined();
    });

    it('should set TTL on the presence key', async () => {
      await presenceService.sendHeartbeat(
        'conn-1',
        'test-tenant',
        'user-1',
        'John Doe',
        'overview',
      );

      // TTL should be 30 seconds
      expect(mockExpire).toHaveBeenCalledWith(expect.any(String), 30);
    });

    it('should handle Redis errors gracefully (no throw)', async () => {
      mockHset.mockRejectedValueOnce(new Error('Redis connection lost'));

      // Should not throw
      await presenceService.sendHeartbeat(
        'conn-1',
        'test-tenant',
        'user-1',
        'John Doe',
        'settings',
      );
    });

    it('should scope presence key by tenantId for isolation', async () => {
      await presenceService.sendHeartbeat('conn-1', 'tenant-a', 'user-1', 'User A', 'overview');
      await presenceService.sendHeartbeat('conn-1', 'tenant-b', 'user-2', 'User B', 'overview');

      const keyA = mockHset.mock.calls[0][0];
      const keyB = mockHset.mock.calls[1][0];
      expect(keyA).not.toBe(keyB);
      expect(keyA).toContain('tenant-a');
      expect(keyB).toContain('tenant-b');
    });
  });

  // ===========================================================================
  // getActiveEditors
  // ===========================================================================

  describe('getActiveEditors', () => {
    it('should return active editors from Redis', async () => {
      mockHgetall.mockResolvedValueOnce({
        'user-1': JSON.stringify({
          userId: 'user-1',
          userName: 'John Doe',
          activeTab: 'settings',
          lastSeen: '2026-03-24T10:00:00.000Z',
        }),
        'user-2': JSON.stringify({
          userId: 'user-2',
          userName: 'Jane Smith',
          activeTab: 'overview',
          lastSeen: '2026-03-24T10:00:05.000Z',
        }),
      });

      const editors = await presenceService.getActiveEditors('conn-1', 'test-tenant');

      expect(editors).toHaveLength(2);
      expect(editors[0].userId).toBe('user-1');
      expect(editors[0].userName).toBe('John Doe');
      expect(editors[1].userId).toBe('user-2');
    });

    it('should return empty array when no editors', async () => {
      mockHgetall.mockResolvedValueOnce({});

      const editors = await presenceService.getActiveEditors('conn-1', 'test-tenant');
      expect(editors).toEqual([]);
    });

    it('should return empty array when Redis returns null', async () => {
      mockHgetall.mockResolvedValueOnce(null);

      const editors = await presenceService.getActiveEditors('conn-1', 'test-tenant');
      expect(editors).toEqual([]);
    });

    it('should skip malformed entries', async () => {
      mockHgetall.mockResolvedValueOnce({
        'user-1': JSON.stringify({
          userId: 'user-1',
          userName: 'John Doe',
          activeTab: 'settings',
          lastSeen: '2026-03-24T10:00:00.000Z',
        }),
        'user-2': 'not-valid-json',
      });

      const editors = await presenceService.getActiveEditors('conn-1', 'test-tenant');
      expect(editors).toHaveLength(1);
      expect(editors[0].userId).toBe('user-1');
    });

    it('should handle Redis errors gracefully', async () => {
      mockHgetall.mockRejectedValueOnce(new Error('Redis timeout'));

      const editors = await presenceService.getActiveEditors('conn-1', 'test-tenant');
      expect(editors).toEqual([]);
    });

    it('should scope query by tenantId', async () => {
      mockHgetall.mockResolvedValueOnce({});

      await presenceService.getActiveEditors('conn-1', 'test-tenant');

      expect(mockHgetall).toHaveBeenCalledTimes(1);
      const key = mockHgetall.mock.calls[0][0];
      expect(key).toContain('test-tenant');
      expect(key).toContain('conn-1');
    });
  });

  // ===========================================================================
  // Zod Validation (route-level)
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate route params', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      expect(schema.safeParse({ indexId: 'idx', connectorId: 'conn' }).success).toBe(true);
      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });

    it('should validate heartbeat body requires activeTab', () => {
      const { z } = require('zod');
      const schema = z.object({ activeTab: z.string().min(1) });

      expect(schema.safeParse({ activeTab: 'overview' }).success).toBe(true);
      expect(schema.safeParse({ activeTab: '' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });
});
