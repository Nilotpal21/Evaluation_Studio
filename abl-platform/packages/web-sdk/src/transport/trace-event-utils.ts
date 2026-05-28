type TraceEventPayload = {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
} & Record<string, unknown>;

function asTraceEventPayload(value: unknown): TraceEventPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as TraceEventPayload;
}

function getLegacyTraceEventPayload(msg: Record<string, unknown>): TraceEventPayload | null {
  const eventType = msg.eventType;
  if (typeof eventType !== 'string' || eventType.length === 0) {
    return null;
  }

  return {
    ...msg,
    type: eventType,
  } as TraceEventPayload;
}

export function getTraceEventPayload(msg: Record<string, unknown>): TraceEventPayload | null {
  return asTraceEventPayload(msg.event) ?? getLegacyTraceEventPayload(msg) ?? null;
}

export function getTraceEventData(event: TraceEventPayload): Record<string, unknown> {
  return asTraceEventPayload(event.data) ?? event;
}
