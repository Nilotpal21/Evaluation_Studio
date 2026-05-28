/**
 * Queue factory - creates queue instances based on config.
 *
 * Usage:
 *   const queue = createEventQueue({ type: 'direct' });
 *   const queue = createEventQueue({ type: 'bullmq', redis: handle });
 *   const queue = createEventQueue({ type: 'kafka', kafka: { brokers: [...] } });
 */

import type { IEventQueue, EventQueueConfig } from '../interfaces/event-queue.js';
import { DirectQueue } from './direct-queue.js';
import { MemoryEventQueue } from './memory-queue.js';
import { BullMQEventQueue } from './bullmq-queue.js';
import { KafkaEventQueue } from './kafka-queue.js';

export function createEventQueue(config: EventQueueConfig): IEventQueue {
  switch (config.type) {
    case 'direct':
      return new DirectQueue();

    case 'bullmq':
      if (!config.redis) {
        throw new Error('BullMQ queue requires redis config');
      }
      return new BullMQEventQueue({
        redis: config.redis,
        concurrency: config.concurrency,
        maxRetries: config.maxRetries,
      });

    case 'kafka':
      if (!config.kafka) {
        throw new Error('Kafka queue requires kafka config');
      }
      return new KafkaEventQueue({
        kafka: config.kafka,
        concurrency: config.concurrency,
        maxRetries: config.maxRetries,
      });

    case 'memory':
      return new MemoryEventQueue();

    default:
      throw new Error(`Unknown queue type: ${(config as { type: string }).type}`);
  }
}
