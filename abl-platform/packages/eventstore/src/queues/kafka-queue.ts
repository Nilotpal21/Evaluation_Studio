/**
 * KafkaEventQueue - Kafka producer/consumer for high-throughput streaming.
 *
 * Uses KafkaJS for:
 * - High-throughput event streaming (100K+ events/sec)
 * - Partitioned topics (tenant-based or round-robin)
 * - Consumer groups (horizontal scaling)
 * - Ordered delivery per partition
 * - Cross-service fan-out
 *
 * Use when:
 * - Need high throughput (>10K events/sec)
 * - Integration with external data pipelines (Spark, Flink, data lake)
 * - Multi-service event streaming
 * - Already have Kafka infrastructure
 */

import { Kafka, Producer, Consumer, type ProducerRecord, type ConsumerRunConfig } from 'kafkajs';
// Register LZ4 codec once per process — KafkaJS doesn't ship with LZ4 /
// Snappy / ZSTD support built in. Our docker-compose sets broker-level
// `compression.type=lz4` on all platform topics, so every consumer needs
// the LZ4 codec to decode batches. Registration is global (mutates the
// `CompressionCodecs` map); doing it at module load ensures every
// `KafkaEventQueue` instance — and any other KafkaJS consumer in this
// process — can read LZ4 batches without per-instance wiring.
//
// `CompressionTypes` + `CompressionCodecs` are attached to KafkaJS's CJS
// module.exports at runtime; tsx's ESM loader doesn't statically see them
// as named exports. Load via `createRequire` to bypass ESM static analysis.
//
// Implementation note: the recommended `kafkajs-lz4` package bundles
// `lz4-asm` (WASM) which fails on Node 24 with `ERR_INVALID_URL` when
// locating the .wasm binary. We instead use pure-JS `lz4js` and hand-roll
// the ~5-line codec interface KafkaJS expects. The `compress` /
// `decompress` functions receive Node `Buffer` (or `Uint8Array`) and must
// return the transformed buffer.
import { createRequire } from 'node:module';
const kafkajsRequire = createRequire(import.meta.url);
const {
  CompressionTypes,
  CompressionCodecs,
}: {
  CompressionTypes: { None: 0; GZIP: 1; Snappy: 2; LZ4: 3; ZSTD: 4 };
  CompressionCodecs: Record<
    number,
    () => {
      compress: (encoder: { buffer: Buffer }) => Promise<Buffer>;
      decompress: (buffer: Buffer) => Promise<Buffer>;
    }
  >;
} = kafkajsRequire('kafkajs');
const lz4js = kafkajsRequire('lz4js') as {
  compress: (input: Uint8Array) => Uint8Array;
  decompress: (input: Uint8Array) => Uint8Array;
};
CompressionCodecs[CompressionTypes.LZ4] = () => ({
  compress: async (encoder: { buffer: Buffer }) => Buffer.from(lz4js.compress(encoder.buffer)),
  decompress: async (buffer: Buffer) => Buffer.from(lz4js.decompress(buffer)),
});
import { resolveKafkaAuth } from '@agent-platform/config';
import { createLogger } from '@agent-platform/shared-observability';
import type { IEventQueue } from '../interfaces/event-queue.js';

const log = createLogger('eventstore:kafka-queue');

export interface KafkaEventQueueConfig {
  kafka: {
    brokers: string[]; // e.g. ['kafka1:9092', 'kafka2:9092']
    topic?: string; // default: 'platform-events'
    groupId?: string; // consumer group (default: 'eventstore-consumer')
    partitions?: number; // topic partition count (default: 6)
  };
  concurrency?: number;
  maxRetries?: number;
}

export class KafkaEventQueue implements IEventQueue {
  readonly queueName: string;
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer | null = null;
  private handler: ((event: unknown) => void | Promise<void>) | null = null;
  private producerHealthy = false;
  private consumerHealthy = false;
  private readonly topic: string;
  private readonly groupId: string;
  private readonly partitions: number;
  private readonly concurrency: number;
  private pendingMessages = 0;

  constructor(private config: KafkaEventQueueConfig) {
    this.queueName = 'kafka';
    this.topic = config.kafka.topic ?? 'platform-events';
    this.groupId = config.kafka.groupId ?? 'eventstore-consumer';
    this.partitions = config.kafka.partitions ?? 6;
    this.concurrency = config.concurrency ?? 10;

    // Create Kafka client — SASL/SSL resolved from env (KAFKA_AUTH_ENABLED, KAFKA_SASL_*, KAFKA_SSL_ENABLED).
    const kafkaAuth = resolveKafkaAuth();
    this.kafka = new Kafka({
      clientId: 'eventstore',
      brokers: config.kafka.brokers,
      retry: {
        retries: config.maxRetries ?? 3,
        initialRetryTime: 100,
        multiplier: 2,
      },
      ...kafkaAuth,
    });
    // Create producer
    this.producer = this.kafka.producer({
      idempotent: true, // Prevent duplicate messages on retry
      maxInFlightRequests: 5,
    });

    // Connect producer
    this.producer
      .connect()
      .then(() => {
        log.info('Producer connected', {
          authMode: kafkaAuth.sasl ? `SASL/${kafkaAuth.sasl.mechanism}` : 'plain',
          ssl: kafkaAuth.ssl ?? false,
        });
        this.producerHealthy = true;
      })
      .catch((err) => {
        log.error('Producer connection failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.producerHealthy = false;
      });

    // Monitor producer health
    this.producer.on(this.producer.events.CONNECT, () => {
      this.producerHealthy = true;
    });

    this.producer.on(this.producer.events.DISCONNECT, () => {
      log.warn('Producer disconnected');
      this.producerHealthy = false;
    });

    this.producer.on(this.producer.events.REQUEST_TIMEOUT, () => {
      log.warn('Producer request timeout');
      this.producerHealthy = false;
    });
  }

  get pendingCount(): number {
    return this.pendingMessages;
  }

  enqueue(event: unknown): void {
    this.pendingMessages++;

    // Serialize event
    const value = JSON.stringify(event);

    // Partition key: use tenant_id for ordered delivery per tenant
    // Falls back to round-robin if no tenant_id
    const key =
      typeof event === 'object' && event !== null && 'tenant_id' in event
        ? String((event as { tenant_id: string }).tenant_id)
        : undefined;

    // Send to Kafka (non-blocking, batched)
    this.producer
      .send({
        topic: this.topic,
        messages: [{ key, value }],
      })
      .then(() => {
        this.pendingMessages--;
        this.producerHealthy = true;
      })
      .catch((err) => {
        this.pendingMessages--;
        log.error('Failed to send message', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.producerHealthy = false;
      });
  }

  enqueueBatch(events: unknown[]): void {
    if (events.length === 0) return;

    this.pendingMessages += events.length;

    // Batch send for efficiency
    const messages = events.map((event) => {
      const value = JSON.stringify(event);
      const key =
        typeof event === 'object' && event !== null && 'tenant_id' in event
          ? String((event as { tenant_id: string }).tenant_id)
          : undefined;
      return { key, value };
    });

    this.producer
      .send({ topic: this.topic, messages })
      .then(() => {
        this.pendingMessages -= events.length;
        this.producerHealthy = true;
      })
      .catch((err) => {
        this.pendingMessages -= events.length;
        log.error('Failed to send batch', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.producerHealthy = false;
      });
  }

  onProcess(handler: (event: unknown) => void | Promise<void>): void {
    if (this.handler) {
      throw new Error('KafkaEventQueue: Handler already registered');
    }

    this.handler = handler;

    // Create Kafka consumer
    this.consumer = this.kafka.consumer({
      groupId: this.groupId,
      maxWaitTimeInMs: 100, // Poll every 100ms
      sessionTimeout: 30000, // 30s
      heartbeatInterval: 3000, // 3s
    });
    this.consumerHealthy = false;

    // Message processor
    const runConfig: ConsumerRunConfig = {
      eachMessage: async ({ message }) => {
        if (!message.value) return;

        try {
          const event = JSON.parse(message.value.toString());
          await Promise.resolve(handler(event));
        } catch (err) {
          log.error('Failed to process message', {
            error: err instanceof Error ? err.message : String(err),
            offset: message.offset,
          });
          // Don't throw - allow Kafka to continue processing other messages
        }
      },
    };

    // Use partitionsConsumedConcurrently for parallel processing
    if (this.concurrency > 1) {
      runConfig.partitionsConsumedConcurrently = Math.min(this.concurrency, this.partitions);
    }

    // Connect → subscribe → run — MUST be sequential. Calling `run()` before
    // `subscribe()` resolves triggers KafkaJS "Cannot subscribe to topic while
    // consumer is running" and leaves the consumer joined to the group with
    // an empty memberAssignment (no messages ever delivered).
    this.consumer
      .connect()
      .then(() => this.consumer!.subscribe({ topic: this.topic, fromBeginning: false }))
      .then(() => {
        log.info('Consumer subscribed');
        return this.consumer!.run(runConfig);
      })
      .catch((err) => {
        log.error('Consumer connection failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.consumerHealthy = false;
      });

    // Monitor consumer health
    this.consumer.on(this.consumer.events.CONNECT, () => {
      log.info('Consumer connected');
    });

    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      log.info('Consumer joined group');
      this.consumerHealthy = true;
    });

    this.consumer.on(this.consumer.events.DISCONNECT, () => {
      log.warn('Consumer disconnected');
      this.consumerHealthy = false;
    });

    this.consumer.on(this.consumer.events.REQUEST_TIMEOUT, () => {
      log.warn('Consumer request timeout');
      this.consumerHealthy = false;
    });

    this.consumer.on(this.consumer.events.CRASH, (event) => {
      log.error('Consumer crashed', {
        error:
          event.payload.error instanceof Error
            ? event.payload.error.message
            : String(event.payload.error),
      });
      this.consumerHealthy = false;
    });
  }

  /**
   * Topic-routed, ACK-awaitable publish for transactional outbox consumers.
   *
   * Unlike `enqueue` (fire-and-forget, fixed topic), this awaits the Kafka
   * broker ACK with `acks: -1` (all in-sync replicas). Required by workflow
   * event-sourcing outbox where the poller MUST know the publish succeeded
   * before marking the outbox row as `publishedAt`. See LLD §1.3, HLD §3.6
   * Gap 2 resolution option (b).
   *
   * `pendingMessages` is incremented/decremented around the await for
   * observability parity with `enqueue`.
   */
  async publishAndAck(topic: string, event: unknown, key?: string): Promise<void> {
    const value = JSON.stringify(event);
    const resolvedKey =
      key ??
      (typeof event === 'object' && event !== null && 'tenant_id' in event
        ? String((event as { tenant_id: string }).tenant_id)
        : undefined);

    this.pendingMessages++;
    try {
      await this.producer.send({
        topic,
        messages: [{ key: resolvedKey, value }],
        acks: -1,
      });
      this.producerHealthy = true;
    } finally {
      this.pendingMessages--;
    }
  }

  async flush(): Promise<void> {
    // Wait for producer to flush all pending messages
    // Kafka producer internally batches, so we need to wait for the batch to be sent
    while (this.pendingMessages > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async close(): Promise<void> {
    // Graceful shutdown: disconnect consumer and producer
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumerHealthy = false;
      this.consumer = null;
    }
    await this.producer.disconnect();
    this.producerHealthy = false;
    this.handler = null;
  }

  isHealthy(): boolean {
    return this.consumer ? this.consumerHealthy : this.producerHealthy;
  }

  /**
   * Get topic metadata (partitions, leaders, etc.)
   */
  async getTopicMetadata(): Promise<unknown> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const metadata = await admin.fetchTopicMetadata({ topics: [this.topic] });
      return metadata;
    } finally {
      await admin.disconnect();
    }
  }
}
