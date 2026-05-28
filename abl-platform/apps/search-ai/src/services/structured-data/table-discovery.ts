/**
 * Table Discovery Service
 *
 * Discovers relevant tables for a query using semantic search over table metadata.
 * Returns ranked list of tables to pass to text-to-SQL or semantic query execution.
 *
 * Flow:
 * 1. User query → Semantic search over table_metadata chunks
 * 2. Get top N table matches from SearchChunk results
 * 3. Fetch full TableMetadata from ClickHouse
 * 4. Return ranked tables with relevance scores
 */

import type { ISearchChunk } from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('table-discovery');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
import { StructuredDataClickHouseClient } from './clickhouse-client.js';
import type { TableMetadata } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface TableDiscoveryRequest {
  query: string;
  tenantId: string;
  indexId: string;
  maxTables?: number; // Max tables to return (default: 5)
  minRelevanceScore?: number; // Min score threshold (default: 0.3)
}

export interface DiscoveredTable {
  metadata: TableMetadata;
  relevanceScore: number;
  matchReason: string; // Why this table was selected
}

export interface TableDiscoveryResult {
  tables: DiscoveredTable[];
  totalAvailable: number; // Total tables in index
  queryAnalysis: {
    keywords: string[];
    intent: 'single_table' | 'multi_table' | 'ambiguous';
  };
}

// =============================================================================
// TABLE DISCOVERY SERVICE
// =============================================================================

export class TableDiscoveryService {
  private chClient: StructuredDataClickHouseClient;

  constructor(chClient?: StructuredDataClickHouseClient) {
    this.chClient = chClient || new StructuredDataClickHouseClient();
  }

  /**
   * Discover relevant tables for a query
   */
  async discoverTables(request: TableDiscoveryRequest): Promise<TableDiscoveryResult> {
    const maxTables = request.maxTables || 5;
    const minScore = request.minRelevanceScore || 0.3;

    logger.info('Discovering tables for query', {
      query: request.query,
      indexId: request.indexId,
      maxTables,
    });

    // Step 1: Get all available tables from ClickHouse
    const allTables = await this.chClient.getTableMetadata(request.tenantId, request.indexId);

    if (allTables.length === 0) {
      logger.info('No tables found in index', { indexId: request.indexId });
      return {
        tables: [],
        totalAvailable: 0,
        queryAnalysis: {
          keywords: this.extractKeywords(request.query),
          intent: 'ambiguous',
        },
      };
    }

    logger.info('Found tables in index', { count: allTables.length });

    // Step 2: Find table metadata SearchChunks (these are embedded)
    const metadataChunks = await SearchChunk.find({
      tenantId: request.tenantId,
      indexId: request.indexId,
      chunkType: 'table_metadata',
    })
      .select('_id metadata')
      .lean();

    logger.info('Found table metadata chunks', { count: metadataChunks.length });

    // Step 3: Score tables based on query
    // For now, use simple keyword matching until semantic search is integrated
    // TODO: Use vector search with embeddings (requires embedding service integration)
    const keywords = this.extractKeywords(request.query);
    const scoredTables = this.scoreTablesKeywordMatch(allTables, keywords, minScore);

    // Step 4: Sort by relevance and take top N
    scoredTables.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const topTables = scoredTables.slice(0, maxTables);

    // Step 5: Analyze query intent
    const intent = this.analyzeQueryIntent(request.query, topTables.length);

    logger.info('Discovered tables', {
      matched: topTables.length,
      intent,
      topTable: topTables[0]?.metadata.table_name,
    });

    return {
      tables: topTables,
      totalAvailable: allTables.length,
      queryAnalysis: {
        keywords,
        intent,
      },
    };
  }

  /**
   * Get all tables in an index (for listing/admin purposes)
   */
  async listTables(tenantId: string, indexId: string): Promise<TableMetadata[]> {
    return this.chClient.getTableMetadata(tenantId, indexId);
  }

  /**
   * Get a specific table by name
   */
  async getTableByName(
    tenantId: string,
    indexId: string,
    tableName: string,
  ): Promise<TableMetadata | null> {
    const tables = await this.chClient.getTableMetadata(tenantId, indexId, tableName);
    return tables[0] || null;
  }

  // ===========================================================================
  // KEYWORD-BASED SCORING (Temporary - will be replaced with semantic search)
  // ===========================================================================

  /**
   * Score tables based on keyword matching
   */
  private scoreTablesKeywordMatch(
    tables: TableMetadata[],
    keywords: string[],
    minScore: number,
  ): DiscoveredTable[] {
    const scored: DiscoveredTable[] = [];

    for (const table of tables) {
      const score = this.calculateKeywordScore(table, keywords);

      if (score >= minScore) {
        scored.push({
          metadata: table,
          relevanceScore: score,
          matchReason: this.buildMatchReason(table, keywords, score),
        });
      }
    }

    return scored;
  }

  /**
   * Calculate relevance score based on keyword matches
   */
  private calculateKeywordScore(table: TableMetadata, keywords: string[]): number {
    if (keywords.length === 0) {
      return 0.5; // Neutral score if no keywords
    }

    const searchableText = table.searchable_text.toLowerCase();
    const tableName = table.table_name.toLowerCase();
    const displayName = table.display_name.toLowerCase();
    const description = table.table_description.toLowerCase();

    let score = 0;
    let matchedKeywords = 0;

    for (const keyword of keywords) {
      const kw = keyword.toLowerCase();
      // Simple stemming: remove trailing 's' for plurals
      const stem = kw.endsWith('s') && kw.length > 3 ? kw.slice(0, -1) : kw;

      // Exact table name match = high score
      if (tableName === kw || displayName === kw) {
        score += 1.0;
        matchedKeywords++;
        continue;
      }

      // Table name contains keyword or stem = medium score
      if (
        tableName.includes(kw) ||
        tableName.includes(stem) ||
        displayName.includes(kw) ||
        displayName.includes(stem)
      ) {
        score += 0.7;
        matchedKeywords++;
        continue;
      }

      // Description contains keyword = lower score
      if (description.includes(kw) || description.includes(stem)) {
        score += 0.4;
        matchedKeywords++;
        continue;
      }

      // Searchable text contains keyword = lowest score
      if (searchableText.includes(kw) || searchableText.includes(stem)) {
        score += 0.2;
        matchedKeywords++;
      }
    }

    // Normalize by number of keywords
    const normalizedScore = matchedKeywords > 0 ? score / keywords.length : 0;

    // Cap at 1.0
    return Math.min(normalizedScore, 1.0);
  }

  /**
   * Build human-readable match reason
   */
  private buildMatchReason(table: TableMetadata, keywords: string[], score: number): string {
    if (score >= 0.9) {
      return `Exact match on table name`;
    } else if (score >= 0.7) {
      return `Strong match on table name or description`;
    } else if (score >= 0.5) {
      return `Matched ${keywords.length} keywords in table metadata`;
    } else if (score >= 0.3) {
      return `Partial match on table metadata`;
    } else {
      return `Low relevance match`;
    }
  }

  // ===========================================================================
  // QUERY ANALYSIS
  // ===========================================================================

  /**
   * Extract keywords from query
   */
  private extractKeywords(query: string): string[] {
    // Remove common SQL keywords and stopwords
    const stopwords = new Set([
      'select',
      'from',
      'where',
      'and',
      'or',
      'order',
      'by',
      'group',
      'having',
      'limit',
      'offset',
      'join',
      'left',
      'right',
      'inner',
      'outer',
      'on',
      'as',
      'in',
      'not',
      'is',
      'null',
      'like',
      'between',
      'the',
      'a',
      'an',
      'of',
      'to',
      'for',
      'with',
      'at',
      'all',
      'me',
      'show',
      'find',
      'get',
      'than',
    ]);

    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopwords.has(t));

    return [...new Set(tokens)]; // Deduplicate
  }

  /**
   * Analyze query intent for multi-table scenarios
   */
  private analyzeQueryIntent(
    query: string,
    matchedTables: number,
  ): 'single_table' | 'multi_table' | 'ambiguous' {
    const lowerQuery = query.toLowerCase();

    // Multi-table indicators
    const joinIndicators = ['join', 'combine', 'merge', 'relate', 'with', 'and'];
    const hasJoinIntent = joinIndicators.some((indicator) => lowerQuery.includes(indicator));

    if (hasJoinIntent && matchedTables > 1) {
      return 'multi_table';
    }

    if (matchedTables === 1) {
      return 'single_table';
    }

    return 'ambiguous';
  }
}
