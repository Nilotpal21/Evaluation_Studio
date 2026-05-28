/**
 * ClickHouse Search Query Store
 *
 * Writes search query analytics to the abl_platform.search_queries table
 * using the BufferedClickHouseWriter from @agent-platform/database.
 * Also provides a query() read method for paginated history retrieval.
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  BufferedClickHouseWriter,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('query-store');

// =============================================================================
// TYPES
// =============================================================================

export interface SearchQueryRecord {
  /** Unique query ID */
  query_id: string;
  /** Tenant ID */
  tenant_id: string;
  /** Project ID */
  project_id: string;
  /** Session ID (empty string if not in a session) */
  session_id: string;
  /** Index ID the query was executed against */
  index_id: string;
  /** User ID or API key ID that issued the query */
  user_id: string;
  /** Query type: vector, hybrid, structured, aggregate, suggest, similar */
  query_type: string;
  /** Raw query text (if applicable) */
  query_text: string;
  /** Number of results returned */
  result_count: number;
  /** Total latency in milliseconds */
  total_latency_ms: number;
  /** Vocabulary resolve latency */
  vocabulary_resolve_ms: number;
  /** Vector search latency */
  vector_search_ms: number;
  /** Structured filter latency */
  structured_filter_ms: number;
  /** Rerank latency */
  rerank_ms: number;
  /** Whether the query was served from cache */
  cache_hit: boolean;
  /** Timestamp */
  timestamp: string;
  /** Optional: applied filters (JSON string) */
  filters?: string;
  /** Optional: resolved vocabulary terms (JSON string) */
  vocabulary_terms?: string;
  /** Optional: top_k requested */
  top_k?: number;
}

/** Row shape returned from ClickHouse SELECT (excludes heavy/sensitive cols) */
export interface SearchQueryRow {
  query_id: string;
  tenant_id: string;
  project_id: string;
  session_id: string;
  index_id: string;
  user_id: string;
  query_type: string;
  query_text: string;
  result_count: string; // ClickHouse returns UInt32 as string
  total_latency_ms: string;
  vocabulary_resolve_ms: string;
  vector_search_ms: string;
  structured_filter_ms: string;
  rerank_ms: string;
  cache_hit: string; // UInt8 → '0' | '1'
  timestamp: string;
  filters: string;
  vocabulary_terms: string;
  top_k: string;
  feedback_score: string;
  click_position: string;
}

export interface QueryHistoryParams {
  tenantId: string;
  indexId: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}

export interface QueryHistoryResult {
  rows: SearchQueryRow[];
  total: number;
}

// =============================================================================
// CLICKHOUSE SEARCH QUERY STORE
// =============================================================================

const TABLE = 'abl_platform.search_queries';

/**
 * Columns to SELECT (excludes results_json, encrypted, key_version).
 * SYNC: Keep in sync with apps/search-ai/src/routes/query-history.ts
 * (cross-app — cannot be shared via import)
 */
const SELECT_COLUMNS = [
  'query_id',
  'tenant_id',
  'project_id',
  'session_id',
  'index_id',
  'user_id',
  'query_type',
  'query_text',
  'result_count',
  'total_latency_ms',
  'vocabulary_resolve_ms',
  'vector_search_ms',
  'structured_filter_ms',
  'rerank_ms',
  'cache_hit',
  'timestamp',
  'filters',
  'vocabulary_terms',
  'top_k',
  'feedback_score',
  'click_position',
].join(', ');

export class ClickHouseSearchQueryStore {
  private writer: BufferedClickHouseWriter<SearchQueryRecord>;
  private client: ClickHouseClient;

  constructor(client: ClickHouseClient) {
    this.client = client;
    this.writer = new BufferedClickHouseWriter<SearchQueryRecord>(client, {
      table: TABLE,
      batchSize: 1000,
      flushIntervalMs: 5000,
      maxBufferSize: 50_000,
      onError: (error, context) => {
        logger.error('Flush error', {
          table: context.table,
          pending: context.pending,
          retries: context.retries,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  /**
   * Record a search query event.
   *
   * @param record - The search query record to write
   */
  record(record: SearchQueryRecord): void {
    this.writer.insert(record);
  }

  /**
   * Query search history with pagination and optional date range.
   *
   * @param params - Query parameters including tenantId, indexId, pagination, date range
   * @returns Paginated rows and total count
   */
  async query(params: QueryHistoryParams): Promise<QueryHistoryResult> {
    const conditions = ['tenant_id = {tenantId:String}', 'index_id = {indexId:String}'];
    const queryParams: Record<string, string | number> = {
      tenantId: params.tenantId,
      indexId: params.indexId,
    };

    if (params.from) {
      conditions.push('timestamp >= {from:DateTime64(3)}');
      queryParams.from = toClickHouseDateTime(params.from);
    }
    if (params.to) {
      conditions.push('timestamp <= {to:DateTime64(3)}');
      queryParams.to = toClickHouseDateTime(params.to);
    }

    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await this.client.query({
      query: `SELECT count() AS cnt FROM ${TABLE} WHERE ${whereClause} SETTINGS max_execution_time = 15`,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    const countRows = await countResult.json<{ cnt: string }>();
    const total = parseInt(countRows[0]?.cnt || '0', 10);

    // Get paginated results
    const result = await this.client.query({
      query: `
        SELECT ${SELECT_COLUMNS}
        FROM ${TABLE}
        WHERE ${whereClause}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 15
      `,
      query_params: { ...queryParams, limit, offset },
      format: 'JSONEachRow',
    });

    const rows = await result.json<SearchQueryRow>();

    return { rows, total };
  }

  /**
   * Flush any buffered records.
   */
  async flush(): Promise<void> {
    await this.writer.flush();
  }

  /**
   * Close the writer and flush remaining records.
   */
  async close(): Promise<void> {
    await this.writer.close();
  }

  /**
   * Get the number of pending (unflushed) records.
   */
  get pending(): number {
    return this.writer.pending;
  }
}
