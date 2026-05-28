/**
 * Pluggable event queue interface.
 *
 * The queue sits between the emitter and the store. It decouples "accept an event"
 * from "persist an event," enabling different durability/throughput tradeoffs.
 *
 * Implementations:
 * - DirectQueue (pass-through, lowest latency)
 * - BullMQEventQueue (Redis-backed, durable)
 * - KafkaEventQueue (high-throughput streaming) — SASL/SSL auth is read from
 *   env vars (KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD,
 *   KAFKA_SSL_ENABLED) via @agent-platform/config#resolveKafkaAuth.
 * - MemoryEventQueue (tests)
 */

export interface IEventQueue {
  /**
   * Enqueue an event for processing. Must be non-blocking.
   * The event will be passed to the registered handler (via `onProcess`) when dequeued.
   */
  enqueue(event: unknown): void;

  /**
   * Enqueue a batch of events. Must be non-blocking.
   */
  enqueueBatch(events: unknown[]): void;

  /**
   * Register the consumer that processes dequeued events.
   * Called once at startup. The consumer typically writes to IEventStore.
   *
   * @param handler - Function called for each dequeued event
   */
  onProcess(handler: (event: unknown) => void | Promise<void>): void;

  /**
   * Flush pending events through to the consumer.
   * Blocks until all queued events have been processed.
   */
  flush(): Promise<void>;

  /**
   * Graceful shutdown: drain queue, then close.
   */
  close(): Promise<void>;

  /**
   * Number of events waiting in the queue (for monitoring).
   */
  readonly pendingCount: number;

  /**
   * Queue backend name for logging (e.g. "direct", "bullmq", "kafka", "memory").
   */
  readonly queueName: string;

  /**
   * Health check — returns false if queue infrastructure is down (e.g., Redis/Kafka unreachable).
   * Used by ResilientEventEmitter to decide when to fall back to direct store write.
   */
  isHealthy(): boolean;
}

/** Configuration for queue creation */
export type EventQueueType = 'direct' | 'bullmq' | 'kafka' | 'memory';

export interface EventQueueConfig {
  type: EventQueueType;
  redis?: import('@agent-platform/redis').RedisConnectionHandle; // required for bullmq
  kafka?: {
    // required for kafka
    brokers: string[]; // e.g. ['kafka1:9092', 'kafka2:9092']
    topic?: string; // default: 'platform-events'
    groupId?: string; // consumer group (default: 'event-consumer')
    partitions?: number; // topic partition count (default: 6)
  };
  concurrency?: number; // bullmq/kafka consumer concurrency (default: 10)
  maxRetries?: number; // retry count (default: 3)
}
