/**
 * Session Timeout Sweep Job
 *
 * Periodic job that terminalizes active conversation sessions whose idle
 * timeout or max age has been exceeded. This job is separate from retention
 * cleanup so live session lifecycle enforcement is not coupled to coarse
 * retention TTL settings.
 *
 * When Redis is available, each pass acquires a best-effort distributed lock
 * so only one pod performs the active-session sweep at a time.
 */

import { isDatabaseAvailable } from '../db/index.js';
import { getDistinctTenantIds } from '../repos/session-repo.js';
import { getTenantConfigService, DEFAULT_SECURITY } from './tenant-config.js';
import { createLogger } from '@abl/compiler/platform';
import { getRuntimeExecutor } from './runtime-executor.js';
import { cleanupClosedSessionArtifacts } from './session-lifecycle/artifact-cleanup.js';
import { SessionRuntimePolicyService } from './session-lifecycle/runtime-policy-service.js';
import {
  isSessionTerminalizationEnabled,
  SessionTerminalizationService,
} from './session-lifecycle/terminalization-service.js';

const log = createLogger('session-timeout-sweep');
const runtimePolicyService = new SessionRuntimePolicyService();
const terminalizationService = new SessionTerminalizationService();

const FALLBACK_SESSION_IDLE_SECONDS = DEFAULT_SECURITY.TEAM.sessionIdleSeconds;
const FALLBACK_SESSION_MAX_AGE_SECONDS = DEFAULT_SECURITY.TEAM.sessionMaxAgeSeconds;
const PASS2_BATCH_SIZE = 100;
const DISTRIBUTED_LOCK_KEY = 'session-timeout-sweep';
const DISTRIBUTED_LOCK_PREFIX = 'runtime-maintenance';
const MIN_LOCK_TTL_MS = 5 * 60 * 1000;

let timeoutSweepTimer: NodeJS.Timeout | null = null;

interface SessionTimeoutSweepConfig {
  enabled: boolean;
  intervalMinutes: number;
}

interface CleanupSessionCandidate {
  _id: string;
  projectId?: string | null;
  currentAgent?: string | null;
  channel?: string | null;
  startedAt?: Date | null;
  createdAt?: Date | null;
  lastActivityAt?: Date | null;
  messageCount?: number | null;
}

function resolveCleanupSessionStartTime(session: CleanupSessionCandidate): Date | undefined {
  if (session.startedAt instanceof Date) {
    return session.startedAt;
  }

  if (session.createdAt instanceof Date) {
    return session.createdAt;
  }

  return undefined;
}

function shouldTerminalizeSession(params: {
  session: CleanupSessionCandidate;
  now: Date;
  idleSeconds: number;
  maxAgeSeconds: number;
}): boolean {
  const lastActivityAt = params.session.lastActivityAt;
  const startedAt = resolveCleanupSessionStartTime(params.session);
  const nowMs = params.now.getTime();

  const exceededIdle =
    params.idleSeconds > 0 &&
    lastActivityAt instanceof Date &&
    nowMs - lastActivityAt.getTime() > params.idleSeconds * 1000;
  const exceededMaxAge =
    params.maxAgeSeconds > 0 &&
    startedAt instanceof Date &&
    nowMs - startedAt.getTime() > params.maxAgeSeconds * 1000;

  return exceededIdle || exceededMaxAge;
}

function buildLegacyTerminalizationUpdate(
  sessionId: string,
  tenantId: string,
  disposition: 'timeout' | 'unengaged',
  now: Date,
): {
  updateOne: {
    filter: Record<string, unknown>;
    update: { $set: Record<string, unknown> };
  };
} {
  return {
    updateOne: {
      filter: { _id: sessionId, tenantId, status: 'active' },
      update: {
        $set: {
          status: 'ended',
          disposition,
          endedAt: now,
        },
      },
    },
  };
}

async function getTenantTimeoutDefaults(tenantId: string): Promise<{
  sessionIdleSeconds: number;
  sessionMaxAgeSeconds: number;
}> {
  try {
    const config = await getTenantConfigService().getConfigAsync(tenantId);
    return {
      sessionIdleSeconds: config.security.sessionIdleSeconds,
      sessionMaxAgeSeconds: config.security.sessionMaxAgeSeconds,
    };
  } catch (err) {
    log.warn('Failed to resolve tenant timeout defaults, using TEAM defaults', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      sessionIdleSeconds: FALLBACK_SESSION_IDLE_SECONDS,
      sessionMaxAgeSeconds: FALLBACK_SESSION_MAX_AGE_SECONDS,
    };
  }
}

async function resolveCleanupRuntimeTimeouts(
  session: CleanupSessionCandidate,
  tenantId: string,
  fallbackIdleSeconds: number,
  fallbackMaxAgeSeconds: number,
  cache: Map<string, Promise<{ idleSeconds: number; maxAgeSeconds: number }>>,
): Promise<{ idleSeconds: number; maxAgeSeconds: number }> {
  const projectId = typeof session.projectId === 'string' ? session.projectId : '';
  const agentName = typeof session.currentAgent === 'string' ? session.currentAgent : '';
  const cacheKey = `${projectId}:${agentName}`;

  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = runtimePolicyService
      .resolveRuntimeSessionTimeouts({
        tenantId,
        ...(projectId ? { projectId } : {}),
        ...(agentName ? { agentName } : {}),
      })
      .then((resolved) => ({
        idleSeconds: resolved.sessionIdleSeconds ?? fallbackIdleSeconds,
        maxAgeSeconds: resolved.sessionMaxAgeSeconds ?? fallbackMaxAgeSeconds,
      }))
      .catch((error) => {
        log.warn('Timeout sweep runtime timeout resolution failed, using tenant defaults', {
          tenantId,
          projectId,
          agentName,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          idleSeconds: fallbackIdleSeconds,
          maxAgeSeconds: fallbackMaxAgeSeconds,
        };
      });
    cache.set(cacheKey, pending);
  }

  return pending;
}

/**
 * Start the periodic timeout sweep job.
 */
export function startSessionTimeoutSweepJob(config: SessionTimeoutSweepConfig): void {
  if (timeoutSweepTimer) return;

  if (!config.enabled) {
    log.info('Session timeout sweep disabled');
    return;
  }

  if (!isDatabaseAvailable()) {
    log.info('Session timeout sweep skipped — database not available');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  log.info('Starting session timeout sweep job', {
    intervalMinutes: config.intervalMinutes,
  });

  runTimeoutSweepWithLock(config).catch((err) =>
    log.error('Initial session timeout sweep failed', {
      phase: 'lock_acquire',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  timeoutSweepTimer = setInterval(() => {
    runTimeoutSweepWithLock(config).catch((err) =>
      log.error('Periodic session timeout sweep failed', {
        phase: 'lock_acquire',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }, intervalMs);

  if (timeoutSweepTimer.unref) timeoutSweepTimer.unref();
}

/**
 * Stop the timeout sweep job (for graceful shutdown).
 */
export function stopSessionTimeoutSweepJob(): void {
  if (timeoutSweepTimer) {
    clearInterval(timeoutSweepTimer);
    timeoutSweepTimer = null;
    log.info('Session timeout sweep job stopped');
  }
}

async function runTimeoutSweepWithLock(config: SessionTimeoutSweepConfig): Promise<void> {
  if (!isDatabaseAvailable()) {
    return;
  }

  const lockTtlMs = Math.max(MIN_LOCK_TTL_MS, config.intervalMinutes * 60 * 1000);

  try {
    const { getRedisClient } = await import('./redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) {
      await runTimeoutSweep();
      return;
    }

    const { DistributedLockManager } = await import('@agent-platform/shared');
    const lockManager = new DistributedLockManager(redis);
    const lock = await lockManager.acquire(DISTRIBUTED_LOCK_KEY, {
      keyPrefix: DISTRIBUTED_LOCK_PREFIX,
      ttlMs: lockTtlMs,
    });

    if (!lock) {
      log.debug('Skipping session timeout sweep pass — lock held by another pod', {
        intervalMinutes: config.intervalMinutes,
      });
      return;
    }

    try {
      await runTimeoutSweep();
    } finally {
      await lockManager.release(lock).catch((error: unknown) =>
        log.warn('Failed to release session timeout sweep lock', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } catch (error) {
    log.warn('Session timeout sweep lock unavailable, running without coordination', {
      phase: 'lock_fallback',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await runTimeoutSweep();
  }
}

async function markTimedOutSessionsLegacy(
  tenantId: string,
  sessionIdleSeconds: number,
  sessionMaxAgeSeconds: number,
): Promise<number> {
  const { Session } = await import('@agent-platform/database/models');
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - sessionIdleSeconds * 1000);
  const ageCutoff = new Date(now.getTime() - sessionMaxAgeSeconds * 1000);

  let marked = 0;
  const cursor = Session.find({
    tenantId,
    status: 'active',
    $or: [{ lastActivityAt: { $lt: idleCutoff } }, { createdAt: { $lt: ageCutoff } }],
  })
    .select('_id messageCount')
    .lean()
    .cursor({ batchSize: PASS2_BATCH_SIZE });

  let bulkOps: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: { $set: Record<string, unknown> };
    };
  }> = [];

  for await (const doc of cursor) {
    const session = doc as { _id: string; messageCount?: number };
    const disposition = (session.messageCount ?? 0) === 0 ? 'unengaged' : 'timeout';
    bulkOps.push(buildLegacyTerminalizationUpdate(session._id, tenantId, disposition, now));
    marked++;

    if (bulkOps.length >= PASS2_BATCH_SIZE) {
      await Session.bulkWrite(bulkOps, { ordered: false });
      bulkOps = [];
    }
  }

  if (bulkOps.length > 0) {
    await Session.bulkWrite(bulkOps, { ordered: false });
  }

  if (marked > 0) {
    log.info('Marked timed-out sessions (legacy path)', { tenantId, marked });
  }

  return marked;
}

async function markTimedOutSessions(
  tenantId: string,
  sessionIdleSeconds: number,
  sessionMaxAgeSeconds: number,
): Promise<number> {
  if (!isSessionTerminalizationEnabled()) {
    return markTimedOutSessionsLegacy(tenantId, sessionIdleSeconds, sessionMaxAgeSeconds);
  }

  const { Session } = await import('@agent-platform/database/models');
  const now = new Date();
  const policyCache = new Map<string, Promise<{ idleSeconds: number; maxAgeSeconds: number }>>();
  const cleanupSessionIds = new Set<string>();
  const legacyTerminalizedSessionIds: string[] = [];
  const legacyTerminalizationOps: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: { $set: Record<string, unknown> };
    };
  }> = [];
  let marked = 0;

  const cursor = Session.find({
    tenantId,
    status: 'active',
  })
    .select('_id projectId currentAgent channel messageCount startedAt createdAt lastActivityAt')
    .lean()
    .cursor({ batchSize: PASS2_BATCH_SIZE });

  for await (const doc of cursor) {
    const session = doc as CleanupSessionCandidate;
    const runtimeSession = getRuntimeExecutor().getSession(session._id);
    const runtimeProjectId =
      typeof runtimeSession?.projectId === 'string' ? runtimeSession.projectId : null;
    const runtimeAgentName =
      typeof runtimeSession?.agentName === 'string' ? runtimeSession.agentName : null;
    const runtimeChannel =
      typeof runtimeSession?.channelType === 'string' ? runtimeSession.channelType : null;
    const runtimeLastActivityAt =
      runtimeSession?.lastActivityAt instanceof Date ? runtimeSession.lastActivityAt : null;
    const runtimeCreatedAt =
      runtimeSession?.createdAt instanceof Date ? runtimeSession.createdAt : null;

    const runtimeAwareSession: CleanupSessionCandidate = {
      ...session,
      ...(runtimeProjectId ? { projectId: runtimeProjectId } : {}),
      ...(runtimeAgentName ? { currentAgent: runtimeAgentName } : {}),
      ...(runtimeChannel ? { channel: runtimeChannel } : {}),
      ...(runtimeLastActivityAt ? { lastActivityAt: runtimeLastActivityAt } : {}),
      ...(runtimeCreatedAt ? { createdAt: runtimeCreatedAt } : {}),
    };

    const disposition = (session.messageCount ?? 0) === 0 ? 'unengaged' : 'timeout';

    const projectId =
      typeof runtimeAwareSession.projectId === 'string' ? runtimeAwareSession.projectId : null;
    if (!projectId) {
      if (
        !shouldTerminalizeSession({
          session: runtimeAwareSession,
          now,
          idleSeconds: sessionIdleSeconds,
          maxAgeSeconds: sessionMaxAgeSeconds,
        })
      ) {
        continue;
      }

      log.warn(
        'Timeout sweep falling back to legacy terminalization for session without projectId',
        {
          tenantId,
          sessionId: session._id,
        },
      );

      legacyTerminalizationOps.push(
        buildLegacyTerminalizationUpdate(session._id, tenantId, disposition, now),
      );
      legacyTerminalizedSessionIds.push(session._id);
      marked++;
      continue;
    }

    const timeouts = await resolveCleanupRuntimeTimeouts(
      runtimeAwareSession,
      tenantId,
      sessionIdleSeconds,
      sessionMaxAgeSeconds,
      policyCache,
    );

    if (
      !shouldTerminalizeSession({
        session: runtimeAwareSession,
        now,
        idleSeconds: timeouts.idleSeconds,
        maxAgeSeconds: timeouts.maxAgeSeconds,
      })
    ) {
      continue;
    }

    const result = await terminalizationService.terminateConversationSession({
      tenantId,
      projectId,
      sessionId: session._id,
      ...(runtimeAwareSession.currentAgent ? { agentName: runtimeAwareSession.currentAgent } : {}),
      ...(runtimeAwareSession.channel ? { channel: runtimeAwareSession.channel } : {}),
      disposition,
      source: 'cleanup',
    });

    if (!result) {
      continue;
    }

    marked++;
    for (const artifactSessionId of result.artifactSessionIds) {
      cleanupSessionIds.add(artifactSessionId);
    }
  }

  if (legacyTerminalizationOps.length > 0) {
    await Session.bulkWrite(legacyTerminalizationOps, { ordered: false });
    const executor = getRuntimeExecutor();
    for (const sessionId of legacyTerminalizedSessionIds) {
      cleanupSessionIds.add(sessionId);
      executor.endSession(sessionId);
    }
  }

  await cleanupClosedSessionArtifacts(cleanupSessionIds);

  if (marked > 0) {
    log.info('Marked timed-out sessions', { tenantId, marked });
  }

  return marked;
}

async function runTimeoutSweep(): Promise<void> {
  if (!isDatabaseAvailable()) {
    return;
  }

  try {
    const tenantIds = await getDistinctTenantIds();
    for (const tenantId of tenantIds) {
      try {
        const retention = await getTenantTimeoutDefaults(tenantId);
        await markTimedOutSessions(
          tenantId,
          retention.sessionIdleSeconds,
          retention.sessionMaxAgeSeconds,
        );
      } catch (err) {
        log.error('Session timeout sweep failed for tenant, continuing', {
          phase: 'tenant_iteration',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          tenantCount: tenantIds?.length ?? null,
        });
      }
    }
  } catch (err) {
    log.warn('Session timeout sweep failed', {
      phase: 'tenant_iteration',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

/**
 * Run a single timeout sweep pass immediately.
 *
 * Unlike the periodic scheduler, this helper does not install a timer.
 * It is useful for deterministic callers such as tests or one-shot
 * maintenance entry points that want to await sweep completion directly.
 */
export async function runSessionTimeoutSweepPass(): Promise<void> {
  await runTimeoutSweep();
}
