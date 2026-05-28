/**
 * Module Dependency Cache
 *
 * TTL cache for ProjectModuleDependency.find() results. During working-copy
 * session creation, the same dependency query is issued up to 3 times
 * (draft validation, compilation stubs, actual merge). This cache collapses
 * those into a single DB call per 5-second window.
 *
 * Safe for single-event-loop (Node.js) — no concurrent-mutation concern.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('module-dependency-cache');

interface CacheEntry {
  data: unknown[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5000; // 5 seconds — covers a single session creation flow
const MAX_ENTRIES = 100;

/**
 * Load module dependencies for a project, returning cached results if
 * available within the TTL window.
 */
export async function loadModuleDependencies(
  projectId: string,
  tenantId: string,
): Promise<unknown[]> {
  const key = `${tenantId}:${projectId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.debug('Module dependency cache hit', { projectId, tenantId });
    return cached.data;
  }

  const { ProjectModuleDependency } = await import('@agent-platform/database/models');
  const deps = await ProjectModuleDependency.find({ projectId, tenantId }).lean();

  // Evict oldest if cache is full
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of cache.entries()) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      cache.delete(oldestKey);
      log.debug('Module dependency cache evicted oldest entry', { evictedKey: oldestKey });
    }
  }

  cache.set(key, { data: deps, timestamp: Date.now() });
  return deps;
}

/**
 * Clear the entire cache. Primarily for testing.
 */
export function resetModuleDependencyCache(): void {
  cache.clear();
}
