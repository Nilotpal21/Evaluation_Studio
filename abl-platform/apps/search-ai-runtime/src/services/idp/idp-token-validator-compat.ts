/**
 * IdP Token Validator — Backward Compatibility Re-export
 *
 * Re-exports from @agent-platform/shared-auth/idp for backward compatibility.
 * Existing code in search-ai-runtime that imports from this path continues to work.
 *
 * New code should import directly from '@agent-platform/shared-auth/idp'.
 */

export { IdPTokenValidator } from '@agent-platform/shared-auth/idp';
export type { UserIdentity, IdPProvider } from '@agent-platform/shared-auth/idp';

import { IdPTokenValidator } from '@agent-platform/shared-auth/idp';
import type { RedisLike } from '@agent-platform/shared-auth/idp';
import { RedisClient } from '../cache/redis-client.js';

/**
 * Adapter: wraps RedisClient to match the RedisLike interface.
 */
class RedisClientAdapter implements RedisLike {
  constructor(private client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.client.set(key, value, ttl);
  }

  async del(...keys: string[]): Promise<void> {
    await this.client.del(...keys);
  }

  async scanByPattern(pattern: string): Promise<string[]> {
    return this.client.scanByPattern(pattern);
  }
}

/**
 * Singleton factory — backward-compatible with existing usage.
 */
let instance: IdPTokenValidator | null = null;

export function getIdPTokenValidator(redisClient: RedisClient): IdPTokenValidator {
  if (!instance) {
    const adapter = new RedisClientAdapter(redisClient);
    instance = new IdPTokenValidator(adapter);
  }
  return instance;
}
