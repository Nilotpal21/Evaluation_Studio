import {
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
} from '@abl/compiler/platform/stores';
import {
  getClickHouseClient,
  parseClickHouseTimestamp,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import {
  AUDIT_LOG_CATEGORIES,
  AUDIT_LOG_SEVERITIES,
  type AuditLogCategory,
  type AuditLogSeverity,
} from '@agent-platform/arch-ai';

const ARCH_AUDIT_TABLE = 'abl_platform.arch_audit_log';
const MAX_IN_MEMORY_AUDIT_FETCH = Number.MAX_SAFE_INTEGER;

interface ArchAuditClickHouseRow {
  tenant_id: string;
  user_id: string;
  session_id: string;
  project_id: string;
  timestamp: string;
  event_id: string;
  category: string;
  severity: string;
  summary: string;
  detail: string;
  specialist: string;
  phase: string;
  duration_ms: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  total_tokens: number | string;
  estimated_cost: number | string;
  metadata: string;
}

export interface ArchAuditLogRecord {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId?: string;
  category: string;
  severity: string;
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: {
    input: number;
    output: number;
    total: number;
    estimatedCost: number;
  };
  timestamp: string;
}

export interface ArchAuditSummary {
  totalEvents: number;
  totalTokens: { input: number; output: number; total: number };
  estimatedCost: number;
  errorCount: { total: number; critical: number; error: number; warning: number };
  byCategory: Record<string, number>;
}

export interface ArchAuditCostBreakdownGroup {
  userId: string;
  phase: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
}

export interface ArchAuditListQuery {
  tenantId: string;
  projectId?: string;
  categories?: string[];
  severities?: string[];
  phase?: string;
  userId?: string;
  sessionId?: string;
  specialist?: string;
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapRowToRecord(row: ArchAuditClickHouseRow): ArchAuditLogRecord {
  const detail = parseJsonRecord(row.detail);
  const input = asNumber(row.input_tokens);
  const output = asNumber(row.output_tokens);
  const total = asNumber(row.total_tokens);
  const estimatedCost = asNumber(row.estimated_cost);

  return {
    _id: row.event_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    projectId: row.project_id || undefined,
    category: row.category,
    severity: row.severity,
    summary: row.summary,
    detail,
    specialist: row.specialist || undefined,
    phase: row.phase || undefined,
    durationMs: asNumber(row.duration_ms) || undefined,
    tokens:
      input > 0 || output > 0 || total > 0 || estimatedCost > 0
        ? {
            input,
            output,
            total,
            estimatedCost,
          }
        : undefined,
    timestamp: parseClickHouseTimestamp(row.timestamp).toISOString(),
  };
}

function mapInMemoryLogToRecord(
  log: Awaited<ReturnType<typeof queryInMemoryAuditTestLogs>>['logs'][number],
): ArchAuditLogRecord {
  const metadata = (
    typeof log.metadata === 'object' && log.metadata !== null ? log.metadata : {}
  ) as Record<string, unknown>;
  const tokens = metadata.tokens as
    | { input?: unknown; output?: unknown; total?: unknown; estimatedCost?: unknown }
    | undefined;

  const input = asNumber(tokens?.input);
  const output = asNumber(tokens?.output);
  const total = asNumber(tokens?.total);
  const estimatedCost = asNumber(tokens?.estimatedCost);

  return {
    _id: log.id,
    tenantId: log.tenantId,
    userId: log.actor,
    sessionId: log.resourceId,
    projectId: typeof log.projectId === 'string' ? log.projectId : undefined,
    category: asString(metadata.category),
    severity: asString(metadata.severity) || 'info',
    summary: asString(metadata.summary),
    detail:
      typeof metadata.detail === 'object' &&
      metadata.detail !== null &&
      !Array.isArray(metadata.detail)
        ? (metadata.detail as Record<string, unknown>)
        : {},
    specialist: asString(metadata.specialist) || undefined,
    phase: asString(metadata.phase) || undefined,
    durationMs: asNumber(metadata.durationMs) || undefined,
    tokens:
      input > 0 || output > 0 || total > 0 || estimatedCost > 0
        ? {
            input,
            output,
            total,
            estimatedCost,
          }
        : undefined,
    timestamp: log.timestamp.toISOString(),
  };
}

function matchesListFilters(entry: ArchAuditLogRecord, query: ArchAuditListQuery): boolean {
  if (
    query.categories &&
    query.categories.length > 0 &&
    !query.categories.includes(entry.category)
  ) {
    return false;
  }
  if (
    query.severities &&
    query.severities.length > 0 &&
    !query.severities.includes(entry.severity)
  ) {
    return false;
  }
  if (query.phase && entry.phase !== query.phase) {
    return false;
  }
  if (query.userId && entry.userId !== query.userId) {
    return false;
  }
  if (query.sessionId && entry.sessionId !== query.sessionId) {
    return false;
  }
  if (query.specialist && entry.specialist !== query.specialist) {
    return false;
  }
  if (query.projectId && entry.projectId !== query.projectId) {
    return false;
  }

  const timestampMs = new Date(entry.timestamp).getTime();
  if (timestampMs < query.from.getTime() || timestampMs > query.to.getTime()) {
    return false;
  }

  return true;
}

function buildListWhereClause(query: ArchAuditListQuery): {
  whereClause: string;
  queryParams: Record<string, unknown>;
} {
  const clauses = [
    'tenant_id = {tenantId:String}',
    'timestamp >= {from:DateTime64(3)}',
    'timestamp <= {to:DateTime64(3)}',
  ];

  const queryParams: Record<string, unknown> = {
    tenantId: query.tenantId,
    from: toClickHouseDateTime(query.from),
    to: toClickHouseDateTime(query.to),
  };

  if (query.projectId) {
    clauses.push('project_id = {projectId:String}');
    queryParams.projectId = query.projectId;
  }
  if (query.categories && query.categories.length > 0) {
    clauses.push('category IN ({categories:Array(String)})');
    queryParams.categories = query.categories;
  }
  if (query.severities && query.severities.length > 0) {
    clauses.push('severity IN ({severities:Array(String)})');
    queryParams.severities = query.severities;
  }
  if (query.phase) {
    clauses.push('phase = {phase:String}');
    queryParams.phase = query.phase;
  }
  if (query.userId) {
    clauses.push('user_id = {userId:String}');
    queryParams.userId = query.userId;
  }
  if (query.sessionId) {
    clauses.push('session_id = {sessionId:String}');
    queryParams.sessionId = query.sessionId;
  }
  if (query.specialist) {
    clauses.push('specialist = {specialist:String}');
    queryParams.specialist = query.specialist;
  }

  return {
    whereClause: clauses.join(' AND '),
    queryParams,
  };
}

async function queryArchAuditLogsFromInMemory(
  query: ArchAuditListQuery,
): Promise<{ entries: ArchAuditLogRecord[]; total: number }> {
  const result = await queryInMemoryAuditTestLogs({
    tenantId: query.tenantId,
    projectId: query.projectId,
    resourceType: 'arch_session',
    startTime: query.from,
    endTime: query.to,
    limit: MAX_IN_MEMORY_AUDIT_FETCH,
    offset: 0,
  });

  const filtered = result.logs
    .map(mapInMemoryLogToRecord)
    .filter((entry) => matchesListFilters(entry, query))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    entries: filtered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
  };
}

export async function queryArchAuditLogs(
  query: ArchAuditListQuery,
): Promise<{ entries: ArchAuditLogRecord[]; total: number }> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return queryArchAuditLogsFromInMemory(query);
  }

  const client = getClickHouseClient();
  const { whereClause, queryParams } = buildListWhereClause(query);

  const countResult = await client.query({
    query: `
      SELECT count() AS cnt
      FROM ${ARCH_AUDIT_TABLE}
      WHERE ${whereClause}
      SETTINGS max_execution_time = 15
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = Number.parseInt(countRows[0]?.cnt || '0', 10);

  const rowsResult = await client.query({
    query: `
      SELECT *
      FROM ${ARCH_AUDIT_TABLE}
      WHERE ${whereClause}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 15
    `,
    query_params: {
      ...queryParams,
      limit: query.limit,
      offset: query.offset,
    },
    format: 'JSONEachRow',
  });
  const rows = await rowsResult.json<ArchAuditClickHouseRow>();

  return {
    entries: rows.map(mapRowToRecord),
    total,
  };
}

export async function queryArchAuditTimeline(
  tenantId: string,
  sessionId: string,
  projectId?: string,
): Promise<ArchAuditLogRecord[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId,
      projectId,
      resourceType: 'arch_session',
      resourceId: sessionId,
      startTime: new Date(0),
      endTime: new Date(),
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });

    return result.logs
      .map(mapInMemoryLogToRecord)
      .filter((entry) => !projectId || entry.projectId === projectId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  const client = getClickHouseClient();
  const projectClause = projectId ? 'AND project_id = {projectId:String}' : '';
  const rowsResult = await client.query({
    query: `
      SELECT *
      FROM ${ARCH_AUDIT_TABLE}
      WHERE tenant_id = {tenantId:String}
        AND session_id = {sessionId:String}
        ${projectClause}
      ORDER BY timestamp ASC
      SETTINGS max_execution_time = 15
    `,
    query_params: { tenantId, sessionId, ...(projectId ? { projectId } : {}) },
    format: 'JSONEachRow',
  });
  const rows = await rowsResult.json<ArchAuditClickHouseRow>();
  return rows.map(mapRowToRecord);
}

export async function summarizeArchAuditLogs(params: {
  tenantId: string;
  projectId?: string;
  from: Date;
  to: Date;
}): Promise<ArchAuditSummary> {
  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId: params.tenantId,
      projectId: params.projectId,
      resourceType: 'arch_session',
      startTime: params.from,
      endTime: params.to,
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });
    const entries = result.logs
      .map(mapInMemoryLogToRecord)
      .filter((entry) => !params.projectId || entry.projectId === params.projectId);

    const summary: ArchAuditSummary = {
      totalEvents: entries.length,
      totalTokens: { input: 0, output: 0, total: 0 },
      estimatedCost: 0,
      errorCount: { total: 0, critical: 0, error: 0, warning: 0 },
      byCategory: {},
    };

    for (const entry of entries) {
      summary.totalTokens.input += entry.tokens?.input ?? 0;
      summary.totalTokens.output += entry.tokens?.output ?? 0;
      summary.totalTokens.total += entry.tokens?.total ?? 0;
      summary.estimatedCost += entry.tokens?.estimatedCost ?? 0;
      summary.byCategory[entry.category] = (summary.byCategory[entry.category] ?? 0) + 1;
      if (
        entry.severity === 'warning' ||
        entry.severity === 'error' ||
        entry.severity === 'critical'
      ) {
        summary.errorCount[entry.severity as 'warning' | 'error' | 'critical'] += 1;
        summary.errorCount.total += 1;
      }
    }

    return summary;
  }

  const client = getClickHouseClient();
  const queryParams = {
    tenantId: params.tenantId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    from: toClickHouseDateTime(params.from),
    to: toClickHouseDateTime(params.to),
  };
  const projectClause = params.projectId ? 'AND project_id = {projectId:String}' : '';

  const [totalsResult, errorCountsResult, categoriesResult] = await Promise.all([
    client.query({
      query: `
        SELECT
          count() AS totalEvents,
          sum(input_tokens) AS totalInputTokens,
          sum(output_tokens) AS totalOutputTokens,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost
        FROM ${ARCH_AUDIT_TABLE}
        WHERE tenant_id = {tenantId:String}
          ${projectClause}
          AND timestamp >= {from:DateTime64(3)}
          AND timestamp <= {to:DateTime64(3)}
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT severity, count() AS count
        FROM ${ARCH_AUDIT_TABLE}
        WHERE tenant_id = {tenantId:String}
          ${projectClause}
          AND timestamp >= {from:DateTime64(3)}
          AND timestamp <= {to:DateTime64(3)}
          AND severity IN ('warning', 'error', 'critical')
        GROUP BY severity
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT category, count() AS count
        FROM ${ARCH_AUDIT_TABLE}
        WHERE tenant_id = {tenantId:String}
          ${projectClause}
          AND timestamp >= {from:DateTime64(3)}
          AND timestamp <= {to:DateTime64(3)}
        GROUP BY category
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }),
  ]);

  const totalsRows = await totalsResult.json<{
    totalEvents: string;
    totalInputTokens: string;
    totalOutputTokens: string;
    totalTokens: string;
    estimatedCost: string;
  }>();
  const errorRows = await errorCountsResult.json<{ severity: string; count: string }>();
  const categoryRows = await categoriesResult.json<{ category: string; count: string }>();

  const totals = totalsRows[0] ?? {
    totalEvents: '0',
    totalInputTokens: '0',
    totalOutputTokens: '0',
    totalTokens: '0',
    estimatedCost: '0',
  };

  const errorCount: ArchAuditSummary['errorCount'] = {
    total: 0,
    critical: 0,
    error: 0,
    warning: 0,
  };
  for (const row of errorRows) {
    if (row.severity === 'critical' || row.severity === 'error' || row.severity === 'warning') {
      const count = Number.parseInt(row.count, 10);
      errorCount[row.severity] = count;
      errorCount.total += count;
    }
  }

  const byCategory: Record<string, number> = {};
  for (const row of categoryRows) {
    byCategory[row.category] = Number.parseInt(row.count, 10);
  }

  return {
    totalEvents: Number.parseInt(totals.totalEvents || '0', 10),
    totalTokens: {
      input: Number.parseInt(totals.totalInputTokens || '0', 10),
      output: Number.parseInt(totals.totalOutputTokens || '0', 10),
      total: Number.parseInt(totals.totalTokens || '0', 10),
    },
    estimatedCost: Number.parseFloat(totals.estimatedCost || '0'),
    errorCount,
    byCategory,
  };
}

export async function getArchAuditCostBreakdown(params: {
  tenantId: string;
  projectId?: string;
  from: Date;
  to: Date;
}): Promise<ArchAuditCostBreakdownGroup[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId: params.tenantId,
      projectId: params.projectId,
      resourceType: 'arch_session',
      startTime: params.from,
      endTime: params.to,
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });
    const groups = new Map<string, ArchAuditCostBreakdownGroup>();

    for (const entry of result.logs.map(mapInMemoryLogToRecord)) {
      if (params.projectId && entry.projectId !== params.projectId) {
        continue;
      }
      if (entry.category !== 'llm_call') {
        continue;
      }
      const model = typeof entry.detail.model === 'string' ? entry.detail.model : '';
      const phase = entry.phase ?? '';
      const key = `${entry.userId}::${phase}::${model}`;
      const existing =
        groups.get(key) ??
        ({
          userId: entry.userId,
          phase,
          model,
          totalCost: 0,
          totalTokens: 0,
          callCount: 0,
        } satisfies ArchAuditCostBreakdownGroup);

      existing.totalCost += entry.tokens?.estimatedCost ?? 0;
      existing.totalTokens += entry.tokens?.total ?? 0;
      existing.callCount += 1;
      groups.set(key, existing);
    }

    return Array.from(groups.values()).sort((a, b) => b.totalCost - a.totalCost);
  }

  const client = getClickHouseClient();
  const projectClause = params.projectId ? 'AND project_id = {projectId:String}' : '';
  const result = await client.query({
    query: `
      SELECT
        user_id AS userId,
        phase AS phase,
        JSONExtractString(detail, 'model') AS model,
        sum(estimated_cost) AS totalCost,
        sum(total_tokens) AS totalTokens,
        count() AS callCount
      FROM ${ARCH_AUDIT_TABLE}
      WHERE tenant_id = {tenantId:String}
        ${projectClause}
        AND category = 'llm_call'
        AND timestamp >= {from:DateTime64(3)}
        AND timestamp <= {to:DateTime64(3)}
      GROUP BY userId, phase, model
      ORDER BY totalCost DESC
      SETTINGS max_execution_time = 15
    `,
    query_params: {
      tenantId: params.tenantId,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      from: toClickHouseDateTime(params.from),
      to: toClickHouseDateTime(params.to),
    },
    format: 'JSONEachRow',
  });

  const rows = await result.json<{
    userId: string;
    phase: string;
    model: string;
    totalCost: string;
    totalTokens: string;
    callCount: string;
  }>();

  return rows.map((row) => ({
    userId: row.userId,
    phase: row.phase,
    model: row.model,
    totalCost: Number.parseFloat(row.totalCost || '0'),
    totalTokens: Number.parseInt(row.totalTokens || '0', 10),
    callCount: Number.parseInt(row.callCount || '0', 10),
  }));
}

export function normalizeArchAuditCategories(rawCategory: string | undefined): AuditLogCategory[] {
  if (!rawCategory) {
    return [];
  }

  return rawCategory
    .split(',')
    .map((category) => category.trim())
    .filter(
      (category): category is AuditLogCategory =>
        category.length > 0 && AUDIT_LOG_CATEGORIES.includes(category as AuditLogCategory),
    );
}

export function normalizeArchAuditSeverities(rawSeverity: string | undefined): AuditLogSeverity[] {
  if (!rawSeverity) {
    return [];
  }

  return rawSeverity
    .split(',')
    .map((severity) => severity.trim())
    .filter(
      (severity): severity is AuditLogSeverity =>
        severity.length > 0 && AUDIT_LOG_SEVERITIES.includes(severity as AuditLogSeverity),
    );
}
