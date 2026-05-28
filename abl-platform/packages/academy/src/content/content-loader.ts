/**
 * Learning Academy — Content Loader
 *
 * Filesystem-based content reader with in-memory cache.
 * All reads use fs.promises (no sync I/O).
 * Cache is bounded: MAX_CACHE_ENTRIES with LRU eviction.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Maximum cached entries — covers all modules + courses + config */
const MAX_CACHE_ENTRIES = 120;

/** Cache entry with access timestamp for LRU eviction */
interface CacheEntry<T> {
  value: T;
  lastAccess: number;
}

const jsonCache = new Map<string, CacheEntry<unknown>>(); // MAX_CACHE_ENTRIES, LRU eviction
const textCache = new Map<string, CacheEntry<string>>(); // MAX_CACHE_ENTRIES, LRU eviction
const hashCache = new Map<string, CacheEntry<string>>(); // MAX_CACHE_ENTRIES, LRU eviction

function evictIfNeeded<T>(cache: Map<string, CacheEntry<T>>): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, entry] of cache) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    cache.delete(oldestKey);
  }
}

/**
 * Load and parse a JSON file with caching.
 */
export async function loadJson<T>(filePath: string): Promise<T> {
  const cached = jsonCache.get(filePath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.value as T;
  }

  const raw = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as T;

  evictIfNeeded(jsonCache);
  jsonCache.set(filePath, { value: parsed, lastAccess: Date.now() });

  return parsed;
}

/**
 * Load a text/markdown file with caching.
 */
export async function loadMarkdown(filePath: string): Promise<string> {
  const cached = textCache.get(filePath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.value;
  }

  const content = await readFile(filePath, 'utf-8');

  evictIfNeeded(textCache);
  textCache.set(filePath, { value: content, lastAccess: Date.now() });

  return content;
}

/**
 * Compute SHA-256 hash of a file's contents (for content versioning).
 * Results are cached — same file returns same hash until cache is cleared.
 */
export async function getContentHash(filePath: string): Promise<string> {
  const cached = hashCache.get(filePath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.value;
  }

  const content = await readFile(filePath, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');

  evictIfNeeded(hashCache);
  hashCache.set(filePath, { value: hash, lastAccess: Date.now() });

  return hash;
}

/**
 * Resolve content root path. When contentRoot is provided explicitly,
 * use it. Otherwise resolve relative to this file's location.
 */
export function resolveContentRoot(explicitRoot?: string): string {
  if (explicitRoot) return explicitRoot;

  // Default: packages/academy/content/ — two levels up from src/content/
  return join(import.meta.dirname, '..', '..', 'content');
}

/**
 * Clear all caches (useful for testing).
 */
export function clearContentCaches(): void {
  jsonCache.clear();
  textCache.clear();
  hashCache.clear();
}
