/**
 * Shared factory for building a ring-buffer-aware publisher.
 *
 * The factory returns a single async function with the shape the TurnEngine
 * expects: `(event: TurnEvent) => Promise<void>`. Internally it forwards
 * every event to `live` (fan-out pub/sub or direct stream) and additionally
 * pushes durable events — per V4 design §9.1 — into the ring buffer for
 * lossless SSE reconnect replay.
 */

import type { RingBuffer } from './ring-buffer.js';

/**
 * Durable event kinds per docs/superpowers/specs/2026-04-18-arch-v4-design.md §9.1.
 * Any edit here MUST be mirrored in the design doc and in ring-buffer-publish.test.ts.
 */
export const DURABLE_EVENT_KINDS = new Set<string>([
  'artifact_updated',
  'interactive_tool',
  'turn_committed',
  'turn_ended',
  'turn_canceled',
  'turn_failed',
  'queued_message_accepted',
]);

/** Minimal shape every publishable event must carry. */
export interface PublishableEvent {
  type: string;
  sessionId: string;
  seq?: number;
  replaySeq?: number;
}

export interface BuildDurablePublisherOpts<T extends PublishableEvent = PublishableEvent> {
  /** Fan-out publisher — called unconditionally for every event. */
  live: (event: T) => Promise<void>;
  /** Redis-backed ring buffer — called only for durable events. */
  ringBuffer: RingBuffer;
  /**
   * Allocate the next monotonic replay cursor for a durable event.
   * When omitted, callers must populate event.replaySeq before publishing.
   */
  nextDurableSeq?: (sessionId: string, event: T) => Promise<number> | number;
  /**
   * Called when a durable event arrives without a numeric replaySeq and
   * nextDurableSeq is unavailable or fails to produce a usable number.
   * Receives the offending event. Defaults to throwing.
   */
  onDurableInvariantViolation?: (event: T) => void;
}

/**
 * Build a ring-buffer-aware publisher.
 *
 * Generic over the concrete event type so callers like engine-factory can pass
 * the narrow `TurnEvent` discriminated union without needing an index-signature
 * widening cast.
 */
export function buildDurablePublisher<T extends PublishableEvent = PublishableEvent>(
  opts: BuildDurablePublisherOpts<T>,
): (event: T) => Promise<void> {
  return async (event) => {
    const isDurable = DURABLE_EVENT_KINDS.has(event.type);

    if (isDurable) {
      // Durability guarantee: ring buffer first. A live fan-out failure must not
      // prevent the event from being replayable on SSE reconnect.
      const replaySeq =
        typeof event.replaySeq === 'number'
          ? event.replaySeq
          : await opts.nextDurableSeq?.(event.sessionId, event);

      if (typeof replaySeq !== 'number' || !Number.isFinite(replaySeq)) {
        // Missing replaySeq on a durable event indicates a programming error
        // in the reconnect publishing path. Default: throw so tests and callers
        // catch invariant breaks at write time. Callers can override with a
        // log-and-continue handler via onDurableInvariantViolation.
        (
          opts.onDurableInvariantViolation ??
          ((e) => {
            throw new Error(
              `buildDurablePublisher: durable event "${e.type}" missing replaySeq (sessionId=${e.sessionId})`,
            );
          })
        )(event);
      } else {
        event.replaySeq = replaySeq;
        await opts.ringBuffer.push(event.sessionId, {
          seq: replaySeq,
          kind: event.type,
          payload: event,
          timestamp: Date.now(),
        });
      }
    }

    // Live fan-out runs last. If it throws, durable events are already persisted
    // and the TurnEngine's non-fatal catch handles the rest.
    await opts.live(event);
  };
}
