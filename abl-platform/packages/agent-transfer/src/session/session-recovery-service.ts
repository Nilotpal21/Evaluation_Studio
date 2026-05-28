/**
 * Session Recovery Service
 *
 * Detects and recovers orphaned transfer sessions after pod crashes.
 * Uses leader election to ensure only one pod runs recovery scans,
 * preventing parallel SCAN races during rolling deploys.
 *
 * Design:
 * - Each pod writes a heartbeat key (at_pod_heartbeat:{hostname}) with 15s TTL
 * - Leader election via SET NX on at_recovery_leader (60s TTL)
 * - Only the leader scans the at_active_sessions SET for orphaned sessions
 * - Orphaned = ownerPod's heartbeat key is missing
 * - Claims orphaned sessions atomically via Lua CAS
 * - Delegates to adapter.recoverSessions() for provider-specific reconnection
 */
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { TransferSessionStore } from './transfer-session-store.js';
import {
  ACTIVE_SESSIONS_SET,
  RECOVERY_LEADER_KEY,
  podHeartbeatKey,
  podSessionsKey,
} from './types.js';
import type { AdapterRegistry } from '../adapters/registry.js';

const log = createLogger('session-recovery');

const SCRIPT_RENEW_LEADER: LuaScript = {
  name: 'agent_transfer.renew_leader',
  numberOfKeys: 1,
  body: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`,
};

/** Recovery service configuration */
export interface SessionRecoveryConfig {
  heartbeatTtlSeconds?: number;
  heartbeatIntervalMs?: number;
  leaderTtlSeconds?: number;
  leaderElectionIntervalMs?: number;
  staleThresholdMs?: number;
}

export interface RecoveryStats {
  scansCompleted: number;
  sessionsRecovered: number;
  claimsFailed: number;
  lastScanAt: number | null;
}

const DEFAULT_CONFIG = {
  heartbeatTtlSeconds: 15,
  heartbeatIntervalMs: 10_000,
  leaderTtlSeconds: 60,
  leaderElectionIntervalMs: 30_000,
  staleThresholdMs: 30_000,
};

export class SessionRecoveryService {
  private readonly redis: RedisClient;
  private readonly hostname: string;
  private readonly sessionStore: TransferSessionStore;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly config: Required<SessionRecoveryConfig>;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderElectionTimer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;

  private stats: RecoveryStats = {
    scansCompleted: 0,
    sessionsRecovered: 0,
    claimsFailed: 0,
    lastScanAt: null,
  };

  constructor(
    redis: RedisClient,
    hostname: string,
    sessionStore: TransferSessionStore,
    adapterRegistry: AdapterRegistry,
    config?: SessionRecoveryConfig,
  ) {
    this.redis = redis;
    this.hostname = hostname;
    this.sessionStore = sessionStore;
    this.adapterRegistry = adapterRegistry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    log.info('Starting session recovery service', { hostname: this.hostname });

    await this.refreshHeartbeat();

    this.heartbeatTimer = setInterval(
      () => this.refreshHeartbeat(),
      this.config.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref();

    await this.tryBecomeLeader();

    this.leaderElectionTimer = setInterval(
      () => this.tryBecomeLeader(),
      this.config.leaderElectionIntervalMs,
    );
    this.leaderElectionTimer.unref();
  }

  async stop(): Promise<void> {
    log.info('Stopping session recovery service', { hostname: this.hostname });

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.leaderElectionTimer) {
      clearInterval(this.leaderElectionTimer);
      this.leaderElectionTimer = null;
    }

    // Clean up leader key if we are the leader
    if (this.isLeader) {
      try {
        const currentLeader = await this.redis.get(RECOVERY_LEADER_KEY);
        if (currentLeader === this.hostname) {
          await this.redis.del(RECOVERY_LEADER_KEY);
          log.info('Released recovery leader key', { hostname: this.hostname });
        }
      } catch (err) {
        log.error('Failed to release leader key on stop', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clean up pod sessions set key (prevents dead pod SET keys from accumulating)
    try {
      await this.redis.del(podSessionsKey(this.hostname));
    } catch (err) {
      log.error('Failed to delete pod sessions key on stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Clean up heartbeat key
    try {
      await this.redis.del(podHeartbeatKey(this.hostname));
    } catch (err) {
      log.error('Failed to delete heartbeat key on stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.isLeader = false;
  }

  getStats(): RecoveryStats {
    return { ...this.stats };
  }

  getIsLeader(): boolean {
    return this.isLeader;
  }

  private async refreshHeartbeat(): Promise<void> {
    try {
      const key = podHeartbeatKey(this.hostname);
      await this.redis.set(key, String(Date.now()), 'EX', this.config.heartbeatTtlSeconds);
    } catch (err) {
      log.error('Failed to refresh heartbeat', {
        hostname: this.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async tryBecomeLeader(): Promise<void> {
    try {
      // Try to acquire leadership (NX = only if not exists)
      const acquired = await this.redis.set(
        RECOVERY_LEADER_KEY,
        this.hostname,
        'EX',
        this.config.leaderTtlSeconds,
        'NX',
      );

      if (acquired === 'OK') {
        this.isLeader = true;
        log.info('Acquired recovery leadership', { hostname: this.hostname });
        await this.recoverOrphanedSessions();
        return;
      }

      // NX failed — renew atomically if we are the current leader
      const renewed = await runLuaScript<number>(
        this.redis,
        SCRIPT_RENEW_LEADER,
        [RECOVERY_LEADER_KEY],
        [this.hostname, String(this.config.leaderTtlSeconds)],
      );
      if (renewed === 1) {
        this.isLeader = true;
        await this.recoverOrphanedSessions();
      } else {
        this.isLeader = false;
      }
    } catch (err) {
      log.error('Leader election failed', {
        hostname: this.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async recoverOrphanedSessions(): Promise<number> {
    const SSCAN_BATCH_SIZE = 100;
    let recovered = 0;
    let totalScanned = 0;

    try {
      let cursor = '0';
      do {
        const [nextCursor, batchKeys] = await this.redis.sscan(
          ACTIVE_SESSIONS_SET,
          cursor,
          'COUNT',
          SSCAN_BATCH_SIZE,
        );
        cursor = nextCursor;

        if (batchKeys.length === 0) continue;
        totalScanned += batchKeys.length;

        // Cluster-safe: batchKeys span tenants (different hash slots), so a
        // single pipeline would CROSSSLOT. Issue independent HGETALLs and let
        // ioredis Cluster route each to its owning master in parallel. Shape
        // the result to match the previous `pipeline.exec()` return so the
        // index-based reader below is unchanged.
        const sessionResults = await Promise.all(
          batchKeys.map((k) =>
            this.redis.hgetall(k).then(
              (hash) => [null, hash] as [Error | null, Record<string, string>],
              (err: Error) => [err, {}] as [Error | null, Record<string, string>],
            ),
          ),
        );

        // Identify keys needing cleanup (no session data) and keys needing heartbeat checks
        const staleKeys: string[] = [];
        const heartbeatChecks: {
          key: string;
          session: {
            ownerPod: string;
            lastHeartbeat: number;
            tenantId: string;
            provider: string;
            providerSessionId: string;
          };
        }[] = [];

        for (let i = 0; i < batchKeys.length; i++) {
          const key = batchKeys[i];
          const result = sessionResults?.[i];
          const hash = result?.[1] as Record<string, string> | null;

          if (!hash || Object.keys(hash).length === 0 || !hash.ownerPod) {
            staleKeys.push(key);
            continue;
          }

          if (hash.ownerPod === this.hostname) continue;

          heartbeatChecks.push({
            key,
            session: {
              ownerPod: hash.ownerPod,
              lastHeartbeat: parseInt(hash.lastHeartbeat || '0', 10),
              tenantId: hash.tenantId ?? '',
              provider: hash.provider ?? '',
              providerSessionId: hash.providerSessionId ?? '',
            },
          });
        }

        // Pipeline SREM for stale keys
        if (staleKeys.length > 0) {
          const sremPipeline = this.redis.pipeline();
          for (const key of staleKeys) {
            sremPipeline.srem(ACTIVE_SESSIONS_SET, key);
          }
          await sremPipeline.exec();
        }

        // Pipeline EXISTS for heartbeat checks
        if (heartbeatChecks.length > 0) {
          // Cluster-safe: pod heartbeat keys span hostnames (different slots),
          // so a pipeline would CROSSSLOT. Issue independent EXISTS calls and
          // shape results to match the previous pipeline.exec() return type.
          const heartbeatResults = await Promise.all(
            heartbeatChecks.map((check) =>
              this.redis.exists(podHeartbeatKey(check.session.ownerPod)).then(
                (n) => [null, n] as [Error | null, number],
                (err: Error) => [err, 0] as [Error | null, number],
              ),
            ),
          );

          for (let i = 0; i < heartbeatChecks.length; i++) {
            const { key, session } = heartbeatChecks[i];
            const podAlive = heartbeatResults?.[i]?.[1] as number;

            if (!podAlive) {
              const staleDuration = Date.now() - session.lastHeartbeat;
              if (staleDuration < this.config.staleThresholdMs) continue;

              try {
                const claimResult = await this.sessionStore.claimOrphanedSession(
                  key,
                  session.ownerPod,
                  this.hostname,
                );
                if (claimResult.success) {
                  recovered++;
                  this.stats.sessionsRecovered++;
                  log.info('Recovered orphaned session', {
                    key,
                    previousPod: session.ownerPod,
                    tenantId: session.tenantId,
                  });

                  if (claimResult.session) {
                    const adapter = this.adapterRegistry.get(claimResult.session.provider);
                    if (adapter?.recoverSessions) {
                      try {
                        await adapter.recoverSessions(this.hostname);
                      } catch (recoverErr) {
                        log.error('Adapter recovery failed for claimed session', {
                          key,
                          provider: claimResult.session.provider,
                          error:
                            recoverErr instanceof Error ? recoverErr.message : String(recoverErr),
                        });
                      }
                    }
                  }
                } else {
                  this.stats.claimsFailed++;
                  log.warn('Failed to claim orphaned session (lost race)', {
                    key,
                    previousPod: session.ownerPod,
                  });
                }
              } catch (err) {
                log.error('Error processing session during recovery scan', {
                  key,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      log.error('Failed during recovery scan', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.stats.scansCompleted++;
    this.stats.lastScanAt = Date.now();
    log.info('Recovery scan completed', {
      activeSessionsCount: totalScanned,
      recovered,
      scansCompleted: this.stats.scansCompleted,
    });

    return recovered;
  }
}
