import type { TraceEvent } from './eval-types.js';

export function extractCurrentAgentFromTraceEvents(traceEvents: TraceEvent[]): string | undefined {
  for (let index = traceEvents.length - 1; index >= 0; index--) {
    const event = traceEvents[index];
    if (!event) continue;
    const value = traceEventValue(event, ['toAgent', 'targetAgent', 'agentName', 'agent']);
    if (value) return value;
  }
  return undefined;
}

export function traceEventValue(event: TraceEvent, keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = (event as unknown as Record<string, unknown>)[key];
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct;
    }
  }

  const data = event.data;
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested;
    }
  }
  return undefined;
}
