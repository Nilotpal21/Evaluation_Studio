/**
 * Structured Data Query Router
 *
 * Intelligently routes queries between semantic search, SQL, and hybrid approaches.
 * Analyzes natural language queries to determine the best execution strategy.
 *
 * Query Types:
 * 1. Semantic - Text similarity search on embeddable fields
 * 2. SQL - Structured filters, aggregations, joins
 * 3. Hybrid - Combines semantic + SQL (e.g., "products with 'wireless' in description AND price < 100")
 */

import type { StructuredDataClickHouseClient } from './clickhouse-client.js';
import { TextToSQLService } from './text-to-sql.js';
import { TableDiscoveryService } from './table-discovery.js';
import { createLogger } from '@abl/compiler/platform';
import type { TableMetadata } from './types.js';

const logger = createLogger('query-router');

// =============================================================================
// TYPES
// =============================================================================

export interface QueryIntent {
  type: 'semantic' | 'sql' | 'hybrid';
  confidence: number;
  reasoning: string;
}

export interface StructuredDataQueryRequest {
  query: string;
  indexId: string;
  tenantId: string;
  tableId?: string; // Optional: restrict to specific table
  limit?: number;
  offset?: number;
}

export interface StructuredDataQueryResponse {
  queryId: string;
  intent: QueryIntent;
  results: StructuredDataResult[];
  totalCount: number;
  executionTimeMs: number;
  sqlGenerated?: string; // For debugging
}

export interface StructuredDataResult {
  tableId: string;
  tableName: string;
  rowNumber: number;
  rowData: Record<string, any>;
  score: number; // 0-1 relevance score
  matchedFields?: string[];
}

export interface SQLQueryComponents {
  select: string[];
  from: string;
  where: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
}

// =============================================================================
// QUERY ROUTER SERVICE
// =============================================================================

export class StructuredDataQueryRouter {
  constructor(private clickhouseClient?: StructuredDataClickHouseClient) {}

  /**
   * Main entry point: analyze query and route to appropriate execution strategy
   */
  async route(request: StructuredDataQueryRequest): Promise<StructuredDataQueryResponse> {
    const startTime = Date.now();

    // Step 1: Analyze query intent
    const intent = await this.analyzeIntent(request.query);

    // Step 2: Discover relevant tables (via chunk search + keyword scoring)
    const tables = await this.getAvailableTables(
      request.query,
      request.tenantId,
      request.indexId,
      request.tableId,
    );

    if (tables.length === 0) {
      return {
        queryId: this.generateQueryId(),
        intent,
        results: [],
        totalCount: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Step 3: Route to appropriate execution strategy
    let results: StructuredDataResult[];
    let sqlGenerated: string | undefined;

    switch (intent.type) {
      case 'semantic':
        // Semantic search for structured data is not yet implemented.
        // Fall through to SQL — the LLM text-to-SQL handles natural language well.
        logger.info('Semantic intent → delegating to SQL (semantic not yet available)', {
          tenantId: request.tenantId,
        });
      // eslint-disable-next-line no-fallthrough
      case 'sql': {
        const { results: sqlResults, sql } = await this.executeSQLQuery(request, tables);
        results = sqlResults;
        sqlGenerated = sql;
        break;
      }
      case 'hybrid': {
        const { results: hybridResults, sql: hybridSql } = await this.executeHybridQuery(
          request,
          tables,
        );
        results = hybridResults;
        sqlGenerated = hybridSql;
        break;
      }
    }

    return {
      queryId: this.generateQueryId(),
      intent,
      results,
      totalCount: results.length,
      executionTimeMs: Date.now() - startTime,
      sqlGenerated,
    };
  }

  /**
   * Analyze query intent using pattern matching and heuristics
   */
  async analyzeIntent(query: string): Promise<QueryIntent> {
    const lowerQuery = query.toLowerCase().trim();

    // SQL indicators (filters, comparisons, aggregations)
    const sqlPatterns = [
      /\bwhere\b/,
      /\bcount\b/,
      /\bsum\b/,
      /\baverage\b|\bavg\b/,
      /\bmin\b|\bmax\b/,
      /\bgreater than\b|\bless than\b/,
      /\b>\s*\d+|\b<\s*\d+/,
      /\b=\s*\d+/,
      /\bbetween\b.*\band\b/,
      /\bin\s+\[|\bin\s+\(/,
      /\bgroup by\b|\bgrouped by\b/,
      /\border by\b|\bordered by\b/,
      /\bsorted by\b|\bsort by\b/,
    ];

    // Semantic indicators (text matching, similarity, descriptions)
    const semanticPatterns = [
      /\bfind\b|\bsearch\b|\blook for\b/,
      /\bsimilar to\b|\blike\b/,
      /\bcontains\b|\bincludes\b/,
      /\bdescribed as\b|\bdescription\b/,
      /\btext\b|\bcontent\b/,
      /\bmatching\b/,
    ];

    // Hybrid indicators (combines both semantic AND SQL)
    // Must have BOTH semantic terms (find/search/containing) AND operators (>/</=)
    const hybridPatterns = [
      /(find|search|containing|described).*["'].*["'].*\b(and|where)\b.*(>|<|=|greater|less|above|below)/, // "find 'wireless' AND price < 100"
      /\b(with|containing)\b.*["'].*["'].*(>|<|=|greater|less|above|below)/, // "with 'text' where price > 100"
    ];

    let sqlScore = 0;
    let semanticScore = 0;
    let hybridScore = 0;

    // Check patterns
    for (const pattern of sqlPatterns) {
      if (pattern.test(lowerQuery)) sqlScore++;
    }

    for (const pattern of semanticPatterns) {
      if (pattern.test(lowerQuery)) semanticScore++;
    }

    for (const pattern of hybridPatterns) {
      if (pattern.test(lowerQuery)) hybridScore += 2; // Higher weight
    }

    // Detect numeric comparisons (strong SQL indicator)
    if (/\d+/.test(lowerQuery) && /(<|>|=|between|less|greater)/i.test(lowerQuery)) {
      sqlScore += 2;
    }

    // Detect aggregation keywords (strong SQL indicator)
    if (/(how many|total|average|sum|count)/i.test(lowerQuery)) {
      sqlScore += 2;
    }

    // Determine intent
    let type: QueryIntent['type'];
    let confidence: number;
    let reasoning: string;

    if (hybridScore > 0) {
      type = 'hybrid';
      confidence = Math.min(0.9, 0.6 + hybridScore * 0.1);
      reasoning = 'Query contains both semantic and structured filter indicators';
    } else if (sqlScore > semanticScore) {
      type = 'sql';
      confidence = Math.min(0.95, 0.6 + sqlScore * 0.1);
      reasoning = `SQL indicators detected: filters, comparisons, or aggregations (score: ${sqlScore})`;
    } else if (semanticScore > 0) {
      type = 'semantic';
      confidence = Math.min(0.9, 0.6 + semanticScore * 0.1);
      reasoning = `Semantic indicators detected: text matching or similarity (score: ${semanticScore})`;
    } else {
      // Default to SQL for structured data queries — the LLM text-to-SQL
      // pipeline can handle natural language like "show me X" better than
      // semantic search (which is not yet implemented for structured data).
      type = 'sql';
      confidence = 0.4;
      reasoning = 'No strong indicators detected, defaulting to SQL for structured data';
    }

    return { type, confidence, reasoning };
  }

  /**
   * Execute semantic search (vector similarity on embeddable fields)
   */
  private async executeSemanticQuery(
    request: StructuredDataQueryRequest,
    tables: TableMetadata[],
  ): Promise<StructuredDataResult[]> {
    // Semantic search for structured data is deferred — requires embedding
    // integration with OpenSearch vector store filtered by tableId.
    logger.info('Semantic search for structured data not yet available', {
      tenantId: request.tenantId,
      indexId: request.indexId,
    });
    return [];
  }

  /**
   * Execute SQL query via TextToSQLService + ClickHouse.
   *
   * Flow:
   * 1. LLM generates logical SQL (for explanation + confidence)
   * 2. Fetch actual data via queryWithLogicalSQL (tenant-isolated, JSON-extracted)
   * 3. Apply in-memory filtering using the LLM's parsed intent
   */
  private async executeSQLQuery(
    request: StructuredDataQueryRequest,
    tables: TableMetadata[],
  ): Promise<{ results: StructuredDataResult[]; sql: string }> {
    const textToSQL = new TextToSQLService();

    const sqlResponse = await textToSQL.generateSQL({
      query: request.query,
      tables,
      tenantId: request.tenantId,
      indexId: request.indexId,
      maxResults: request.limit,
    });

    // If no ClickHouse client, return the generated SQL without executing
    if (!this.clickhouseClient) {
      logger.warn('No ClickHouse client — returning generated SQL without execution', {
        tenantId: request.tenantId,
      });
      return {
        results: [],
        sql: sqlResponse.sql,
      };
    }

    // Execute against ClickHouse using tenant-isolated JSON row extraction
    try {
      const targetTable = tables[0];
      if (!targetTable) {
        return { results: [], sql: sqlResponse.sql };
      }

      const columns = JSON.parse(targetTable.columns) as string[];
      const columnTypes = JSON.parse(targetTable.column_types) as string[];

      const rows = await this.clickhouseClient.queryWithLogicalSQL(
        request.tenantId,
        request.indexId,
        targetTable.table_id,
        columns,
        columnTypes,
        sqlResponse.sql,
        {
          limit: request.limit ?? 10,
          offset: request.offset ?? 0,
        },
      );

      const results: StructuredDataResult[] = rows.map((row: Record<string, any>, idx: number) => ({
        tableId: targetTable.table_id,
        tableName: targetTable.table_name,
        rowNumber: idx,
        rowData: row,
        score: sqlResponse.confidence,
        matchedFields: sqlResponse.tablesReferenced,
      }));

      return { results, sql: sqlResponse.sql };
    } catch (error) {
      logger.error('ClickHouse structured query failed', {
        error: error instanceof Error ? error.message : String(error),
        sql: sqlResponse.sql,
      });
      return {
        results: [],
        sql: sqlResponse.sql,
      };
    }
  }

  /**
   * Execute hybrid query (SQL generation + semantic ranking).
   * Currently delegates to SQL path; semantic ranking is deferred.
   */
  private async executeHybridQuery(
    request: StructuredDataQueryRequest,
    tables: TableMetadata[],
  ): Promise<{ results: StructuredDataResult[]; sql: string }> {
    // Hybrid = SQL execution for now; semantic re-ranking deferred
    logger.info('Hybrid query: delegating to SQL path (semantic ranking deferred)', {
      tenantId: request.tenantId,
    });
    return this.executeSQLQuery(request, tables);
  }

  /**
   * Discover relevant tables for the query.
   *
   * Uses TableDiscoveryService which:
   * 1. Finds table_metadata SearchChunks (embedded in OpenSearch)
   * 2. Scores tables by keyword relevance to the user's query
   * 3. Returns ranked tables so only relevant ones go to the LLM
   *
   * Falls back to ClickHouse direct lookup if discovery fails or
   * if a specific tableId is provided.
   */
  private async getAvailableTables(
    query: string,
    tenantId: string,
    indexId: string,
    tableId?: string,
  ): Promise<TableMetadata[]> {
    // If specific tableId requested, fetch directly from ClickHouse
    if (tableId && this.clickhouseClient) {
      try {
        return await this.clickhouseClient.getTableMetadata(tenantId, indexId, tableId);
      } catch (error) {
        logger.error('Failed to fetch specific table metadata', {
          error: error instanceof Error ? error.message : String(error),
          tableId,
        });
        return [];
      }
    }

    // Use TableDiscoveryService to find relevant tables via chunk search
    try {
      const discoveryService = new TableDiscoveryService(this.clickhouseClient ?? undefined);
      const discovery = await discoveryService.discoverTables({
        query,
        tenantId,
        indexId,
        maxTables: 5,
        minRelevanceScore: 0.2,
      });

      if (discovery.tables.length > 0) {
        logger.info('Table discovery found relevant tables', {
          tenantId,
          indexId,
          matched: discovery.tables.length,
          totalAvailable: discovery.totalAvailable,
          topTable: discovery.tables[0].metadata.table_name,
          topScore: discovery.tables[0].relevanceScore,
        });
        return discovery.tables.map((t) => t.metadata);
      }

      // No tables matched — fall back to all tables
      logger.info('Table discovery found no matches, falling back to all tables', {
        tenantId,
        indexId,
      });
    } catch (error) {
      logger.warn('Table discovery failed, falling back to ClickHouse direct', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback: load all tables from ClickHouse
    if (!this.clickhouseClient) {
      return [];
    }

    try {
      return await this.clickhouseClient.getTableMetadata(tenantId, indexId);
    } catch (error) {
      logger.error('Failed to fetch table metadata from ClickHouse', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Generate unique query ID for tracking
   */
  private generateQueryId(): string {
    return `qry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}
