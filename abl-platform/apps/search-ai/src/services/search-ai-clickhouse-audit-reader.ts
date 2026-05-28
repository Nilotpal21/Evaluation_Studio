import type { AuditEventType, AuditLog } from '@abl/compiler/platform';
import {
  ClickHouseAuditReader,
  decodeClickHouseAuditRow,
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
  type ClickHouseAuditRow,
  type QueryAuditParams,
} from '@abl/compiler/platform/stores';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

const MAX_IN_MEMORY_AUDIT_FETCH = Number.MAX_SAFE_INTEGER;

export interface SearchAIAuditQueryOptions {
  tenantId: string;
  resourceType?: string;
  resourceId?: string;
  actor?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}

export interface SearchAIKnowledgeBaseActivityQueryOptions {
  tenantId: string;
  indexId?: string | null;
  sourceIds: string[];
  limit: number;
  offset: number;
}

function createBaseAuditQueryParams(
  tenantId: string,
  limit?: number,
  offset?: number,
): QueryAuditParams {
  return {
    tenantId,
    startTime: new Date(0),
    endTime: new Date(),
    limit: limit ?? 100,
    offset: offset ?? 0,
  };
}

function paginateLogs(
  logs: AuditLog[],
  limit: number,
  offset: number,
): { logs: AuditLog[]; total: number } {
  const sorted = [...logs].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return {
    logs: sorted.slice(offset, offset + limit),
    total: sorted.length,
  };
}

function matchesKnowledgeBaseActivity(
  log: AuditLog,
  indexId: string | null | undefined,
  sourceIds: string[],
): boolean {
  if (indexId && log.resourceType === 'index' && log.resourceId === indexId) {
    return true;
  }

  return log.resourceType === 'source' && sourceIds.includes(log.resourceId);
}

export async function querySearchAIAuditLogsFromClickHouse(
  options: SearchAIAuditQueryOptions,
): Promise<AuditLog[]> {
  const params = createBaseAuditQueryParams(options.tenantId, options.limit, options.offset);

  if (options.resourceType) {
    params.resourceType = options.resourceType;
  }
  if (options.resourceId) {
    params.resourceId = options.resourceId;
  }
  if (options.actor) {
    params.actor = options.actor;
  }
  if (options.eventType) {
    params.eventTypes = [options.eventType as AuditEventType];
  }

  const result = isInMemoryAuditTestBackendEnabled()
    ? await queryInMemoryAuditTestLogs(params)
    : await new ClickHouseAuditReader(getClickHouseClient(), {
        requireTenantId: true,
      }).query(params);

  return result.logs;
}

export async function queryKnowledgeBaseActivityAuditLogsFromClickHouse(
  options: SearchAIKnowledgeBaseActivityQueryOptions,
): Promise<{ logs: AuditLog[]; total: number }> {
  const sourceIds = options.sourceIds.filter((sourceId) => sourceId.length > 0);
  if (!options.indexId && sourceIds.length === 0) {
    return { logs: [], total: 0 };
  }

  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId: options.tenantId,
      startTime: new Date(0),
      endTime: new Date(),
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });

    const filtered = result.logs.filter((log) =>
      matchesKnowledgeBaseActivity(log, options.indexId, sourceIds),
    );
    return paginateLogs(filtered, options.limit, options.offset);
  }

  const client = getClickHouseClient();
  const filterClauses: string[] = [];
  const queryParams: Record<string, unknown> = {
    tenantId: options.tenantId,
    limit: options.limit,
    offset: options.offset,
  };

  if (options.indexId) {
    filterClauses.push(`(resource_type = 'index' AND resource_id = {indexId:String})`);
    queryParams.indexId = options.indexId;
  }
  if (sourceIds.length > 0) {
    filterClauses.push(`(resource_type = 'source' AND resource_id IN ({sourceIds:Array(String)}))`);
    queryParams.sourceIds = sourceIds;
  }

  const whereClause = `tenant_id = {tenantId:String} AND (${filterClauses.join(' OR ')})`;

  const countResult = await client.query({
    query: `
      SELECT count() AS cnt
      FROM abl_platform.audit_events
      WHERE ${whereClause}
      SETTINGS max_execution_time = 15
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = Number.parseInt(countRows[0]?.cnt || '0', 10);

  const queryResult = await client.query({
    query: `
      SELECT *
      FROM abl_platform.audit_events
      WHERE ${whereClause}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 15
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const rows = await queryResult.json<ClickHouseAuditRow>();

  return {
    logs: rows.map((row) => decodeClickHouseAuditRow(row)),
    total,
  };
}
