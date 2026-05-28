import { randomUUID } from 'node:crypto';
import { BufferedKafkaTopicPublisher, parsePositiveIntEnv } from '@abl/eventstore';
import {
  appendInMemoryAuditTestEvent,
  deriveRetentionClass,
  isInMemoryAuditTestBackendEnabled,
} from '@abl/compiler/platform/stores';
import type {
  AuditActorType,
  AuditMetadataEncoding,
  AuditResourceType,
  AuditRetentionClass,
  AuditSource,
  Environment,
} from '@abl/compiler/platform';
import { getSearchAIAuditEnvironment } from './search-ai-audit-environment.js';

const DEFAULT_KAFKA_BROKER = 'localhost:19092';
const DEFAULT_SHARED_AUDIT_TOPIC = 'abl.audit.shared.v1';
const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-search-ai-audit';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LINGER_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 100;
const GLOBAL_SHUTDOWN_HOOK_KEY = '__abl_search_ai_audit_pipeline_shutdown_hook__' as const;

export interface SearchAIAuditPipelineEventInput {
  timestamp?: Date;
  source?: AuditSource;
  eventType: string;
  action: string;
  actorId?: string | null;
  actorType?: AuditActorType;
  tenantId?: string | null;
  projectId?: string | null;
  resourceType?: AuditResourceType | string | null;
  resourceId?: string | null;
  environment?: Environment | null;
  traceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
  metadataEncoding?: AuditMetadataEncoding;
  retentionClass?: AuditRetentionClass | null;
  expiresAt?: Date | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

let publisher: BufferedKafkaTopicPublisher<Record<string, unknown>> | null = null;

function ensureSearchAIAuditShutdownHooksRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_SHUTDOWN_HOOK_KEY]) {
    return;
  }

  const flushOnShutdown = () => {
    void closeSearchAIAuditPipelineWriter();
  };

  process.once('beforeExit', flushOnShutdown);
  process.once('SIGINT', flushOnShutdown);
  process.once('SIGTERM', flushOnShutdown);
  globalState[GLOBAL_SHUTDOWN_HOOK_KEY] = true;
}

export function buildSearchAIAuditPipelineEvent(
  input: SearchAIAuditPipelineEventInput,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  return {
    auditId: randomUUID(),
    stream: 'shared',
    schemaVersion: 2,
    timestamp: input.timestamp ?? new Date(),
    source: input.source ?? 'search-ai',
    eventType: input.eventType,
    action: input.action,
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? (input.actorId ? 'user' : 'system'),
    tenantId: input.tenantId ?? null,
    projectId: input.projectId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    environment: input.environment ?? getSearchAIAuditEnvironment(env),
    traceId: input.traceId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? null,
    metadataEncoding: input.metadataEncoding ?? 'object',
    retentionClass:
      input.retentionClass ??
      deriveRetentionClass({
        source: input.source ?? 'search-ai',
        eventType: input.eventType,
        action: input.action,
        explicitRetentionClass: null,
      }),
    expiresAt: input.expiresAt ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
  };
}

function getSearchAIAuditPublisher(
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
    clientId: env.AUDIT_KAFKA_CLIENT_ID?.trim() || DEFAULT_AUDIT_KAFKA_CLIENT_ID,
    topic: env.AUDIT_KAFKA_SHARED_TOPIC?.trim() || DEFAULT_SHARED_AUDIT_TOPIC,
    batchSize: parsePositiveIntEnv(env.AUDIT_KAFKA_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    lingerMs: parsePositiveIntEnv(env.AUDIT_KAFKA_LINGER_MS, DEFAULT_LINGER_MS),
    maxRetries: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRIES, DEFAULT_MAX_RETRIES),
    retryInitialMs: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRY_INITIAL_MS, DEFAULT_RETRY_INITIAL_MS),
  });
  ensureSearchAIAuditShutdownHooksRegistered();

  return publisher;
}

export function publishSearchAIAuditPipelineEvent(
  event: Record<string, unknown>,
  tenantId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isInMemoryAuditTestBackendEnabled(env)) {
    appendInMemoryAuditTestEvent(event);
    return;
  }

  getSearchAIAuditPublisher(env).publish({
    key: tenantId ?? undefined,
    value: event,
  });
}

export async function closeSearchAIAuditPipelineWriter(): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.close();
  publisher = null;
}
