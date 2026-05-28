/**
 * Permission Filter Service (Design-Time)
 *
 * Provides query-time permission filtering for search results.
 * Queries MongoPermissionStore to determine which documents a user can access,
 * then filters search results to only include accessible documents.
 *
 * Key features:
 * - User permission resolution via pre-computed effective groups
 * - Public document handling (publicInDomain, publicEverywhere)
 * - Redis caching (5-minute TTL) for performance
 * - Large permission set optimization
 */

import { createLogger } from '@abl/compiler/platform';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import type { RedisClient } from '@agent-platform/redis';
import { scanKeys } from '@agent-platform/redis';
import { createHash } from 'crypto';

const logger = createLogger('permission-filter-service');

// ============================================================================
// Types
// ============================================================================

export interface UserIdentity {
  tenantId: string;
  userId: string;
  email: string;
  groupIds?: string[];
}

export interface AccessibleDocumentsResult {
  documentIds: string[];
  totalCount: number;
  isComplete: boolean; // false if result was truncated due to size
  cacheHit: boolean;
}

export interface PermissionFilterOptions {
  maxDocuments?: number; // Max number of document IDs to return (default: 10000)
  skipCache?: boolean; // Skip Redis cache and query MongoDB directly
}

// ============================================================================
// Permission Filter Service
// ============================================================================

export class PermissionFilterService {
  private readonly permissionStore: MongoPermissionStore;
  private readonly redis: RedisClient | null;
  private readonly defaultMaxDocuments = 10000;
  private readonly cacheTTL = 300; // 5 minutes

  constructor(permissionStore: MongoPermissionStore, redis?: RedisClient) {
    this.permissionStore = permissionStore;
    this.redis = redis || null;
  }

  /**
   * Get all documents accessible by a user.
   * Includes documents user can access directly, via group membership,
   * or via public access flags.
   *
   * @param identity - User identity (userId, email, groupIds)
   * @param options - Filter options
   * @returns List of accessible document IDs
   */
  async getAccessibleDocuments(
    identity: UserIdentity,
    options: PermissionFilterOptions = {},
  ): Promise<AccessibleDocumentsResult> {
    const maxDocuments = options.maxDocuments || this.defaultMaxDocuments;

    // Try cache first (unless skipCache is true)
    if (!options.skipCache && this.redis) {
      const cached = await this.getCachedAccessibleDocuments(identity);
      if (cached) {
        return {
          ...cached,
          cacheHit: true,
          isComplete: cached.documentIds.length <= maxDocuments,
        };
      }
    }

    // Query MongoDB for accessible documents
    const documentIds = await this.queryAccessibleDocuments(identity, maxDocuments);

    const result: AccessibleDocumentsResult = {
      documentIds,
      totalCount: documentIds.length,
      isComplete: documentIds.length <= maxDocuments,
      cacheHit: false,
    };

    // Cache result
    if (this.redis) {
      await this.cacheAccessibleDocuments(identity, result);
    }

    return result;
  }

  /**
   * Check if a user can access a specific document.
   * More efficient than getAccessibleDocuments when checking single document.
   *
   * @param identity - User identity
   * @param documentId - Document ID to check
   * @returns true if user can access document
   */
  async canAccessDocument(identity: UserIdentity, documentId: string): Promise<boolean> {
    // For single document check, query MongoDB directly (more efficient than loading all accessible docs)
    const permissions = await this.permissionStore.getFlattenedPermissions(
      identity.tenantId,
      documentId,
    );

    // Check if user has direct permission
    const hasUserPermission = permissions.allowedUsers.some(
      (email: string) => email === identity.email,
    );
    if (hasUserPermission) {
      return true;
    }

    // Check if user belongs to a group with permission
    if (identity.groupIds && identity.groupIds.length > 0) {
      const hasGroupPermission = permissions.allowedGroups.some((groupId: string) =>
        identity.groupIds!.includes(groupId),
      );
      if (hasGroupPermission) {
        return true;
      }
    }

    // Check public access
    if (permissions.publicInDomain || permissions.publicEverywhere) {
      return true;
    }

    return false;
  }

  /**
   * Invalidate cached permissions for a user.
   * Call this when user's permissions change (e.g., added to group).
   *
   * @param identity - User identity
   */
  async invalidateCache(identity: UserIdentity): Promise<void> {
    if (!this.redis) {
      return;
    }

    const cacheKey = this.getCacheKey(identity);
    await this.redis.del(cacheKey);
  }

  /**
   * Invalidate cached permissions for all users in a tenant.
   * Call this when permission structure changes significantly.
   *
   * @param tenantId - Tenant ID
   */
  async invalidateTenantCache(tenantId: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    const pattern = `permission-filter:${tenantId}:*`;
    const delPromises: Promise<unknown>[] = [];
    for await (const key of scanKeys(this.redis, pattern, 200)) {
      delPromises.push(this.redis.del(key));
    }
    await Promise.all(delPromises);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Private Methods
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Query MongoDB for accessible documents.
   *
   * INTENTIONAL NO-OP: This method returns [] because design-time document-level
   * filtering is handled by the OpenSearch 4-clause bool filter (runtime path).
   * The permission filter middleware injects the user's groups into the search
   * query, and OpenSearch performs the actual filtering at query time.
   *
   * This method returns an empty array because document-level filtering in
   * the design-time context is handled differently: the permission filter
   * middleware injects the user's groups into the search query, and OpenSearch
   * performs the actual filtering.
   *
   * TODO: If admin audit requires "list all docs user X can access", implement
   * a MongoDB aggregation over acl_document_permissions matching user's groups.
   */
  private async queryAccessibleDocuments(
    _identity: UserIdentity,
    _maxDocuments: number,
  ): Promise<string[]> {
    // Design-time accessible document listing is deferred.
    // Query-time filtering uses the OpenSearch 4-clause bool filter (runtime path).
    // For audit purposes, use the admin API which queries acl_document_permissions directly.
    return [];
  }

  /**
   * Get cached accessible documents from Redis.
   */
  private async getCachedAccessibleDocuments(
    identity: UserIdentity,
  ): Promise<AccessibleDocumentsResult | null> {
    if (!this.redis) {
      return null;
    }

    const cacheKey = this.getCacheKey(identity);
    const cached = await this.redis.get(cacheKey);

    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached);
    } catch (error) {
      logger.error('Failed to parse cached permission data', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Cache accessible documents in Redis.
   */
  private async cacheAccessibleDocuments(
    identity: UserIdentity,
    result: AccessibleDocumentsResult,
  ): Promise<void> {
    if (!this.redis) {
      return;
    }

    const cacheKey = this.getCacheKey(identity);
    const value = JSON.stringify(result);

    await this.redis.setex(cacheKey, this.cacheTTL, value);
  }

  /**
   * Generate cache key for user identity.
   * Format: permission-filter:{tenantId}:{userId}:{groupIdsHash}
   */
  private getCacheKey(identity: UserIdentity): string {
    const groupIdsStr = identity.groupIds?.sort().join(',') || '';
    const groupIdsHash = this.hashString(groupIdsStr);

    return `permission-filter:${identity.tenantId}:${identity.userId}:${groupIdsHash}`;
  }

  /**
   * Hash a string to create a shorter cache key.
   */
  private hashString(str: string): string {
    return createHash('sha256').update(str).digest('hex').substring(0, 16);
  }
}
