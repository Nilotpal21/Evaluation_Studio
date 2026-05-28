import { z } from 'zod';
import type {
  AuditActorType,
  AuditEventType,
  AuditResourceType,
  Environment,
} from '@abl/compiler/platform';
import {
  decodeClickHouseAuditRow,
  formatClickHouseAuditTimestamp,
  type ClickHouseAuditRow,
} from '@abl/compiler/platform/stores';
import type { AuditLog } from '@abl/compiler/platform/core/types';
import {
  AUDIT_EXPLORER_CATEGORIES,
  getComplianceAuditExplorerValues,
  getAuditExplorerCategoryValues,
  type AuditExplorerCategory,
} from './audit-explorer-catalog';

const MAX_AUDIT_QUERY_LIMIT = 200;
const DEFAULT_AUDIT_QUERY_LIMIT = 50;
const METADATA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const auditActorTypeSchema = z.enum(['user', 'admin', 'agent', 'system', 'unknown']);
const auditEnvironmentSchema = z.enum(['dev', 'staging', 'production']);
const auditCategorySchema = z.enum(AUDIT_EXPLORER_CATEGORIES);
const LEGACY_AUDIT_CATEGORY_ALIASES: Partial<Record<string, AuditExplorerCategory>> = {
  project_agent_lifecycle: 'project_agent_configuration',
  connectors_crawl: 'connector_configuration',
};
const RETIRED_AUDIT_CATEGORIES = new Set(['runtime_sessions_traces', 'system_plugin']);

function buildValidationError(path: string, message: string): z.ZodError {
  return new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [path],
      message,
    },
  ]);
}

const arrayParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const values = Array.isArray(value)
      ? value.flatMap((item) => item.split(','))
      : value.split(',');
    const normalized = values.map((item) => item.trim()).filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  });

const numberParam = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    if (!/^-?\d+$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an integer',
      });
      return z.NEVER;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a safe integer',
      });
      return z.NEVER;
    }
    return parsed;
  });

const rawAuditExplorerQuerySchema = z
  .object({
    scope: z.enum(['personal', 'workspace']).optional(),
    personalScopeMode: z.literal('tenant-safe').optional(),
    action: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    limit: numberParam,
    offset: numberParam,
    cursor: z.string().min(1).optional(),
    q: z.string().trim().min(1).optional(),
    categories: arrayParam,
    eventTypes: arrayParam,
    actions: arrayParam,
    actor: z.string().min(1).optional(),
    actorTypes: arrayParam,
    projectId: z.string().min(1).optional(),
    resourceTypes: arrayParam,
    resourceId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    sources: arrayParam,
    environments: arrayParam,
    success: z.enum(['success', 'failure']).optional(),
    ipAddress: z.string().min(1).optional(),
    metadataKey: z.string().min(1).optional(),
    metadataValue: z.string().min(1).optional(),
    includeFacets: z.enum(['true', 'false']).optional(),
  })
  .strict();

export interface StudioAuditExplorerQuery {
  scope: 'personal' | 'workspace';
  personalScopeMode: 'tenant-safe';
  action?: string;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
  cursor?: string;
  query?: string;
  categories?: AuditExplorerCategory[];
  eventTypes?: AuditEventType[];
  actions?: string[];
  actor?: string;
  actorTypes?: AuditActorType[];
  projectId?: string;
  resourceTypes?: AuditResourceType[];
  resourceId?: string;
  traceId?: string;
  sources?: string[];
  environments?: Environment[];
  success?: 'success' | 'failure';
  ipAddress?: string;
  metadataKey?: string;
  metadataValue?: string;
  includeFacets: boolean;
}

export interface StudioAuditExplorerRow extends AuditLog {
  category?: string;
}

export interface StudioAuditExplorerQueryResult {
  logs: StudioAuditExplorerRow[];
  total: number;
  nextCursor?: string;
}

export interface StudioAuditExplorerSql {
  rowsQuery: string;
  countQuery: string;
  queryParams: Record<string, unknown>;
  rowQueryParams: Record<string, unknown>;
  limit: number;
}

export interface StudioAuditExplorerClickHouseClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format: 'JSONEachRow';
  }): Promise<{
    json<T>(): Promise<T[]>;
  }>;
}

function getAllSearchParams(searchParams: URLSearchParams): Record<string, string | string[]> {
  const raw: Record<string, string | string[]> = {};

  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key);
    raw[key] = values.length > 1 ? values : (values[0] ?? '');
  }

  return raw;
}

function normalizeLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_AUDIT_QUERY_LIMIT;
  return Math.min(limit, MAX_AUDIT_QUERY_LIMIT);
}

function normalizeOffset(offset?: number): number {
  if (!offset || offset < 0) return 0;
  return offset;
}

function parseTypedArray<T extends string>(
  values: string[] | undefined,
  schema: z.ZodType<T>,
): T[] | undefined {
  if (!values) return undefined;
  const parsed = values.map((value) => schema.parse(value));
  return parsed.length > 0 ? parsed : undefined;
}

function parseAuditCategories(values: string[] | undefined): AuditExplorerCategory[] | undefined {
  if (!values) return undefined;
  const categories = new Set<AuditExplorerCategory>();

  for (const value of values) {
    const alias = LEGACY_AUDIT_CATEGORY_ALIASES[value];
    if (alias) {
      categories.add(alias);
      continue;
    }
    if (RETIRED_AUDIT_CATEGORIES.has(value)) {
      continue;
    }
    categories.add(auditCategorySchema.parse(value));
  }

  return categories.size > 0 ? [...categories] : undefined;
}

export function parseStudioAuditExplorerQuery(searchParams: URLSearchParams) {
  const raw = rawAuditExplorerQuerySchema.parse(getAllSearchParams(searchParams));
  const actions = [...(raw.actions ?? [])];
  if (raw.action) {
    actions.push(raw.action);
  }

  const metadataKey = raw.metadataKey;
  if (metadataKey && !METADATA_KEY_RE.test(metadataKey)) {
    throw buildValidationError('metadataKey', 'metadataKey must be a safe metadata path');
  }

  const query: StudioAuditExplorerQuery = {
    scope: raw.scope ?? 'personal',
    personalScopeMode: 'tenant-safe',
    action: raw.action,
    from: raw.from ?? null,
    to: raw.to ?? null,
    limit: normalizeLimit(raw.limit),
    offset: normalizeOffset(raw.offset),
    cursor: raw.cursor,
    query: raw.q,
    categories: parseAuditCategories(raw.categories),
    eventTypes: raw.eventTypes as AuditEventType[] | undefined,
    actions: actions.length > 0 ? [...new Set(actions)] : undefined,
    actor: raw.actor,
    actorTypes: parseTypedArray(raw.actorTypes, auditActorTypeSchema),
    projectId: raw.projectId,
    resourceTypes: raw.resourceTypes as AuditResourceType[] | undefined,
    resourceId: raw.resourceId,
    traceId: raw.traceId ?? raw.sessionId,
    sources: raw.sources,
    environments: parseTypedArray(raw.environments, auditEnvironmentSchema),
    success: raw.success,
    ipAddress: raw.ipAddress,
    metadataKey,
    metadataValue: raw.metadataValue,
    includeFacets: raw.includeFacets === 'true',
  };

  if ((query.query || query.metadataKey || query.metadataValue) && (!query.from || !query.to)) {
    throw buildValidationError('from', 'from and to are required for search and metadata filters');
  }

  const startTime = query.from ? new Date(query.from) : null;
  const endTime = query.to ? new Date(query.to) : null;
  if (startTime && Number.isNaN(startTime.getTime())) {
    throw buildValidationError('from', 'from must be a valid date');
  }
  if (endTime && Number.isNaN(endTime.getTime())) {
    throw buildValidationError('to', 'to must be a valid date');
  }
  if (startTime && endTime && startTime.getTime() > endTime.getTime()) {
    throw buildValidationError('from', 'from must be before to');
  }

  return query;
}

function resolveDateRange(from?: string | null, to?: string | null) {
  const startTime = from ? new Date(from) : new Date(0);
  const endTime = to ? new Date(to) : new Date();

  return {
    startTime: Number.isNaN(startTime.getTime()) ? new Date(0) : startTime,
    endTime: Number.isNaN(endTime.getTime()) ? new Date() : endTime,
  };
}

function addArrayCondition(
  conditions: string[],
  queryParams: Record<string, unknown>,
  expression: string,
  paramName: string,
  values?: readonly string[],
) {
  if (!values || values.length === 0) return;
  conditions.push(`${expression} IN ({${paramName}:Array(String)})`);
  queryParams[paramName] = [...values];
}

function addAuditValueCondition(
  conditions: string[],
  queryParams: Record<string, unknown>,
  options: {
    canonicalEventTypeExpr: string;
    values: readonly string[];
    prefixes: readonly string[];
    valueParamName: string;
    prefixParamPrefix: string;
  },
) {
  const valueConditions: string[] = [];
  if (options.values.length > 0) {
    valueConditions.push(
      `(${options.canonicalEventTypeExpr} IN ({${options.valueParamName}:Array(String)}) OR action IN ({${options.valueParamName}:Array(String)}))`,
    );
    queryParams[options.valueParamName] = [...options.values];
  }

  options.prefixes.forEach((prefix, index) => {
    const paramName = `${options.prefixParamPrefix}${index}`;
    valueConditions.push(
      `(startsWith(${options.canonicalEventTypeExpr}, {${paramName}:String}) OR startsWith(action, {${paramName}:String}))`,
    );
    queryParams[paramName] = prefix;
  });

  if (valueConditions.length > 0) {
    conditions.push(`(${valueConditions.join(' OR ')})`);
  }
}

function buildSearchCondition(queryParamName: string): string {
  return `(
    positionCaseInsensitive(event_type, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(action, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(actor_id, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(resource_type, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(resource_id, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(project_id, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(session_id, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(actor_ip, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(source, {${queryParamName}:String}) > 0 OR
    positionCaseInsensitive(metadata, {${queryParamName}:String}) > 0
  )`;
}

function buildStudioAuditUnionSubquery(baseWhereClause: string): string {
  return `
    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      action,
      event_id,
      actor_id,
      actor_type,
      actor_ip,
      actor_user_agent,
      resource_type,
      resource_id,
      session_id,
      project_id,
      old_value,
      new_value,
      metadata,
      success,
      failure_reason,
      if(JSONExtractString(metadata, 'eventType') != '', JSONExtractString(metadata, 'eventType'), action) AS event_type,
      if(JSONExtractString(metadata, 'source') != '', JSONExtractString(metadata, 'source'), JSONExtractString(metadata, 'auditSource')) AS source,
      if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev') AS environment
    FROM abl_platform.audit_events
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      operation AS action,
      event_id,
      actor_id,
      actor_type,
      actor_ip,
      '' AS actor_user_agent,
      'kms_key' AS resource_type,
      key_id AS resource_id,
      '' AS session_id,
      project_id,
      '' AS old_value,
      '' AS new_value,
      metadata,
      success,
      error_message AS failure_reason,
      operation AS event_type,
      'admin' AS source,
      if(environment != '', environment, 'dev') AS environment
    FROM abl_platform.kms_audit_log
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      action,
      event_id,
      JSONExtractString(metadata, 'actorId') AS actor_id,
      if(JSONExtractString(metadata, 'actorType') != '', JSONExtractString(metadata, 'actorType'), 'system') AS actor_type,
      '' AS actor_ip,
      '' AS actor_user_agent,
      'pii_token' AS resource_type,
      token_id AS resource_id,
      if(trace_id != '', trace_id, session_id) AS session_id,
      project_id,
      '' AS old_value,
      '' AS new_value,
      metadata,
      1 AS success,
      '' AS failure_reason,
      action AS event_type,
      'runtime-store' AS source,
      if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev') AS environment
    FROM abl_platform.pii_audit_log
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      event AS action,
      event_id,
      actor AS actor_id,
      actor_type,
      '' AS actor_ip,
      '' AS actor_user_agent,
      'connector' AS resource_type,
      connector_id AS resource_id,
      '' AS session_id,
      JSONExtractString(metadata, 'projectId') AS project_id,
      '' AS old_value,
      '' AS new_value,
      metadata,
      1 AS success,
      '' AS failure_reason,
      event AS event_type,
      'search-ai' AS source,
      if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev') AS environment
    FROM abl_platform.connector_audit_log
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      event_type AS action,
      event_id,
      user_id AS actor_id,
      'user' AS actor_type,
      '' AS actor_ip,
      '' AS actor_user_agent,
      'crawl_job' AS resource_type,
      crawl_job_id AS resource_id,
      '' AS session_id,
      JSONExtractString(metadata, 'projectId') AS project_id,
      changes_before AS old_value,
      changes_after AS new_value,
      metadata,
      if(severity = 'error', 0, 1) AS success,
      if(severity = 'error', description, '') AS failure_reason,
      event_type AS event_type,
      'search-ai' AS source,
      if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev') AS environment
    FROM abl_platform.crawl_audit_events
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      category AS action,
      event_id,
      user_id AS actor_id,
      'user' AS actor_type,
      '' AS actor_ip,
      '' AS actor_user_agent,
      'arch_session' AS resource_type,
      session_id AS resource_id,
      session_id,
      project_id,
      '' AS old_value,
      '' AS new_value,
      metadata,
      if(severity = 'error', 0, 1) AS success,
      if(severity = 'error', summary, '') AS failure_reason,
      category AS event_type,
      'studio' AS source,
      if(JSONExtractString(metadata, 'environment') != '', JSONExtractString(metadata, 'environment'), 'dev') AS environment
    FROM abl_platform.arch_audit_log
    WHERE ${baseWhereClause}

    UNION ALL

    SELECT
      tenant_id,
      toDateTime(timestamp) AS timestamp,
      event_type AS action,
      event_id,
      JSONExtractString(data, 'actorId') AS actor_id,
      if(JSONExtractString(data, 'actorType') != '', JSONExtractString(data, 'actorType'), 'system') AS actor_type,
      '' AS actor_ip,
      '' AS actor_user_agent,
      'omnichannel_session' AS resource_type,
      session_id AS resource_id,
      session_id,
      project_id,
      '' AS old_value,
      '' AS new_value,
      data AS metadata,
      1 AS success,
      '' AS failure_reason,
      event_type AS event_type,
      'runtime-store' AS source,
      if(JSONExtractString(data, 'environment') != '', JSONExtractString(data, 'environment'), 'dev') AS environment
    FROM abl_platform.omnichannel_audit_log
    WHERE ${baseWhereClause}
  `;
}

export function buildStudioAuditExplorerSql(
  options: StudioAuditExplorerQuery & { tenantId: string; userId: string },
): StudioAuditExplorerSql {
  const canonicalEventTypeExpr = 'event_type';
  const sourceExpr = 'source';
  const { startTime, endTime } = resolveDateRange(options.from, options.to);
  const baseWhereClause = `tenant_id = {tenantId:String}
    AND timestamp >= {startTime:DateTime}
    AND timestamp <= {endTime:DateTime}`;
  const conditions = [
    `tenant_id = {tenantId:String}`,
    `timestamp >= {startTime:DateTime}`,
    `timestamp <= {endTime:DateTime}`,
  ];
  const queryParams: Record<string, unknown> = {
    tenantId: options.tenantId,
    startTime: formatClickHouseAuditTimestamp(startTime),
    endTime: formatClickHouseAuditTimestamp(endTime),
  };
  const complianceFilters = getComplianceAuditExplorerValues();

  addAuditValueCondition(conditions, queryParams, {
    canonicalEventTypeExpr,
    values: complianceFilters.values,
    prefixes: complianceFilters.prefixes,
    valueParamName: 'complianceValues',
    prefixParamPrefix: 'compliancePrefix',
  });

  if (options.scope === 'personal') {
    conditions.push(`actor_id = {personalActorId:String}`);
    queryParams.personalActorId = options.userId;
  }

  addArrayCondition(
    conditions,
    queryParams,
    canonicalEventTypeExpr,
    'eventTypes',
    options.eventTypes,
  );
  addArrayCondition(conditions, queryParams, 'action', 'actions', options.actions);
  addArrayCondition(conditions, queryParams, 'actor_type', 'actorTypes', options.actorTypes);
  addArrayCondition(
    conditions,
    queryParams,
    'resource_type',
    'resourceTypes',
    options.resourceTypes,
  );
  addArrayCondition(conditions, queryParams, sourceExpr, 'sources', options.sources);
  addArrayCondition(conditions, queryParams, 'environment', 'environments', options.environments);

  if (options.categories && options.categories.length > 0) {
    const categoryFilters = getAuditExplorerCategoryValues(options.categories);
    addAuditValueCondition(conditions, queryParams, {
      canonicalEventTypeExpr,
      values: categoryFilters.values,
      prefixes: categoryFilters.prefixes,
      valueParamName: 'categoryValues',
      prefixParamPrefix: 'categoryPrefix',
    });
  }

  if (options.actor) {
    conditions.push(`actor_id = {actorId:String}`);
    queryParams.actorId = options.actor;
  }
  if (options.projectId) {
    conditions.push(`project_id = {projectId:String}`);
    queryParams.projectId = options.projectId;
  }
  if (options.resourceId) {
    conditions.push(`resource_id = {resourceId:String}`);
    queryParams.resourceId = options.resourceId;
  }
  if (options.traceId) {
    conditions.push(
      `(session_id = {traceId:String} OR JSONExtractString(metadata, 'traceId') = {traceId:String})`,
    );
    queryParams.traceId = options.traceId;
  }
  if (options.success) {
    conditions.push(`success = {success:UInt8}`);
    queryParams.success = options.success === 'success' ? 1 : 0;
  }
  if (options.ipAddress) {
    conditions.push(`startsWith(actor_ip, {ipAddress:String})`);
    queryParams.ipAddress = options.ipAddress;
  }
  if (options.metadataKey && options.metadataValue) {
    conditions.push(
      `positionCaseInsensitive(JSONExtractString(metadata, {metadataKey:String}), {metadataValue:String}) > 0`,
    );
    queryParams.metadataKey = options.metadataKey;
    queryParams.metadataValue = options.metadataValue;
  } else if (options.metadataKey) {
    conditions.push(`JSONHas(metadata, {metadataKey:String})`);
    queryParams.metadataKey = options.metadataKey;
  }
  if (options.query) {
    conditions.push(buildSearchCondition('searchQuery'));
    queryParams.searchQuery = options.query;
  }

  const limit = options.limit;
  const offset = options.offset;
  const whereClause = conditions.join(' AND ');
  const rowConditions = [...conditions];
  const rowQueryParams: Record<string, unknown> = { ...queryParams, limit, offset };
  const auditUnionSubquery = buildStudioAuditUnionSubquery(baseWhereClause);

  if (options.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as {
        timestamp?: unknown;
        id?: unknown;
      };
      if (typeof parsed.timestamp === 'string' && typeof parsed.id === 'string') {
        rowConditions.push(
          `(timestamp < {cursorTimestamp:DateTime} OR (timestamp = {cursorTimestamp:DateTime} AND event_id < {cursorEventId:String}))`,
        );
        rowQueryParams.cursorTimestamp = formatClickHouseAuditTimestamp(new Date(parsed.timestamp));
        rowQueryParams.cursorEventId = parsed.id;
      }
    } catch {
      // Invalid cursors are ignored so users can recover by refreshing the base query.
    }
  }

  return {
    countQuery: `
      SELECT count() AS cnt
      FROM (${auditUnionSubquery}) AS audit_events
      WHERE ${whereClause}
      SETTINGS max_execution_time = 15
    `,
    rowsQuery: `
      SELECT *
      FROM (${auditUnionSubquery}) AS audit_events
      WHERE ${rowConditions.join(' AND ')}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 15
    `,
    queryParams: { ...queryParams, limit, offset },
    rowQueryParams,
    limit,
  };
}

function buildNextCursor(logs: readonly AuditLog[], limit: number): string | undefined {
  if (logs.length < limit) return undefined;
  const last = logs[logs.length - 1];
  return Buffer.from(
    JSON.stringify({ timestamp: last.timestamp.toISOString(), id: last.id }),
  ).toString('base64url');
}

export async function queryStudioAuditExplorer(
  client: StudioAuditExplorerClickHouseClient,
  options: StudioAuditExplorerQuery & { tenantId: string; userId: string },
): Promise<StudioAuditExplorerQueryResult> {
  const sql = buildStudioAuditExplorerSql(options);
  const countResult = await client.query({
    query: sql.countQuery,
    query_params: sql.queryParams,
    format: 'JSONEachRow',
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = Number.parseInt(countRows[0]?.cnt ?? '0', 10);

  const rowsResult = await client.query({
    query: sql.rowsQuery,
    query_params: sql.rowQueryParams,
    format: 'JSONEachRow',
  });
  const rows = await rowsResult.json<ClickHouseAuditRow>();
  const logs = rows.map((row) => decodeClickHouseAuditRow(row));

  return {
    logs,
    total,
    nextCursor: buildNextCursor(logs, sql.limit),
  };
}
