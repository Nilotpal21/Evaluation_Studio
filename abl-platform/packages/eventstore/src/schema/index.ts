/**
 * Event schema barrel exports.
 *
 * Import './events' to register all event schemas with the EventRegistry.
 */

// Core types
export type { PlatformEvent, ValidatedEvent } from './platform-event.js';

// Event registry
export {
  EventRegistry,
  eventRegistry,
  type EventMetadata,
  type ValidationResult,
} from './event-registry.js';

// Event categories
export {
  EVENT_CATEGORIES,
  getCategoryFromEventType,
  getCategoryLabel,
} from './event-categories.js';

// Event schemas (importing this registers all events)
export * from './events/index.js';
