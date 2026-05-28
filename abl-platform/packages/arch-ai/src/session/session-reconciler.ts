/**
 * Session reconciler — claims orphaned v2 sessions whose turn-worker died
 * without releasing the Redis lock.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.4.1
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 2
 *
 * Runs as a `setInterval` on every pod (no leader election — idempotent).
 * Per decision D-18: NOT via SchedulerStrategy framework — the reconciler
 * already depends on Redis to check locks, so cron-level scheduling gives
 * us nothing over a plain interval. Startup delay is jittered so N pods
 * don't all scan on the same wall-clock second.
 *
 * Algorithm (every RECONCILER_INTERVAL_MS):
 *   1. Query arch_sessions where schemaVersion=2, state='active',
 *      activeTurnLock.renewedAt < now - ORPHAN_AGE_MS
 *   2. For each candidate, check Redis lock state
 *   3. If Redis lock missing OR TTL < 15s: orphan confirmed
 *   4. Emit `turn_ended.reason: 'worker_lost'` via fan-out (listening tabs re-fetch)
 *   5. Clear activeTurnId + activeTurnLock, transition state to 'idle'
 *
 * Every query includes explicit { tenantId, userId, _id } or equivalent
 * projections — the reconciler does NOT run inside an ALS context and must
 * not rely on tenant-isolation plugins.
 */

import type { Model } from 'mongoose';
import { uuidv7 } from '@agent-platform/database/mongo';

import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@agent-platform/shared-observability';

import { ARCH_AI_LOCK } from '../engine/hard-limits.js';
import type { TurnEndedEvent } from '../types/turn-events.js';
import { publishTurnEvent } from './fan-out-publisher.js';

const log = createLogger('arch-ai:reconciler');

// ─── Types ───────────────────────────────────────────────────────────────

export interface ReconcilerSessionDoc {
  _id: string;
  tenantId: string;
  userId: string;
  schemaVersion?: number;
  activeTurnId?: string;
  activeTurnLock?: {
    workerId: string;
    fencingToken: number;
    acquiredAt: number;
    renewedAt: number;
  };
}

export interface ReconcilerOptions {
  /** Mongoose model; queries must project tenant+user explicitly. */
  ArchSessions: Model<unknown>;
  redis: RedisClient;
  intervalMs?: number;
  jitterMs?: number;
  orphanAgeMs?: number;
  /** Unique identifier for this pod — used for log correlation. */
  workerId?: string;
  /** Optional clock override for deterministic tests. */
  now?: () => number;
}

export interface ReconcilerHandle {
  /** Stop the reconciler (interval + any in-flight scan). */
  stop: () => void;
  /**
   * Run one scan immediately (bypasses the interval wait). Returns the
   * number of orphans reconciled. Primarily for tests.
   */
  runOnce: () => Promise<number>;
}

// ─── Public API ──────────────────────────────────────────────────────────

export function startSessionReconciler(opts: ReconcilerOptions): ReconcilerHandle {
  const {
    ArchSessions,
    redis,
    intervalMs = ARCH_AI_LOCK.RECONCILER_INTERVAL_MS,
    jitterMs = ARCH_AI_LOCK.RECONCILER_STARTUP_JITTER_MS,
    orphanAgeMs = ARCH_AI_LOCK.ORPHAN_AGE_MS,
    workerId = `reconciler-${uuidv7()}`,
    now = () => Date.now(),
  } = opts;

  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let jitterHandle: ReturnType<typeof setTimeout> | null = null;

  const scan = async (): Promise<number> => {
    if (stopped) return 0;
    const cutoff = now() - orphanAgeMs;
    let reconciled = 0;

    // Explicit projection — no ALS / tenantIsolationPlugin reliance.
    // Mongoose queries are thenable; no need to call `.exec()`.
    const candidates = (await ArchSessions.find(
      {
        schemaVersion: 2,
        state: 'active',
        'activeTurnLock.renewedAt': { $lt: cutoff },
      },
      {
        _id: 1,
        tenantId: 1,
        userId: 1,
        schemaVersion: 1,
        activeTurnId: 1,
        activeTurnLock: 1,
      },
    ).lean()) as unknown as ReconcilerSessionDoc[];

    for (const doc of candidates) {
      if (stopped) break;
      try {
        await reconcileSession(doc, { ArchSessions, redis, workerId, now });
        reconciled += 1;
      } catch (err) {
        log.warn('reconcile failed for session', {
          sessionId: doc._id,
          tenantId: doc.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return reconciled;
  };

  const tick = () => {
    if (stopped) return;
    scan().catch((err) => {
      log.warn('reconciler scan failed', {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Stagger pod startup so N pods don't all scan at t=0.
  const jitter = Math.floor(Math.random() * jitterMs);
  jitterHandle = setTimeout(() => {
    if (stopped) return;
    intervalHandle = setInterval(tick, intervalMs);
    if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
    tick();
  }, jitter);
  if (typeof jitterHandle.unref === 'function') jitterHandle.unref();

  log.info('session reconciler started', { workerId, intervalMs, jitterMs: jitter });

  return {
    stop: () => {
      stopped = true;
      if (intervalHandle) clearInterval(intervalHandle);
      if (jitterHandle) clearTimeout(jitterHandle);
      intervalHandle = null;
      jitterHandle = null;
    },
    runOnce: scan,
  };
}

// ─── Per-session reconciliation ──────────────────────────────────────────

async function reconcileSession(
  doc: ReconcilerSessionDoc,
  ctx: {
    ArchSessions: Model<unknown>;
    redis: RedisClient;
    workerId: string;
    now: () => number;
  },
): Promise<void> {
  const { ArchSessions, redis, workerId, now } = ctx;
  const sessionId = doc._id;

  // Check Redis lock state. If the lock still exists with a non-trivial TTL,
  // the worker is still alive — don't reconcile.
  const lockKey = `arch:session:${sessionId}:turn_lock`;
  const ttlMs = await redis.pttl(lockKey);
  // ioredis returns -2 for missing, -1 for no TTL, otherwise ms
  const lockHealthy = ttlMs > 15_000;

  if (lockHealthy) {
    log.debug('session stale in DB but lock still healthy; skipping', {
      sessionId,
      tenantId: doc.tenantId,
      lockTtlMs: ttlMs,
    });
    return;
  }

  // Orphan confirmed. Emit worker_lost, clear turn lock, mark idle.
  if (doc.activeTurnId) {
    const event: TurnEndedEvent = {
      eventId: uuidv7(),
      schemaVersion: 2,
      sessionId,
      turnId: doc.activeTurnId,
      seq: 0,
      timestamp: now(),
      type: 'turn_ended',
      reason: 'worker_lost',
    };
    await publishTurnEvent(redis, sessionId, event);
  }

  const result = await ArchSessions.updateOne(
    {
      _id: sessionId,
      tenantId: doc.tenantId,
      userId: doc.userId,
      schemaVersion: 2,
      state: 'active',
    },
    {
      $set: { state: 'idle', lastActiveAt: new Date() },
      $unset: { activeTurnId: 1, activeTurnLock: 1 },
    },
  );

  if (result.matchedCount === 0) {
    log.debug('reconcile updateOne matched nothing (another pod reconciled)', {
      sessionId,
      tenantId: doc.tenantId,
    });
    return;
  }

  // Best-effort lock cleanup if it somehow still exists with no TTL.
  if (ttlMs === -1) {
    try {
      await redis.del(lockKey);
    } catch (err) {
      log.debug('lock cleanup failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('orphaned session reconciled', {
    sessionId,
    tenantId: doc.tenantId,
    userId: doc.userId,
    activeTurnId: doc.activeTurnId,
    priorWorkerId: doc.activeTurnLock?.workerId,
    reconcilerWorkerId: workerId,
  });
}
