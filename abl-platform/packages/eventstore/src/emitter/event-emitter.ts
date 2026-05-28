/**
 * EventEmitter - validates events and enqueues for persistence.
 *
 * Standard emitter with:
 * - Zod validation via EventRegistry
 * - Non-blocking enqueue to IEventQueue
 * - Optional webhook forwarding
 * - Unregistered event types pass through (extensibility)
 * - Invalid events logged but passed through (never block runtime)
 *
 * Flow:
 *   emit(event) → validate via EventRegistry → enqueue to IEventQueue → handler → IEventStore.write()
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { IEventQueue } from '../interfaces/event-queue.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import { EventRegistry } from '../schema/event-registry.js';
import { enrichPlatformEvent } from './enrich-event.js';

const log = createLogger('eventstore:event-emitter');

export interface EventEmitterConfig {
  validation?: {
    enabled?: boolean; // default: true
    strictMode?: boolean; // default: false (log warnings, don't throw)
  };
}

export class EventEmitter implements IEventEmitter {
  constructor(
    private queue: IEventQueue,
    private registry: EventRegistry,
    private config?: EventEmitterConfig,
  ) {}

  emit(event: unknown): void {
    const platformEvent = event as Partial<PlatformEvent>;

    // Validation enabled by default
    const validationEnabled = this.config?.validation?.enabled ?? true;

    if (validationEnabled) {
      if (!this.registry.has(platformEvent.event_type as string)) {
        // Unknown type — pass through without data validation (extensibility)
        log.debug('Unregistered event type, skipping data validation', {
          eventType: platformEvent.event_type,
        });
        // Don't return — let it through to the writer
      } else {
        // Known type — validate data, warn on failure but don't drop
        const dataValidation = this.registry.validate({
          event_type: platformEvent.event_type,
          data: platformEvent.data,
        });
        if (!dataValidation.valid) {
          const errors = dataValidation.errors
            ?.map((e) => `${e.path.join('.')}: ${e.message}`)
            .join(', ');

          if (this.config?.validation?.strictMode) {
            throw new Error(`Invalid event: ${platformEvent.event_type} - ${errors}`);
          } else {
            log.warn('Event data validation failed (passing through)', {
              eventType: platformEvent.event_type,
              errors,
            });
            // Don't return — pass through with raw data
          }
        }
      }
    }

    // Enrich event with defaults
    const enrichedEvent = enrichPlatformEvent(platformEvent as PlatformEvent);

    // Enqueue for persistence (non-blocking)
    this.queue.enqueue(enrichedEvent);
  }

  emitBatch(events: unknown[]): void {
    const validEvents: PlatformEvent[] = [];

    for (const event of events) {
      const platformEvent = event as Partial<PlatformEvent>;

      // Validate
      const validationEnabled = this.config?.validation?.enabled ?? true;
      if (validationEnabled) {
        if (!this.registry.has(platformEvent.event_type as string)) {
          // Unknown type — pass through without data validation (extensibility)
          log.debug('Unregistered event type in batch, skipping data validation', {
            eventType: platformEvent.event_type,
          });
        } else {
          const validation = this.registry.validate({
            event_type: platformEvent.event_type,
            data: platformEvent.data,
          });
          if (!validation.valid) {
            log.warn('Event data validation failed in batch (passing through)', {
              eventType: platformEvent.event_type,
              errors: validation.errors?.map((e) => `${e.path.join('.')}: ${e.message}`),
            });
            // Don't skip — pass through with raw data
          }
        }
      }

      // Enrich and add to batch
      validEvents.push(enrichPlatformEvent(platformEvent as PlatformEvent));
    }

    if (validEvents.length > 0) {
      this.queue.enqueueBatch(validEvents);
    }
  }

  get pendingCount(): number {
    return this.queue.pendingCount;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
