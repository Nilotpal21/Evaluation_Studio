/**
 * EventStore Trace Adapter
 *
 * Composite adapter that wraps the existing TraceStoreHandle (Redis) write
 * with a fire-and-forget EventStore (ClickHouse) write. The TraceStore write
 * always happens; the EventStore write is best-effort and only fires when:
 *   1. The EventStore singleton is available (ClickHouse initialized)
 *   2. The trace event carries a tenantId in its data
 *
 * Session ID resolution for EventStore: prefers `runtimeSessionId` from the
 * event data, falls back to `contactId`.
 */

import type { TraceEventEmitter, TraceStoreHandle } from '@agent-platform/agent-transfer';
import type { EventStoreServices } from '@abl/eventstore';
import { redactPII } from '@abl/compiler';
import { emitToEventStore } from '../trace/emit-to-eventstore.js';
import { getEventStore } from '../eventstore-singleton.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('agent-transfer:eventstore-adapter');

/**
 * Creates a composite TraceEventEmitter that writes to both the in-memory
 * TraceStore (Redis ring buffer) and the durable EventStore (ClickHouse).
 *
 * @param traceStore - The platform TraceStore handle for Redis writes
 * @param getEventStoreFn - Lazy accessor for the EventStore singleton;
 *   defaults to the runtime's `getEventStore()` when not provided (tests
 *   inject a stub).
 */
export function createEventStoreTraceAdapter(
  traceStore: TraceStoreHandle,
  getEventStoreFn: () => EventStoreServices | null = getEventStore,
  emitFn: typeof emitToEventStore = emitToEventStore,
): TraceEventEmitter {
  return {
    emit(event) {
      // ── 1. Always write to TraceStore (Redis) ────────────────────────
      const storeEventId = `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = 'agent-transfer';
      const storeEvent = {
        id: storeEventId,
        sessionId,
        type: event.type,
        timestamp: new Date(event.timestamp),
        data: event.data,
      };

      const traceResult = traceStore.addEvent(sessionId, storeEvent);

      // ── 2. Fire-and-forget to EventStore (ClickHouse) ────────────────
      const eventStore = getEventStoreFn();
      if (!eventStore) {
        return traceResult;
      }

      const tenantId = typeof event.data.tenantId === 'string' ? event.data.tenantId : '';
      if (!tenantId) {
        log.debug('Skipping EventStore emit — tenantId missing from transfer trace event', {
          type: event.type,
        });
        return traceResult;
      }

      const runtimeSessionId =
        typeof event.data.runtimeSessionId === 'string' ? event.data.runtimeSessionId : undefined;
      const contactId = typeof event.data.contactId === 'string' ? event.data.contactId : undefined;

      emitFn({
        eventStore,
        event: {
          id: storeEventId,
          type: event.type,
          tenantId,
          projectId: typeof event.data.projectId === 'string' ? event.data.projectId : '',
          sessionId: runtimeSessionId ?? contactId,
          timestamp: new Date(event.timestamp),
          data: event.data,
        },
        scrubPII: true,
        redactPIIFn: (value: string) => redactPII(value),
      });

      return traceResult;
    },
  };
}
