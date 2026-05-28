/**
 * Core eventstore interfaces — zero dependencies, backend-agnostic contracts.
 *
 * All components depend on these interfaces, never on concrete implementations.
 * This enables pluggable storage (ClickHouse, memory, remote) and queuing (direct, BullMQ, Kafka).
 */

export type {
  // Shared types
  TimeRange,
  EventCategory,
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  PurgeResult,
} from './types.js';

export type {
  // Storage interfaces
  IEventWriter,
  IEventReader,
  IEventLifecycle,
  IEventStore,
} from './event-store.js';

export type {
  // Queue interfaces
  IEventQueue,
  EventQueueType,
  EventQueueConfig,
} from './event-queue.js';

export type {
  // Emitter interface
  IEventEmitter,
} from './event-emitter.js';

export type {
  // Query interfaces
  IEventQueryService,
  ICacheProvider,
} from './event-query.js';

export type {
  // Retention interface
  IEventRetention,
  RetentionPolicy,
} from './event-retention.js';

export type {
  // GDPR interface
  IEventGDPR,
} from './event-gdpr.js';
