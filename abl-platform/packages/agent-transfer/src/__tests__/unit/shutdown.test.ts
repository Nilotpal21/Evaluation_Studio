/**
 * Shutdown Tests
 *
 * Validates graceful shutdown behavior for adapters and recovery service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KoreEventHandler } from '../../adapters/kore/event-handler.js';
import { SessionRecoveryService } from '../../session/session-recovery-service.js';
import { RECOVERY_LEADER_KEY, podHeartbeatKey } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('shutdown', () => {
  describe('KoreEventHandler', () => {
    it('clear() removes all handlers', () => {
      const handler = new KoreEventHandler();
      handler.onAgentMessage(vi.fn());
      handler.onAgentMessage(vi.fn());

      expect(handler.handlerCount()).toBe(2);
      handler.clear();
      expect(handler.handlerCount()).toBe(0);
    });
  });

  describe('SessionRecoveryService', () => {
    let mockRedis: any;
    let mockStore: any;
    let mockRegistry: any;

    beforeEach(() => {
      mockRedis = {
        set: vi.fn().mockResolvedValue('OK'),
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        exists: vi.fn().mockResolvedValue(0),
        smembers: vi.fn().mockResolvedValue([]),
      };
      mockStore = {
        get: vi.fn().mockResolvedValue(null),
        claimOrphanedSession: vi.fn(),
      };
      mockRegistry = { get: vi.fn() };
    });

    it('stop() clears all timers', async () => {
      const service = new SessionRecoveryService(mockRedis, 'pod-1', mockStore, mockRegistry, {
        heartbeatIntervalMs: 100_000,
        leaderElectionIntervalMs: 100_000,
      });

      await service.start();
      expect(service.getIsLeader()).toBe(true); // became leader via SET NX

      await service.stop();
      expect(service.getIsLeader()).toBe(false);
    });

    it('stop() deletes leader key if leader', async () => {
      mockRedis.get.mockResolvedValue('pod-1'); // We are the leader

      const service = new SessionRecoveryService(mockRedis, 'pod-1', mockStore, mockRegistry, {
        heartbeatIntervalMs: 100_000,
        leaderElectionIntervalMs: 100_000,
      });

      await service.start();
      await service.stop();

      // Should have deleted the leader key
      expect(mockRedis.del).toHaveBeenCalledWith(RECOVERY_LEADER_KEY);
      // Should have deleted heartbeat key
      expect(mockRedis.del).toHaveBeenCalledWith(podHeartbeatKey('pod-1'));
    });

    it('stop() deletes heartbeat key even if not leader', async () => {
      // Another pod is leader
      mockRedis.set.mockResolvedValue(null); // SET NX fails
      mockRedis.get.mockResolvedValue('other-pod');

      const service = new SessionRecoveryService(mockRedis, 'pod-1', mockStore, mockRegistry, {
        heartbeatIntervalMs: 100_000,
        leaderElectionIntervalMs: 100_000,
      });

      // Manually start without becoming leader
      await service.stop();

      // Should still delete heartbeat
      expect(mockRedis.del).toHaveBeenCalledWith(podHeartbeatKey('pod-1'));
    });

    it('stop() handles Redis errors gracefully', async () => {
      mockRedis.get.mockResolvedValue('pod-1');
      mockRedis.del.mockRejectedValue(new Error('Redis down'));

      const service = new SessionRecoveryService(mockRedis, 'pod-1', mockStore, mockRegistry, {
        heartbeatIntervalMs: 100_000,
        leaderElectionIntervalMs: 100_000,
      });

      await service.start();
      // Should not throw
      await service.stop();
    });
  });
});
