import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import type { ServerMessage, TraceEvent } from '../types';
import { toExtendedTraceEvent } from './trace-event-adapter';

export type LiveTraceEventMessage = Extract<ServerMessage, { type: 'trace_event' }>;

export function ingestLiveTraceEvent(message: LiveTraceEventMessage): {
  accepted: boolean;
  eventPayload: Record<string, unknown>;
  traceEvent: TraceEvent;
} {
  const traceEvent: TraceEvent = {
    ...message.event,
    timestamp: new Date(message.event.timestamp),
  };

  const currentSessionId = useSessionStore.getState().sessionId;
  const observatoryStore = useObservatoryStore.getState();
  const extendedEvent = toExtendedTraceEvent(traceEvent, {
    fallbackSessionId: message.sessionId || currentSessionId || undefined,
    fallbackTraceId: currentSessionId || message.sessionId,
  });

  const accepted = observatoryStore.addEvent(extendedEvent);

  return {
    accepted,
    eventPayload: traceEvent.data ?? {},
    traceEvent,
  };
}
