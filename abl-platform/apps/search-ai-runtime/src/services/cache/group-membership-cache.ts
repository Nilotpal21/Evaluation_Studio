import { createLogger } from '@abl/compiler/platform';
import { RedisClient } from './redis-client.js';

const logger = createLogger('group-membership-cache');

/**
 * Cache TTL for group memberships: 5 minutes
 *
 * Rationale:
 * - Group memberships change infrequently (weekly/monthly)
 * - 5 minutes is acceptable staleness for search results
 * - Balances MongoDB load vs freshness
 */
const GROUP_CACHE_TTL = 300; // 5 minutes in seconds

/**
 * Group Membership Cache
 *
 * Caches user group memberships to avoid repeated MongoDB queries.
 * Cache key pattern: searchai:permissions:groups:{tenantId}:{email}
 *
 * Design:
 * - Redis-backed with 5-minute TTL
 * - Tenant-scoped keys for multi-tenant isolation
 * - Email normalized to lowercase
 * - Group IDs stored as JSON array
 *
 * Invalidation triggers:
 * - Permission crawl completes (batch invalidate all users)
 * - IdP sync completes (batch invalidate all users)
 * - Manual cache clear via admin API
 */
export class GroupMembershipCache {
  private redisClient: RedisClient;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient;
  }

  /**
   * Get cached group memberships for a user
   *
   * @param tenantId - Tenant ID
   * @param email - User email (case-insensitive)
   * @returns Array of group IDs, or null if cache miss
   */
  async getUserGroups(tenantId: string, email: string): Promise<string[] | null> {
    const cacheKey = this.getCacheKey(tenantId, email);

    try {
      const cached = await this.redisClient.get(cacheKey);
      if (!cached) {
        logger.debug('Group cache miss', { tenantId, email });
        return null;
      }

      const groups = JSON.parse(cached) as string[];
      logger.debug('Group cache hit', { tenantId, email, groupCount: groups.length });
      return groups;
    } catch (error) {
      logger.error('Failed to get cached groups', {
        tenantId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      return null; // Graceful degradation on cache errors
    }
  }

  /**
   * Set group memberships for a user
   *
   * @param tenantId - Tenant ID
   * @param email - User email (case-insensitive)
   * @param groups - Array of group IDs (e.g., ["sharepoint:g_1", "azuread:g_2"])
   */
  async setUserGroups(tenantId: string, email: string, groups: string[]): Promise<void> {
    const cacheKey = this.getCacheKey(tenantId, email);

    try {
      const serialized = JSON.stringify(groups);
      await this.redisClient.set(cacheKey, serialized, GROUP_CACHE_TTL);
      logger.debug('Group cache updated', { tenantId, email, groupCount: groups.length });
    } catch (error) {
      logger.error('Failed to cache groups', {
        tenantId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - caching is optional optimization
    }
  }

  /**
   * Invalidate cache for a specific user
   *
   * @param tenantId - Tenant ID
   * @param email - User email (case-insensitive)
   */
  async invalidateUser(tenantId: string, email: string): Promise<void> {
    const cacheKey = this.getCacheKey(tenantId, email);

    try {
      await this.redisClient.del(cacheKey);
      logger.debug('Group cache invalidated for user', { tenantId, email });
    } catch (error) {
      logger.error('Failed to invalidate user cache', {
        tenantId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Invalidate cache for entire tenant (all users)
   *
   * Use cases:
   * - Permission crawl completes (SharePoint permissions updated)
   * - IdP sync completes (Azure AD/Okta/Google groups updated)
   * - Manual cache clear via admin API
   *
   * @param tenantId - Tenant ID
   * @returns Number of keys deleted
   */
  async invalidateTenant(tenantId: string): Promise<number> {
    const pattern = `searchai:permissions:groups:${tenantId}:*`;

    try {
      const keys = await this.redisClient.scanByPattern(pattern);

      if (keys.length === 0) {
        logger.debug('No cached groups to invalidate', { tenantId });
        return 0;
      }

      await this.redisClient.del(...keys);
      logger.info('Group cache invalidated for tenant', {
        tenantId,
        keysDeleted: keys.length,
      });
      return keys.length;
    } catch (error) {
      logger.error('Failed to invalidate tenant cache', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Invalidate cache for multiple users (batch operation)
   *
   * Use case: IdP sync updates specific users' group memberships
   *
   * @param tenantId - Tenant ID
   * @param emails - Array of user emails
   * @returns Number of keys deleted
   */
  async invalidateUsers(tenantId: string, emails: string[]): Promise<number> {
    if (emails.length === 0) {
      return 0;
    }

    try {
      const keys = emails.map((email) => this.getCacheKey(tenantId, email));
      await this.redisClient.del(...keys);
      logger.info('Group cache invalidated for users', {
        tenantId,
        userCount: emails.length,
      });
      return keys.length;
    } catch (error) {
      logger.error('Failed to invalidate users cache', {
        tenantId,
        userCount: emails.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get cache statistics for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns Cache statistics
   */
  async getStats(tenantId: string): Promise<{ cachedUsers: number; totalKeys: number }> {
    const pattern = `searchai:permissions:groups:${tenantId}:*`;

    try {
      const keys = await this.redisClient.scanByPattern(pattern);
      return {
        cachedUsers: keys.length,
        totalKeys: keys.length,
      };
    } catch (error) {
      logger.error('Failed to get cache stats', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { cachedUsers: 0, totalKeys: 0 };
    }
  }

  /**
   * Get cache key for user group memberships
   *
   * Pattern: searchai:permissions:groups:{tenantId}:{email}
   * Email normalized to lowercase for case-insensitive lookup
   */
  private getCacheKey(tenantId: string, email: string): string {
    return `searchai:permissions:groups:${tenantId}:${email.toLowerCase()}`;
  }
}

/**
 * Singleton instance
 */
let instance: GroupMembershipCache | null = null;

export function getGroupMembershipCache(redisClient: RedisClient): GroupMembershipCache {
  if (!instance) {
    instance = new GroupMembershipCache(redisClient);
  }
  return instance;
}
