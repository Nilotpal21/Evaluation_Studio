import { ulid } from 'ulid';
import type { PlatformEvent } from '../schema/platform-event.js';
import { getCategoryFromEventType } from '../schema/event-categories.js';

export function enrichPlatformEvent(event: PlatformEvent): PlatformEvent {
  return {
    ...event,
    event_id: event.event_id || ulid(),
    category: event.category || getCategoryFromEventType(event.event_type),
    timestamp: event.timestamp || new Date(),
  };
}
