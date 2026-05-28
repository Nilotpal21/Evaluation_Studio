import { randomUUID } from 'node:crypto';
import {
  redactAuditPayloadContent,
  type ArchAuditLogWriter,
  type AuditPayloadType,
  type BufferedArchAuditLogEntry,
} from '@agent-platform/arch-ai';
import { BufferedKafkaTopicPublisher, parsePositiveIntEnv } from '@abl/eventstore';
import {
  appendInMemoryAuditTestEvent,
  isInMemoryAuditTestBackendEnabled,
} from '@abl/compiler/platform/stores';

const DEFAULT_KAFKA_BROKER = 'localhost:19092';
const DEFAULT_ARCH_AUDIT_TOPIC = 'abl.audit.arch.v1';
const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-studio-arch-audit';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LINGER_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 100;
const GLOBAL_SHUTDOWN_HOOK_KEY = '__abl_studio_arch_audit_pipeline_shutdown_hook__' as const;

function resolveStudioEnvironment(
  env: Record<string, string | undefined> = process.env,
): 'dev' | 'staging' | 'production' {
  const deployment = (
    env.DEPLOYMENT_ENVIRONMENT ||
    env.RUNTIME_ENV ||
    env.APP_ENV ||
    env.NODE_ENV ||
    'development'
  ).toLowerCase();

  if (deployment === 'production' || deployment === 'prod') {
    return 'production';
  }
  if (deployment === 'staging' || deployment === 'stage') {
    return 'staging';
  }
  return 'dev';
}

let publisher: BufferedKafkaTopicPublisher<Record<string, unknown>> | null = null;

function ensureStudioArchAuditShutdownHooksRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_SHUTDOWN_HOOK_KEY]) {
    return;
  }

  const flushOnShutdown = () => {
    void closeStudioArchAuditPipelineWriter();
  };

  process.once('beforeExit', flushOnShutdown);
  process.once('SIGINT', flushOnShutdown);
  process.once('SIGTERM', flushOnShutdown);
  globalState[GLOBAL_SHUTDOWN_HOOK_KEY] = true;
}

function getStudioArchAuditPublisher(
  env: Record<string, string | undefined> = process.env,
): BufferedKafkaTopicPublisher<Record<string, unknown>> {
  if (publisher) {
    return publisher;
  }

  const brokerConfig = env.AUDIT_KAFKA_BROKERS || env.EVENT_KAFKA_BROKERS;
  if (!brokerConfig && resolveStudioEnvironment(env) === 'production') {
    throw new Error('AUDIT_KAFKA_BROKERS or EVENT_KAFKA_BROKERS is required in production');
  }

  const brokers = (brokerConfig || DEFAULT_KAFKA_BROKER)
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  publisher = new BufferedKafkaTopicPublisher<Record<string, unknown>>({
    brokers,
    clientId: env.AUDIT_KAFKA_ARCH_CLIENT_ID?.trim() || DEFAULT_AUDIT_KAFKA_CLIENT_ID,
    topic: env.AUDIT_KAFKA_ARCH_TOPIC?.trim() || DEFAULT_ARCH_AUDIT_TOPIC,
    batchSize: parsePositiveIntEnv(env.AUDIT_KAFKA_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    lingerMs: parsePositiveIntEnv(env.AUDIT_KAFKA_LINGER_MS, DEFAULT_LINGER_MS),
    maxRetries: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRIES, DEFAULT_MAX_RETRIES),
    retryInitialMs: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRY_INITIAL_MS, DEFAULT_RETRY_INITIAL_MS),
  });
  ensureStudioArchAuditShutdownHooksRegistered();

  return publisher;
}

function assertStudioArchAuditKafkaConfigured(
  env: Record<string, string | undefined> = process.env,
): void {
  if (
    !env.AUDIT_KAFKA_BROKERS &&
    !env.EVENT_KAFKA_BROKERS &&
    resolveStudioEnvironment(env) === 'production'
  ) {
    throw new Error('AUDIT_KAFKA_BROKERS or EVENT_KAFKA_BROKERS is required in production');
  }
}

function buildStudioArchAuditPipelineEvent(
  entry: BufferedArchAuditLogEntry,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  return {
    auditId: randomUUID(),
    stream: 'arch',
    schemaVersion: 2,
    timestamp: entry.timestamp,
    source: 'studio',
    eventType: `arch.${entry.category}`,
    action: entry.category,
    actorId: entry.userId,
    actorType: 'user',
    tenantId: entry.tenantId,
    projectId: entry.projectId ?? null,
    resourceType: 'arch_session',
    resourceId: entry.sessionId,
    environment: resolveStudioEnvironment(env),
    traceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      sessionId: entry.sessionId,
      category: entry.category,
      severity: entry.severity,
      summary: entry.summary,
      detail: entry.detail,
      specialist: entry.specialist ?? null,
      phase: entry.phase ?? null,
      durationMs: entry.durationMs ?? null,
      tokens: entry.tokens ?? null,
      turnId: entry.turnId ?? null,
      parentEventId: entry.parentEventId ?? null,
      phaseLabel: entry.phaseLabel ?? null,
      retryOf: entry.retryOf ?? null,
      retryIndex: entry.retryIndex ?? null,
      nestingDepth: entry.nestingDepth ?? null,
      spanKind: entry.spanKind ?? null,
    },
    metadataEncoding: 'object',
    retentionClass: 'default',
    expiresAt: null,
    oldValue: null,
    newValue: null,
  };
}

function publishStudioArchAuditPipelineEvent(
  event: Record<string, unknown>,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isInMemoryAuditTestBackendEnabled(env)) {
    appendInMemoryAuditTestEvent(event);
    return;
  }

  getStudioArchAuditPublisher(env).publish({
    key: tenantId,
    value: event,
  });
}

const MAX_PAYLOAD_BYTES = 256 * 1024;

export class StudioArchAuditPipelineWriter implements ArchAuditLogWriter {
  async insertMany(
    entries: BufferedArchAuditLogEntry[],
    _options?: { ordered?: boolean },
  ): Promise<unknown> {
    for (const entry of entries) {
      publishStudioArchAuditPipelineEvent(buildStudioArchAuditPipelineEvent(entry), entry.tenantId);
    }

    return entries;
  }

  emitPayload(payload: {
    tenantId: string;
    sessionId: string;
    eventId: string;
    payloadType: AuditPayloadType;
    content: string;
    toolName?: string;
  }): void {
    let content = redactAuditPayloadContent(payload.content, {
      payloadType: payload.payloadType,
      toolName: payload.toolName,
    });
    const originalSize = Buffer.byteLength(content, 'utf8');
    let truncated = false;

    if (originalSize > MAX_PAYLOAD_BYTES) {
      content = content.slice(0, MAX_PAYLOAD_BYTES - 50);
      truncated = true;
    }

    const event: Record<string, unknown> = {
      auditId: randomUUID(),
      stream: 'arch_payload',
      schemaVersion: 1,
      timestamp: new Date(),
      source: 'studio',
      eventType: `arch.payload.${payload.payloadType}`,
      action: 'payload_capture',
      actorId: '',
      actorType: 'system',
      tenantId: payload.tenantId,
      projectId: null,
      resourceType: 'arch_session',
      resourceId: payload.sessionId,
      environment: resolveStudioEnvironment(),
      metadata: {
        eventId: payload.eventId,
        sessionId: payload.sessionId,
        payloadType: payload.payloadType,
        toolName: payload.toolName ?? null,
        content: truncated ? content + '\n{"_truncated":true}' : content,
        contentSizeBytes: originalSize,
      },
      metadataEncoding: 'object',
      retentionClass: 'default',
      expiresAt: null,
    };

    publishStudioArchAuditPipelineEvent(event, payload.tenantId);
  }
}

let writerInstance: StudioArchAuditPipelineWriter | null = null;

export function getStudioArchAuditPipelineWriter(): StudioArchAuditPipelineWriter {
  assertStudioArchAuditKafkaConfigured();
  if (!writerInstance) {
    writerInstance = new StudioArchAuditPipelineWriter();
  }
  return writerInstance;
}

export async function closeStudioArchAuditPipelineWriter(): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.close();
  publisher = null;
  writerInstance = null;
}
