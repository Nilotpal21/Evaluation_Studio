import { createHash } from 'node:crypto';

/**
 * TTL-aware cache entry for config hashes.
 */
interface CacheEntry {
  hash: string;
  expiresAt: number;
}

const MAX_CACHE_SIZE = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

const hashCache = new Map<string, CacheEntry>();

/**
 * Sort object keys recursively for deterministic JSON serialization.
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Build a deterministic cache key from the inputs.
 */
function buildCacheKey(
  agentDSL: Record<string, unknown>,
  tenantConfig?: Record<string, unknown>,
): string {
  const parts = [JSON.stringify(sortKeys(agentDSL))];
  if (tenantConfig) {
    parts.push(JSON.stringify(sortKeys(tenantConfig)));
  }
  return parts.join('|');
}

/**
 * Evict expired entries from the cache, then evict oldest if still over capacity.
 */
function evictIfNeeded(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [key, entry] of hashCache) {
    if (entry.expiresAt <= now) {
      hashCache.delete(key);
    }
  }

  // If still over capacity, remove the oldest entries (first inserted)
  if (hashCache.size >= MAX_CACHE_SIZE) {
    const keysToRemove = hashCache.size - MAX_CACHE_SIZE + 1;
    const iter = hashCache.keys();
    for (let i = 0; i < keysToRemove; i++) {
      const next = iter.next();
      if (!next.done) {
        hashCache.delete(next.value);
      }
    }
  }
}

/**
 * Compute a SHA-256 hash of the structural configuration.
 *
 * Hashes only the agent DSL structure and optional tenant config —
 * never conversation content. The result is cached per deploy key
 * with a TTL to avoid redundant computation.
 *
 * @param agentDSL - The agent definition / DSL object (structural config only)
 * @param tenantConfig - Optional tenant-level configuration overrides
 * @returns Hex-encoded SHA-256 hash string
 */
export function computeConfigHash(
  agentDSL: Record<string, unknown>,
  tenantConfig?: Record<string, unknown>,
): string {
  const cacheKey = buildCacheKey(agentDSL, tenantConfig);
  const now = Date.now();

  // Check cache
  const cached = hashCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.hash;
  }

  // Compute hash from sorted, deterministic JSON
  const sorted = sortKeys(agentDSL);
  let payload = JSON.stringify(sorted);
  if (tenantConfig) {
    payload += JSON.stringify(sortKeys(tenantConfig));
  }

  const hash = createHash('sha256').update(payload).digest('hex');

  // Store in cache
  evictIfNeeded();
  hashCache.set(cacheKey, { hash, expiresAt: now + DEFAULT_TTL_MS });

  return hash;
}

/**
 * Clear the config hash cache. Useful for testing.
 */
export function clearConfigHashCache(): void {
  hashCache.clear();
}
