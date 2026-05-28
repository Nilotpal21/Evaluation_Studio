import { createLogger } from '@abl/compiler/platform';
import {
  MongoPermissionStore,
  type FlattenedPermissions,
} from '@agent-platform/search-ai-internal/permissions';

const logger = createLogger('document-permission-resolver');

/**
 * Document Permission Resolver
 *
 * Resolves document permissions from MongoDB for OpenSearch indexing.
 * Implements document-level caching to avoid N+1 queries.
 *
 * Design:
 * - Used by embedding worker during chunk indexing
 * - Fetches permissions once per document (not per chunk)
 * - Caches in-memory for batch processing
 * - FAIL-CLOSED on errors: returns restricted permissions (not publicEverywhere)
 *
 * Performance:
 * - Without caching: N queries for N chunks (N * 3ms = 300ms for 100 chunks)
 * - With caching: 1 query per document (1 * 3ms = 3ms for 100 chunks)
 * - Improvement: 100x faster for multi-chunk documents
 */
/**
 * Max cached permission entries.
 * At ~500 bytes per FlattenedPermissions, 10K entries ≈ 5MB — bounded memory.
 */
const MAX_CACHE_ENTRIES = 10_000;

export class DocumentPermissionResolver {
  private permissionStore: MongoPermissionStore;
  private cache: Map<string, FlattenedPermissions>;
  private cacheHits: number;
  private cacheMisses: number;

  constructor() {
    this.permissionStore = MongoPermissionStore.getInstance();
    this.cache = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Get permissions for a document (with in-memory caching)
   *
   * @param tenantId - Tenant ID
   * @param documentId - Document ID (MongoDB _id)
   * @returns Flattened permissions for OpenSearch
   */
  async getPermissions(tenantId: string, documentId: string): Promise<FlattenedPermissions> {
    const cacheKey = `${tenantId}:${documentId}`;

    // Check in-memory cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      logger.debug('Permission cache hit', { tenantId, documentId, cacheSize: this.cache.size });
      return cached;
    }

    this.cacheMisses++;

    // Cache miss — query MongoDB acl_document_permissions
    try {
      const permissions = await this.permissionStore.getFlattenedPermissions(tenantId, documentId);

      // Evict oldest entry (LRU — Map iteration order is insertion order) if at capacity
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }

      // Cache result for this batch
      this.cache.set(cacheKey, permissions);

      logger.debug('Permission fetched from MongoDB', {
        tenantId,
        documentId,
        publicEverywhere: permissions.publicEverywhere,
        userCount: permissions.allowedUsers.length,
        groupCount: permissions.allowedGroups.length,
      });

      return permissions;
    } catch (error) {
      logger.error('Failed to fetch permissions from MongoDB', {
        tenantId,
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });

      // FAIL-CLOSED: Return restricted permissions on error.
      // Private docs stay private when the permission store is unavailable.
      // This is a security-critical change from the previous Neo4j behavior
      // which returned publicEverywhere: true on error (fail-open bug).
      const fallbackPermissions: FlattenedPermissions = {
        publicEverywhere: false,
        publicInDomain: false,
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        source: 'fallback-restricted',
      };

      logger.warn('Using fail-closed restricted permissions due to MongoDB error', {
        tenantId,
        documentId,
      });

      return fallbackPermissions;
    }
  }

  /**
   * Clear cache (called after batch processing)
   */
  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();

    logger.info('Permission cache cleared', {
      entriesCleared: size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses || 1),
    });

    // Reset counters
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    return {
      size: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses || 1),
    };
  }

  /**
   * Prefetch permissions for multiple documents (batch optimization)
   *
   * Use case: Connector sync workers can prefetch permissions for
   * all documents before starting chunk processing.
   *
   * @param tenantId - Tenant ID
   * @param documentIds - Array of document IDs
   */
  async prefetchPermissions(tenantId: string, documentIds: string[]): Promise<void> {
    const startTime = Date.now();

    logger.info('Prefetching permissions for documents', {
      tenantId,
      documentCount: documentIds.length,
    });

    // Fetch all permissions in parallel from MongoDB
    const results = await Promise.allSettled(
      documentIds.map((documentId) =>
        this.permissionStore.getFlattenedPermissions(tenantId, documentId),
      ),
    );

    // Cache successful results
    let successCount = 0;
    let failureCount = 0;

    results.forEach((result, index) => {
      const documentId = documentIds[index];
      const cacheKey = `${tenantId}:${documentId}`;

      // Evict oldest if at capacity
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }

      if (result.status === 'fulfilled') {
        this.cache.set(cacheKey, result.value);
        successCount++;
      } else {
        // FAIL-CLOSED: cache restricted permissions for failed documents
        this.cache.set(cacheKey, {
          publicEverywhere: false,
          publicInDomain: false,
          allowedUsers: [],
          allowedGroups: [],
          allowedDomains: [],
          source: 'fallback-restricted',
        });
        failureCount++;
      }
    });

    const duration = Date.now() - startTime;

    logger.info('Prefetch complete', {
      tenantId,
      documentCount: documentIds.length,
      successCount,
      failureCount,
      durationMs: duration,
      cacheSize: this.cache.size,
    });
  }
}

/**
 * Singleton instance
 */
let instance: DocumentPermissionResolver | null = null;

export function getDocumentPermissionResolver(): DocumentPermissionResolver {
  if (!instance) {
    instance = new DocumentPermissionResolver();
  }
  return instance;
}
