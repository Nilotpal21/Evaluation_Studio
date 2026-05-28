/**
 * RedisExecutionQueue — Redis-backed ExecutionQueue for distributed use.
 *
 * Uses Redis lists (RPUSH/LPOP) for per-session FIFO queues and
 * Redis strings (SET/GET) for the active execution slot. All keys
 * have TTLs to prevent orphaned data from stuck sessions.
 *
 * NOTE: The Execution type has a `signal?: AbortSignal` field which is
 * NOT serializable to JSON. The signal field will be lost during
 * serialization — this is by design. AbortSignals are only meaningful
 * in-memory during active execution, not across pods.
 */

import type { Execution, ExecutionQueue } from '@agent-platform/execution';
import type { RedisClient } from '@agent-platform/redis';

const QUEUE_KEY_PREFIX = 'exec:queue:';
const ACTIVE_KEY_PREFIX = 'exec:active:';
const QUEUE_TTL_SEC = 600; // 10 minutes
const ACTIVE_TTL_SEC = 300; // 5 minutes

export class RedisExecutionQueue implements ExecutionQueue {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async enqueue(sessionId: string, execution: Execution): Promise<void> {
    const key = QUEUE_KEY_PREFIX + sessionId;
    await this.redis.rpush(key, JSON.stringify(execution));
    await this.redis.expire(key, QUEUE_TTL_SEC);
  }

  async dequeue(sessionId: string): Promise<Execution | null> {
    const raw = await this.redis.lpop(QUEUE_KEY_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  }

  async peek(sessionId: string): Promise<Execution | null> {
    const raw = await this.redis.lindex(QUEUE_KEY_PREFIX + sessionId, 0);
    return raw ? JSON.parse(raw) : null;
  }

  async length(sessionId: string): Promise<number> {
    return this.redis.llen(QUEUE_KEY_PREFIX + sessionId);
  }

  async cancelAll(sessionId: string): Promise<Execution[]> {
    const key = QUEUE_KEY_PREFIX + sessionId;
    const items = await this.redis.lrange(key, 0, -1);
    await this.redis.del(key);
    return items.map((raw) => ({
      ...JSON.parse(raw),
      status: 'cancelled' as const,
    }));
  }

  async getActive(sessionId: string): Promise<Execution | null> {
    const raw = await this.redis.get(ACTIVE_KEY_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  }

  async setActive(sessionId: string, execution: Execution): Promise<void> {
    await this.redis.set(
      ACTIVE_KEY_PREFIX + sessionId,
      JSON.stringify(execution),
      'EX',
      ACTIVE_TTL_SEC,
    );
  }

  async clearActive(sessionId: string): Promise<void> {
    await this.redis.del(ACTIVE_KEY_PREFIX + sessionId);
  }
}
