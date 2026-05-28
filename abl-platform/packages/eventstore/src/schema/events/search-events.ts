/**
 * Search event schemas.
 *
 * Events related to search-ai queries and reranking.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── search.query.executed ─────────────────────────────────────────────────

export const SearchQueryExecutedDataSchema = z
  .object({
    query_id: z.string().optional(),
    queryId: z.string().optional(),
    result_count: z.number().optional(),
    resultCount: z.number().optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
    ranking_method: z.enum(['vector', 'bm25', 'hybrid']).optional(),
    rankingMethod: z.enum(['vector', 'bm25', 'hybrid']).optional(),
    reranking_used: z.boolean().optional(),
    rerankingUsed: z.boolean().optional(),
  })
  .passthrough();

eventRegistry.register('search.query.executed', SearchQueryExecutedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SEARCH,
  containsPII: false,
  description: 'Search query executed',
});

// ─── search.reranked ───────────────────────────────────────────────────────

export const SearchRerankedDataSchema = z
  .object({
    candidate_count: z.number().optional(),
    candidateCount: z.number().optional(),
    reranking_model: z.string().optional(),
    rerankingModel: z.string().optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('search.reranked', SearchRerankedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SEARCH,
  containsPII: false,
  description: 'Search results reranked',
});
