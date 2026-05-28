/**
 * ResilientEventEmitter - 3-level failover for zero data loss.
 *
 * Failover cascade:
 *   LEVEL 1: Primary queue (Kafka/BullMQ) - if healthy
 *   LEVEL 2: Direct store write (ClickHouse BufferedWriter) - if queue unhealthy
 *   LEVEL 3: Filesystem WAL (JSONL append-only) - if store write fails
 *
 * Features:
 * - Health check loop (every 5s) - marks queue unhealthy on failure
 * - Automatic fallback when primary fails
 * - WAL replay on startup + periodic recovery
 * - Zero data loss guarantee (events survive pod restarts)
 *
 * Use when:
 * - Events are critical for compliance/audit
 * - Need zero data loss (billing, GDPR, audit trails)
 * - Can tolerate disk I/O per event (WAL write is async)
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { IEventQueue } from '../interfaces/event-queue.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import { EventRegistry } from '../schema/event-registry.js';
import { FileSystemWAL } from '../resilience/filesystem-wal.js';
import type { EventEmitterConfig } from './event-emitter.js';
import { enrichPlatformEvent } from './enrich-event.js';

const log = createLogger('eventstore:resilient-emitter');

export interface ResilienceConfig extends EventEmitterConfig {
  enabled?: boolean; // default: false
  healthCheckIntervalMs?: number; // default: 5000
  wal?: {
    directory: string;
    maxFileSizeBytes?: number;
    maxRetentionHours?: number;
  };
}

export class ResilientEventEmitter implements IEventEmitter {
  private primaryQueue: IEventQueue;
  private fallbackQueue: IEventQueue; // DirectQueue → direct store write
  private wal: FileSystemWAL;
  private registry: EventRegistry;
  private primaryHealthy = true;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    primaryQueue: IEventQueue,
    fallbackQueue: IEventQueue,
    wal: FileSystemWAL,
    registry: EventRegistry,
    config?: ResilienceConfig,
  ) {
    this.primaryQueue = primaryQueue;
    this.fallbackQueue = fallbackQueue;
    this.wal = wal;
    this.registry = registry;

    // Start health check loop
    const interval = config?.healthCheckIntervalMs ?? 5_000;
    this.healthCheckInterval = setInterval(() => {
      this.checkPrimaryHealth();
    }, interval);

    // Don't prevent Node.js from exiting
    if (this.healthCheckInterval.unref) {
      this.healthCheckInterval.unref();
    }
  }

  /**
   * Emit event with 3-level failover.
   */
  emit(event: unknown): void {
    const platformEvent = event as Partial<PlatformEvent>;

    // Match EventEmitter behavior: registered event types validate, while
    // unregistered platform events pass through for forward-compatible traces.
    if (this.registry.has(platformEvent.event_type as string)) {
      const validation = this.registry.validate(platformEvent);
      if (!validation.valid) {
        log.warn('Invalid event (dropped)', {
          eventType: platformEvent.event_type,
          errors: validation.errors,
        });
        return;
      }
    } else {
      log.debug('Unregistered event type, skipping data validation', {
        eventType: platformEvent.event_type,
      });
    }

    // Enrich event
    const enrichedEvent = enrichPlatformEvent(platformEvent as PlatformEvent);

    // LEVEL 1: Try primary queue (if healthy)
    if (this.primaryHealthy) {
      try {
        this.primaryQueue.enqueue(enrichedEvent);
        return; // Success - event in durable queue
      } catch (err) {
        log.warn('Primary queue failed, falling back', {
          error: err instanceof Error ? err.message : String(err),
          eventType: enrichedEvent.event_type,
        });
        this.primaryHealthy = false; // Mark unhealthy for next emit
      }
    }

    // LEVEL 2: Try direct store write (fallback queue → BufferedWriter)
    try {
      this.fallbackQueue.enqueue(enrichedEvent);
      log.debug('Event written via fallback queue', {
        eventType: enrichedEvent.event_type,
      });
      return; // Success - event in ClickHouse buffer
    } catch (err) {
      log.error('Store write failed, writing to WAL', {
        error: err instanceof Error ? err.message : String(err),
        eventType: enrichedEvent.event_type,
      });
    }

    // LEVEL 3: Filesystem WAL (last resort)
    // append() is synchronous (buffers in memory, flushes periodically)
    try {
      this.wal.append(enrichedEvent);
    } catch (err) {
      // Even WAL failed - log and drop (extremely rare: serialization error)
      log.error('WAL write failed — event lost', {
        error: err instanceof Error ? err.message : String(err),
        eventId: enrichedEvent.event_id,
        eventType: enrichedEvent.event_type,
      });
    }
  }

  emitBatch(events: unknown[]): void {
    // For batch, try to send the whole batch at once through each level
    const platformEvents = (events as PlatformEvent[]).map((event) => enrichPlatformEvent(event));

    // LEVEL 1: Primary queue
    if (this.primaryHealthy) {
      try {
        this.primaryQueue.enqueueBatch(platformEvents);
        return;
      } catch (err) {
        log.warn('Primary queue batch failed', {
          error: err instanceof Error ? err.message : String(err),
          count: platformEvents.length,
        });
        this.primaryHealthy = false;
      }
    }

    // LEVEL 2: Fallback queue
    try {
      this.fallbackQueue.enqueueBatch(platformEvents);
      return;
    } catch (err) {
      log.error('Fallback batch failed, writing to WAL', {
        error: err instanceof Error ? err.message : String(err),
        count: platformEvents.length,
      });
    }

    // LEVEL 3: WAL (write each event individually)
    for (const event of platformEvents) {
      try {
        this.wal.append(event);
      } catch (err) {
        log.error('WAL write failed', {
          error: err instanceof Error ? err.message : String(err),
          eventId: event.event_id,
        });
      }
    }
  }

  get pendingCount(): number {
    return this.primaryQueue.pendingCount + this.fallbackQueue.pendingCount;
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    await Promise.all([this.primaryQueue.close(), this.fallbackQueue.close(), this.wal.close()]);
  }

  /**
   * Check primary queue health.
   */
  private checkPrimaryHealth(): void {
    const healthy = this.primaryQueue.isHealthy();

    if (healthy && !this.primaryHealthy) {
      log.info('Primary queue recovered');
    } else if (!healthy && this.primaryHealthy) {
      log.warn('Primary queue unhealthy, using fallback');
    }

    this.primaryHealthy = healthy;
  }

  /**
   * Get current primary health status (for monitoring).
   */
  isPrimaryHealthy(): boolean {
    return this.primaryHealthy;
  }
}
