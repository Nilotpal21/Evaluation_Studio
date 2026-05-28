import {
  getClickHouseClient,
  parseClickHouseTimestamp,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import {
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
} from '@abl/compiler/platform/stores';

const ARCH_AUDIT_TABLE = 'abl_platform.arch_audit_log';
const ARCH_PAYLOAD_TABLE = 'abl_platform.arch_audit_payloads';
const MAX_SESSION_TREE_EVENTS = 5_000;

export interface SessionListItem {
  sessionId: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  totalCost: number;
  errorCount: number;
  turnCount: number;
  lastPhase: string;
}

export interface SessionListQuery {
  tenantId: string;
  projectId?: string;
  userId?: string;
  from: Date;
  to: Date;
  hasErrors?: boolean;
  minCost?: number;
  limit: number;
  offset: number;
}

export async function querySessionList(query: SessionListQuery): Promise<{
  sessions: SessionListItem[];
  total: number;
}> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return querySessionListFromMemory(query);
  }
  const client = getClickHouseClient();
  const clauses = [
    'tenant_id = {tenantId:String}',
    'timestamp >= {from:DateTime64(3)}',
    'timestamp <= {to:DateTime64(3)}',
  ];
  const params: Record<string, unknown> = {
    tenantId: query.tenantId,
    from: toClickHouseDateTime(query.from),
    to: toClickHouseDateTime(query.to),
  };

  if (query.projectId) {
    clauses.push('project_id = {projectId:String}');
    params.projectId = query.projectId;
  }
  if (query.userId) {
    clauses.push('user_id = {userId:String}');
    params.userId = query.userId;
  }

  const whereClause = clauses.join(' AND ');
  const havingClause: string[] = [];
  if (query.hasErrors) havingClause.push('error_count > 0');
  if (query.minCost) {
    havingClause.push('total_cost >= {minCost:Float64}');
    params.minCost = query.minCost;
  }
  const havingSql = havingClause.length > 0 ? `HAVING ${havingClause.join(' AND ')}` : '';

  const countResult = await client.query({
    query: `
      SELECT count() AS cnt FROM (
        SELECT
          session_id,
          sum(estimated_cost) AS total_cost,
          countIf(severity IN ('error', 'critical')) AS error_count
        FROM ${ARCH_AUDIT_TABLE}
        WHERE ${whereClause}
        GROUP BY session_id, user_id
        ${havingSql}
      )
      SETTINGS max_execution_time = 15
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = Number.parseInt(countRows[0]?.cnt || '0', 10);

  const result = await client.query({
    query: `
      SELECT
        session_id,
        user_id,
        min(timestamp) AS started_at,
        max(timestamp) AS ended_at,
        sum(estimated_cost) AS total_cost,
        countIf(severity IN ('error', 'critical')) AS error_count,
        countIf(span_kind = 'turn') AS turn_count,
        max(phase_label) AS last_phase
      FROM ${ARCH_AUDIT_TABLE}
      WHERE ${whereClause}
      GROUP BY session_id, user_id
      ${havingSql}
      ORDER BY started_at DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 15
    `,
    query_params: { ...params, limit: query.limit, offset: query.offset },
    format: 'JSONEachRow',
  });

  const rows = await result.json<Record<string, string>>();
  const sessions: SessionListItem[] = rows.map((r) => ({
    sessionId: r.session_id,
    userId: r.user_id,
    startedAt: parseClickHouseTimestamp(r.started_at).toISOString(),
    endedAt: parseClickHouseTimestamp(r.ended_at).toISOString(),
    totalCost: Number.parseFloat(r.total_cost || '0'),
    errorCount: Number.parseInt(r.error_count || '0', 10),
    turnCount: Number.parseInt(r.turn_count || '0', 10),
    lastPhase: r.last_phase || '',
  }));

  return { sessions, total };
}

export interface SessionTreeEvent {
  eventId: string;
  timestamp: string;
  category: string;
  severity: string;
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number; estimatedCost: number };
  turnId: string;
  parentEventId: string;
  phaseLabel: string;
  retryOf: string;
  retryIndex: number;
  nestingDepth: number;
  spanKind: string;
}

export async function querySessionTree(
  tenantId: string,
  sessionId: string,
  projectId?: string,
): Promise<SessionTreeEvent[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return querySessionTreeFromMemory(tenantId, sessionId);
  }
  const client = getClickHouseClient();
  const projectClause = projectId ? 'AND project_id = {projectId:String}' : '';

  const result = await client.query({
    query: `
      SELECT
        event_id,
        timestamp,
        category,
        severity,
        summary,
        detail,
        specialist,
        phase,
        duration_ms,
        input_tokens,
        output_tokens,
        total_tokens,
        estimated_cost,
        turn_id,
        parent_event_id,
        phase_label,
        retry_of,
        retry_index,
        nesting_depth,
        span_kind
      FROM ${ARCH_AUDIT_TABLE}
      WHERE tenant_id = {tenantId:String}
        AND session_id = {sessionId:String}
        ${projectClause}
      ORDER BY timestamp ASC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 15
    `,
    query_params: {
      tenantId,
      sessionId,
      limit: MAX_SESSION_TREE_EVENTS,
      ...(projectId ? { projectId } : {}),
    },
    format: 'JSONEachRow',
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    eventId: String(r.event_id ?? ''),
    timestamp: parseClickHouseTimestamp(String(r.timestamp ?? '')).toISOString(),
    category: String(r.category ?? ''),
    severity: String(r.severity ?? ''),
    summary: String(r.summary ?? ''),
    detail: parseJsonSafe(String(r.detail ?? '{}')),
    specialist: String(r.specialist ?? '') || undefined,
    phase: String(r.phase ?? '') || undefined,
    durationMs: Number(r.duration_ms) || undefined,
    tokens: buildTokens(r),
    turnId: String(r.turn_id ?? ''),
    parentEventId: String(r.parent_event_id ?? ''),
    phaseLabel: String(r.phase_label ?? ''),
    retryOf: String(r.retry_of ?? ''),
    retryIndex: Number(r.retry_index ?? 0),
    nestingDepth: Number(r.nesting_depth ?? 255),
    spanKind: String(r.span_kind ?? ''),
  }));
}

function parseJsonSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildTokens(r: Record<string, unknown>) {
  const input = Number(r.input_tokens ?? 0);
  const output = Number(r.output_tokens ?? 0);
  const total = Number(r.total_tokens ?? 0);
  const cost = Number(r.estimated_cost ?? 0);
  if (input === 0 && output === 0 && total === 0 && cost === 0) return undefined;
  return { input, output, total, estimatedCost: cost };
}

export interface SparklinePoint {
  hour: string;
  sessions: number;
  cost: number;
  errors: number;
}

export async function querySparklineData(
  tenantId: string,
  projectId?: string,
): Promise<SparklinePoint[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return [];
  }
  const client = getClickHouseClient();
  const projectClause = projectId ? 'AND project_id = {projectId:String}' : '';

  const result = await client.query({
    query: `
      SELECT
        toStartOfHour(timestamp) AS hour,
        uniqExact(session_id) AS sessions,
        sum(estimated_cost) AS cost,
        countIf(severity IN ('error', 'critical')) AS errors
      FROM ${ARCH_AUDIT_TABLE}
      WHERE tenant_id = {tenantId:String}
        ${projectClause}
        AND timestamp >= now() - INTERVAL 24 HOUR
      GROUP BY hour
      ORDER BY hour ASC
      SETTINGS max_execution_time = 15
    `,
    query_params: { tenantId, ...(projectId ? { projectId } : {}) },
    format: 'JSONEachRow',
  });

  const rows = await result.json<Record<string, string>>();
  return rows.map((r) => ({
    hour: parseClickHouseTimestamp(r.hour).toISOString(),
    sessions: Number.parseInt(r.sessions || '0', 10),
    cost: Number.parseFloat(r.cost || '0'),
    errors: Number.parseInt(r.errors || '0', 10),
  }));
}

export async function queryPayload(
  tenantId: string,
  eventId: string,
): Promise<{ payloadType: string; content: string; contentSizeBytes: number } | null> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return null;
  }
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT payload_type, content, content_size_bytes
      FROM ${ARCH_PAYLOAD_TABLE}
      WHERE tenant_id = {tenantId:String} AND event_id = {eventId:String}
      LIMIT 1
      SETTINGS max_execution_time = 10
    `,
    query_params: { tenantId, eventId },
    format: 'JSONEachRow',
  });

  const rows = await result.json<Record<string, string>>();
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    payloadType: r.payload_type,
    content: r.content,
    contentSizeBytes: Number.parseInt(r.content_size_bytes || '0', 10),
  };
}

export async function queryPayloadsBatch(
  tenantId: string,
  eventIds: string[],
): Promise<Array<{ eventId: string; payloadType: string; content: string }>> {
  if (eventIds.length === 0) return [];
  if (isInMemoryAuditTestBackendEnabled()) {
    return [];
  }
  const capped = eventIds.slice(0, 50);
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT event_id, payload_type, content
      FROM ${ARCH_PAYLOAD_TABLE}
      WHERE tenant_id = {tenantId:String} AND event_id IN ({eventIds:Array(String)})
      SETTINGS max_execution_time = 10
    `,
    query_params: { tenantId, eventIds: capped },
    format: 'JSONEachRow',
  });

  const rows = await result.json<Record<string, string>>();
  return rows.map((r) => ({
    eventId: r.event_id,
    payloadType: r.payload_type,
    content: r.content,
  }));
}

// ─── In-Memory Backend Fallbacks (local dev without ClickHouse/Kafka) ────────

function isArchStream(log: { eventType: string }): boolean {
  return log.eventType.startsWith('arch.');
}

function getMetaStr(meta: Record<string, unknown>, key: string): string {
  const v = meta[key];
  return typeof v === 'string' ? v : '';
}

function getMetaNum(meta: Record<string, unknown>, key: string, fallback = 0): number {
  const v = meta[key];
  return typeof v === 'number' ? v : fallback;
}

async function querySessionListFromMemory(query: SessionListQuery): Promise<{
  sessions: SessionListItem[];
  total: number;
}> {
  const { logs } = await queryInMemoryAuditTestLogs({
    tenantId: query.tenantId,
    resourceType: 'arch_session',
    startTime: query.from,
    endTime: query.to,
    limit: 10000,
    offset: 0,
  });

  const archLogs = logs.filter(isArchStream);
  const grouped = new Map<string, typeof archLogs>();
  for (const log of archLogs) {
    const sid = log.resourceId;
    if (!sid) continue;
    if (query.projectId && log.projectId !== query.projectId) continue;
    if (query.userId && log.actor !== query.userId) continue;
    const arr = grouped.get(sid) ?? [];
    arr.push(log);
    grouped.set(sid, arr);
  }

  let sessions: SessionListItem[] = [];
  for (const [sessionId, entries] of grouped) {
    const meta0 = (entries[0].metadata ?? {}) as Record<string, unknown>;
    const errorCount = entries.filter(
      (e) =>
        (e.metadata as Record<string, unknown>)?.severity === 'error' ||
        (e.metadata as Record<string, unknown>)?.severity === 'critical',
    ).length;
    const turnCount = entries.filter(
      (e) => getMetaStr(e.metadata as Record<string, unknown>, 'spanKind') === 'turn',
    ).length;
    const tokens = entries.reduce((sum, e) => {
      const t = (e.metadata as Record<string, unknown>)?.tokens as
        | Record<string, unknown>
        | undefined;
      return sum + (t ? getMetaNum(t, 'estimatedCost') : 0);
    }, 0);

    sessions.push({
      sessionId,
      userId: entries[0].actor ?? '',
      startedAt: entries[0].timestamp.toISOString(),
      endedAt: entries[entries.length - 1].timestamp.toISOString(),
      totalCost: tokens,
      errorCount,
      turnCount,
      lastPhase: getMetaStr(meta0, 'phase'),
    });
  }

  if (query.hasErrors) {
    sessions = sessions.filter((s) => s.errorCount > 0);
  }

  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const total = sessions.length;
  const paged = sessions.slice(query.offset, query.offset + query.limit);
  return { sessions: paged, total };
}

async function querySessionTreeFromMemory(
  tenantId: string,
  sessionId: string,
): Promise<SessionTreeEvent[]> {
  const { logs } = await queryInMemoryAuditTestLogs({
    tenantId,
    resourceType: 'arch_session',
    startTime: new Date(0),
    endTime: new Date(),
    limit: 10000,
    offset: 0,
  });

  return logs
    .filter(
      (log) =>
        log.resourceId === sessionId &&
        isArchStream(log) &&
        !String(log.eventType).startsWith('arch.payload.'),
    )
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((log) => {
      const meta = (log.metadata ?? {}) as Record<string, unknown>;
      const tokens = meta.tokens as Record<string, unknown> | undefined;
      return {
        eventId: log.id,
        timestamp: log.timestamp.toISOString(),
        category: getMetaStr(meta, 'category'),
        severity: getMetaStr(meta, 'severity') || 'info',
        summary: getMetaStr(meta, 'summary'),
        detail: (meta.detail as Record<string, unknown>) ?? {},
        specialist: getMetaStr(meta, 'specialist') || undefined,
        phase: getMetaStr(meta, 'phase') || undefined,
        durationMs: getMetaNum(meta, 'durationMs') || undefined,
        tokens: tokens
          ? {
              input: getMetaNum(tokens, 'input'),
              output: getMetaNum(tokens, 'output'),
              total: getMetaNum(tokens, 'total'),
              estimatedCost: getMetaNum(tokens, 'estimatedCost'),
            }
          : undefined,
        turnId: getMetaStr(meta, 'turnId'),
        parentEventId: getMetaStr(meta, 'parentEventId'),
        phaseLabel: getMetaStr(meta, 'phaseLabel'),
        retryOf: getMetaStr(meta, 'retryOf'),
        retryIndex: getMetaNum(meta, 'retryIndex'),
        nestingDepth: getMetaNum(meta, 'nestingDepth', 255),
        spanKind: getMetaStr(meta, 'spanKind'),
      };
    });
}
