/**
 * Crawl Audit Service
 *
 * Kafka-backed append-only audit trail for crawl operations.
 * Reads materialize from ClickHouse crawl_audit_events.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import {
  appendInMemoryAuditTestEvent,
  deleteInMemoryAuditTestLogs,
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
} from '@abl/compiler/platform/stores';
import { BufferedKafkaTopicPublisher, parsePositiveIntEnv } from '@abl/eventstore';
import type { ICrawlAuditEvent } from '@agent-platform/database';
import { getClickHouseClient, toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import { getSearchAIAuditEnvironment } from './search-ai-audit-environment.js';

const logger = createLogger('crawl-audit');

const DEFAULT_KAFKA_BROKER = 'localhost:19092';
const DEFAULT_CRAWL_AUDIT_TOPIC = 'abl.audit.crawl.v1';
const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-search-ai-crawl-audit';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LINGER_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 100;
const MAX_IN_MEMORY_AUDIT_FETCH = Number.MAX_SAFE_INTEGER;
const GLOBAL_SHUTDOWN_HOOK_KEY = '__abl_search_ai_crawl_audit_pipeline_shutdown_hook__' as const;

interface CrawlAuditClickHouseRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  crawl_job_id: string;
  user_id: string;
  event_type: ICrawlAuditEvent['eventType'];
  description: string;
  changes_before: string;
  changes_after: string;
  context: string;
  severity: ICrawlAuditEvent['severity'];
  metadata: string;
}

export interface CrawlAuditWriteParams {
  crawlJobId: string;
  tenantId: string;
  userId?: string;
  eventType: ICrawlAuditEvent['eventType'];
  description: string;
  changes?: ICrawlAuditEvent['changes'];
  context: ICrawlAuditEvent['context'];
  severity?: ICrawlAuditEvent['severity'];
  timestamp?: Date;
}

let publisher: BufferedKafkaTopicPublisher<Record<string, unknown>> | null = null;

function ensureCrawlAuditShutdownHooksRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_SHUTDOWN_HOOK_KEY]) {
    return;
  }

  const flushOnShutdown = () => {
    void closeCrawlAuditPipelineWriter();
  };

  process.once('beforeExit', flushOnShutdown);
  process.once('SIGINT', flushOnShutdown);
  process.once('SIGTERM', flushOnShutdown);
  globalState[GLOBAL_SHUTDOWN_HOOK_KEY] = true;
}

function getCrawlAuditPublisher(
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
    clientId: env.AUDIT_KAFKA_CRAWL_CLIENT_ID?.trim() || DEFAULT_AUDIT_KAFKA_CLIENT_ID,
    topic: env.AUDIT_KAFKA_CRAWL_TOPIC?.trim() || DEFAULT_CRAWL_AUDIT_TOPIC,
    batchSize: parsePositiveIntEnv(env.AUDIT_KAFKA_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    lingerMs: parsePositiveIntEnv(env.AUDIT_KAFKA_LINGER_MS, DEFAULT_LINGER_MS),
    maxRetries: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRIES, DEFAULT_MAX_RETRIES),
    retryInitialMs: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRY_INITIAL_MS, DEFAULT_RETRY_INITIAL_MS),
  });
  ensureCrawlAuditShutdownHooksRegistered();

  return publisher;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function buildCrawlAuditEntry(
  params: CrawlAuditWriteParams,
  timestamp: Date,
  auditId: string,
): ICrawlAuditEvent {
  return {
    _id: auditId,
    tenantId: params.tenantId,
    crawlJobId: params.crawlJobId,
    userId: params.userId,
    eventType: params.eventType,
    description: params.description,
    changes: params.changes,
    context: params.context,
    severity: params.severity ?? 'info',
    createdAt: timestamp,
    _v: 1,
  };
}

function mapRowToEntry(row: CrawlAuditClickHouseRow): ICrawlAuditEvent {
  const changesBefore = parseJsonObject(row.changes_before);
  const changesAfter = parseJsonObject(row.changes_after);

  return {
    _id: row.event_id,
    tenantId: row.tenant_id,
    crawlJobId: row.crawl_job_id,
    userId: row.user_id || undefined,
    eventType: row.event_type,
    description: row.description,
    changes:
      changesBefore || changesAfter
        ? {
            before: changesBefore,
            after: changesAfter ?? {},
          }
        : undefined,
    context: (parseJsonObject(row.context) ?? {
      strategy: 'unknown',
      urls: 0,
    }) as ICrawlAuditEvent['context'],
    severity: row.severity || 'info',
    createdAt: new Date(row.timestamp),
    _v: 1,
  };
}

function buildCrawlAuditPipelineEvent(
  params: CrawlAuditWriteParams,
  timestamp: Date,
  auditId: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  return {
    auditId,
    stream: 'crawl',
    schemaVersion: 2,
    timestamp,
    source: 'search-ai',
    eventType: params.eventType,
    action: params.eventType,
    actorId: params.userId ?? null,
    actorType: params.userId ? 'user' : 'system',
    tenantId: params.tenantId,
    projectId: null,
    resourceType: 'crawl_job',
    resourceId: params.crawlJobId,
    environment: getSearchAIAuditEnvironment(env),
    traceId: null,
    ipAddress: params.context.ipAddress ?? null,
    userAgent: params.context.userAgent ?? null,
    metadata: {
      crawlJobId: params.crawlJobId,
      userId: params.userId ?? null,
      description: params.description,
      changes: params.changes ?? null,
      context: params.context,
      severity: params.severity ?? 'info',
    },
    metadataEncoding: 'object',
    retentionClass: 'default',
    expiresAt: null,
    oldValue: params.changes?.before ?? null,
    newValue: params.changes?.after ?? null,
  };
}

function publishCrawlAuditPipelineEvent(
  event: Record<string, unknown>,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isInMemoryAuditTestBackendEnabled(env)) {
    appendInMemoryAuditTestEvent(event);
    return;
  }

  getCrawlAuditPublisher(env).publish({
    key: tenantId,
    value: event,
  });
}

export async function writeCrawlAuditEvent(
  params: CrawlAuditWriteParams,
): Promise<ICrawlAuditEvent> {
  const timestamp = params.timestamp ?? new Date();
  const auditId = randomUUID();
  const entry = buildCrawlAuditEntry(params, timestamp, auditId);

  publishCrawlAuditPipelineEvent(
    buildCrawlAuditPipelineEvent(params, timestamp, auditId),
    params.tenantId,
  );

  logger.info('Crawl audit event written', {
    crawlJobId: params.crawlJobId,
    eventType: params.eventType,
    tenantId: params.tenantId,
  });

  return entry;
}

export async function getCrawlAuditEvents(
  crawlJobId: string,
  tenantId: string,
): Promise<ICrawlAuditEvent[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    const result = await queryInMemoryAuditTestLogs({
      tenantId,
      resourceType: 'crawl_job',
      resourceId: crawlJobId,
      startTime: new Date(0),
      endTime: new Date(),
      limit: MAX_IN_MEMORY_AUDIT_FETCH,
      offset: 0,
    });

    return result.logs
      .map((log) =>
        buildCrawlAuditEntry(
          {
            crawlJobId,
            tenantId,
            userId: log.actor !== 'system' ? log.actor : undefined,
            eventType: log.eventType as ICrawlAuditEvent['eventType'],
            description:
              typeof log.metadata?.description === 'string' ? log.metadata.description : log.action,
            changes: log.metadata?.changes as ICrawlAuditEvent['changes'],
            context: (log.metadata?.context ?? {
              strategy: 'unknown',
              urls: 0,
            }) as ICrawlAuditEvent['context'],
            severity:
              typeof log.metadata?.severity === 'string'
                ? (log.metadata.severity as ICrawlAuditEvent['severity'])
                : 'info',
            timestamp: log.timestamp,
          },
          log.timestamp,
          log.id,
        ),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const client = getClickHouseClient();
  const queryResult = await client.query({
    query: `
      SELECT *
      FROM abl_platform.crawl_audit_events
      WHERE tenant_id = {tenantId:String}
        AND crawl_job_id = {crawlJobId:String}
      ORDER BY timestamp ASC
      SETTINGS max_execution_time = 15
    `,
    query_params: {
      tenantId,
      crawlJobId,
    },
    format: 'JSONEachRow',
  });
  const rows = await queryResult.json<CrawlAuditClickHouseRow>();
  return rows.map(mapRowToEntry);
}

export async function deleteCrawlAuditEventsForJob(params: {
  crawlJobId: string;
  tenantId: string;
}): Promise<boolean> {
  if (isInMemoryAuditTestBackendEnabled()) {
    deleteInMemoryAuditTestLogs({
      tenantId: params.tenantId,
      resourceType: 'crawl_job',
      resourceId: params.crawlJobId,
    });
    return true;
  }

  const client = getClickHouseClient();
  await client.command({
    query: `
      ALTER TABLE abl_platform.crawl_audit_events
      DELETE WHERE tenant_id = {tenantId:String}
        AND crawl_job_id = {crawlJobId:String}
    `,
    query_params: {
      tenantId: params.tenantId,
      crawlJobId: params.crawlJobId,
    },
  });
  return true;
}

export async function closeCrawlAuditPipelineWriter(): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.close();
  publisher = null;
}
