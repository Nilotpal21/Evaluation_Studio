/**
 * Aggregation Query Handler
 *
 * Handles aggregation queries via MongoDB aggregation pipeline on SearchChunk.
 * Steps: vocabulary resolve -> construct aggregation -> execute -> validate
 */

import type {
  AggregationQuery,
  AggregationResponse,
  AggregationResult,
  SearchLatency,
  MetadataFilter,
} from '@agent-platform/search-ai-sdk';
import type { ISearchChunk } from '@agent-platform/database/models/search-chunk';
import { getLazyModel } from '../../db/index.js';

const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
import { VocabularyResolver } from '../vocabulary/vocabulary-resolver.js';

// =============================================================================
// AGGREGATION QUERY SERVICE
// =============================================================================

export class AggregationQueryService {
  private readonly vocabularyResolver: VocabularyResolver;

  constructor(vocabularyResolver?: VocabularyResolver) {
    this.vocabularyResolver = vocabularyResolver ?? new VocabularyResolver();
  }

  /**
   * Execute an aggregation query with optional vocabulary resolution.
   *
   * @param tenantId - Authenticated tenant ID for defense-in-depth filtering
   */
  async execute(
    query: AggregationQuery,
    projectKbId?: string,
    tenantId?: string,
  ): Promise<AggregationResponse> {
    const latency: SearchLatency = {
      vocabularyResolveMs: 0,
      vectorSearchMs: 0,
      structuredFilterMs: 0,
      rerankMs: 0,
      totalMs: 0,
    };

    const overallStart = Date.now();

    // Step 1: Vocabulary Resolution (optional — resolve measure/groupBy field names)
    if (projectKbId) {
      const vocabStart = Date.now();
      try {
        const measureResult = await this.vocabularyResolver.resolve(
          projectKbId,
          query.aggregation.measure,
          'exact',
        );
        if (measureResult.aggregationSpec) {
          query.aggregation = {
            ...query.aggregation,
            ...measureResult.aggregationSpec,
          };
        }
        if (measureResult.structuredFilters.length > 0) {
          query.filters = [...(query.filters ?? []), ...measureResult.structuredFilters];
        }
      } catch {
        // Vocabulary resolution failure is non-fatal
      }
      latency.vocabularyResolveMs = Date.now() - vocabStart;
    }

    // Step 2: Execute aggregation via MongoDB pipeline
    const aggStart = Date.now();
    const results = await this.executeAggregation(query, tenantId);
    latency.structuredFilterMs = Date.now() - aggStart;

    // Step 3: Validate results
    this.validateResults(results);

    latency.totalMs = Date.now() - overallStart;

    return {
      queryId: `qry_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      results,
      totalCount: results.length,
      latency,
    };
  }

  // ─── MongoDB Aggregation Pipeline ─────────────────────────────────────────

  /**
   * Execute an aggregation against SearchChunk via MongoDB $group.
   */
  private async executeAggregation(
    query: AggregationQuery,
    tenantId?: string,
  ): Promise<AggregationResult[]> {
    const pipeline: Record<string, unknown>[] = [];

    // $match stage — tenant-scoped for defense-in-depth
    const matchStage: Record<string, unknown> = {
      indexId: query.indexId,
      status: 'indexed',
    };
    if (tenantId) matchStage.tenantId = tenantId;
    if (query.filters) {
      for (const filter of query.filters) {
        const key = `canonicalMetadata.${filter.field}`;
        matchStage[key] = this.filterToMongo(filter);
      }
    }
    pipeline.push({ $match: matchStage });

    // $group stage
    const groupBy = query.aggregation.groupBy;
    const groupId = groupBy
      ? Object.fromEntries(groupBy.map((f) => [f, `$canonicalMetadata.${f}`]))
      : null;

    const measurePath = `$canonicalMetadata.${query.aggregation.measure}`;
    const groupStage: Record<string, unknown> = {
      _id: groupId,
      count: { $sum: 1 },
    };

    switch (query.aggregation.function) {
      case 'sum':
        groupStage.value = { $sum: measurePath };
        break;
      case 'avg':
        groupStage.value = { $avg: measurePath };
        break;
      case 'count':
        groupStage.value = { $sum: 1 };
        break;
      case 'min':
        groupStage.value = { $min: measurePath };
        break;
      case 'max':
        groupStage.value = { $max: measurePath };
        break;
      case 'count_distinct':
        groupStage.distinctValues = { $addToSet: measurePath };
        break;
    }
    pipeline.push({ $group: groupStage });

    // For count_distinct, project the count of the set
    if (query.aggregation.function === 'count_distinct') {
      pipeline.push({
        $project: {
          _id: 1,
          count: 1,
          value: { $size: '$distinctValues' },
        },
      });
    }

    // $sort stage (optional)
    if (query.aggregation.orderBy) {
      pipeline.push({
        $sort: { value: query.aggregation.orderBy === 'asc' ? 1 : -1 },
      });
    }

    // $limit stage (optional)
    if (query.aggregation.limit) {
      pipeline.push({ $limit: query.aggregation.limit });
    }

    const rawResults = await SearchChunk.aggregate(pipeline as any[]);

    return rawResults.map((r: any) => ({
      groupKey: r._id ?? undefined,
      value: r.value ?? 0,
      count: r.count ?? 0,
    }));
  }

  /**
   * Translate a single MetadataFilter to a MongoDB filter value.
   */
  private filterToMongo(filter: MetadataFilter): unknown {
    switch (filter.operator) {
      case 'eq':
        return filter.value;
      case 'neq':
        return { $ne: filter.value };
      case 'gt':
        return { $gt: filter.value };
      case 'gte':
        return { $gte: filter.value };
      case 'lt':
        return { $lt: filter.value };
      case 'lte':
        return { $lte: filter.value };
      case 'in':
        return { $in: filter.value };
      case 'not_in':
        return { $nin: filter.value };
      case 'contains':
        return { $regex: String(filter.value), $options: 'i' };
      case 'not_contains':
        return { $not: { $regex: String(filter.value), $options: 'i' } };
      case 'exists':
        return { $exists: true, $ne: null };
      case 'not_exists':
        return { $in: [null, undefined] };
      default:
        return filter.value;
    }
  }

  /**
   * Validate aggregation results (e.g., check for NaN, negative counts).
   */
  private validateResults(results: AggregationResult[]): void {
    for (const result of results) {
      if (typeof result.value !== 'number' || isNaN(result.value)) {
        result.value = 0;
      }
      if (typeof result.count !== 'number' || result.count < 0) {
        result.count = 0;
      }
    }
  }
}
