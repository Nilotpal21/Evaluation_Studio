import { createLogger } from '@abl/compiler/platform';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import type { UserIdentity } from '../idp/idp-token-validator.js';
import { GroupMembershipCache } from '../cache/group-membership-cache.js';
import { RedisClient } from '../cache/redis-client.js';

const logger = createLogger('permission-filter-service');

/**
 * Permission filter for OpenSearch queries
 *
 * This filter is injected into the bool query to restrict results
 * to documents the user has access to.
 */
export interface PermissionFilter {
  bool: {
    should: Array<{
      term?: Record<string, unknown>;
      terms?: Record<string, unknown[]>;
      bool?: { must_not?: Array<{ exists?: { field: string } }> };
    }>;
    minimum_should_match: number;
  };
}

/**
 * Permission Filter Service (Runtime — 3-Tier Resolution)
 *
 * Builds OpenSearch permission filters based on user identity.
 * Uses a 3-tier group resolution strategy:
 *
 *   Tier 1: JWT groups claim (0ms — already parsed from IdP token)
 *   Tier 2: Redis cache (0.5ms — searchai:permissions:groups:{tenantId}:{email})
 *   Tier 3: MongoDB contact card (1-3ms — pre-computed effectiveGroups)
 *
 * Design:
 * - Two modes: user mode (identity-based) and public mode (public content only)
 * - User mode: Resolves groups via 3-tier strategy, builds 4-clause OpenSearch filter
 * - FAIL-CLOSED: empty groups on error (user sees only public + email + domain matches)
 *
 * Performance:
 * - Tier 1 (JWT): 0ms (no external call)
 * - Tier 2 (Redis): ~0.5ms
 * - Tier 3 (MongoDB): ~1-3ms
 * - Filter construction: <1ms
 * - Total overhead: <1ms (JWT/cached), <5ms (MongoDB fallback)
 */
export class PermissionFilterService {
  private mongoPermissionStore: MongoPermissionStore | null = null;
  private groupCache: GroupMembershipCache;
  private redisClient: RedisClient;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient;
    this.groupCache = new GroupMembershipCache(redisClient);
  }

  /**
   * Lazily resolve MongoPermissionStore — only needed for Tier 3 (MongoDB).
   * Public mode and JWT/Redis paths never touch the permission store.
   */
  private getPermissionStore(): MongoPermissionStore {
    if (!this.mongoPermissionStore) {
      this.mongoPermissionStore = MongoPermissionStore.getInstance();
    }
    return this.mongoPermissionStore;
  }

  /**
   * Build permission filter for user mode
   *
   * 3-Tier group resolution:
   *   Tier 1: If userIdentity.groups is populated (from JWT), use directly
   *   Tier 2: Check Redis cache
   *   Tier 3: Query MongoPermissionStore (pre-computed effectiveGroups)
   *
   * Filter logic (4-clause OR):
   * - Document is publicEverywhere = true, OR
   * - User email is in allowedUsers, OR
   * - Any of user's groups are in allowedGroups, OR
   * - User's domain is in allowedDomains
   *
   * @param tenantId - Tenant ID
   * @param userIdentity - Validated user identity from IdP token
   * @returns OpenSearch permission filter
   */
  async buildUserPermissionFilter(
    tenantId: string,
    userIdentity: UserIdentity,
  ): Promise<PermissionFilter> {
    const startTime = Date.now();

    try {
      // 3-Tier group resolution
      const groups = await this.getUserGroups(tenantId, userIdentity);

      // Build OpenSearch bool filter (4-clause OR)
      const filter: PermissionFilter = {
        bool: {
          should: [
            // Public documents (no restrictions)
            { term: { 'permissions.publicEverywhere': true } },

            // User explicitly allowed
            { term: { 'permissions.allowedUsers': userIdentity.email } },

            // User's groups allowed (if groups exist)
            ...(groups.length > 0 ? [{ terms: { 'permissions.allowedGroups': groups } }] : []),

            // User's domain allowed
            { term: { 'permissions.allowedDomains': userIdentity.domain } },
          ],
          minimum_should_match: 1, // At least one condition must match
        },
      };

      const latency = Date.now() - startTime;
      logger.debug('Built user permission filter', {
        tenantId,
        email: userIdentity.email,
        groupCount: groups.length,
        latencyMs: latency,
        tier: userIdentity.groups?.length ? 'jwt' : 'cache-or-db',
      });

      return filter;
    } catch (error) {
      logger.error('Failed to build user permission filter', {
        tenantId,
        email: userIdentity.email,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build permission filter for public mode
   *
   * Filter logic (2-clause OR):
   * - Document has permissions.publicEverywhere = true, OR
   * - Document has no permissions field at all (indexed before RACL was enabled)
   *
   * The second clause provides backward compatibility so that documents indexed
   * before the ABLP-303 permission system was deployed are still returned in
   * public mode queries. Without it, every existing document would be filtered
   * out because OpenSearch term queries on a non-existent field return no match.
   *
   * @returns OpenSearch permission filter for public content only
   */
  buildPublicPermissionFilter(): PermissionFilter {
    return {
      bool: {
        should: [
          // Documents explicitly marked as public
          { term: { 'permissions.publicEverywhere': true } },
          // Backward compatibility: documents indexed before RACL (no permissions field)
          { bool: { must_not: [{ exists: { field: 'permissions' } }] } },
        ],
        minimum_should_match: 1,
      },
    };
  }

  /**
   * 3-Tier group resolution
   *
   * Tier 1: JWT groups claim (0ms) — if IdP embedded groups in the token
   * Tier 2: Redis cache (0.5ms) — 5-min TTL
   * Tier 3: MongoDB contact card (1-3ms) — pre-computed effectiveGroups
   *
   * @param tenantId - Tenant ID
   * @param userIdentity - Validated user identity (may contain groups from JWT)
   * @returns Array of group IDs (e.g., ["sharepoint:g_1", "azuread:g_2"])
   */
  private async getUserGroups(tenantId: string, userIdentity: UserIdentity): Promise<string[]> {
    // ── Tier 1: JWT groups claim ──────────────────────────────────────────
    // Azure AD and Okta can embed group memberships directly in the JWT.
    // If present, use directly — zero database lookups needed.
    if (userIdentity.groups && userIdentity.groups.length > 0) {
      logger.debug('Tier 1: Using groups from JWT claim', {
        tenantId,
        email: userIdentity.email,
        groupCount: userIdentity.groups.length,
      });
      return userIdentity.groups;
    }

    // ── Tier 2: Redis cache ───────────────────────────────────────────────
    const cached = await this.groupCache.getUserGroups(tenantId, userIdentity.email);
    if (cached !== null) {
      logger.debug('Tier 2: Groups from Redis cache', {
        tenantId,
        email: userIdentity.email,
        groupCount: cached.length,
      });
      return cached;
    }

    // ── Tier 3: MongoDB contact card (pre-computed effectiveGroups) ───────
    logger.debug('Tier 3: Fetching user groups from MongoDB contact card', {
      tenantId,
      email: userIdentity.email,
    });

    try {
      const groups = await this.getPermissionStore().getUserGroups(tenantId, userIdentity.email);

      // Cache result in Redis for next lookup
      await this.groupCache.setUserGroups(tenantId, userIdentity.email, groups);

      return groups;
    } catch (error) {
      logger.error('Failed to fetch user groups from MongoDB', {
        tenantId,
        email: userIdentity.email,
        error: error instanceof Error ? error.message : String(error),
      });

      // FAIL-CLOSED: Return empty groups on MongoDB error
      // User still sees public docs + email-matched docs + domain-matched docs
      logger.warn('Returning empty groups due to MongoDB error (fail-closed)', {
        tenantId,
        email: userIdentity.email,
      });
      return [];
    }
  }

  /**
   * Invalidate group cache for a user
   *
   * Use case: User's group memberships changed (IdP sync, manual edit)
   */
  async invalidateUserCache(tenantId: string, email: string): Promise<void> {
    await this.groupCache.invalidateUser(tenantId, email);
  }

  /**
   * Invalidate group cache for entire tenant
   *
   * Use case: Permission crawl completed, IdP sync completed
   */
  async invalidateTenantCache(tenantId: string): Promise<number> {
    return this.groupCache.invalidateTenant(tenantId);
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(tenantId: string): Promise<{ cachedUsers: number; totalKeys: number }> {
    return this.groupCache.getStats(tenantId);
  }
}

/**
 * Singleton instance
 */
let instance: PermissionFilterService | null = null;

export function getPermissionFilterService(redisClient: RedisClient): PermissionFilterService {
  if (!instance) {
    instance = new PermissionFilterService(redisClient);
  }
  return instance;
}
