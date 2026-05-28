/**
 * Event queue implementations - pluggable queuing layer.
 *
 * Four implementations:
 * - DirectQueue: pass-through, zero latency (default)
 * - BullMQEventQueue: Redis-backed, durable
 * - KafkaEventQueue: high-throughput streaming
 * - MemoryEventQueue: in-memory for tests
 */

export { DirectQueue } from './direct-queue.js';
export { MemoryEventQueue } from './memory-queue.js';
export { BullMQEventQueue, type BullMQEventQueueConfig } from './bullmq-queue.js';
export {
  BufferedKafkaTopicPublisher,
  type BufferedKafkaRecord,
  type BufferedKafkaTopicPublisherConfig,
} from './buffered-kafka-topic-publisher.js';
export { parseBooleanEnv, parsePositiveIntEnv } from './env-utils.js';
export { KafkaEventQueue, type KafkaEventQueueConfig } from './kafka-queue.js';
export { createEventQueue } from './queue-factory.js';
