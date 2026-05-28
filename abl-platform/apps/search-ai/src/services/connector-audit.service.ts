/**
 * Connector Audit Service
 *
 * Kafka-backed append-only audit trail for connector operations.
 * Reads materialize from ClickHouse connector_audit_log.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { IConnectorAuditEntry } from '@agent-platform/database';
import { getClickHouseClient, toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import { BufferedKafkaTopicPublisher, parsePositiveIntEnv } from '@abl/eventstore';
import {
  appendInMemoryAuditTestEvent,
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
} from '@abl/compiler/platform/stores';
import { getSearchAIAuditEnvironment } from './search-ai-audit-environment.js';

const logger = createLogger('connector-audit');

const DEFAULT_KAFKA_BROKER = 'localhost:19092';
const DEFAULT_CONNECTOR_AUDIT_TOPIC = 'abl.audit.connector.v1';
const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-search-ai-connector-audit';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LINGER_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 100;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_IN_MEMORY_AUDIT_FETCH = Number.MAX_SAFE_INTEGER;
const GLOBAL_SHUTDOWN_HOOK_KEY =
  '__abl_search_ai_connector_audit_pipeline_shutdown_hook__' as const;

type ConnectorAuditCategory = 'auth' | 'config' | 'sync' | 'permission' | 'lifecycle';

interface ConnectorAuditClickHouseRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  connector_id: string;
  actor: string;
  actor_type: string;
  event: string;
  category: string;
  metadata: string;
}

export interface ConnectorAuditWriteParams {
  connectorId: string;
  tenantId: string;
  actor: string;
  actorType: 'user' | 'system';
  event: string;
  category: ConnectorAuditCategory;
  metadata?: Record<string, unknown>;
}

interface ConnectorAuditQueryOptions {
  connectorId: string;
  tenantId: string;
  category?: string;
  page?: number;
  limit?: number;
  startDate?: Date;
  endDate?: Date;
}

let publisher: BufferedKafkaTopicPublisher<Record<string, unknown>> | null = null;

function ensureConnectorAuditShutdownHooksRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_SHUTDOWN_HOOK_KEY]) {
    return;
  }

  const flushOnShutdown = () => {
    void closeConnectorAuditPipelineWriter();
  };

  process.once('beforeExit', flushOnShutdown);
  process.once('SIGINT', flushOnShutdown);
  process.once('SIGTERM', flushOnShutdown);
  globalState[GLOBAL_SHUTDOWN_HOOK_KEY] = true;
}

function getConnectorAuditPublisher(
  env: Record<string, string | undefined> = process.env,
): BufferedKafkaTopicPublisher<Record<string, unknown>> {
  if (publisher) {
    return publisher;
  }

  const brokers = (env.AUDIT_KAFKA_BROKERS || env.EVENT_KAFKA_BROKERS || DEFAULT_KAFKA_BROKER)
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  publisher = new BufferedKafkaTopicPublisher<Record<string, unknown>>({
    brokers,
    clientId: env.AUDIT_KAFKA_CONNECTOR_CLIENT_ID?.trim() || DEFAULT_AUDIT_KAFKA_CLIENT_ID,
    topic: env.AUDIT_KAFKA_CONNECTOR_TOPIC?.trim() || DEFAULT_CONNECTOR_AUDIT_TOPIC,
    batchSize: parsePositiveIntEnv(env.AUDIT_KAFKA_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    lingerMs: parsePositiveIntEnv(env.AUDIT_KAFKA_LINGER_MS, DEFAULT_LINGER_MS),
    maxRetries: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRIES, DEFAULT_MAX_RETRIES),
    retryInitialMs: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRY_INITIAL_MS, DEFAULT_RETRY_INITIAL_MS),
  });
  ensureConnectorAuditShutdownHooksRegistered();

  return publisher;
}

function mapActorType(value: string): 'user' | 'system' {
  return value === 'system' ? 'system' : 'user';
}

function parseMetadata(value: string): Record<string, unknown> {
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

function buildConnectorAuditEntry(
  params: ConnectorAuditWriteParams,
  timestamp: Date,
  auditId: string,
): IConnectorAuditEntry {
  return {
    _id: auditId,
    connectorId: params.connectorId,
    tenantId: params.tenantId,
    timestamp,
    actor: params.actor,
    actorType: params.actorType,
    event: params.event,
    category: params.category,
    metadata: params.metadata ?? {},
    _v: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mapRowToEntry(row: ConnectorAuditClickHouseRow): IConnectorAuditEntry {
  const timestamp = new Date(row.timestamp);
  return {
    _id: row.event_id,
    connectorId: row.connector_id,
    tenantId: row.tenant_id,
    timestamp,
    actor: row.actor,
    actorType: mapActorType(row.actor_type),
    event: row.event,
    category: (row.category || 'lifecycle') as ConnectorAuditCategory,
    metadata: parseMetadata(row.metadata),
    _v: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildConnectorAuditPipelineEvent(
  params: ConnectorAuditWriteParams,
  timestamp: Date,
  auditId: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  return {
    auditId,
    stream: 'connector',
    schemaVersion: 2,
    timestamp,
    source: 'search-ai',
    eventType: params.event,
    action: params.event,
    actorId: params.actor,
    actorType: params.actorType,
    tenantId: params.tenantId,
    projectId: null,
    resourceType: 'connector',
    resourceId: params.connectorId,
    environment: getSearchAIAuditEnvironment(env),
    traceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      connectorId: params.connectorId,
      actor: params.actor,
      category: params.category,
      ...(params.metadata ?? {}),
    },
    metadataEncoding: 'object',
    retentionClass: 'indefinite',
    expiresAt: null,
    oldValue: null,
    newValue: null,
  };
}

function publishConnectorAuditPipelineEvent(
  event: Record<string, unknown>,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isInMemoryAuditTestBackendEnabled(env)) {
    appendInMemoryAuditTestEvent(event);
    return;
  }

  getConnectorAuditPublisher(env).publish({
    key: tenantId,
    value: event,
  });
}

async function queryConnectorAuditEntries(
  options: ConnectorAuditQueryOptions,
): Promise<{ entries: IConnectorAuditEntry[]; total: number }> {
  const startTime = options.startDate ?? new Date(0);
  const endTime = options.endDate ?? new Date();

  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId: options.tenantId,
      resourceType: 'connector',
      resourceId: options.connectorId,
      startTime,
      endTime,
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });

    const filtered = result.logs
      .filter((log) => {
        const category = typeof log.metadata?.category === 'string' ? log.metadata.category : null;
        return !options.category || category === options.category;
      })
      .map((log) =>
        buildConnectorAuditEntry(
          {
            connectorId: log.resourceId,
            tenantId: log.tenantId,
            actor: log.actor,
            actorType: mapActorType(log.actorType),
            event: log.eventType,
            category: (typeof log.metadata?.category === 'string'
              ? log.metadata.category
              : 'lifecycle') as ConnectorAuditCategory,
            metadata: log.metadata,
          },
          log.timestamp,
          log.id,
        ),
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return {
      entries: filtered,
      total: filtered.length,
    };
  }

  const client = getClickHouseClient();
  const queryParams: Record<string, unknown> = {
    tenantId: options.tenantId,
    connectorId: options.connectorId,
    startTime: toClickHouseDateTime(startTime),
    endTime: toClickHouseDateTime(endTime),
  };

  const filters = [
    'tenant_id = {tenantId:String}',
    'connector_id = {connectorId:String}',
    'timestamp >= {startTime:DateTime}',
    'timestamp <= {endTime:DateTime}',
  ];

  if (options.category) {
    filters.push('category = {category:String}');
    queryParams.category = options.category;
  }

  const whereClause = filters.join(' AND ');

  const countResult = await client.query({
    query: `
      SELECT count() AS cnt
      FROM abl_platform.connector_audit_log
      WHERE ${whereClause}
      SETTINGS max_execution_time = 15
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = Number.parseInt(countRows[0]?.cnt || '0', 10);

  const baseQuery = `
    SELECT *
    FROM abl_platform.connector_audit_log
    WHERE ${whereClause}
    ORDER BY timestamp DESC
  `;

  if (typeof options.limit === 'number') {
    queryParams.limit = options.limit;
    queryParams.offset = options.page && options.page > 1 ? (options.page - 1) * options.limit : 0;

    const pagedResult = await client.query({
      query: `
        ${baseQuery}
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    const rows = await pagedResult.json<ConnectorAuditClickHouseRow>();
    return { entries: rows.map(mapRowToEntry), total };
  }

  const rowsResult = await client.query({
    query: `
      ${baseQuery}
      SETTINGS max_execution_time = 15
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const rows = await rowsResult.json<ConnectorAuditClickHouseRow>();
  return { entries: rows.map(mapRowToEntry), total };
}

export async function writeAuditEntry(
  params: ConnectorAuditWriteParams,
): Promise<IConnectorAuditEntry> {
  const timestamp = new Date();
  const auditId = randomUUID();
  const entry = buildConnectorAuditEntry(params, timestamp, auditId);

  publishConnectorAuditPipelineEvent(
    buildConnectorAuditPipelineEvent(params, timestamp, auditId),
    params.tenantId,
  );

  logger.info('Audit entry written', {
    connectorId: params.connectorId,
    event: params.event,
    actor: params.actor,
  });

  return entry;
}

/**
 * Best-effort audit writer for request hot paths.
 * Never throws back into the caller.
 */
export function queueAuditEntry(params: ConnectorAuditWriteParams): void {
  void writeAuditEntry(params).catch((error) => {
    logger.error('Failed to write queued connector audit entry', {
      connectorId: params.connectorId,
      event: params.event,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function getAuditLog(
  connectorId: string,
  tenantId: string,
  options: {
    category?: string;
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  },
): Promise<{
  entries: IConnectorAuditEntry[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = options.page ?? 1;
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const { entries, total } = await queryConnectorAuditEntries({
    connectorId,
    tenantId,
    category: options.category,
    page,
    limit,
    startDate: options.startDate,
    endDate: options.endDate,
  });

  return { entries, total, page, limit };
}

export async function exportAuditLog(
  connectorId: string,
  tenantId: string,
  format: 'json' | 'csv',
): Promise<{ data: string; contentType: string; filename: string }> {
  const { entries } = await queryConnectorAuditEntries({
    connectorId,
    tenantId,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseFilename = `audit-log-${connectorId}-${timestamp}`;

  if (format === 'csv') {
    const header = 'timestamp,actor,actorType,event,category,metadata';
    const rows = entries.map((entry) => {
      const meta = JSON.stringify(entry.metadata ?? {}).replace(/"/g, '""');
      return `${entry.timestamp.toISOString()},"${entry.actor}","${entry.actorType}","${entry.event}","${entry.category}","${meta}"`;
    });
    return {
      data: [header, ...rows].join('\n'),
      contentType: 'text/csv',
      filename: `${baseFilename}.csv`,
    };
  }

  return {
    data: JSON.stringify(entries, null, 2),
    contentType: 'application/json',
    filename: `${baseFilename}.json`,
  };
}

export async function closeConnectorAuditPipelineWriter(): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.close();
  publisher = null;
}
