/**
 * @abl/eventstore - Unified event storage framework.
 *
 * Pluggable storage (ClickHouse, Memory, Remote) and queuing (Direct, BullMQ, Kafka, Memory).
 *
 * Usage:
 *   import { createEventStore } from '@abl/eventstore';
 *
 *   const { emitter, queryService, retention, gdpr } = createEventStore({
 *     mode: 'embedded',
 *     backend: 'clickhouse',
 *     clickhouse: { client: getClickHouseClient() },
 *   });
 *
 *   emitter.emit({ event_type: 'session.started', ... });
 */

// ═══════════════════════════════════════════════════════════════════════════
// Factory (main entry point)
// ═══════════════════════════════════════════════════════════════════════════

export {
  createEventStore,
  type EventStoreConfig,
  type EventStoreServices,
  type EventStoreBackend,
  type EventStoreMode,
} from './factory.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export type * from './interfaces/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Schema & Events
// ═══════════════════════════════════════════════════════════════════════════

export type { PlatformEvent, ValidatedEvent } from './schema/platform-event.js';

export {
  EventRegistry,
  eventRegistry,
  type EventMetadata,
  type ValidationResult,
} from './schema/event-registry.js';

export {
  EVENT_CATEGORIES,
  getCategoryFromEventType,
  getCategoryLabel,
} from './schema/event-categories.js';

// Side-effect import: triggers event schema registration with eventRegistry
import './schema/events/index.js';
// Re-export event type definitions
export type * from './schema/events/index.js';

// Workflow + human-task event schemas use explicit-registration (see
// `./schema/events/workflow-execution-events.ts` file header). Re-export
// the register functions + Zod schemas so runtime callers can wire them.
export {
  registerWorkflowExecutionEvents,
  registerHumanTaskEvents,
  WorkflowExecutionEventSchema,
  WorkflowExecutionEventTypeSchema,
  HumanTaskEventSchema,
  HumanTaskEventTypeSchema,
} from './schema/events/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Stores
// ═══════════════════════════════════════════════════════════════════════════

export * from './stores/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Queues
// ═══════════════════════════════════════════════════════════════════════════

export * from './queues/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Emitters
// ═══════════════════════════════════════════════════════════════════════════

export * from './emitter/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Query Service
// ═══════════════════════════════════════════════════════════════════════════

export * from './query/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Retention & GDPR
// ═══════════════════════════════════════════════════════════════════════════

export * from './retention/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Webhook Forwarder
// ═══════════════════════════════════════════════════════════════════════════

export * from './webhook/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Resilience (WAL & Recovery)
// ═══════════════════════════════════════════════════════════════════════════

export * from './resilience/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Evaluation Pipeline
// ═══════════════════════════════════════════════════════════════════════════

export * from './evaluation/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Alerting Engine
// ═══════════════════════════════════════════════════════════════════════════

export * from './alerting/index.js';
