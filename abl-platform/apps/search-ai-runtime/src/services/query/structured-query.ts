/**
 * Structured Query Handler
 *
 * Handles filter-based (non-vector) queries with vocabulary resolution.
 * Queries SearchChunk documents by canonicalMetadata filters.
 */

import type {
  StructuredSearchQuery,
  SearchResponse,
  SearchResult,
  SearchLatency,
  MetadataFilter,
} from '@agent-platform/search-ai-sdk';
import type { ISearchChunk } from '@agent-platform/database/models/search-chunk';
import { getLazyModel } from '../../db/index.js';

const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
import { VocabularyResolver } from '../vocabulary/vocabulary-resolver.js';

// =============================================================================
// STRUCTURED QUERY SERVICE
// =============================================================================

export class StructuredQueryService {
  private readonly vocabularyResolver: VocabularyResolver;

  constructor(vocabularyResolver?: VocabularyResolver) {
    this.vocabularyResolver = vocabularyResolver ?? new VocabularyResolver();
  }

  /**
   * Execute a structured query with optional vocabulary resolution.
   *
   * @param tenantId - Authenticated tenant ID for defense-in-depth filtering
   */
  async execute(
    query: StructuredSearchQuery,
    projectKbId?: string,
    tenantId?: string,
  ): Promise<SearchResponse> {
    const latency: SearchLatency = {
      vocabularyResolveMs: 0,
      vectorSearchMs: 0,
      structuredFilterMs: 0,
      rerankMs: 0,
      totalMs: 0,
    };

    const overallStart = Date.now();

    // Step 1: Vocabulary Resolution (optional — resolve any text-based filter values)
    if (projectKbId) {
      const vocabStart = Date.now();
      try {
        for (const filter of query.filters) {
          if (typeof filter.value === 'string') {
            const vocabResult = await this.vocabularyResolver.resolve(
              projectKbId,
              filter.value,
              'exact',
            );
            if (vocabResult.structuredFilters.length > 0) {
              query.filters.push(...vocabResult.structuredFilters);
            }
          }
        }
      } catch {
        // Vocabulary resolution failure is non-fatal
      }
      latency.vocabularyResolveMs = Date.now() - vocabStart;
    }

    // Step 2: Execute filter search against MongoDB
    const filterStart = Date.now();
    const results = await this.executeFilterSearch(query, tenantId);
    latency.structuredFilterMs = Date.now() - filterStart;

    latency.totalMs = Date.now() - overallStart;

    return {
      queryId: `qry_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      results,
      totalCount: results.length,
      latency,
    };
  }

  // ─── MongoDB Filter Search ──────────────────────────────────────────────

  /**
   * Execute a filter-based search against SearchChunk collection.
   * Translates MetadataFilter[] to MongoDB query on canonicalMetadata.
   */
  private async executeFilterSearch(
    query: StructuredSearchQuery,
    tenantId?: string,
  ): Promise<SearchResult[]> {
    const mongoFilter = this.buildMongoFilter(query.indexId, query.filters, tenantId);
    const limit = query.limit ?? query.topK ?? 10;
    const offset = query.offset ?? 0;

    // Build sort — default to createdAt desc
    const sort: Record<string, 1 | -1> = {};
    if (query.sort && query.sort.length > 0) {
      for (const s of query.sort) {
        sort[`canonicalMetadata.${s.field}`] = s.order === 'asc' ? 1 : -1;
      }
    } else {
      sort.createdAt = -1;
    }

    const chunks = await SearchChunk.find(mongoFilter).sort(sort).skip(offset).limit(limit).lean();

    return chunks.map((chunk: any) => ({
      documentId: chunk.documentId,
      chunkId: chunk._id,
      score: 1.0,
      content: chunk.content,
      metadata: chunk.canonicalMetadata ?? chunk.metadata ?? {},
    }));
  }

  /**
   * Translate MetadataFilter[] to a MongoDB query object.
   */
  private buildMongoFilter(
    indexId: string,
    filters: MetadataFilter[],
    tenantId?: string,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = { indexId, status: 'indexed' };
    if (tenantId) query.tenantId = tenantId;

    for (const filter of filters) {
      const key = `canonicalMetadata.${filter.field}`;
      switch (filter.operator) {
        case 'eq':
          query[key] = filter.value;
          break;
        case 'neq':
          query[key] = { $ne: filter.value };
          break;
        case 'gt':
          query[key] = { $gt: filter.value };
          break;
        case 'gte':
          query[key] = { $gte: filter.value };
          break;
        case 'lt':
          query[key] = { $lt: filter.value };
          break;
        case 'lte':
          query[key] = { $lte: filter.value };
          break;
        case 'in':
          query[key] = { $in: filter.value };
          break;
        case 'not_in':
          query[key] = { $nin: filter.value };
          break;
        case 'contains':
          query[key] = { $regex: String(filter.value), $options: 'i' };
          break;
        case 'not_contains':
          query[key] = { $not: { $regex: String(filter.value), $options: 'i' } };
          break;
        case 'exists':
          query[key] = { $exists: true, $ne: null };
          break;
        case 'not_exists':
          query[key] = { $in: [null, undefined] };
          break;
      }
    }

    return query;
  }
}
