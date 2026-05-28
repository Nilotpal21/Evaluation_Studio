import type { AuditLog, AuditEventType, Environment } from '../core/types.js';
import type { AuditReader } from './audit-pipeline.js';
import type { AuditSummary, QueryAuditParams } from './audit-store.js';
import {
  decodeSharedAuditRecord,
  toAuditLog,
  type SharedAuditRecord,
} from './shared-audit-codec.js';

const CLICKHOUSE_AUDIT_TABLE_NAME_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

export function formatClickHouseAuditTimestamp(timestamp: Date): string {
  return timestamp
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');
}

function normalizeClickHouseAuditTableName(tableName: string): string {
  if (!CLICKHOUSE_AUDIT_TABLE_NAME_RE.test(tableName)) {
    throw new Error(`Invalid ClickHouse audit table name: ${tableName}`);
  }

  return tableName;
}

function parseClickHouseTimestamp(timestamp: string | Date): Date {
  if (timestamp instanceof Date) {
    return timestamp;
  }

  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return new Date(timestamp);
  }

  return new Date(timestamp.replace(' ', 'T') + 'Z');
}

function buildEnvironmentExpression(): string {
  return `if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev')`;
}

export interface ClickHouseAuditRow {
  tenant_id: string;
  timestamp: string;
  action: string;
  event_id: string;
  actor_id: string;
  actor_type: string;
  actor_ip: string;
  actor_user_agent: string;
  resource_type: string;
  resource_id: string;
  session_id: string;
  project_id: string;
  old_value: string;
  new_value: string;
  metadata: string;
  success: number;
  failure_reason: string;
  event_type?: string;
  source?: string;
  environment?: string;
}

export interface ClickHouseAuditReaderOptions {
  tenantId?: string;
  requireTenantId?: boolean;
  tableName?: string;
}

export interface ClickHouseQueryResult {
  json<T>(): Promise<T[]>;
}

export interface ClickHouseQueryClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format: 'JSONEachRow';
  }): Promise<ClickHouseQueryResult>;
}

export function mapClickHouseAuditRowToSharedAuditRecord(
  row: ClickHouseAuditRow,
): SharedAuditRecord {
  return {
    _id: row.event_id,
    userId: row.actor_id || null,
    tenantId: row.tenant_id || null,
    action: row.action || null,
    ip: row.actor_ip || null,
    userAgent: row.actor_user_agent || null,
    metadata: row.metadata || null,
    eventType: row.event_type || null,
    actorType: row.actor_type || null,
    projectId: row.project_id || null,
    resourceType: row.resource_type || null,
    resourceId: row.resource_id || null,
    environment: row.environment || null,
    traceId: row.session_id || null,
    source: row.source || null,
    createdAt: row.timestamp,
  };
}

export function decodeClickHouseAuditRow(row: ClickHouseAuditRow): AuditLog {
  const decoded = decodeSharedAuditRecord(mapClickHouseAuditRowToSharedAuditRecord(row));
  const parsedOldValue = row.old_value
    ? (tryParseJson(row.old_value) as Record<string, unknown> | undefined)
    : undefined;
  const parsedNewValue = row.new_value
    ? (tryParseJson(row.new_value) as Record<string, unknown> | undefined)
    : undefined;

  if (decoded.envelope) {
    return toAuditLog(
      {
        ...decoded.envelope,
        oldValue: parsedOldValue ?? decoded.envelope.oldValue,
        newValue: parsedNewValue ?? decoded.envelope.newValue,
      },
      row.event_id,
    );
  }

  const parsedMetadata = (tryParseJson(row.metadata) as Record<string, unknown> | undefined) ?? {};

  return {
    id: row.event_id,
    tenantId: row.tenant_id || 'unscoped',
    projectId: row.project_id || undefined,
    timestamp: parseClickHouseTimestamp(row.timestamp),
    eventType: ((parsedMetadata.eventType as string | undefined) || row.action) as AuditEventType,
    actor: row.actor_id || 'system',
    actorType: (row.actor_type || 'unknown') as AuditLog['actorType'],
    resourceType: (row.resource_type || 'agent') as AuditLog['resourceType'],
    resourceId: row.resource_id || '',
    environment: (parsedMetadata.environment as Environment | undefined) ?? 'dev',
    action: row.action,
    oldValue: parsedOldValue,
    newValue: parsedNewValue,
    metadata: parsedMetadata,
    ipAddress: row.actor_ip || undefined,
    traceId: row.session_id || undefined,
  };
}

export class ClickHouseAuditReader implements AuditReader {
  private readonly tableName: string;
  private readonly tenantId?: string;
  private readonly requireTenantId: boolean;

  constructor(
    private readonly client: ClickHouseQueryClient,
    options: ClickHouseAuditReaderOptions = {},
  ) {
    this.tableName = normalizeClickHouseAuditTableName(
      options.tableName ?? 'abl_platform.audit_events',
    );
    this.tenantId = options.tenantId;
    this.requireTenantId = options.requireTenantId ?? true;
  }

  private resolveReadTenantId(explicitTenantId?: string, scope?: string): string | undefined {
    const scopedTenantId =
      typeof scope === 'string' && scope.length > 0 && scope !== 'unscoped' ? scope : undefined;
    const tenantId = explicitTenantId ?? scopedTenantId ?? this.tenantId;

    if (this.requireTenantId && !tenantId) {
      throw new Error('tenantId is required for ClickHouse audit reads');
    }

    return tenantId;
  }

  async query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }> {
    const tenantId = this.resolveReadTenantId(params.tenantId);
    const canonicalEventTypeExpr = `if(JSONExtractString(metadata, 'eventType') != '', JSONExtractString(metadata, 'eventType'), action)`;
    const conditions = [`timestamp >= {startTime:DateTime}`, `timestamp <= {endTime:DateTime}`];
    const queryParams: Record<string, unknown> = {
      startTime: formatClickHouseAuditTimestamp(params.startTime),
      endTime: formatClickHouseAuditTimestamp(params.endTime),
    };

    if (tenantId) {
      conditions.unshift(`tenant_id = {tenantId:String}`);
      queryParams.tenantId = tenantId;
    }
    if (params.projectId) {
      conditions.push(`project_id = {projectId:String}`);
      queryParams.projectId = params.projectId;
    }
    if (params.eventTypes && params.eventTypes.length > 0) {
      conditions.push(`${canonicalEventTypeExpr} IN ({eventTypes:Array(String)})`);
      queryParams.eventTypes = params.eventTypes;
    }
    if (params.actions && params.actions.length > 0) {
      conditions.push(`action IN ({actions:Array(String)})`);
      queryParams.actions = params.actions;
    }
    if (params.actor) {
      conditions.push(`actor_id = {actorId:String}`);
      queryParams.actorId = params.actor;
    }
    if (params.actorType) {
      conditions.push(`actor_type = {actorType:String}`);
      queryParams.actorType = params.actorType;
    }
    if (params.resourceType) {
      conditions.push(`resource_type = {resourceType:String}`);
      queryParams.resourceType = params.resourceType;
    }
    if (params.resourceId) {
      conditions.push(`resource_id = {resourceId:String}`);
      queryParams.resourceId = params.resourceId;
    }
    if (params.environment) {
      conditions.push(`${buildEnvironmentExpression()} = {environment:String}`);
      queryParams.environment = params.environment;
    }

    const offset = params.offset || 0;
    const limit = params.limit || 100;
    const whereClause = conditions.join(' AND ');

    const countResult = await this.client.query({
      query: `SELECT count() AS cnt FROM ${this.tableName} WHERE ${whereClause} SETTINGS max_execution_time = 15`,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    const countRows = await countResult.json<{ cnt: string }>();
    const total = parseInt(countRows[0]?.cnt || '0', 10);

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${this.tableName}
        WHERE ${whereClause}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 15
      `,
      query_params: { ...queryParams, limit, offset },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseAuditRow>();

    return {
      logs: rows.map((row) => decodeClickHouseAuditRow(row)),
      total,
    };
  }

  async getSummary(
    scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary> {
    const tenantId = this.resolveReadTenantId(undefined, scope);
    const conditions = [
      `timestamp >= {startTime:DateTime}`,
      `timestamp <= {endTime:DateTime}`,
      `${buildEnvironmentExpression()} = {environment:String}`,
    ];
    const queryParams: Record<string, unknown> = {
      environment,
      startTime: formatClickHouseAuditTimestamp(startTime),
      endTime: formatClickHouseAuditTimestamp(endTime),
    };

    if (tenantId) {
      conditions.unshift(`tenant_id = {tenantId:String}`);
      queryParams.tenantId = tenantId;
    }

    const result = await this.client.query({
      query: `
        SELECT
          if(JSONExtractString(metadata, 'eventType') != '', JSONExtractString(metadata, 'eventType'), action) AS event_type,
          actor_id,
          resource_type,
          count() AS cnt
        FROM ${this.tableName}
        WHERE ${conditions.join(' AND ')}
        GROUP BY event_type, actor_id, resource_type
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      event_type: string;
      actor_id: string;
      resource_type: string;
      cnt: string;
    }>();

    const eventsByType: Record<string, number> = {};
    const eventsByActor: Record<string, number> = {};
    const eventsByResource: Record<string, number> = {};
    let totalEvents = 0;

    for (const row of rows) {
      const cnt = parseInt(row.cnt, 10);
      totalEvents += cnt;
      eventsByType[row.event_type] = (eventsByType[row.event_type] || 0) + cnt;
      eventsByActor[row.actor_id] = (eventsByActor[row.actor_id] || 0) + cnt;
      eventsByResource[row.resource_type] = (eventsByResource[row.resource_type] || 0) + cnt;
    }

    return {
      totalEvents,
      eventsByType: eventsByType as Record<AuditEventType, number>,
      eventsByActor,
      eventsByResource,
    };
  }

  async getByTraceId(scope: string, traceId: string): Promise<AuditLog[]> {
    const tenantId = this.resolveReadTenantId(undefined, scope);
    const conditions = [
      `(session_id = {traceId:String} OR JSONExtractString(metadata, 'traceId') = {traceId:String})`,
    ];
    const queryParams: Record<string, unknown> = { traceId };

    if (tenantId) {
      conditions.unshift(`tenant_id = {tenantId:String}`);
      queryParams.tenantId = tenantId;
    }

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${this.tableName}
        WHERE ${conditions.join(' AND ')}
        ORDER BY timestamp ASC
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseAuditRow>();
    return rows.map((row) => decodeClickHouseAuditRow(row));
  }

  async close(): Promise<void> {
    // Reader lifecycle is a no-op because the shared ClickHouse client is owned externally.
  }
}
