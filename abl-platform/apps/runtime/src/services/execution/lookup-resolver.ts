/**
 * Lookup table resolver.
 *
 * Supports inline (O(1) set lookup), collection (tenant-scoped LookupEntry),
 * and API sources (with circuit breaker and TTL cache).
 * Fuzzy matching via Levenshtein distance for inline tables.
 */
import { createLogger } from '@abl/compiler/platform';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';
import { validateUrlForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('lookup-resolver');

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_API_LOOKUP_TIMEOUT_MS = 5000;

const COLLECTION_CACHE_MAX = 500;
const COLLECTION_CACHE_TTL_MS = 5_000; // 5s

const API_CACHE_MAX = 200;
const API_CACHE_TTL_MS = 5_000; // 5s

const COLLECTION_FUZZY_CANDIDATES_MAX = 500;

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 30_000; // 30 seconds

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LookupResult {
  found: boolean;
  matched_value?: string;
  similarity?: number;
  error?: string;
}

/** Minimal interface for the LookupEntry model used in collection-source lookups. */
export interface LookupEntryModel {
  findOne(query: Record<string, unknown>): { lean(): Promise<{ value: string } | null> };
  find(query: Record<string, unknown>): {
    select(fields: string): { limit(n: number): { lean(): Promise<Array<{ value: string }>> } };
  };
}

export interface LookupContext {
  tenantId: string;
  projectId: string;
  mongooseConnection?: import('mongoose').Connection;
  fetchFn?: typeof fetch;
  /** Injectable LookupEntry model for collection lookups (DI for testability). */
  lookupEntryModel?: LookupEntryModel;
}

// ─── TTL Cache ──────────────────────────────────────────────────────────────

class TTLCache<V> {
  private cache = new Map<string, { value: V; expires: number }>();

  constructor(
    private maxSize: number,
    private ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    // If key exists, delete first so it moves to end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict least-recently-used (first entry) if at max size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}

const collectionCache = new TTLCache<LookupResult>(COLLECTION_CACHE_MAX, COLLECTION_CACHE_TTL_MS);
const apiCache = new TTLCache<LookupResult>(API_CACHE_MAX, API_CACHE_TTL_MS);

// ─── Circuit Breaker ────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuitBreakers = new Map<string, CircuitState>();

function isCircuitOpen(endpoint: string): boolean {
  const state = circuitBreakers.get(endpoint);
  if (!state) return false;
  if (state.failures < CIRCUIT_BREAKER_THRESHOLD) return false;
  // Circuit has been opened — check if reset period has elapsed
  if (state.openUntil > 0 && Date.now() > state.openUntil) {
    circuitBreakers.delete(endpoint);
    return false;
  }
  return true;
}

function recordFailure(endpoint: string): void {
  const state = circuitBreakers.get(endpoint) ?? { failures: 0, openUntil: 0 };
  state.failures++;
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
  }
  circuitBreakers.set(endpoint, state);
}

function recordSuccess(endpoint: string): void {
  circuitBreakers.delete(endpoint);
}

// ─── O(1) Inline Set Cache ─────────────────────────────────────────────────

/**
 * WeakMap-based cache that lazily builds a Set from a LookupTableIR's values.
 * Uses WeakMap so Sets are GC'd when the table IR is no longer referenced.
 */
const inlineSetCache = new WeakMap<LookupTableIR, Set<string>>();
const inlineNormalizedSetCache = new WeakMap<LookupTableIR, Set<string>>();

function getInlineSet(table: LookupTableIR): Set<string> {
  let set = inlineSetCache.get(table);
  if (!set) {
    set = new Set(table.values ?? []);
    inlineSetCache.set(table, set);
  }
  return set;
}

function getInlineNormalizedSet(table: LookupTableIR): Set<string> {
  let set = inlineNormalizedSetCache.get(table);
  if (!set) {
    if (table.normalized_values) {
      // Pre-lowercased at compile time
      set = new Set(table.normalized_values);
    } else {
      // Fallback: lowercase values at runtime
      set = new Set((table.values ?? []).map((v) => v.toLowerCase()));
    }
    inlineNormalizedSetCache.set(table, set);
  }
  return set;
}

// ─── String Utilities ───────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

export function fuzzyMatch(
  value: string,
  candidates: string[],
  threshold: number,
): { value: string; similarity: number } | null {
  if (candidates.length === 0) return null;

  const normalized = value.toLowerCase();
  let bestMatch: string | null = null;
  let bestSimilarity = 0;

  for (const candidate of candidates) {
    const candidateNorm = candidate.toLowerCase();
    const maxLen = Math.max(normalized.length, candidateNorm.length);
    if (maxLen === 0) continue;

    // Early termination: exact match after normalization gives similarity=1.0
    if (normalized === candidateNorm) {
      return { value: candidate, similarity: 1.0 };
    }

    const distance = levenshteinDistance(normalized, candidateNorm);
    const similarity = 1 - distance / maxLen;

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (bestMatch && bestSimilarity >= threshold) {
    return { value: bestMatch, similarity: bestSimilarity };
  }

  return null;
}

// ─── Inline Lookup (O(1) Set-based) ────────────────────────────────────────

export function resolveInlineLookup(value: string, table: LookupTableIR): LookupResult {
  const values = table.values;
  if (!values || values.length === 0) {
    return { found: false };
  }

  if (table.case_sensitive) {
    // Use raw values Set for case-sensitive matching
    const set = getInlineSet(table);
    if (set.has(value)) {
      return { found: true, matched_value: value };
    }
  } else {
    // Use normalized_values Set for case-insensitive O(1) lookup
    const normalizedSet = getInlineNormalizedSet(table);
    const normalizedInput = value.toLowerCase();

    if (normalizedSet.has(normalizedInput)) {
      // Find the original-case value to return as matched_value
      // If normalized_values were used (pre-lowercased), we need the original
      const originalMatch = values.find((v) => v.toLowerCase() === normalizedInput);
      return { found: true, matched_value: originalMatch ?? value };
    }
  }

  // Fuzzy fallback
  if (table.fuzzy_match) {
    const result = fuzzyMatch(value, values, table.fuzzy_threshold);
    if (result) {
      return { found: true, matched_value: result.value, similarity: result.similarity };
    }
  }

  return { found: false };
}

// ─── Main Resolver ──────────────────────────────────────────────────────────

export async function resolveLookup(
  value: string,
  table: LookupTableIR,
  context: LookupContext,
): Promise<LookupResult> {
  switch (table.source) {
    case 'inline':
      return resolveInlineLookup(value, table);

    case 'collection': {
      if (!table.table_name) {
        return {
          found: false,
          error: `Collection lookup requires table_name (table: ${table.name})`,
        };
      }
      if (!context.tenantId || !context.projectId) {
        return {
          found: false,
          error: `Collection lookup requires tenant and project context (table: ${table.name})`,
        };
      }

      try {
        // Check cache first
        const cacheKey = `${context.tenantId}:${context.projectId}:${table.table_name}:${value.toLowerCase()}`;
        const cached = collectionCache.get(cacheKey);
        if (cached !== undefined) return cached;

        // Use injected model or dynamically import the default LookupEntry
        const LookupEntry =
          context.lookupEntryModel ?? (await import('@agent-platform/database')).LookupEntry;
        const query: Record<string, unknown> = {
          tenantId: context.tenantId,
          projectId: context.projectId,
          tableName: table.table_name,
        };

        if (table.case_sensitive) {
          query.value = value;
        } else {
          query.value = new RegExp(`^${escapeRegex(value)}$`, 'i');
        }

        const doc = await LookupEntry.findOne(query).lean();
        if (doc) {
          const result: LookupResult = {
            found: true,
            matched_value: (doc as { value: string }).value,
          };
          collectionCache.set(cacheKey, result);
          return result;
        }

        // Fuzzy fallback for collection source
        if (table.fuzzy_match) {
          const candidates = await LookupEntry.find({
            tenantId: context.tenantId,
            projectId: context.projectId,
            tableName: table.table_name,
          })
            .select('value')
            .limit(COLLECTION_FUZZY_CANDIDATES_MAX)
            .lean();
          const candidateValues = candidates.map((c: { value: string }) => c.value);
          const match = fuzzyMatch(value, candidateValues, table.fuzzy_threshold);
          if (match) {
            const result: LookupResult = {
              found: true,
              matched_value: match.value,
              similarity: match.similarity,
            };
            collectionCache.set(cacheKey, result);
            return result;
          }
        }

        const result: LookupResult = { found: false };
        collectionCache.set(cacheKey, result);
        return result;
      } catch (err) {
        log.warn('Collection lookup failed', {
          table: table.name,
          tableName: table.table_name,
          error: err instanceof Error ? err.message : String(err),
        });
        return { found: false, error: 'Collection lookup failed' };
      }
    }

    case 'api': {
      if (!table.endpoint) {
        return { found: false, error: `API lookup requires endpoint (table: ${table.name})` };
      }

      // Check circuit breaker
      if (isCircuitOpen(table.endpoint)) {
        return { found: false, error: `API circuit breaker open for ${table.endpoint}` };
      }

      // Check cache
      const apiCacheKey = `${table.endpoint}:${value}`;
      const cached = apiCache.get(apiCacheKey);
      if (cached !== undefined) return cached;

      try {
        const ssrfResult = validateUrlForSSRF(table.endpoint, getDevSSRFOptions());
        if (!ssrfResult.safe) {
          return { found: false, error: `API lookup blocked: ${ssrfResult.reason}` };
        }

        const fetchFn = context.fetchFn ?? fetch;
        const url = new URL(table.endpoint);
        url.searchParams.set('value', value);
        if (table.field) url.searchParams.set('field', table.field);

        const timeoutMs = table.timeout_ms ?? DEFAULT_API_LOOKUP_TIMEOUT_MS;
        const requestHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(table.headers ?? {}),
        };
        const res = await fetchFn(url.toString(), {
          method: 'GET',
          headers: requestHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          recordFailure(table.endpoint);
          return { found: false, error: `API HTTP ${res.status}` };
        }

        const data = (await res.json()) as { found: boolean; matched_value?: string };
        const result: LookupResult = { found: data.found, matched_value: data.matched_value };

        recordSuccess(table.endpoint);
        apiCache.set(apiCacheKey, result);
        return result;
      } catch (err) {
        recordFailure(table.endpoint);
        log.warn('API lookup failed', {
          table: table.name,
          endpoint: table.endpoint,
          error: err instanceof Error ? err.message : String(err),
        });
        return { found: false, error: 'API lookup failed' };
      }
    }

    default:
      return { found: false, error: `Unknown lookup source: ${(table as LookupTableIR).source}` };
  }
}

// ─── Batch Resolution ───────────────────────────────────────────────────────

export async function resolveLookupBatch(
  entries: Array<{ field: string; value: string; table: LookupTableIR }>,
  context: LookupContext,
): Promise<Map<string, LookupResult>> {
  const results = await Promise.all(
    entries.map(
      async ({ field, value, table }) =>
        [field, await resolveLookup(value, table, context)] as const,
    ),
  );
  return new Map(results);
}

// ─── Cache Management (exported for testing) ────────────────────────────────

export function clearCaches(): void {
  collectionCache.clear();
  apiCache.clear();
  circuitBreakers.clear();
}
