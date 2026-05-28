/**
 * Flow-Scoped Secret Store
 *
 * Hybrid Redis/in-memory store for transient auth credentials collected
 * via the collect_secret tool. Follows the pattern from sso-state-store.ts.
 *
 * Key properties:
 * - Flow-scoped: keyed by flowId (UUIDv4), not sessionId
 * - Atomic consume: GETDEL on Redis prevents concurrent read races
 * - Never persisted to MongoDB or LLM context
 * - TTL-evicted after 15 minutes
 */

import { isRedisAvailable, getRedisClient } from '@/lib/redis-client';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:secret-store');

const REDIS_PREFIX = 'arch:secret:';
const SECRET_TTL_SECONDS = 900; // 15 minutes
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds
const MAX_ENTRIES = 10_000;

// In-memory fallback (single-process only)
const memSecrets = new Map<string, { data: Record<string, string>; expiresAt: number }>();

// Lazy-init cleanup interval — avoids duplicate timers during Next.js hot-reload
let cleanupStarted = false;
function ensureCleanupInterval(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of memSecrets) {
      if (v.expiresAt < now) memSecrets.delete(k);
    }
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Store or merge secrets for a flow. Accumulates across multiple
 * collect_secret calls with the same flowId.
 */
export async function setFlowSecrets(
  flowId: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    try {
      const existing = await redis.get(`${REDIS_PREFIX}${flowId}`);
      const merged = { ...(existing ? JSON.parse(existing) : {}), ...secrets };
      await redis.set(`${REDIS_PREFIX}${flowId}`, JSON.stringify(merged), 'EX', SECRET_TTL_SECONDS);
      return;
    } catch (err) {
      log.error('Redis setFlowSecrets failed, falling through to in-memory', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  ensureCleanupInterval();
  // Evict oldest entry if at capacity
  if (!memSecrets.has(flowId) && memSecrets.size >= MAX_ENTRIES) {
    const oldest = memSecrets.keys().next().value;
    if (oldest !== undefined) memSecrets.delete(oldest);
  }
  const entry = memSecrets.get(flowId);
  const merged = { ...(entry?.data ?? {}), ...secrets };
  memSecrets.set(flowId, {
    data: merged,
    expiresAt: Date.now() + SECRET_TTL_SECONDS * 1000,
  });
}

/**
 * Atomically consume (read + delete) all secrets for a flow.
 * Returns null if flowId doesn't exist or is expired.
 * Uses Redis GETDEL for atomicity.
 */
export async function consumeFlowSecrets(flowId: string): Promise<Record<string, string> | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    try {
      const raw = await redis.getdel(`${REDIS_PREFIX}${flowId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      log.error('Redis consumeFlowSecrets failed, falling through to in-memory', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const entry = memSecrets.get(flowId);
  memSecrets.delete(flowId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}

/** Exposed for testing only — do not use in production code */
export function _getMemSecretsForTest(): Map<
  string,
  { data: Record<string, string>; expiresAt: number }
> {
  return memSecrets;
}
