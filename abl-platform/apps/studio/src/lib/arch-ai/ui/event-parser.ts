/**
 * @arch-v2-ui
 * @arch-v2-ui-cleanup-promote
 *
 * Parses a single SSE frame's data payload into a typed TurnEvent.
 * Used by both the POST body parser (in hook.ts) and the EventSource
 * onmessage handler. Returns null on malformed input — caller logs + skips.
 */

import type { LiveArchEvent, TurnEvent } from './types';

/**
 * Parse a single SSE frame's data payload into a typed TurnEvent.
 *
 * @param raw - The raw JSON string from the `data:` SSE field.
 * @param eventType - Optional: the value from the `event:` SSE field.
 *   The V4 SSE serializer writes `type` to the SSE `event:` line and omits it
 *   from the JSON body. When provided, `eventType` is injected into the parsed
 *   object so the `type` guard succeeds for those frames.
 */
export function parseEnvelope(raw: string, eventType?: string): LiveArchEvent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Inject type from the SSE `event:` line if the JSON body lacks it.
    // This bridges the gap between the SSE wire format (type in event: field
    // only) and parseEnvelope's type guard.
    if (typeof parsed.type !== 'string' && typeof eventType === 'string') {
      parsed.type = eventType;
    }
    if (typeof parsed.type !== 'string') {
      return null;
    }
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.turnId === 'string' &&
      typeof parsed.seq === 'number'
    ) {
      return parsed as TurnEvent;
    }
    return parsed as LiveArchEvent;
  } catch {
    return null;
  }
}
