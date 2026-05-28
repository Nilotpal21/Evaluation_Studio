/**
 * ClickHouse Client for Structured Data Storage
 *
 * Handles:
 * - Table creation with tenant/index isolation
 * - Bulk data insertion
 * - Table metadata storage
 * - Query execution with tenant/index filters
 */

import { getClickHouseClient, toClickHouseDateTimeSec } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';
import type { TableSchema, TableMetadata, ClickHouseTableRow, IngestionResult } from './types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('clickhouse-structured-data');
const DATABASE = 'abl_platform';

export class StructuredDataClickHouseClient {
  private client: ClickHouseClient;

  constructor(client?: ClickHouseClient) {
    this.client = client || getClickHouseClient();
  }

  /**
   * Initialize structured data tables in ClickHouse
   */
  async initialize(): Promise<void> {
    // Create table_metadata table
    await this.client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS ${DATABASE}.table_metadata (
          table_id String,
          table_name String,
          display_name String,

          -- Isolation
          tenant_id String,
          index_id String,

          -- Schema
          columns String,  -- JSON array
          column_types String,  -- JSON array
          primary_key Nullable(String),
          row_count UInt64,

          -- Descriptions
          table_description String,
          column_descriptions String,  -- JSON object

          -- Statistics
          statistics String,  -- JSON object
          sample_rows String,  -- JSON array

          -- Relationships
          foreign_keys String,  -- JSON array

          -- Searchability
          searchable_text String,

          -- Timestamps
          created_at DateTime DEFAULT now(),
          updated_at DateTime DEFAULT now()
        )
        ENGINE = MergeTree()
        ORDER BY (tenant_id, index_id, table_name)
      `,
    });

    logger.info('ClickHouse table_metadata table initialized');
  }

  /**
   * Create a new table for storing structured data rows
   */
  async createDataTable(tenantId: string, indexId: string, tableId: string): Promise<void> {
    const tableName = this.getDataTableName(tableId);

    await this.client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS ${DATABASE}.${tableName} (
          tenant_id String,
          index_id String,
          table_id String,
          row_data String,  -- JSON string of the row
          row_number UInt64,
          created_at DateTime DEFAULT now()
        )
        ENGINE = MergeTree()
        ORDER BY (tenant_id, index_id, row_number)
      `,
    });

    logger.info('Created ClickHouse data table', { tableName });
  }

  /**
   * Insert table metadata
   */
  async insertMetadata(metadata: TableMetadata): Promise<void> {
    // table_metadata.created_at / updated_at are DateTime (second-precision)
    const metadataForInsert = {
      ...metadata,
      created_at: toClickHouseDateTimeSec(metadata.created_at),
      updated_at: toClickHouseDateTimeSec(metadata.updated_at),
    };

    await this.client.insert({
      table: `${DATABASE}.table_metadata`,
      values: [metadataForInsert],
      format: 'JSONEachRow',
    });
  }

  /**
   * Bulk insert structured data rows
   */
  async insertRows(
    tenantId: string,
    indexId: string,
    tableId: string,
    rows: Record<string, any>[],
  ): Promise<IngestionResult> {
    try {
      const tableName = this.getDataTableName(tableId);

      // data table created_at is DateTime (second-precision)
      const now = new Date();
      const clickhouseRows = rows.map((row, index) => ({
        tenant_id: tenantId,
        index_id: indexId,
        table_id: tableId,
        row_data: JSON.stringify(row),
        row_number: index,
        created_at: toClickHouseDateTimeSec(now),
      }));

      // Bulk insert
      await this.client.insert({
        table: `${DATABASE}.${tableName}`,
        values: clickhouseRows,
        format: 'JSONEachRow',
      });

      return {
        success: true,
        tableId,
        rowsIngested: rows.length,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INSERTION_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
          details: error,
        },
      };
    }
  }

  /**
   * Query table metadata with tenant/index isolation
   */
  async getTableMetadata(
    tenantId: string,
    indexId: string,
    tableName?: string,
  ): Promise<TableMetadata[]> {
    const whereClause = tableName
      ? `WHERE tenant_id = {tenantId:String} AND index_id = {indexId:String} AND table_name = {tableName:String}`
      : `WHERE tenant_id = {tenantId:String} AND index_id = {indexId:String}`;

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${DATABASE}.table_metadata
        ${whereClause}
        ORDER BY created_at DESC
      `,
      query_params: { tenantId, indexId, ...(tableName && { tableName }) },
      format: 'JSONEachRow',
    });

    return (await result.json()) as any as TableMetadata[];
  }

  /**
   * Query structured data rows with tenant/index isolation
   */
  async queryRows(
    tenantId: string,
    indexId: string,
    tableId: string,
    options?: {
      limit?: number;
      offset?: number;
      where?: string; // Additional WHERE clause (user must not include tenant/index filters)
    },
  ): Promise<Record<string, any>[]> {
    const tableName = this.getDataTableName(tableId);
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    const additionalWhere = options?.where ? `AND (${options.where})` : '';

    const result = await this.client.query({
      query: `
        SELECT row_data
        FROM ${DATABASE}.${tableName}
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          ${additionalWhere}
        ORDER BY row_number
        LIMIT {limit:UInt64}
        OFFSET {offset:UInt64}
      `,
      query_params: { tenantId, indexId, limit, offset },
      format: 'JSONEachRow',
    });

    const rows = (await result.json()) as any as Array<{ row_data: string }>;
    return rows.map((row) => JSON.parse(row.row_data));
  }

  /**
   * Execute custom SQL query with tenant/index isolation validation
   */
  async executeQuery(
    tenantId: string,
    indexId: string,
    sql: string,
    params?: Record<string, any>,
  ): Promise<any[]> {
    // Security: Validate that SQL includes tenant_id and index_id filters
    if (!sql.includes('tenant_id') || !sql.includes('index_id')) {
      throw new Error('SECURITY_VIOLATION: SQL must include tenant_id and index_id filters');
    }

    const result = await this.client.query({
      query: sql,
      query_params: { tenantId, indexId, ...params },
      format: 'JSONEachRow',
    });

    return (await result.json()) as any;
  }

  /**
   * Delete table and metadata
   */
  async deleteTable(tenantId: string, indexId: string, tableId: string): Promise<void> {
    const tableName = this.getDataTableName(tableId);

    // Delete metadata
    await this.client.exec({
      query: `
        DELETE FROM ${DATABASE}.table_metadata
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND table_id = {tableId:String}
      `,
      query_params: { tenantId, indexId, tableId },
    });

    // Drop data table
    await this.client.exec({
      query: `DROP TABLE IF EXISTS ${DATABASE}.${tableName}`,
    });

    logger.info('Deleted ClickHouse data table', { tableName });
  }

  /**
   * Get statistics for a table
   */
  async getTableStats(
    tenantId: string,
    indexId: string,
    tableId: string,
  ): Promise<{ rowCount: number; sizeBytes: number }> {
    const tableName = this.getDataTableName(tableId);

    const result = await this.client.query({
      query: `
        SELECT
          count() as row_count,
          sum(length(row_data)) as size_bytes
        FROM ${DATABASE}.${tableName}
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
      `,
      query_params: { tenantId, indexId },
      format: 'JSONEachRow',
    });

    const stats = (await result.json()) as any as Array<{
      row_count: string;
      size_bytes: string;
    }>;

    return {
      rowCount: parseInt(stats[0]?.row_count || '0', 10),
      sizeBytes: parseInt(stats[0]?.size_bytes || '0', 10),
    };
  }

  /**
   * Insert path index entries for hierarchical structured data
   */
  async insertPathEntries(
    entries: Array<{
      tenantId: string;
      indexId: string;
      objectId: string;
      objectType: 'json' | 'xml';
      path: string;
      pathNormalized: string;
      depth: number;
      valueType: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
      valueString?: string;
      valueNumber?: number;
      valueBoolean?: boolean;
      parentPath: string | null;
      pathTokens: string[];
    }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.client.insert({
      table: `${DATABASE}.json_path_index`,
      values: entries.map((entry) => ({
        tenant_id: entry.tenantId,
        index_id: entry.indexId,
        object_id: entry.objectId,
        object_type: entry.objectType,
        path: entry.path,
        path_normalized: entry.pathNormalized,
        depth: entry.depth,
        value_type: entry.valueType,
        value_string: entry.valueString || null,
        value_number: entry.valueNumber || null,
        value_boolean: entry.valueBoolean !== undefined ? (entry.valueBoolean ? 1 : 0) : null,
        parent_path: entry.parentPath || null,
        path_tokens: entry.pathTokens,
        created_at: new Date(),
      })),
      format: 'JSONEachRow',
    });
  }

  /**
   * Query path index by pattern
   */
  async queryPathsByPattern(
    tenantId: string,
    indexId: string,
    pathPattern: string,
    limit: number = 100,
  ): Promise<
    Array<{
      objectId: string;
      path: string;
      valueType: string;
      valueString?: string;
      valueNumber?: number;
      valueBoolean?: boolean;
    }>
  > {
    const result = await this.client.query({
      query: `
        SELECT
          object_id,
          path,
          value_type,
          value_string,
          value_number,
          value_boolean
        FROM ${DATABASE}.json_path_index
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND path_normalized = {pathPattern:String}
        LIMIT {limit:UInt64}
      `,
      query_params: { tenantId, indexId, pathPattern, limit },
      format: 'JSONEachRow',
    });

    return (await result.json()) as any;
  }

  /**
   * Execute a logical SQL query against structured data stored as JSON rows.
   *
   * Translates LLM-generated SQL (which references logical column names like
   * `price`, `name`) into ClickHouse-native SQL using JSONExtract on `row_data`.
   * Tenant and index isolation is always enforced.
   *
   * The LLM SQL's WHERE, ORDER BY, GROUP BY, and LIMIT clauses are extracted
   * and rewritten so the filtering happens inside ClickHouse, not in-memory.
   *
   * @param tenantId    - Tenant isolation
   * @param indexId     - Index isolation
   * @param tableId     - Physical table to query
   * @param columns     - Logical column names (from table metadata)
   * @param columnTypes - Corresponding logical types (string, integer, number, etc.)
   * @param logicalSQL  - The LLM-generated SQL to translate
   * @param options     - fallback limit/offset if not in SQL
   */
  async queryWithLogicalSQL(
    tenantId: string,
    indexId: string,
    tableId: string,
    columns: string[],
    columnTypes: string[],
    logicalSQL: string,
    options?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<Record<string, any>[]> {
    const tableName = this.getDataTableName(tableId);

    // Build a column name → ClickHouse type map
    const colTypeMap = new Map<string, string>();
    for (let i = 0; i < columns.length; i++) {
      colTypeMap.set(columns[i], this.mapLogicalTypeToClickHouse(columnTypes[i] ?? 'string'));
    }

    // Build SELECT with JSONExtract for each logical column
    // CRITICAL: Use original column name (with spaces) inside JSONExtract quotes
    // because row_data JSON keys have the original names. Only sanitize for AS alias.
    const selectCols = columns.map((col) => {
      const chType = colTypeMap.get(col) ?? 'String';
      const alias = this.sanitizeColumnName(col);
      const escaped = col.replace(/'/g, "\\'");
      return `JSONExtract(row_data, '${escaped}', '${chType}') AS ${alias}`;
    });

    // Extract WHERE clause from LLM SQL and rewrite column refs to JSONExtract
    const whereClause = this.extractAndRewriteClause(logicalSQL, 'WHERE', colTypeMap);

    // Extract ORDER BY clause
    const orderByClause = this.extractOrderByClause(logicalSQL, colTypeMap);

    // Extract LIMIT from LLM SQL, fall back to options
    const limitMatch = logicalSQL.match(/\bLIMIT\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : (options?.limit ?? 100);
    const offset = options?.offset ?? 0;

    const sql = `
      SELECT ${selectCols.join(', ')}
      FROM ${DATABASE}.${tableName}
      WHERE tenant_id = {tenantId:String}
        AND index_id = {indexId:String}
        ${whereClause ? `AND (${whereClause})` : ''}
      ${orderByClause ? `ORDER BY ${orderByClause}` : 'ORDER BY row_number'}
      LIMIT {limit:UInt64}
      OFFSET {offset:UInt64}
    `;

    const result = await this.client.query({
      query: sql,
      query_params: { tenantId, indexId, limit, offset },
      format: 'JSONEachRow',
    });

    return (await result.json()) as any as Record<string, any>[];
  }

  /**
   * Extract a SQL clause (WHERE) from the LLM SQL and rewrite column
   * references to JSONExtract expressions.
   *
   * Example: `WHERE price > 50 AND category = 'Electronics'`
   * → `JSONExtract(row_data,'price','Float64') > 50 AND JSONExtract(row_data,'category','String') = 'Electronics'`
   */
  private extractAndRewriteClause(
    sql: string,
    clause: string,
    colTypeMap: Map<string, string>,
  ): string | null {
    // Extract everything between WHERE and (ORDER BY|GROUP BY|HAVING|LIMIT|$)
    const regex = new RegExp(
      `\\b${clause}\\b\\s+(.+?)(?=\\b(?:ORDER BY|GROUP BY|HAVING|LIMIT)\\b|$)`,
      'is',
    );
    const match = sql.match(regex);
    if (!match) return null;

    let clauseBody = match[1].trim();

    // Replace column references with JSONExtract
    // Sort by length descending to avoid partial replacements (e.g., 'id' matching 'product_id')
    const sortedCols = Array.from(colTypeMap.entries()).sort((a, b) => b[0].length - a[0].length);

    for (const [col, chType] of sortedCols) {
      const escaped = col.replace(/'/g, "\\'");
      // Match column name — either bare or wrapped in double quotes (LLMs quote columns with spaces)
      // Bare: `Search Index ID = ...`  Quoted: `"Search Index ID" = ...`
      const quotedRegex = new RegExp(`"${this.escapeRegex(col)}"`, 'g');
      const bareRegex = new RegExp(`(?<!['"\\w])\\b${this.escapeRegex(col)}\\b(?!['"\\w])`, 'g');
      const replacement = `JSONExtract(row_data, '${escaped}', '${chType}')`;
      clauseBody = clauseBody.replace(quotedRegex, replacement);
      clauseBody = clauseBody.replace(bareRegex, replacement);
    }

    return clauseBody;
  }

  /**
   * Extract and rewrite ORDER BY clause.
   */
  private extractOrderByClause(sql: string, colTypeMap: Map<string, string>): string | null {
    const match = sql.match(/\bORDER BY\b\s+(.+?)(?=\b(?:LIMIT|$)\b|$)/is);
    if (!match) return null;

    let orderBody = match[1].trim();

    const sortedCols = Array.from(colTypeMap.entries()).sort((a, b) => b[0].length - a[0].length);
    for (const [col, chType] of sortedCols) {
      const escaped = col.replace(/'/g, "\\'");
      const quotedRegex = new RegExp(`"${this.escapeRegex(col)}"`, 'g');
      const bareRegex = new RegExp(`(?<!['"\\w])\\b${this.escapeRegex(col)}\\b(?!['"\\w])`, 'g');
      const replacement = `JSONExtract(row_data, '${escaped}', '${chType}')`;
      orderBody = orderBody.replace(quotedRegex, replacement);
      orderBody = orderBody.replace(bareRegex, replacement);
    }

    return orderBody;
  }

  /**
   * Map logical column type to ClickHouse type for JSONExtract.
   */
  private mapLogicalTypeToClickHouse(logicalType: string): string {
    switch (logicalType.toLowerCase()) {
      case 'integer':
        return 'Int64';
      case 'number':
      case 'decimal':
        return 'Float64';
      case 'boolean':
        return 'UInt8';
      default:
        return 'String';
    }
  }

  /**
   * Sanitize column name to prevent SQL injection in identifiers.
   */
  private sanitizeColumnName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Generate table name for data storage
   * Format: structured_data_{tableId}
   */
  private getDataTableName(tableId: string): string {
    // Sanitize tableId to ensure it's a valid ClickHouse table name
    const sanitized = tableId.replace(/[^a-zA-Z0-9_]/g, '_');
    return `structured_data_${sanitized}`;
  }
}
