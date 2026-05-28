import { createLogger } from '@abl/compiler/platform';
import { resolveKafkaAuth } from '@agent-platform/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';

const log = createLogger('buffered-kafka-topic-publisher');

export interface BufferedKafkaTopicPublisherConfig {
  brokers: string[];
  clientId: string;
  topic: string;
  batchSize: number;
  lingerMs: number;
  maxRetries: number;
  retryInitialMs: number;
}

export interface BufferedKafkaRecord<T> {
  key?: string;
  value: T;
}

export class BufferedKafkaTopicPublisher<T> {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly buffer: Array<BufferedKafkaRecord<T>> = [];
  private readonly inFlightDrains = new Set<Promise<void>>();
  private readonly connectPromise: Promise<void>;
  private readonly state = {
    connected: false,
    closed: false,
    healthy: true,
  };
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: BufferedKafkaTopicPublisherConfig) {
    const kafkaAuth = resolveKafkaAuth();
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
    this.connectPromise = this.producer
      .connect()
      .then(() => {
        this.state.connected = true;
        this.state.healthy = true;
        log.info('Buffered Kafka topic publisher connected', {
          topic: this.config.topic,
          authMode: kafkaAuth.sasl ? `SASL/${kafkaAuth.sasl.mechanism}` : 'plain',
          ssl: kafkaAuth.ssl ?? false,
        });
      })
      .catch((error: unknown) => {
        this.state.connected = false;
        this.state.healthy = false;
        log.error('Buffered Kafka topic publisher failed to connect', {
          topic: this.config.topic,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }

  publish(record: BufferedKafkaRecord<T>): void {
    if (this.state.closed) {
      throw new Error('BufferedKafkaTopicPublisher is closed');
    }

    this.buffer.push(record);

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

  publishBatch(records: Array<BufferedKafkaRecord<T>>): void {
    for (const record of records) {
      this.publish(record);
    }
  }

  async flush(): Promise<void> {
    this.cancelLinger();
    await this.drainBuffer(true);
    await this.waitForDrains();
  }

  async close(): Promise<void> {
    if (this.state.closed) {
      return;
    }

    this.cancelLinger();
    await this.flush();
    await this.connectPromise;
    await this.producer.disconnect();
    this.state.closed = true;
    this.state.connected = false;
    this.state.healthy = false;
  }

  isHealthy(): boolean {
    return this.state.healthy;
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private enqueueDrain(): void {
    const drainPromise = this.drainBuffer(false);
    this.inFlightDrains.add(drainPromise);
    void drainPromise
      .catch((error: unknown) => {
        log.error('Buffered Kafka topic publisher drain failed', {
          topic: this.config.topic,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlightDrains.delete(drainPromise);
      });
  }

  private async drainBuffer(force: boolean): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    if (!force && this.buffer.length < this.config.batchSize && this.lingerTimer) {
      return;
    }

    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      await this.connectPromise;
      await this.producer.sendBatch({
        topicMessages: [
          {
            topic: this.config.topic,
            messages: batch.map((record) => ({
              ...(record.key ? { key: record.key } : {}),
              value: JSON.stringify(record.value),
            })),
          },
        ],
      });
      this.state.healthy = true;
    } catch (error) {
      this.state.healthy = false;
      this.buffer.unshift(...batch);
      throw error;
    }
  }

  private async waitForDrains(): Promise<void> {
    while (this.inFlightDrains.size > 0) {
      await Promise.all(Array.from(this.inFlightDrains));
    }
  }
}
