/**
 * WritePipelineImpl — Fire-and-forget event sink wrapping TraceStore, WS broadcast, and EventStore.
 */

import { randomUUID } from 'crypto';
import type { WritePipeline } from '@agent-platform/shared-observability/tracing';
import type { TraceStoreInterface, TraceEvent as StoreTraceEvent } from '../trace-store.js';
import type { EventStoreServices } from '@abl/eventstore';
import { createLogger, type PIIRecognizerRegistry } from '@abl/compiler/platform';
import { scrubTraceEvent } from '@abl/compiler';
import { emitToEventStore } from '../trace/emit-to-eventstore.js';

const log = createLogger('write-pipeline');

export interface WritePipelineConfig {
  getTraceStore: () => TraceStoreInterface | null;
  getEventStore: () => EventStoreServices | null;
  getPIIRecognizerRegistry?: () => PIIRecognizerRegistry | undefined;
  getKnownSource?: () => 'production' | 'eval' | 'synthetic' | undefined;
  broadcastToSession: (sessionId: string, message: unknown) => void;
  /** When true, scrub PII and secrets from event data before writing */
  scrubPII?: boolean;
}

export class WritePipelineImpl implements WritePipeline {
  private readonly config: WritePipelineConfig;

  constructor(config: WritePipelineConfig) {
    this.config = config;
  }

  write(event: Record<string, unknown>): void {
    const eventId =
      typeof event.id === 'string' && event.id.trim().length > 0 ? event.id : randomUUID();
    const enrichedEvent = {
      ...event,
      id: eventId,
    } as Record<string, unknown> & { id: string };
    const sessionId = enrichedEvent.sessionId as string | undefined;

    // Scrub PII and secrets from event data before any storage/transmission
    if (this.config.scrubPII && enrichedEvent.data && typeof enrichedEvent.data === 'object') {
      try {
        const piiRecognizerRegistry = this.config.getPIIRecognizerRegistry?.();
        enrichedEvent.data = scrubTraceEvent(
          enrichedEvent.data as Record<string, unknown>,
          piiRecognizerRegistry ? { piiRecognizerRegistry } : undefined,
        );
      } catch (err) {
        log.warn('Event data scrubbing failed — emitting original', {
          sessionId,
          eventType: enrichedEvent.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Write to TraceStore
    try {
      const traceStore = this.config.getTraceStore();
      if (traceStore && sessionId) {
        traceStore.addEvent(sessionId, enrichedEvent as unknown as StoreTraceEvent);
      }
    } catch (err) {
      log.warn('TraceStore write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Broadcast over WebSocket
    try {
      if (sessionId) {
        this.config.broadcastToSession(sessionId, {
          type: 'trace_event',
          sessionId,
          event: enrichedEvent,
        });
      }
    } catch (err) {
      log.warn('WS broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit to EventStore (fire-and-forget)
    try {
      const eventStore = this.config.getEventStore();
      if (eventStore && enrichedEvent.tenantId) {
        emitToEventStore({
          eventStore,
          event: {
            id: enrichedEvent.id as string,
            type: enrichedEvent.type as string,
            sessionId,
            tenantId: enrichedEvent.tenantId as string,
            projectId: (enrichedEvent.projectId as string) ?? undefined,
            deploymentId: (enrichedEvent.deploymentId as string) || undefined,
            agentName: enrichedEvent.agentName as string | undefined,
            environment: enrichedEvent.environment as string | undefined,
            timestamp: (enrichedEvent.timestamp as Date) ?? new Date(),
            durationMs: enrichedEvent.durationMs as number | undefined,
            spanId: enrichedEvent.spanId as string | undefined,
            parentSpanId: enrichedEvent.parentSpanId as string | undefined,
            data: (enrichedEvent.data as Record<string, unknown>) ?? {},
          },
          knownSource: this.config.getKnownSource?.(),
        });
      }
    } catch (err) {
      log.warn('EventStore emit failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
