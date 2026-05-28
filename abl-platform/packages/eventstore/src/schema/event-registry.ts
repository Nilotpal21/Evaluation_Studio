/**
 * EventRegistry - central registry for all event types with Zod validation.
 *
 * Adding a new event type:
 * 1. Define Zod schema in events/{category}-events.ts
 * 2. Register it here with `.register(eventType, schema, metadata)`
 * 3. Done - no DDL changes, no emitter changes, no query changes
 *
 * Validation is fast (<1ms per event). Invalid events are logged and dropped.
 */

import { z } from 'zod';
import type { PlatformEvent } from './platform-event.js';
import { getCategoryFromEventType } from './event-categories.js';

export interface EventMetadata {
  /** Schema version (semver) */
  version: string;
  /** Category for this event type */
  category: string;
  /** Does this event contain PII? (used for GDPR scrubbing) */
  containsPII: boolean;
  /** Human-readable description */
  description?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: z.ZodIssue[];
  eventType?: string;
}

/**
 * EventRegistry - singleton registry for all platform event schemas.
 */
export class EventRegistry {
  private schemas = new Map<string, z.ZodSchema>();
  private metadata = new Map<string, EventMetadata>();

  /**
   * Register an event type with its Zod schema and metadata.
   */
  register(eventType: string, schema: z.ZodSchema, metadata: EventMetadata): void {
    if (this.schemas.has(eventType)) {
      throw new Error(`Event type already registered: ${eventType}`);
    }
    this.schemas.set(eventType, schema);
    this.metadata.set(eventType, metadata);
  }

  /**
   * Validate an event's data field against its registered schema.
   * Returns validation result with errors if invalid.
   */
  validate(event: Partial<PlatformEvent>): ValidationResult {
    if (!event.event_type) {
      return {
        valid: false,
        errors: [
          {
            code: 'custom',
            path: ['event_type'],
            message: 'event_type is required',
          } as z.ZodIssue,
        ],
      };
    }

    const schema = this.schemas.get(event.event_type);
    if (!schema) {
      return {
        valid: false,
        eventType: event.event_type,
        errors: [
          {
            code: 'custom',
            path: ['event_type'],
            message: `Unknown event type: ${event.event_type}`,
          } as z.ZodIssue,
        ],
      };
    }

    const result = schema.safeParse(event.data);
    if (!result.success) {
      return {
        valid: false,
        eventType: event.event_type,
        errors: result.error.issues,
      };
    }

    return { valid: true, eventType: event.event_type };
  }

  /**
   * Validate and return parsed data (throws on invalid).
   */
  validateData<T = unknown>(eventType: string, data: unknown): T {
    const schema = this.schemas.get(eventType);
    if (!schema) {
      throw new Error(`Unknown event type: ${eventType}`);
    }
    return schema.parse(data) as T;
  }

  /**
   * Safe validation - returns undefined if invalid, doesn't throw.
   */
  safeValidateData<T = unknown>(eventType: string, data: unknown): T | undefined {
    const schema = this.schemas.get(eventType);
    if (!schema) return undefined;

    const result = schema.safeParse(data);
    return result.success ? (result.data as T) : undefined;
  }

  /**
   * Get metadata for an event type.
   */
  getMetadata(eventType: string): EventMetadata | undefined {
    return this.metadata.get(eventType);
  }

  /**
   * Check if an event type is registered.
   */
  has(eventType: string): boolean {
    return this.schemas.has(eventType);
  }

  /**
   * Get all registered event types.
   */
  getEventTypes(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Get all event types that contain PII (for GDPR scrubbing).
   */
  getPIIEventTypes(): string[] {
    return Array.from(this.metadata.entries())
      .filter(([, meta]) => meta.containsPII)
      .map(([eventType]) => eventType);
  }

  /**
   * Get event types by category.
   */
  getEventTypesByCategory(category: string): string[] {
    return Array.from(this.metadata.entries())
      .filter(([, meta]) => meta.category === category)
      .map(([eventType]) => eventType);
  }

  /**
   * Infer category from event_type prefix.
   */
  inferCategory(eventType: string): string {
    return getCategoryFromEventType(eventType);
  }
}

/**
 * Global singleton registry.
 * Import this and register your event schemas in the events/ directory.
 */
export const eventRegistry = new EventRegistry();
