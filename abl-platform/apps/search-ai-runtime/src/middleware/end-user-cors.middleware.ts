/**
 * End-User Dynamic CORS Middleware
 *
 * Handles CORS for end-user browser requests (Paths A & C).
 * Reads allowedOrigins from ProjectSettings.publicApiAccess for dynamic per-project CORS.
 *
 * This is an established platform pattern — apps/runtime/src/middleware/sdk-auth.ts
 * already does per-request DB-based origin checks for SDK keys.
 *
 * Runs early (before auth) to handle OPTIONS preflight without authentication.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { ISearchIndex, IProjectSettings } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';

const logger = createLogger('end-user-cors');

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const ProjectSettings = getLazyModel<IProjectSettings>('ProjectSettings');

/**
 * In-memory origin cache to avoid DB lookups on every request.
 * TTL: 5 minutes. Max entries: 500.
 */
interface OriginCacheEntry {
  origins: string[];
  expiresAt: number;
}

const originCache = new Map<string, OriginCacheEntry>();
const ORIGIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ORIGIN_CACHE_MAX_SIZE = 500;

/**
 * Create dynamic CORS middleware for end-user paths.
 *
 * Only activates when:
 * 1. Origin header is present (browser request)
 * 2. Request targets /api/search/auth/* OR has X-Auth-Mode: user
 */
export function createEndUserCorsMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const origin = req.header('Origin');

    // No Origin header → not a browser CORS request, skip
    if (!origin) {
      return next();
    }

    // Determine if this is an end-user path
    const isAuthPath = req.path.startsWith('/auth/');
    const isEndUserMode = req.header('X-Auth-Mode')?.toLowerCase() === 'user';
    const hasNoApiKey = !req.headers.authorization;

    if (!isAuthPath && !(isEndUserMode && hasNoApiKey)) {
      return next();
    }

    // Resolve indexId from path, header, or URL pattern
    // At app.use() level, req.params is empty — extract from URL path manually.
    let indexId = req.params.indexId || req.header('X-Index-Id');
    if (!indexId) {
      // Try to extract indexId from URL: /api/search/:indexId/query or /:indexId/query
      // At this middleware level, req.path is relative to mount point (/api/search)
      const pathMatch = req.path.match(/^\/([a-f0-9-]+)\//i);
      if (pathMatch) {
        indexId = pathMatch[1];
      }
    }
    if (!indexId) {
      // For auth paths without indexId, allow the request through
      // (the auth handler will validate and return proper errors)
      return next();
    }

    try {
      // Check if origin is allowed for this project
      const allowed = await isOriginAllowed(origin, indexId);

      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, X-Auth-Mode, X-End-User-Token, X-Search-Session-Token, X-Index-Id',
        );
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '3600');
        res.setHeader(
          'Access-Control-Expose-Headers',
          'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
        );
      }

      // Handle preflight
      if (req.method === 'OPTIONS') {
        if (allowed) {
          res.status(204).end();
        } else {
          res.status(403).json({
            success: false,
            error: { code: 'CORS_DENIED', message: 'Origin not allowed' },
          });
        }
        return;
      }

      next();
    } catch (error) {
      logger.error('CORS check failed', {
        origin,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      // On error, allow request through (CORS check is best-effort)
      next();
    }
  };
}

/**
 * Check if an origin is allowed for a given index's project.
 */
async function isOriginAllowed(origin: string, indexId: string): Promise<boolean> {
  // Check cache first
  const cacheKey = `${indexId}`;
  const now = Date.now();
  const cached = originCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.origins.includes(origin);
  }

  // Look up index → project → settings
  const index = await SearchIndex.findOne({ _id: indexId }).lean();
  if (!index) {
    return false;
  }

  const settings = await ProjectSettings.findOne({
    tenantId: index.tenantId,
    projectId: index.projectId,
  }).lean();

  const allowedOrigins = settings?.publicApiAccess?.scopes?.['search.query']?.allowedOrigins ?? [];

  // Cache the result
  if (originCache.size >= ORIGIN_CACHE_MAX_SIZE) {
    // Evict oldest entry
    const oldestKey = originCache.keys().next().value;
    if (oldestKey !== undefined) {
      originCache.delete(oldestKey);
    }
  }
  originCache.set(cacheKey, {
    origins: allowedOrigins,
    expiresAt: now + ORIGIN_CACHE_TTL_MS,
  });

  return allowedOrigins.includes(origin);
}
