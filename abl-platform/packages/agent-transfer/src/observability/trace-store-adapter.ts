/**
 * Trace Store Adapter
 *
 * Adapts a platform TraceStore (or any object with an addEvent method)
 * to the TraceEventEmitter interface used by agent-transfer trace events.
 */
import type { TraceEventEmitter } from './trace-events.js';

export interface TraceStoreHandle {
  addEvent(
    sessionId: string,
    event: {
      id: string;
      sessionId: string;
      type: string;
      timestamp: Date;
      data: Record<string, unknown>;
    },
  ): void | Promise<void>;
}

/**
 * Creates a TraceEventEmitter that forwards events to a TraceStore.
 *
 * The adapter converts agent-transfer trace event format (numeric timestamp)
 * to the TraceStore format (Date timestamp, with id and sessionId).
 */
export function createTraceStoreAdapter(
  traceStore: TraceStoreHandle,
  sessionId: string,
): TraceEventEmitter {
  return {
    emit(event) {
      const storeEvent = {
        id: `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        type: event.type,
        timestamp: new Date(event.timestamp),
        data: event.data,
      };
      return traceStore.addEvent(sessionId, storeEvent);
    },
  };
}
