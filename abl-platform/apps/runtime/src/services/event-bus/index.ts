/**
 * EventBus Module Index & Factory
 *
 * Wires all event bus components together: Kafka producer, dead-letter writer,
 * subscription registry, and the bus itself. Provides createEventBus() for
 * startup and shutdownEventBus() for graceful teardown.
 */

import { Kafka, logLevel } from 'kafkajs';
import { createLogger } from '@abl/compiler/platform';
import { BufferedClickHouseWriter } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  DEFAULT_KAFKA_BROKER,
  EVENT_KAFKA_BATCH_SIZE,
  EVENT_KAFKA_LINGER_MS,
  EVENT_KAFKA_RETRIES,
  EVENT_KAFKA_RETRY_INITIAL_MS,
  EVENT_REGISTRY_SYNC_MS,
  resolveKafkaAuth,
} from '@agent-platform/config';
import { RuntimeEventBus } from './event-bus.js';
import { EventSubscriptionRegistry } from './subscription-registry.js';
import { KafkaSubscriber } from './kafka-subscriber.js';
import type { KafkaProducer } from './kafka-subscriber.js';
import { ClickHouseDeadLetterWriter } from './dead-letter-writer.js';
import type { BufferedWriter, DeadLetterRow } from './dead-letter-writer.js';

export { RuntimeEventBus } from './event-bus.js';
export { EventSubscriptionRegistry } from './subscription-registry.js';
export { KafkaSubscriber } from './kafka-subscriber.js';
export { ClickHouseDeadLetterWriter, DEAD_LETTER_TABLE_SQL } from './dead-letter-writer.js';
export type { EventBus, AnyPlatformEvent, PlatformEvent, EventType } from './types.js';
export { EVENT_TYPES, eventTypeToTopic } from './types.js';

const log = createLogger('event-bus-factory');

export interface EventBusComponents {
  bus: RuntimeEventBus;
  registry: EventSubscriptionRegistry;
  kafkaSubscriber: KafkaSubscriber;
  deadLetterWriter: ClickHouseDeadLetterWriter;
}

/**
 * Adapts BufferedClickHouseWriter (insert/flush) to the BufferedWriter<T>
 * interface (add/flush) expected by ClickHouseDeadLetterWriter.
 */
function adaptWriter<T extends object>(chWriter: BufferedClickHouseWriter<T>): BufferedWriter<T> {
  return {
    add(row: T): void {
      chWriter.insert(row);
    },
    async flush(): Promise<void> {
      await chWriter.flush();
    },
  };
}

export async function createEventBus(
  clickhouseClient: ClickHouseClient,
  syncFn: () => Promise<Map<string, Set<string>>>,
): Promise<EventBusComponents> {
  const brokers = (process.env.EVENT_KAFKA_BROKERS || DEFAULT_KAFKA_BROKER).split(',');
  const batchSize = Number(process.env.EVENT_KAFKA_BATCH_SIZE) || EVENT_KAFKA_BATCH_SIZE;
  const lingerMs = Number(process.env.EVENT_KAFKA_LINGER_MS) || EVENT_KAFKA_LINGER_MS;
  const maxRetries = Number(process.env.EVENT_KAFKA_RETRIES) || EVENT_KAFKA_RETRIES;
  const retryInitialMs =
    Number(process.env.EVENT_KAFKA_RETRY_INITIAL_MS) || EVENT_KAFKA_RETRY_INITIAL_MS;
  const registrySyncMs = Number(process.env.EVENT_REGISTRY_SYNC_MS) || EVENT_REGISTRY_SYNC_MS;

  const kafkaAuth = resolveKafkaAuth();
  const kafka = new Kafka({
    clientId: 'abl-runtime-events',
    brokers,
    logLevel: logLevel.WARN,
    ...kafkaAuth,
  });
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 5,
    retry: { initialRetryTime: retryInitialMs, retries: maxRetries, factor: 2 },
  });
  await producer.connect().catch((err: unknown) => {
    log.error('Kafka event bus producer failed to connect', {
      authMode: kafkaAuth.sasl ? `SASL/${kafkaAuth.sasl.mechanism}` : 'plain',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  });
  log.info('Kafka event producer connected', {
    authMode: kafkaAuth.sasl ? `SASL/${kafkaAuth.sasl.mechanism}` : 'plain',
    ssl: kafkaAuth.ssl ?? false,
  });

  const chWriter = new BufferedClickHouseWriter<DeadLetterRow>(clickhouseClient, {
    table: 'abl_platform.dead_letter_events',
    onError: (err, ctx) => {
      log.error('Dead-letter ClickHouse flush error', {
        error: err instanceof Error ? err.message : String(err),
        context: ctx,
      });
    },
  });
  const deadLetterWriter = new ClickHouseDeadLetterWriter(adaptWriter(chWriter));

  // Cast: KafkaJS Producer.sendBatch returns RecordMetadata[] but our
  // KafkaProducer interface returns void (we don't use the metadata).
  const kafkaSubscriber = new KafkaSubscriber(
    producer as unknown as KafkaProducer,
    deadLetterWriter,
    {
      batchSize,
      lingerMs,
      maxRetries,
      retryInitialMs,
    },
  );

  const registry = new EventSubscriptionRegistry();
  await registry.startSync(syncFn, registrySyncMs);

  const bus = new RuntimeEventBus(registry);
  bus.subscribe(kafkaSubscriber.handle);

  log.info('EventBus initialized', { batchSize, lingerMs, maxRetries, registrySyncMs });
  return { bus, registry, kafkaSubscriber, deadLetterWriter };
}

export async function shutdownEventBus(components: EventBusComponents): Promise<void> {
  const { bus, registry, kafkaSubscriber, deadLetterWriter } = components;
  await bus.shutdown();
  registry.stop();
  await kafkaSubscriber.close();
  await deadLetterWriter.flush();
  log.info('EventBus shut down completely');
}
