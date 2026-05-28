import { createLogger } from '@abl/compiler/platform';
import type {
  AuditEvent,
  AuditMaterializer,
  AuditPolicyResolver,
  AuditTransportResilienceStatus,
  AuditTransportStatus,
  AuditTransport,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import {
  DEFAULT_KAFKA_BROKER,
  EVENT_KAFKA_BATCH_SIZE,
  EVENT_KAFKA_LINGER_MS,
  EVENT_KAFKA_RETRIES,
  EVENT_KAFKA_RETRY_INITIAL_MS,
  resolveKafkaAuth,
} from '@agent-platform/config';
import { parseBooleanEnv, parsePositiveIntEnv } from '@abl/eventstore';
import { Kafka, logLevel, type Consumer, type EachBatchPayload, type Producer } from 'kafkajs';
import { resolveRuntimeAuditTopicsFromEnv } from './runtime-audit-policy-resolver.js';
import { AuditFileSystemWAL, type AuditWALConfig } from './audit-filesystem-wal.js';
import { AuditRecoveryService } from './audit-recovery-service.js';

const log = createLogger('kafka-audit-transport');

const DEFAULT_AUDIT_KAFKA_CLIENT_ID = 'abl-runtime-audit';
const DEFAULT_AUDIT_KAFKA_GROUP_ID = 'abl-runtime-audit-materializer';
const DEFAULT_AUDIT_KAFKA_CONCURRENCY = 2;
const DEFAULT_AUDIT_KAFKA_MAX_BUFFERED_MESSAGES = 10_000;
const AUDIT_QUEUE_FLUSH_POLL_MS = 25;
const DEFAULT_AUDIT_WAL_DIRECTORY = '/tmp/audit-pipeline-wal';
const DEFAULT_AUDIT_WAL_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;

export interface KafkaAuditTransportResilienceConfig {
  enabled: boolean;
  wal: AuditWALConfig;
  recoveryIntervalMs: number;
}

export interface KafkaAuditTransportConfig {
  brokers: string[];
  clientId: string;
  groupId: string;
  topics: string[];
  batchSize: number;
  lingerMs: number;
  maxRetries: number;
  retryInitialMs: number;
  consumerConcurrency: number;
  maxBufferedMessages?: number;
  resilience?: KafkaAuditTransportResilienceConfig | null;
}

interface BufferedAuditMessage {
  event: AuditEvent;
  topic: string;
  key: string;
  value: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SUPPORTED_AUDIT_STREAMS = new Set<string>([
  'shared',
  'kms',
  'pii',
  'connector',
  'crawl',
  'arch',
  'omnichannel',
]);

class UnsupportedStreamError extends Error {
  constructor(stream: unknown) {
    super(`Audit event payload has unsupported stream: ${String(stream)}`);
    this.name = 'UnsupportedStreamError';
  }
}

function parseAuditEventPayload(payload: unknown): AuditEvent {
  if (!isRecord(payload)) {
    throw new Error('Audit event payload must be an object');
  }

  const timestampValue = payload.timestamp;
  const timestamp =
    timestampValue instanceof Date ? timestampValue : new Date(String(timestampValue));
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('Audit event payload is missing a valid timestamp');
  }

  if (typeof payload.auditId !== 'string' || payload.auditId.length === 0) {
    throw new Error('Audit event payload is missing auditId');
  }

  if (!SUPPORTED_AUDIT_STREAMS.has(payload.stream as string)) {
    throw new UnsupportedStreamError(payload.stream);
  }

  return {
    ...(payload as Omit<AuditEvent, 'timestamp'>),
    timestamp,
  };
}

export function getKafkaAuditTransportConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): KafkaAuditTransportConfig {
  const brokers = (env.AUDIT_KAFKA_BROKERS || env.EVENT_KAFKA_BROKERS || DEFAULT_KAFKA_BROKER)
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  const topics = resolveRuntimeAuditTopicsFromEnv(env);

  return {
    brokers,
    clientId: env.AUDIT_KAFKA_CLIENT_ID?.trim() || DEFAULT_AUDIT_KAFKA_CLIENT_ID,
    groupId: env.AUDIT_KAFKA_GROUP_ID?.trim() || DEFAULT_AUDIT_KAFKA_GROUP_ID,
    topics: Array.from(
      new Set([
        topics.shared,
        topics.kms,
        topics.pii,
        topics.connector,
        topics.crawl,
        topics.arch,
        topics.omnichannel,
      ]),
    ),
    batchSize: parsePositiveIntEnv(env.AUDIT_KAFKA_BATCH_SIZE, EVENT_KAFKA_BATCH_SIZE),
    lingerMs: parsePositiveIntEnv(env.AUDIT_KAFKA_LINGER_MS, EVENT_KAFKA_LINGER_MS),
    maxRetries: parsePositiveIntEnv(env.AUDIT_KAFKA_RETRIES, EVENT_KAFKA_RETRIES),
    retryInitialMs: parsePositiveIntEnv(
      env.AUDIT_KAFKA_RETRY_INITIAL_MS,
      EVENT_KAFKA_RETRY_INITIAL_MS,
    ),
    consumerConcurrency: parsePositiveIntEnv(
      env.AUDIT_KAFKA_CONCURRENCY,
      DEFAULT_AUDIT_KAFKA_CONCURRENCY,
    ),
    maxBufferedMessages: parsePositiveIntEnv(
      env.AUDIT_KAFKA_MAX_BUFFERED_MESSAGES,
      DEFAULT_AUDIT_KAFKA_MAX_BUFFERED_MESSAGES,
    ),
    resilience: parseBooleanEnv(env.AUDIT_PIPELINE_WAL_ENABLED, true)
      ? {
          enabled: true,
          wal: {
            directory: env.AUDIT_PIPELINE_WAL_DIR?.trim() || DEFAULT_AUDIT_WAL_DIRECTORY,
            ...(env.AUDIT_PIPELINE_WAL_MAX_FILE_SIZE_BYTES && {
              maxFileSizeBytes: parsePositiveIntEnv(env.AUDIT_PIPELINE_WAL_MAX_FILE_SIZE_BYTES, 1),
            }),
            ...(env.AUDIT_PIPELINE_WAL_MAX_RETENTION_HOURS && {
              maxRetentionHours: parsePositiveIntEnv(env.AUDIT_PIPELINE_WAL_MAX_RETENTION_HOURS, 1),
            }),
            ...(env.AUDIT_PIPELINE_WAL_FLUSH_INTERVAL_MS && {
              flushIntervalMs: parsePositiveIntEnv(env.AUDIT_PIPELINE_WAL_FLUSH_INTERVAL_MS, 1),
            }),
            ...(env.AUDIT_PIPELINE_WAL_MAX_BUFFER_SIZE && {
              maxBufferSize: parsePositiveIntEnv(env.AUDIT_PIPELINE_WAL_MAX_BUFFER_SIZE, 1),
            }),
          },
          recoveryIntervalMs: parsePositiveIntEnv(
            env.AUDIT_PIPELINE_WAL_RECOVERY_INTERVAL_MS,
            DEFAULT_AUDIT_WAL_RECOVERY_INTERVAL_MS,
          ),
        }
      : null,
  };
}

export class KafkaAuditTransport implements AuditTransport {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumer: Consumer;
  private readonly buffer: BufferedAuditMessage[] = [];
  private readonly wal: AuditFileSystemWAL | null;
  private readonly kafkaAuthMode: string;
  private readonly inFlightProducerDrains = new Set<Promise<void>>();
  private readonly inFlightMaterializations = new Set<Promise<void>>();
  private recovery: AuditRecoveryService | null = null;
  private readonly state: {
    producerConnected: boolean;
    consumerConnected: boolean;
    healthy: boolean;
    started: boolean;
    publishedMessages: number;
    materializedMessages: number;
    failedProducerDrains: number;
    failedMaterializations: number;
    lastProducedAt: Date | null;
    lastMaterializedAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    resilience: AuditTransportResilienceStatus | null;
  } = {
    producerConnected: false,
    consumerConnected: false,
    healthy: true,
    started: false,
    publishedMessages: 0,
    materializedMessages: 0,
    failedProducerDrains: 0,
    failedMaterializations: 0,
    lastProducedAt: null as Date | null,
    lastMaterializedAt: null as Date | null,
    lastErrorAt: null as Date | null,
    lastError: null as string | null,
    resilience: null,
  };
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: KafkaAuditTransportConfig,
    private readonly policyResolver: AuditPolicyResolver,
  ) {
    const kafkaAuth = resolveKafkaAuth();
    this.kafkaAuthMode = kafkaAuth.sasl ? `SASL/${kafkaAuth.sasl.mechanism}` : 'plain';
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.WARN,
      ...kafkaAuth,
    });
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
      retry: {
        initialRetryTime: config.retryInitialMs,
        retries: config.maxRetries,
        factor: 2,
      },
    });
    this.consumer = this.kafka.consumer({
      groupId: config.groupId,
      maxWaitTimeInMs: 100,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      retry: {
        initialRetryTime: config.retryInitialMs,
        retries: config.maxRetries,
        factor: 2,
      },
    });
    this.wal =
      config.resilience?.enabled && config.resilience.wal
        ? new AuditFileSystemWAL(config.resilience.wal)
        : null;
    if (this.wal) {
      this.state.resilience = {
        walEnabled: true,
        walBufferedEvents: 0,
        spooledMessages: 0,
        failedWalWrites: 0,
        recoveryRuns: 0,
        recoveredMessages: 0,
        failedRecoveryMessages: 0,
        lastSpooledAt: null,
        lastWalErrorAt: null,
        lastWalError: null,
        lastRecoveredAt: null,
        lastRecoveryErrorAt: null,
        lastRecoveryError: null,
      };
    }
  }

  async start(materializer: AuditMaterializer): Promise<void> {
    if (this.state.started) {
      return;
    }

    await this.producer.connect();
    this.state.producerConnected = true;

    await this.consumer.connect();
    this.state.consumerConnected = true;

    for (const topic of this.config.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      partitionsConsumedConcurrently: this.config.consumerConcurrency,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        const drainPromise = this.processBatch(payload, materializer);
        this.inFlightMaterializations.add(drainPromise);

        try {
          await drainPromise;
        } finally {
          this.inFlightMaterializations.delete(drainPromise);
        }
      },
    });

    if (this.wal) {
      this.recovery = new AuditRecoveryService(this.wal, materializer, {
        onResult: (result) => {
          this.recordRecoveryResult(result);
        },
        onError: (error) => {
          this.recordRecoveryError(error);
        },
      });
      try {
        await this.recovery.recoverFromWAL();
        this.recovery.startPeriodicRecovery(
          this.config.resilience?.recoveryIntervalMs ?? DEFAULT_AUDIT_WAL_RECOVERY_INTERVAL_MS,
        );
      } catch (err) {
        log.warn('Audit WAL recovery failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.state.started = true;
    this.state.healthy = true;
    log.info('Kafka audit transport started', {
      topics: this.config.topics,
      groupId: this.config.groupId,
      authMode: this.kafkaAuthMode,
    });
  }

  publish(event: AuditEvent): void {
    const routing = this.policyResolver.resolve(event);
    this.buffer.push({
      event,
      topic: routing.topic,
      key: event.tenantId ?? 'unscoped',
      value: JSON.stringify(event),
    });
    this.enforceBufferLimit();

    if (this.buffer.length >= this.config.batchSize) {
      this.cancelLinger();
      this.enqueueDrain();
      return;
    }

    if (!this.lingerTimer) {
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        this.enqueueDrain();
      }, this.config.lingerMs);
    }
  }

  publishBatch(events: AuditEvent[]): void {
    for (const event of events) {
      this.publish(event);
    }
  }

  async flush(): Promise<void> {
    this.cancelLinger();
    await this.drainBuffer(true);
    await this.waitForProducerDrains();
    await this.waitForMaterializations();
  }

  async close(): Promise<void> {
    this.cancelLinger();
    await this.flush();

    if (this.state.consumerConnected) {
      await this.consumer.disconnect();
      this.state.consumerConnected = false;
    }

    if (this.state.producerConnected) {
      await this.producer.disconnect();
      this.state.producerConnected = false;
    }

    if (this.recovery) {
      await this.recovery.close();
      this.recovery = null;
    } else if (this.wal) {
      await this.wal.close();
    }

    this.state.started = false;
    this.state.healthy = false;
  }

  isHealthy(): boolean {
    return this.state.healthy;
  }

  getStatus(): AuditTransportStatus {
    return {
      healthy: this.state.healthy,
      started: this.state.started,
      bufferedMessages: this.buffer.length,
      inFlightProducerDrains: this.inFlightProducerDrains.size,
      inFlightMaterializations: this.inFlightMaterializations.size,
      publishedMessages: this.state.publishedMessages,
      materializedMessages: this.state.materializedMessages,
      failedProducerDrains: this.state.failedProducerDrains,
      failedMaterializations: this.state.failedMaterializations,
      lastProducedAt: this.state.lastProducedAt,
      lastMaterializedAt: this.state.lastMaterializedAt,
      lastErrorAt: this.state.lastErrorAt,
      lastError: this.state.lastError,
      resilience: this.getResilienceStatus(),
    };
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private enforceBufferLimit(): void {
    const maxBufferedMessages =
      this.config.maxBufferedMessages ?? DEFAULT_AUDIT_KAFKA_MAX_BUFFERED_MESSAGES;
    if (this.buffer.length <= maxBufferedMessages) {
      return;
    }

    const overflowCount = this.buffer.length - maxBufferedMessages;
    const overflowBatch = this.buffer.splice(0, overflowCount);
    this.recordError(
      new Error(`Kafka audit transport buffer overflow dropped ${overflowCount} buffered event(s)`),
    );
    log.warn('Kafka audit transport buffer exceeded configured limit', {
      bufferedMessages: this.buffer.length,
      overflowCount,
      maxBufferedMessages,
    });
    this.spoolOverflowBatchToWal(overflowBatch);
  }

  private enqueueDrain(): void {
    const drainPromise = this.drainBuffer(false)
      .catch((err) => {
        log.error('Kafka audit transport drain failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.inFlightProducerDrains.delete(drainPromise);
      });

    this.inFlightProducerDrains.add(drainPromise);
  }

  private async waitForProducerDrains(): Promise<void> {
    while (this.inFlightProducerDrains.size > 0) {
      await Promise.allSettled([...this.inFlightProducerDrains]);
    }
  }

  private async waitForMaterializations(): Promise<void> {
    while (this.inFlightMaterializations.size > 0) {
      await Promise.allSettled([...this.inFlightMaterializations]);
      if (this.inFlightMaterializations.size > 0) {
        await sleep(AUDIT_QUEUE_FLUSH_POLL_MS);
      }
    }
  }

  private async drainBuffer(throwOnError: boolean): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      await this.sendWithRetry(batch);
    } catch (err) {
      this.state.healthy = false;
      this.state.failedProducerDrains += 1;
      this.recordError(err);

      const persistedToWal = await this.persistBatchToWal(batch, err);
      if (!persistedToWal) {
        this.buffer.unshift(...batch);
      }

      if (throwOnError && !persistedToWal) {
        throw err;
      }
    }
  }

  private async sendWithRetry(messages: BufferedAuditMessage[]): Promise<void> {
    const topicMessages = this.groupMessagesByTopic(messages);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.producer.sendBatch({ topicMessages });
        this.state.healthy = true;
        this.state.publishedMessages += messages.length;
        this.state.lastProducedAt = new Date();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.maxRetries) {
          await sleep(this.config.retryInitialMs * Math.pow(2, attempt));
        }
      }
    }

    throw lastError ?? new Error('Kafka audit send failed');
  }

  private groupMessagesByTopic(messages: BufferedAuditMessage[]): Array<{
    topic: string;
    messages: Array<{ key: string; value: string }>;
  }> {
    const grouped = new Map<string, Array<{ key: string; value: string }>>();

    for (const message of messages) {
      const entries = grouped.get(message.topic) ?? [];
      entries.push({
        key: message.key,
        value: message.value,
      });
      grouped.set(message.topic, entries);
    }

    return [...grouped.entries()].map(([topic, groupedMessages]) => ({
      topic,
      messages: groupedMessages,
    }));
  }

  private async processBatch(
    payload: EachBatchPayload,
    materializer: AuditMaterializer,
  ): Promise<void> {
    try {
      const events: AuditEvent[] = [];
      let skippedMessages = 0;

      for (const message of payload.batch.messages) {
        if (!message.value) {
          payload.resolveOffset(message.offset);
          continue;
        }

        try {
          const parsedPayload = JSON.parse(message.value.toString()) as unknown;
          events.push(parseAuditEventPayload(parsedPayload));
        } catch (parseErr) {
          skippedMessages += 1;
          log.warn('Skipping unparseable audit message', {
            topic: payload.batch.topic,
            partition: payload.batch.partition,
            offset: message.offset,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
          payload.resolveOffset(message.offset);
        }
      }

      if (events.length > 0) {
        await materializer.handleBatch(events);
        this.state.materializedMessages += events.length;
        this.state.lastMaterializedAt = new Date();
      }

      for (const message of payload.batch.messages) {
        payload.resolveOffset(message.offset);
      }

      await payload.commitOffsetsIfNecessary();
      await payload.heartbeat();
      this.state.healthy = true;

      if (skippedMessages > 0) {
        this.state.failedMaterializations += skippedMessages;
      }
    } catch (err) {
      this.state.healthy = false;
      this.state.failedMaterializations += 1;
      this.recordError(err);
      log.error('Kafka audit materialization failed', {
        topic: payload.batch.topic,
        partition: payload.batch.partition,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private recordError(error: unknown): void {
    this.state.lastErrorAt = new Date();
    this.state.lastError = error instanceof Error ? error.message : String(error);
  }

  private async persistBatchToWal(batch: BufferedAuditMessage[], error: unknown): Promise<boolean> {
    if (!this.wal) {
      return false;
    }

    try {
      this.wal.appendBatch(batch.map((message) => message.event));
      await this.wal.flushBuffer();
      if (this.state.resilience) {
        this.state.resilience.spooledMessages += batch.length;
        this.state.resilience.lastSpooledAt = new Date();
      }
      log.warn('Kafka audit producer write failed; spooled batch to WAL', {
        messageCount: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.recovery) {
        try {
          await this.recovery.recoverFromWAL();
        } catch (recoveryError) {
          log.warn('Immediate audit WAL recovery failed; batch retained on disk', {
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        }
      }

      return true;
    } catch (walError) {
      this.recordWalWriteFailure(walError);
      log.error('Failed to spool Kafka audit batch to WAL', {
        messageCount: batch.length,
        error: walError instanceof Error ? walError.message : String(walError),
      });
      return false;
    }
  }

  private spoolOverflowBatchToWal(batch: BufferedAuditMessage[]): void {
    if (batch.length === 0) {
      return;
    }

    if (!this.wal) {
      return;
    }

    try {
      this.wal.appendBatch(batch.map((message) => message.event));
    } catch (walError) {
      this.recordWalWriteFailure(walError);
      log.error('Failed to append overflowed Kafka audit events to WAL', {
        messageCount: batch.length,
        error: walError instanceof Error ? walError.message : String(walError),
      });
      return;
    }

    void this.wal.flushBuffer().then(
      () => {
        if (this.state.resilience) {
          this.state.resilience.spooledMessages += batch.length;
          this.state.resilience.lastSpooledAt = new Date();
        }
      },
      (walError: unknown) => {
        this.recordWalWriteFailure(walError);
        log.error('Failed to flush overflowed Kafka audit events to WAL', {
          messageCount: batch.length,
          error: walError instanceof Error ? walError.message : String(walError),
        });
      },
    );
  }

  private getResilienceStatus(): AuditTransportResilienceStatus | null {
    if (!this.state.resilience) {
      return null;
    }

    return {
      ...this.state.resilience,
      walBufferedEvents: this.wal?.getBufferLength() ?? 0,
    };
  }

  private recordRecoveryResult(result: {
    recovered: number;
    failed: number;
    filesProcessed: number;
  }): void {
    if (!this.state.resilience) {
      return;
    }

    if (result.filesProcessed === 0 && result.recovered === 0 && result.failed === 0) {
      return;
    }

    this.state.resilience.recoveryRuns += 1;
    this.state.resilience.recoveredMessages += result.recovered;
    this.state.resilience.failedRecoveryMessages += result.failed;

    if (result.recovered > 0 || result.filesProcessed > 0) {
      this.state.resilience.lastRecoveredAt = new Date();
    }

    if (result.failed === 0) {
      this.state.resilience.lastRecoveryErrorAt = null;
      this.state.resilience.lastRecoveryError = null;
      return;
    }

    this.state.resilience.lastRecoveryErrorAt = new Date();
    this.state.resilience.lastRecoveryError = `Failed to recover ${result.failed} audit event(s) from WAL`;
  }

  private recordRecoveryError(error: unknown): void {
    if (!this.state.resilience) {
      return;
    }

    this.state.resilience.lastRecoveryErrorAt = new Date();
    this.state.resilience.lastRecoveryError =
      error instanceof Error ? error.message : String(error);
  }

  private recordWalWriteFailure(error: unknown): void {
    if (!this.state.resilience) {
      return;
    }

    this.state.resilience.failedWalWrites += 1;
    this.state.resilience.lastWalErrorAt = new Date();
    this.state.resilience.lastWalError = error instanceof Error ? error.message : String(error);
  }
}
