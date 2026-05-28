/**
 * Query Builder — ClickHouse Parameterized Query Construction
 *
 * Builds safe, parameterized SELECT queries against ClickHouse analytics tables.
 * Forces tenant_id + project_id isolation in every query.
 * Validates table names, column names, and filter operations against the schema.
 *
 * All user inputs are passed as parameterized values — never interpolated
 * directly into SQL — preventing injection.
 */

import type { ColumnMeta } from './schema-resolver.js';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';

// ─── Error ────────────────────────────────────────────────────────────────

export class QueryBuilderError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'QueryBuilderError';
  }
}

// ─── Validation Regexes ───────────────────────────────────────────────────

/** database.table — both parts must be safe identifiers */
const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Single safe column identifier */
const COL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ─── Types ────────────────────────────────────────────────────────────────

export interface BuildQueryArgs {
  tenantId: string;
  projectId: string;
  pipelineId: string;
  tableName: string;
  columns: ColumnMeta[];
  sessionId?: string;
  runId?: string;
  timeRange: { from: Date; to: Date };
  filters: Array<{
    column: string;
    op: '=' | 'in' | 'contains';
    value?: unknown;
  }>;
  limit: number;
  offset: number;
}

// ─── Max limits ───────────────────────────────────────────────────────────

const MAX_QUERY_LIMIT = 500;

// Removed local formatCHDateTime — use centralized toClickHouseDateTime from @agent-platform/database

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Detect the time column present in the schema. Analytics tables use
 * session_started_at or processed_at; custom tables may use created_at.
 */
function detectTimeColumn(columns: ColumnMeta[]): string {
  const names = new Set(columns.map((c) => c.name));
  if (names.has('session_started_at')) return 'session_started_at';
  if (names.has('created_at')) return 'created_at';
  if (names.has('processed_at')) return 'processed_at';
  return 'processed_at'; // safe fallback — all analytics tables have this
}

// ─── Builder ──────────────────────────────────────────────────────────────

export function buildPipelineDataQuery(args: BuildQueryArgs): {
  sql: string;
  params: Record<string, unknown>;
} {
  if (!TABLE_RE.test(args.tableName)) {
    throw new QueryBuilderError(`Invalid table name: ${args.tableName}`, 'INVALID_TABLE');
  }

  const colByName = new Map(args.columns.map((c) => [c.name, c]));
  const filterable = new Set(args.columns.filter((c) => c.filterable).map((c) => c.name));
  const timeCol = detectTimeColumn(args.columns);

  // ── Forced isolation clauses ──
  // Analytics tables use DateTime64(3) for time columns.
  // toClickHouseDateTime keeps ms precision and strips the trailing 'Z'.
  const where: string[] = [
    'tenant_id = {tenantId:String}',
    'project_id = {projectId:String}',
    `${timeCol} >= {from:DateTime64(3)}`,
    `${timeCol} <= {to:DateTime64(3)}`,
  ];
  const params: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
    from: toClickHouseDateTime(args.timeRange.from),
    to: toClickHouseDateTime(args.timeRange.to),
  };

  // ── Optional scope filters ──
  if (args.sessionId) {
    where.push('session_id = {sessionId:String}');
    params.sessionId = args.sessionId;
  }
  if (args.runId && colByName.has('run_id')) {
    where.push('run_id = {runId:String}');
    params.runId = args.runId;
  }
  if (args.pipelineId && colByName.has('pipeline_id')) {
    where.push('pipeline_id = {pipelineId:String}');
    params.pipelineId = args.pipelineId;
  }

  // ── User-supplied filters ──
  args.filters.forEach((f, i) => {
    if (!COL_RE.test(f.column)) {
      throw new QueryBuilderError(`Invalid column name: ${f.column}`, 'INVALID_COLUMN');
    }
    if (!filterable.has(f.column)) {
      throw new QueryBuilderError(`Column "${f.column}" is not filterable`, 'INVALID_FILTER');
    }
    const col = colByName.get(f.column);
    if (!col) {
      throw new QueryBuilderError(`Unknown column: ${f.column}`, 'INVALID_COLUMN');
    }
    const p = `f${i}`;
    switch (f.op) {
      case '=':
        where.push(`${f.column} = {${p}:${col.type}}`);
        params[p] = f.value;
        break;
      case 'in':
        where.push(`${f.column} IN {${p}:Array(${col.type})}`);
        params[p] = f.value;
        break;
      case 'contains':
        if (col.type !== 'String') {
          throw new QueryBuilderError('"contains" only valid on String columns', 'INVALID_FILTER');
        }
        where.push(`positionCaseInsensitive(${f.column}, {${p}:String}) > 0`);
        params[p] = f.value;
        break;
      default:
        throw new QueryBuilderError(`Unsupported operator: ${String(f.op)}`, 'INVALID_FILTER');
    }
  });

  // Only include columns that actually exist in the schema — exclude
  // tenant_id and project_id from the SELECT (they're isolation, not data).
  const selectCols = args.columns
    .filter((c) => c.exportable)
    .map((c) => c.name)
    .join(', ');

  const limit = Math.min(Math.max(args.limit, 1), MAX_QUERY_LIMIT);
  const offset = Math.max(args.offset, 0);

  const sql = [
    `SELECT ${selectCols}`,
    `FROM ${args.tableName}`,
    `WHERE ${where.join(' AND ')}`,
    `ORDER BY ${timeCol} DESC`,
    `LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    `SETTINGS max_execution_time = 10, max_rows_to_read = 1000000, max_result_rows = 500`,
  ].join('\n');

  params.limit = limit;
  params.offset = offset;

  return { sql, params };
}
