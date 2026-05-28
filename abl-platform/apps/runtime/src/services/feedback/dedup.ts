/**
 * Feedback deduplication via Redis SETNX.
 *
 * Key pattern: `feedback:{tenantId}:{sessionId}:{messageId}:{userId}`
 * TTL: 90 days (matches the email CSAT dedup window).
 *
 * Soft-allow on Redis down — we record the attempt as allowed and rely on the
 * read-side `argMax(feedback_id) GROUP BY (tenant_id, session_id, message_id,
 * user_id)` backstop in ABLP-988 to collapse duplicates at query time. The
 * acceptance criterion in the LLD §7 explicitly carves out this case: hard
 * dedup only applies when Redis is available.
 */

export const FEEDBACK_DEDUP_TTL_SECONDS = 90 * 24 * 3600;

/**
 * Structural subset of ioredis we use. Loosely typed to accommodate both
 * Redis and Cluster (their `set` overloads differ in TS) without forcing
 * tests to import the full ioredis type surface.
 */
export interface RedisLikeClient {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  del?: (key: string) => Promise<number>;
}

export interface DedupContext {
  tenantId: string;
  sessionId: string;
  messageId: string;
  userId: string;
}

export interface DedupResult {
  /** True when the caller acquired the dedup slot and may proceed to write. */
  acquired: boolean;
  /** True when Redis was unavailable and soft-allow applied. */
  softAllowed: boolean;
}

export function buildDedupKey(ctx: DedupContext): string {
  // Use a fixed value separator that cannot appear in any of the parts (they
  // are all uuids / opaque ids and Redis keys allow ':').
  return `feedback:${ctx.tenantId}:${ctx.sessionId}:${ctx.messageId}:${ctx.userId}`;
}

/**
 * Try to acquire the dedup slot. Returns `{ acquired: true }` on first write,
 * `{ acquired: false }` on duplicate (within TTL), or `{ acquired: true,
 * softAllowed: true }` when Redis is null or the SETNX call throws.
 *
 * The `redis` arg is optional so callers can soft-allow without checking
 * availability themselves; pass `null` when Redis isn't ready.
 */
export async function acquireDedupSlot(
  redis: RedisLikeClient | null,
  ctx: DedupContext,
  ttlSeconds: number = FEEDBACK_DEDUP_TTL_SECONDS,
): Promise<DedupResult> {
  if (!redis) {
    return { acquired: true, softAllowed: true };
  }
  const key = buildDedupKey(ctx);
  try {
    // ioredis SET key value EX ttl NX — returns 'OK' on success, null on
    // duplicate. Both Cluster and Redis support this signature.
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return { acquired: result === 'OK', softAllowed: false };
  } catch {
    // Soft-allow on Redis failure (matches email CSAT path semantics).
    return { acquired: true, softAllowed: true };
  }
}

/**
 * Release a previously acquired dedup slot. Used to roll back the lock when
 * the downstream write fails so the user can retry without hitting a stale
 * DUPLICATE_FEEDBACK error.
 *
 * Errors during release are swallowed — they would replace the original
 * failure context with a less useful one.
 */
export async function releaseDedupSlot(
  redis: RedisLikeClient | null,
  ctx: DedupContext,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del?.(buildDedupKey(ctx));
  } catch {
    /* swallow — release is best-effort */
  }
}
