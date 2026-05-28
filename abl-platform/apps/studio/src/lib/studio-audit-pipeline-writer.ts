import { BufferedKafkaTopicPublisher, parsePositiveIntEnv } from '@abl/eventstore';
import {
  appendInMemoryAuditTestEvent,
  isInMemoryAuditTestBackendEnabled,
} from '@abl/compiler/platform/stores';

const DEFAULT_KAFKA_BROKER = 'localhost:19092';
const DEFAULT_SHARED_AUDIT_TOPIC = 'abl.audit.shared.v1';
const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-studio-audit';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LINGER_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 100;

let publisher: BufferedKafkaTopicPublisher<Record<string, unknown>> | null = null;
const GLOBAL_SHUTDOWN_HOOK_KEY = '__abl_studio_audit_pipeline_shutdown_hook__' as const;

function ensureStudioAuditShutdownHooksRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_SHUTDOWN_HOOK_KEY]) {
    return;
  }

  const flushOnShutdown = () => {
    void closeStudioAuditPipelineWriter();
  };

  process.once('beforeExit', flushOnShutdown);
  process.once('SIGINT', flushOnShutdown);
  process.once('SIGTERM', flushOnShutdown);
  globalState[GLOBAL_SHUTDOWN_HOOK_KEY] = true;
}

function getStudioAuditPublisher(
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
  ensureStudioAuditShutdownHooksRegistered();

  return publisher;
}

export function publishStudioAuditPipelineEvent(
  event: Record<string, unknown>,
  tenantId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isInMemoryAuditTestBackendEnabled(env)) {
    appendInMemoryAuditTestEvent(event);
    return;
  }

  getStudioAuditPublisher(env).publish({
    key: tenantId ?? undefined,
    value: event,
  });
}

export async function closeStudioAuditPipelineWriter(): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.close();
  publisher = null;
}
