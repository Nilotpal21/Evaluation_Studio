/**
 * Vocabulary Resolver Service
 *
 * Loads domain vocabulary from MongoDB and resolves business terms in a query
 * to structured filters, field references, and aggregation specs.
 *
 * Caching:
 * - LRU cache with max 500 entries, 5-minute TTL
 * - Cache key: `${tenantId}:${projectKbId}`
 * - Redis pub/sub for distributed cache invalidation across pods
 *
 * Pattern: Follows CanonicalMapperService (apps/search-ai/src/services/canonical-mapping/)
 */

import type {
  VocabularyResolutionResult,
  ResolvedVocabularyTerm,
  VocabularyEntry,
  MetadataFilter,
  AggregationSpec,
} from '@agent-platform/search-ai-sdk';
import type { IDomainVocabulary } from '@agent-platform/database/models/domain-vocabulary';
import { getLazyModel } from '../../db/index.js';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  createSubscriber,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';

const logger = createLogger('vocabulary-resolver');

const VOCABULARY_INVALIDATE_CHANNEL = 'vocabulary:invalidate';

// ─── Cache Observability Metrics ─────────────────────────────────────────────

export const vocabularyCacheMetrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : (this.hits / total) * 100;
  },
};

// =============================================================================
// VOCABULARY RESOLVER
// =============================================================================

export class VocabularyResolver {
  private cache: LRUCache<string, VocabularyEntry[]>;
  private subscriber: RedisClient | null = null;
  private handle: RedisConnectionHandle | null = null;

  constructor() {
    this.cache = new LRUCache<string, VocabularyEntry[]>({
      max: 500,
      ttl: 1000 * 60 * 5, // 5 minutes
      updateAgeOnGet: true,
    });

    this.initRedis();

    logger.info('VocabularyResolver initialized', {
      maxCacheSize: 500,
      ttlMs: 1000 * 60 * 5,
    });
  }

  /**
   * Resolve vocabulary terms in a query string.
   *
   * @param projectKbId - The project knowledge base ID to load vocabulary for
   * @param query - The natural language query to resolve
   * @param tenantId - Tenant ID for isolation (required)
   * @param mode - Match mode: 'exact' only matches primary terms, 'alias' includes aliases,
   *               'fuzzy' also includes approximate matches
   * @returns Vocabulary resolution result with resolved terms, unresolved segments, and filters
   */
  async resolve(
    projectKbId: string,
    query: string,
    tenantId: string,
    mode: 'exact' | 'alias' | 'fuzzy' = 'alias',
  ): Promise<VocabularyResolutionResult> {
    // Load vocabulary entries from the database (cached)
    const entries = await this.loadVocabulary(projectKbId, tenantId);

    if (entries.length === 0) {
      return {
        originalQuery: query,
        resolvedTerms: [],
        unresolvedSegments: query.split(/\s+/).filter((s) => s.length > 0),
        structuredFilters: [],
      };
    }

    const resolvedTerms: ResolvedVocabularyTerm[] = [];
    const structuredFilters: MetadataFilter[] = [];
    let aggregationSpec: Partial<AggregationSpec> | undefined;

    // Scan query for term matches (match against original, don't modify it)
    const queryLower = query.toLowerCase();
    for (const entry of entries) {
      if (!entry.enabled) continue;

      const match = this.findMatch(queryLower, entry, mode);
      if (!match) continue;

      resolvedTerms.push(match.resolved);

      // Extract filters and aggregation from entry capabilities
      const extracted = this.extractFromEntry(entry, query, match.matchedText);
      structuredFilters.push(...extracted.filters);
      if (extracted.aggregation) {
        aggregationSpec = { ...aggregationSpec, ...extracted.aggregation };
      }
    }

    // Extract unresolved segments (for debugging/observability)
    // These are terms that didn't match any vocabulary entry
    const unresolvedSegments = this.extractUnresolvedSegments(query, resolvedTerms);

    return {
      originalQuery: query,
      resolvedTerms,
      unresolvedSegments,
      structuredFilters,
      ...(aggregationSpec ? { aggregationSpec } : {}),
    };
  }

  /**
   * Invalidate cached vocabulary for a specific project KB.
   * Also broadcasts to other pods via Redis pub/sub.
   */
  async invalidateCache(projectKbId: string, tenantId: string): Promise<void> {
    const cacheKey = `${tenantId}:${projectKbId}`;
    this.cache.delete(cacheKey);

    // Broadcast to other pods
    if (this.handle) {
      try {
        await this.handle.client.publish(
          VOCABULARY_INVALIDATE_CHANNEL,
          JSON.stringify({ projectKbId, tenantId }),
        );
        logger.info('Vocabulary cache invalidation broadcast', { projectKbId, tenantId });
      } catch (error) {
        logger.error('Failed to publish vocabulary cache invalidation', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Clear all cached vocabulary entries.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache metrics for monitoring.
   */
  getCacheMetrics(): {
    hits: number;
    misses: number;
    evictions: number;
    hitRate: number;
    size: number;
  } {
    return {
      ...vocabularyCacheMetrics,
      hitRate: vocabularyCacheMetrics.getHitRate(),
      size: this.cache.size,
    };
  }

  /**
   * Cleanup Redis connections on shutdown.
   */
  async cleanup(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(VOCABULARY_INVALIDATE_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    if (this.handle) {
      await this.handle.disconnect();
      this.handle = null;
    }
    logger.info('VocabularyResolver cleanup complete');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Initialize Redis pub/sub for distributed cache invalidation.
   */
  private initRedis(): void {
    try {
      const opts = resolveRedisOptionsFromEnv() ?? {};
      this.handle = createRedisConnection(opts);
      this.subscriber = createSubscriber(this.handle);

      this.subscriber.on('error', (err: Error) => {
        logger.warn('Vocabulary subscriber Redis error (non-fatal)', { error: err.message });
      });
      this.subscriber.subscribe(VOCABULARY_INVALIDATE_CHANNEL, (err: Error | null | undefined) => {
        if (err) {
          logger.error('Failed to subscribe to vocabulary invalidation channel', {
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          logger.info('Subscribed to vocabulary invalidation channel');
        }
      });

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === VOCABULARY_INVALIDATE_CHANNEL) {
          try {
            const { projectKbId, tenantId } = JSON.parse(message);
            const cacheKey = `${tenantId}:${projectKbId}`;
            this.cache.delete(cacheKey);
            logger.info('Cache invalidated via Redis pub/sub', { projectKbId, tenantId });
          } catch (error) {
            logger.error('Failed to parse invalidation message', {
              message,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });

      logger.info('Redis pub/sub initialized for distributed vocabulary cache invalidation');
    } catch (error) {
      logger.error('Failed to initialize Redis pub/sub for vocabulary', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without Redis pub/sub — local cache still works
    }
  }

  /**
   * Extract query segments that weren't matched by vocabulary.
   * Used for debugging and observability (doesn't affect query processing).
   * Always returns individual words as separate elements.
   */
  private extractUnresolvedSegments(
    query: string,
    resolvedTerms: ResolvedVocabularyTerm[],
  ): string[] {
    if (resolvedTerms.length === 0) {
      // No matches - return all words
      return query
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0);
    }

    // Remove matched terms to see what's left
    let remaining = query.toLowerCase();
    for (const term of resolvedTerms) {
      const pattern = new RegExp(
        term.inputTerm.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      );
      remaining = remaining.replace(pattern, ' ');
    }

    // Return remaining words as individual segments
    return remaining
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
  }

  /**
   * Load vocabulary entries from the DomainVocabulary model (with LRU caching).
   */
  private async loadVocabulary(projectKbId: string, tenantId: string): Promise<VocabularyEntry[]> {
    const cacheKey = `${tenantId}:${projectKbId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      vocabularyCacheMetrics.hits++;
      return cached;
    }

    // Cache miss — load from database
    vocabularyCacheMetrics.misses++;

    try {
      const doc = await DomainVocabulary.findOne({
        projectKnowledgeBaseId: projectKbId,
        tenantId,
        status: 'active',
      })
        .sort({ version: -1 })
        .lean();

      if (!doc || !doc.entries) {
        // Cache empty result to avoid repeated DB queries
        const empty: VocabularyEntry[] = [];
        this.cache.set(cacheKey, empty);
        return empty;
      }

      const entries: VocabularyEntry[] = doc.entries.map((e: any) => ({
        term: e.term,
        aliases: e.aliases ?? [],
        description: e.description,
        fieldRef: e.fieldRef,
        capabilities: e.capabilities ?? {
          canFilter: false,
          canDisplay: false,
          canAggregate: false,
          canSort: false,
        },
        relatedFields: e.relatedFields ?? { displayWith: [], aggregateWith: [] },
        enabled: e.enabled ?? true,
      }));

      this.cache.set(cacheKey, entries);
      return entries;
    } catch (error) {
      logger.error('Failed to load vocabulary from database', {
        projectKbId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Database unavailable — return empty
      return [];
    }
  }

  /**
   * Attempt to match a query segment against a vocabulary entry.
   */
  private findMatch(
    query: string,
    entry: any,
    mode: 'exact' | 'alias' | 'fuzzy',
  ): { resolved: ResolvedVocabularyTerm; matchedText: string } | null {
    const queryLower = query.toLowerCase();

    const buildResolved = (
      inputTerm: string,
      matchType: 'exact' | 'alias' | 'fuzzy',
      confidence: number,
    ): ResolvedVocabularyTerm => ({
      inputTerm,
      matchedTerm: entry.term,
      matchType,
      confidence,
      fieldRef: entry.fieldRef,
      capabilities: entry.capabilities || {
        canFilter: false,
        canDisplay: false,
        canAggregate: false,
        canSort: false,
      },
    });

    // Exact match on primary term
    const termLower = entry.term.toLowerCase();
    if (queryLower.includes(termLower)) {
      return {
        resolved: buildResolved(entry.term, 'exact', 1.0),
        matchedText: entry.term,
      };
    }

    // Alias match
    if (mode === 'alias' || mode === 'fuzzy') {
      for (const alias of entry.aliases) {
        const aliasLower = alias.toLowerCase();
        if (queryLower.includes(aliasLower)) {
          return {
            resolved: buildResolved(alias, 'alias', 0.9),
            matchedText: alias,
          };
        }
      }
    }

    // Fuzzy match (simple substring containment for now)
    if (mode === 'fuzzy') {
      const termWords = termLower.split(/\s+/);
      for (const word of termWords) {
        if (word.length >= 4 && queryLower.includes(word)) {
          return {
            resolved: buildResolved(word, 'fuzzy', 0.6),
            matchedText: word,
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract structured filters and aggregation from a vocabulary entry's capabilities.
   *
   * Two patterns for filter-capable entries:
   * 1. Value-type entries (term ≠ fieldRef, e.g., "devops tools" → category):
   *    The term itself IS the filter value → filter: category = "devops tools"
   * 2. Field-name entries (term ≈ fieldRef, e.g., "author" → author):
   *    The term is just the field name — extract the actual value from query context.
   *    "author ramgopal" → filter: author = "ramgopal"
   *    "list authors" → no filter (no concrete value found)
   */
  private extractFromEntry(
    entry: any,
    query: string,
    matchedText: string,
  ): {
    filters: MetadataFilter[];
    aggregation?: Partial<AggregationSpec>;
  } {
    const capabilities = entry.capabilities || {};
    const fieldRef = entry.fieldRef;

    if (!fieldRef) {
      return { filters: [] };
    }

    if (capabilities.canFilter) {
      if (this.isFieldNameEntry(entry.term, fieldRef)) {
        // Field-name entry: extract actual value from query context
        const value = this.extractFilterValue(query, matchedText);
        if (value) {
          return {
            filters: [{ field: fieldRef, operator: 'eq' as any, value }],
          };
        }
        // No concrete value found — don't generate a bogus filter
        return { filters: [] };
      }

      // Value-type entry: the term itself IS the filter value
      return {
        filters: [{ field: fieldRef, operator: 'eq' as any, value: entry.term }],
      };
    }

    // If entry can aggregate, create an aggregation spec
    if (capabilities.canAggregate) {
      return {
        filters: [],
        aggregation: {
          measure: fieldRef,
          function: 'count',
        },
      };
    }

    return { filters: [] };
  }

  /**
   * Detect whether a vocabulary entry is a "field-name" entry (term describes
   * the field itself) vs a "value" entry (term describes a filterable value).
   *
   * Field-name entries: "author" → author, "source type" → source_type
   * Value entries: "devops tools" → category, "premium" → tier
   */
  private isFieldNameEntry(term: string, fieldRef: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
    return normalize(term) === normalize(fieldRef);
  }

  /**
   * Extract a concrete filter value from the query by removing the matched
   * term/alias and stop words, then returning the remaining meaningful words.
   *
   * Examples:
   *   "author ramgopal" → "ramgopal"
   *   "documents by author ramgopal" → "ramgopal"
   *   "list all authors" → null (no concrete value)
   */
  private extractFilterValue(query: string, matchedText: string): string | null {
    const pattern = new RegExp(matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const remaining = query.replace(pattern, ' ');

    const stopWords = new Set([
      'show',
      'me',
      'find',
      'get',
      'list',
      'all',
      'the',
      'a',
      'an',
      'by',
      'with',
      'for',
      'of',
      'in',
      'on',
      'from',
      'to',
      'is',
      'are',
      'what',
      'which',
      'who',
      'how',
      'many',
      'documents',
      'docs',
      'files',
      'search',
      'query',
      'filter',
      'where',
      'and',
      'or',
      'not',
      'please',
      'can',
      'you',
      'i',
      'my',
      'do',
      'does',
      'has',
      'have',
      'been',
    ]);

    const words = remaining
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !stopWords.has(w.toLowerCase()));

    // No meaningful words or too many to be a single value
    if (words.length === 0 || words.length > 3) {
      return null;
    }

    return words.join(' ');
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let vocabularyResolverInstance: VocabularyResolver | null = null;

export function getVocabularyResolver(): VocabularyResolver {
  if (!vocabularyResolverInstance) {
    vocabularyResolverInstance = new VocabularyResolver();
  }
  return vocabularyResolverInstance;
}
