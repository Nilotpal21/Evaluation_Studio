/**
 * Index Ownership Verification Middleware
 *
 * Verifies that the authenticated tenant owns the index specified in the route.
 * Returns 404 (not 403) if the index doesn't exist or belongs to another tenant,
 * to avoid leaking resource existence.
 *
 * Optimization: Caches verified indexes in an LRU with 2-minute TTL to avoid
 * a MongoDB roundtrip on every search request. Index ownership rarely changes,
 * and the short TTL ensures deletions/transfers propagate quickly.
 */

import type { RequestHandler } from 'express';
import type { ISearchIndex } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

const logger = createLogger('verify-index-ownership');

// ─── Ownership Cache ─────────────────────────────────────────────────────────
// Caches verified index documents per tenant+indexId. Avoids a MongoDB query
// on every search request (agent tool calls hit this ~1-3x per turn).

interface CachedIndex {
  index: Record<string, unknown>;
  cachedAt: number;
}

const OWNERSHIP_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const OWNERSHIP_CACHE_MAX = 1000;

const ownershipCache = new Map<string, CachedIndex>();

type ProjectOwnershipFilter = string | { $in: string[] };

interface OwnershipScope {
  cacheScope: string;
  projectFilter?: ProjectOwnershipFilter;
  denied: boolean;
}

function normalizeProjectScope(projectScope: readonly string[] | undefined): string[] {
  if (!Array.isArray(projectScope)) {
    return [];
  }
  return [...new Set(projectScope.filter((projectId) => projectId.length > 0))].sort();
}

function resolveOwnershipScope(context: {
  projectId?: string;
  projectScope?: string[];
}): OwnershipScope {
  const projectId = context.projectId;
  const projectScope = normalizeProjectScope(context.projectScope);

  if (projectId) {
    if (projectScope.length > 0 && !projectScope.includes(projectId)) {
      return {
        cacheScope: `project:${projectId}:denied`,
        denied: true,
      };
    }

    return {
      cacheScope: `project:${projectId}`,
      projectFilter: projectId,
      denied: false,
    };
  }

  if (projectScope.length > 0) {
    return {
      cacheScope: `scope:${projectScope.join(',')}`,
      projectFilter: { $in: projectScope },
      denied: false,
    };
  }

  return {
    cacheScope: 'tenant',
    denied: false,
  };
}

function getOwnershipCacheKey(tenantId: string, indexId: string, cacheScope: string): string {
  return `${tenantId}:${cacheScope}:${indexId}`;
}

function getCachedOwnership(
  tenantId: string,
  indexId: string,
  cacheScope: string,
): Record<string, unknown> | null {
  const key = getOwnershipCacheKey(tenantId, indexId, cacheScope);
  const entry = ownershipCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > OWNERSHIP_CACHE_TTL_MS) {
    ownershipCache.delete(key);
    return null;
  }
  return entry.index;
}

function setCachedOwnership(
  tenantId: string,
  indexId: string,
  cacheScope: string,
  index: Record<string, unknown>,
): void {
  // Evict oldest if at capacity (Map iterates in insertion order)
  if (ownershipCache.size >= OWNERSHIP_CACHE_MAX) {
    const oldest = ownershipCache.keys().next().value;
    if (oldest !== undefined) ownershipCache.delete(oldest);
  }
  const key = getOwnershipCacheKey(tenantId, indexId, cacheScope);
  // Delete-then-set to keep insertion order fresh
  ownershipCache.delete(key);
  ownershipCache.set(key, { index, cachedAt: Date.now() });
}

/** Invalidate a specific cache entry (call on index delete/update). */
export function invalidateOwnershipCache(tenantId: string, indexId: string): void {
  const prefix = `${tenantId}:`;
  const suffix = `:${indexId}`;
  for (const key of ownershipCache.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      ownershipCache.delete(key);
    }
  }
}

/** Clear all cached entries (for testing). */
export function clearOwnershipCache(): void {
  ownershipCache.clear();
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export const verifyIndexOwnership: RequestHandler = async (req, res, next) => {
  try {
    const { indexId } = req.params;
    if (!indexId) {
      res.status(400).json({ error: 'Missing indexId parameter' });
      return;
    }

    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const ownershipScope = resolveOwnershipScope(req.tenantContext ?? {});
    if (ownershipScope.denied) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Check cache first — avoids MongoDB roundtrip on repeated search calls
    const cached = getCachedOwnership(tenantId, indexId, ownershipScope.cacheScope);
    if (cached) {
      (req as any).verifiedIndex = cached;
      next();
      return;
    }

    const filter: Record<string, unknown> = {
      _id: indexId,
      tenantId,
    };
    if (ownershipScope.projectFilter) {
      filter.projectId = ownershipScope.projectFilter;
    }

    const index = await SearchIndex.findOne(filter).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Cache for subsequent requests
    setCachedOwnership(
      tenantId,
      indexId,
      ownershipScope.cacheScope,
      index as Record<string, unknown>,
    );

    // Stash verified index on request for downstream use
    (req as any).verifiedIndex = index;
    next();
  } catch (error) {
    logger.error('Index ownership verification failed', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
};
