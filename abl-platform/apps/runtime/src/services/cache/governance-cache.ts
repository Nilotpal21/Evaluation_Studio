import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { scanKeys } from '@agent-platform/redis';
import { getRedisClient } from '../redis/redis-client.js';

const log = createLogger('governance-cache');

export class GovernanceCache {
  constructor(private readonly redis: RedisClient | null) {}

  private buildKey(tenantId: string, projectId: string, period: string): string {
    return `governance:status:${tenantId}:${projectId}:${period}`;
  }

  async get(tenantId: string, projectId: string, period: string): Promise<unknown | null> {
    if (!this.redis) return null;
    try {
      const key = this.buildKey(tenantId, projectId, period);
      const cached = await this.redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached);
    } catch (err) {
      log.warn('Governance cache get failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set(
    tenantId: string,
    projectId: string,
    period: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = this.buildKey(tenantId, projectId, period);
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      log.warn('Governance cache set failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async invalidate(tenantId: string, projectId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const pattern = `governance:status:${tenantId}:${projectId}:*`;
      const keys: string[] = [];
      for await (const key of scanKeys(this.redis, pattern, 100)) {
        keys.push(key);
      }
      if (keys.length > 0) {
        // Keys may span different cluster slots — delete individually.
        await Promise.all(keys.map((k) => this.redis!.del(k)));
      }
    } catch (err) {
      log.warn('Governance cache invalidate failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  static async create(): Promise<GovernanceCache> {
    try {
      const redis = getRedisClient();
      return new GovernanceCache(redis);
    } catch {
      return new GovernanceCache(null);
    }
  }
}
