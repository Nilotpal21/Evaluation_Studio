/**
 * Permission Filter Middleware (Design-Time)
 *
 * Express middleware that applies query-time permission filtering to search requests.
 * Uses MongoPermissionStore to determine accessible documents.
 *
 * Usage:
 *   router.post('/search', applyPermissionFilter(), async (req, res) => {
 *     // req.accessibleDocumentIds contains filtered document IDs
 *     // Use these to filter vector DB query
 *   });
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { PermissionFilterService } from '../services/permission-filter.service.js';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import type { RedisClient } from '@agent-platform/redis';

const logger = createLogger('permission-filter-middleware');

// ============================================================================
// Extended Request Type
// ============================================================================

export interface PermissionFilteredRequest extends Request {
  /**
   * Document IDs accessible by the current user.
   * Set by applyPermissionFilter middleware.
   */
  accessibleDocumentIds?: string[];

  /**
   * Whether permission filtering is enabled for this request.
   * Set by applyPermissionFilter middleware.
   */
  permissionFilterEnabled?: boolean;

  /**
   * Permission filter metadata (for debugging/monitoring).
   */
  permissionFilterMetadata?: {
    totalAccessible: number;
    cacheHit: boolean;
    queryDurationMs: number;
    isComplete: boolean;
  };
}

// ============================================================================
// Middleware Options
// ============================================================================

export interface PermissionFilterOptions {
  /**
   * Redis client for caching (optional).
   * If not provided, caching is disabled.
   */
  redis?: RedisClient;

  /**
   * @deprecated Neo4j config — no longer needed. MongoPermissionStore is used.
   */
  neo4jConfig?: Record<string, unknown>;

  /**
   * Maximum number of accessible documents to load.
   * If user has more, query will be truncated.
   * Default: 10000
   */
  maxDocuments?: number;

  /**
   * Skip permission filtering for certain conditions.
   * Function receives request and returns true to skip filtering.
   */
  skipIf?: (req: Request) => boolean;

  /**
   * Bypass cache and query MongoDB directly.
   * Useful for testing or when fresh data is required.
   * Default: false
   */
  skipCache?: boolean;
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create permission filter middleware.
 *
 * @param options - Middleware configuration options
 * @returns Express middleware function
 */
export function applyPermissionFilter(options: PermissionFilterOptions = {}) {
  // Initialize services (singleton pattern)
  const mongoPermissionStore = MongoPermissionStore.getInstance();
  const permissionFilterService = new PermissionFilterService(mongoPermissionStore, options.redis);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();

    try {
      // Check if filtering should be skipped
      if (options.skipIf && options.skipIf(req)) {
        (req as PermissionFilteredRequest).permissionFilterEnabled = false;
        next();
        return;
      }

      // Validate tenant context
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
        });
        return;
      }

      // Extract user identity from tenant context
      // For user auth, userId IS the email
      // For SDK/API key auth, userId is not an email
      const userEmail = req.tenantContext.userId;
      if (!userEmail || !userEmail.includes('@')) {
        res.status(400).json({
          success: false,
          error: {
            code: 'EMAIL_REQUIRED',
            message:
              'User email required for permission filtering. Permission filtering only supports user authentication (not SDK or API keys)',
          },
        });
        return;
      }

      // Query accessible documents
      // Note: groupIds are resolved by MongoPermissionStore from pre-computed contact card ACL
      const result = await permissionFilterService.getAccessibleDocuments(
        {
          tenantId: req.tenantContext.tenantId,
          userId: req.tenantContext.userId,
          email: userEmail,
          groupIds: [], // Resolved from MongoDB contact card's acl.effectiveGroups
        },
        {
          maxDocuments: options.maxDocuments,
          skipCache: options.skipCache,
        },
      );

      // Attach to request
      const filteredReq = req as PermissionFilteredRequest;
      filteredReq.accessibleDocumentIds = result.documentIds;
      filteredReq.permissionFilterEnabled = true;
      filteredReq.permissionFilterMetadata = {
        totalAccessible: result.totalCount,
        cacheHit: result.cacheHit,
        queryDurationMs: Date.now() - startTime,
        isComplete: result.isComplete,
      };

      // Log permission filter metadata (for monitoring)
      logger.info('Permission filter applied', {
        email: userEmail,
        tenantId: req.tenantContext.tenantId,
        totalAccessible: result.totalCount,
        cacheHit: result.cacheHit,
        durationMs: Date.now() - startTime,
      });

      next();
    } catch (error) {
      logger.error('Failed to apply permission filter', {
        error: error instanceof Error ? error.message : String(error),
      });

      // FAIL-CLOSED: deny search when permissions cannot be loaded (security).
      res.status(500).json({
        success: false,
        error: {
          code: 'PERMISSION_LOAD_FAILED',
          message: 'Failed to load permissions',
          ...(process.env.NODE_ENV === 'development' && {
            details: error instanceof Error ? error.message : String(error),
          }),
        },
      });
    }
  };
}

/**
 * Helper to check if request has permission filtering applied.
 */
export function hasPermissionFilter(req: Request): req is PermissionFilteredRequest {
  return (req as PermissionFilteredRequest).permissionFilterEnabled === true;
}

/**
 * Helper to get accessible document IDs from request.
 * Returns undefined if permission filtering was not applied.
 */
export function getAccessibleDocumentIds(req: Request): string[] | undefined {
  if (!hasPermissionFilter(req)) {
    return undefined;
  }
  return (req as PermissionFilteredRequest).accessibleDocumentIds;
}
