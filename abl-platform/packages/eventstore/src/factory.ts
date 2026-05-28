/**
 * EventStore factory - wires everything together based on mode and config.
 *
 * Three modes:
 * - embedded: All components run in-process (default)
 * - remote: Runtime pod delegates to standalone service
 * - service: Standalone service pod owns the store
 *
 * Usage:
 *   const { emitter, queryService, retention, gdpr } = createEventStore(config);
 */

import type { ClickHouseClient } from '@clickhouse/client';
import type { IEventEmitter } from './interfaces/event-emitter.js';
import type { IEventQueryService, ICacheProvider } from './interfaces/event-query.js';
import type { IEventRetention } from './interfaces/event-retention.js';
import type { IEventGDPR } from './interfaces/event-gdpr.js';
import type { IEventStore } from './interfaces/event-store.js';
import type { EventQueueConfig } from './interfaces/event-queue.js';
import { eventRegistry } from './schema/event-registry.js';
// Side-effect import: registers all event schemas with eventRegistry
import './schema/events/index.js';
import { createEventQueue } from './queues/queue-factory.js';
import { ClickHouseEventStore } from './stores/clickhouse/clickhouse-event-store.js';
import { MemoryEventStore } from './stores/memory/memory-event-store.js';
import { RemoteEventQueryClient } from './stores/remote/remote-event-query-client.js';
import { RemoteEventLifecycleClient } from './stores/remote/remote-event-lifecycle-client.js';
import { EventEmitter } from './emitter/event-emitter.js';
import { ResilientEventEmitter } from './emitter/resilient-event-emitter.js';
import { DirectQueue } from './queues/direct-queue.js';
import { FileSystemWAL } from './resilience/filesystem-wal.js';
import { EventRecoveryService } from './resilience/event-recovery-service.js';
import { EventQueryService } from './query/event-query-service.js';
import { EventRetentionService } from './retention/event-retention-service.js';
import { EventGDPRService } from './retention/event-gdpr-service.js';
import {
  EventWebhookForwarder,
  type WebhookForwarderConfig,
} from './webhook/event-webhook-forwarder.js';

export type EventStoreBackend = 'clickhouse' | 'memory';
export type EventStoreMode = 'embedded' | 'remote' | 'service';

export interface EventStoreConfig {
  mode?: EventStoreMode; // default: 'embedded'
  backend?: EventStoreBackend; // default: 'clickhouse' (used in embedded/service modes)
  queue?: EventQueueConfig; // default: { type: 'direct' }

  // Remote mode config
  queryUrl?: string; // required for 'remote' mode

  // Store config (for embedded/service modes)
  clickhouse?: {
    client: ClickHouseClient;
    table?: string;
    batchSize?: number;
    flushIntervalMs?: number;
    maxBufferSize?: number;
    maxRetries?: number;
  };

  // Cache config
  cache?: {
    provider: ICacheProvider;
    ttlSeconds?: number;
  };

  // Webhook config
  webhook?: WebhookForwarderConfig;

  // Validation config
  validation?: {
    enabled?: boolean;
    strictMode?: boolean;
  };

  // Resilience config (3-level failover)
  resilience?: {
    enabled?: boolean; // default: false
    healthCheckIntervalMs?: number;
    wal?: {
      directory: string;
      maxFileSizeBytes?: number;
      maxRetentionHours?: number;
    };
  };
}

export interface EventStoreServices {
  store?: IEventStore; // only in embedded/service modes
  emitter: IEventEmitter;
  queryService: IEventQueryService;
  retention: IEventRetention;
  gdpr: IEventGDPR;
  recovery?: EventRecoveryService; // only when resilience.wal is configured
  webhookForwarder?: EventWebhookForwarder;
}

/**
 * Create event store services based on configuration.
 */
export function createEventStore(config: EventStoreConfig): EventStoreServices {
  const mode = config.mode ?? 'embedded';

  // ═══════════════════════════════════════════════════════════════════════════
  // REMOTE MODE: Runtime pod → Remote service
  // ═══════════════════════════════════════════════════════════════════════════

  if (mode === 'remote') {
    if (!config.queryUrl) {
      throw new Error('queryUrl is required for remote mode');
    }

    // Create queue for writes (typically BullMQ or Kafka)
    const queue = createEventQueue(config.queue ?? { type: 'direct' });

    // Remote HTTP clients for queries and lifecycle operations
    const remoteReader = new RemoteEventQueryClient(config.queryUrl);
    const remoteLifecycle = new RemoteEventLifecycleClient(config.queryUrl);

    return {
      emitter: new EventEmitter(queue, eventRegistry, config),
      queryService: new EventQueryService(remoteReader, config.cache?.provider ?? null, config),
      retention: new EventRetentionService(remoteLifecycle),
      gdpr: new EventGDPRService(remoteLifecycle),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMBEDDED / SERVICE MODE: Local store
  // ═══════════════════════════════════════════════════════════════════════════

  const backend = config.backend ?? 'clickhouse';

  // Create store
  const store: IEventStore =
    backend === 'clickhouse'
      ? new ClickHouseEventStore(config.clickhouse!)
      : new MemoryEventStore();

  // Create queue
  const primaryQueue = createEventQueue(config.queue ?? { type: 'direct' });

  // Wire queue → store
  primaryQueue.onProcess((event) => store.write(event));

  // Create webhook forwarder (optional)
  const webhookForwarder = config.webhook ? new EventWebhookForwarder(config.webhook) : undefined;

  // Create emitter (standard or resilient)
  let emitter: IEventEmitter;
  let recovery: EventRecoveryService | undefined;

  if (config.resilience?.enabled && config.resilience?.wal) {
    // RESILIENT MODE: 3-level failover (queue → direct → WAL)
    const wal = new FileSystemWAL(config.resilience.wal);
    const fallbackQueue = new DirectQueue();
    fallbackQueue.onProcess((event) => store.write(event));

    emitter = new ResilientEventEmitter(
      primaryQueue,
      fallbackQueue,
      wal,
      eventRegistry,
      config.resilience,
    );

    recovery = new EventRecoveryService(wal, store);
  } else {
    // STANDARD MODE: Single queue path
    emitter = new EventEmitter(primaryQueue, eventRegistry, config);
  }

  return {
    store,
    emitter,
    queryService: new EventQueryService(store, config.cache?.provider ?? null, config),
    retention: new EventRetentionService(store),
    gdpr: new EventGDPRService(store),
    recovery,
    webhookForwarder,
  };
}
