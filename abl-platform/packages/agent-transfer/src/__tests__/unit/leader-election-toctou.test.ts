/**
 * Leader Election TOCTOU Fix Tests
 *
 * Validates that tryBecomeLeader uses atomic Lua script for renewal
 * instead of a separate EXPIRE call (which has a TOCTOU race).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { SessionRecoveryService } from '../../session/session-recovery-service.js';
import { RECOVERY_LEADER_KEY } from '../../session/types.js';
import { TransferSessionStore } from '../../session/transfer-session-store.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('leader election TOCTOU fix', () => {
  let redis: InstanceType<typeof Redis>;
  let service: SessionRecoveryService;

  const hostname = 'pod-a';

  beforeEach(() => {
    redis = new Redis();
    const store = new TransferSessionStore(redis as any);
    const mockRegistry = { getAdapter: vi.fn() } as any;
    service = new SessionRecoveryService(redis as any, hostname, store, mockRegistry, {
      leaderTtlSeconds: 60,
    });
    // Stub recoverOrphanedSessions to avoid side effects
    vi.spyOn(service, 'recoverOrphanedSessions').mockResolvedValue(0);
  });

  it('acquires leadership with SET NX EX on first call', async () => {
    const setSpy = vi.spyOn(redis, 'set');

    await service.tryBecomeLeader();

    // First call should use NX
    expect(setSpy).toHaveBeenCalledWith(RECOVERY_LEADER_KEY, hostname, 'EX', 60, 'NX');
    // No EXPIRE call should happen
    const expireSpy = vi.spyOn(redis, 'expire');
    expect(expireSpy).not.toHaveBeenCalled();
  });

  it('renews leadership with atomic Lua eval (not EXPIRE) when already leader', async () => {
    // Pre-set the key as if this pod already holds leadership
    await redis.set(RECOVERY_LEADER_KEY, hostname, 'EX', 60);

    const setSpy = vi.spyOn(redis, 'set');
    const evalSpy = vi.spyOn(redis, 'eval');
    const expireSpy = vi.spyOn(redis, 'expire');

    await service.tryBecomeLeader();

    // NX attempt should fail (key exists)
    expect(setSpy).toHaveBeenCalledWith(RECOVERY_LEADER_KEY, hostname, 'EX', 60, 'NX');
    // Lua eval should be called for atomic check-and-renew
    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      RECOVERY_LEADER_KEY,
      hostname,
      '60',
    );
    // EXPIRE must never be called (that was the TOCTOU bug)
    expect(expireSpy).not.toHaveBeenCalled();
  });

  it('yields leadership when another pod holds the key', async () => {
    // Another pod holds leadership
    await redis.set(RECOVERY_LEADER_KEY, 'pod-b', 'EX', 60);

    const setSpy = vi.spyOn(redis, 'set');

    await service.tryBecomeLeader();

    // NX attempt should fail
    expect(setSpy).toHaveBeenCalledWith(RECOVERY_LEADER_KEY, hostname, 'EX', 60, 'NX');
    // recoverOrphanedSessions should not be called
    expect(service.recoverOrphanedSessions).not.toHaveBeenCalled();
  });
});
