/**
 * Redis pub/sub fan-out publisher for turn events and session signals.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.4.2
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 2
 *
 * Every emitted TurnEvent (and out-of-band SessionSignal) is published to a
 * per-session channel. The POST /messages SSE response streams directly AND
 * publishes — the GET /events route subscribes to receive the same events.
 * This is how multi-tab observation works without holding a single long-lived
 * HTTP connection per tab.
 *
 * Publishers use the primary Redis connection. Subscribers MUST use a
 * duplicated connection (`duplicateRedisClient()`) — ioredis puts a connection
 * into subscriber mode on SUBSCRIBE, forbidding regular commands.
 */

import { createLogger } from '@agent-platform/shared-observability';

import type { RedisClient } from '@agent-platform/redis';

import type { FanOutEnvelope, SessionSignal, TurnEvent } from '../types/turn-events.js';

const log = createLogger('arch-ai:fan-out');

/**
 * Redis channel name for a given session's fan-out stream.
 * Exported for subscribers (`GET /events` route handler) to use the same key.
 */
export function sessionEventsChannel(sessionId: string): string {
  return `arch:session:${sessionId}:events`;
}

/**
 * Publish a single envelope (TurnEvent or SessionSignal) to the session's
 * fan-out channel. Fire-and-forget semantics — subscribers connected AT
 * publish time receive the event. Any subscriber that connects later must
 * reconcile state via `GET /arch/sessions/:id` first.
 *
 * The publisher logs but does not throw on Redis errors — a failed fan-out
 * publish must not crash the in-flight turn. The primary SSE response stream
 * is the authoritative delivery path; fan-out is secondary for multi-tab.
 */
export async function publishFanOut(
  redis: RedisClient,
  sessionId: string,
  envelope: FanOutEnvelope,
): Promise<void> {
  try {
    await redis.publish(sessionEventsChannel(sessionId), JSON.stringify(envelope));
  } catch (err) {
    // Fan-out is best-effort. The originating POST /messages SSE response
    // still carries the event to the sender's tab; missing fan-out only
    // affects passive observers (second tabs). Log but do not throw.
    log.warn('fan-out publish failed (non-fatal)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Convenience wrapper for a TurnEvent publish.
 */
export async function publishTurnEvent(
  redis: RedisClient,
  sessionId: string,
  event: TurnEvent,
): Promise<void> {
  await publishFanOut(redis, sessionId, event);
}

/**
 * Convenience wrapper for a SessionSignal publish (queue_updated / queue_cleared).
 */
export async function publishSessionSignal(
  redis: RedisClient,
  sessionId: string,
  signal: SessionSignal,
): Promise<void> {
  await publishFanOut(redis, sessionId, signal);
}

/**
 * Subscribe a dedicated Redis client to the session's fan-out channel.
 * Caller MUST provide a dedicated (duplicated) client — never the primary one.
 *
 * Returns a cleanup handle that unsubscribes and can be used to shut down
 * gracefully on client disconnect.
 *
 * Usage:
 * ```ts
 * import { duplicateRedisClient } from '@agent-platform/redis';
 *
 * const subscriber = duplicateRedisClient();
 * const stop = await subscribeFanOut(subscriber, sessionId, (envelope) => {
 *   // forward to SSE stream
 * });
 * // on HTTP disconnect:
 * await stop();
 * ```
 */
export async function subscribeFanOut(
  subscriber: RedisClient,
  sessionId: string,
  onEnvelope: (envelope: FanOutEnvelope) => void,
): Promise<() => Promise<void>> {
  const channel = sessionEventsChannel(sessionId);

  const messageHandler = (receivedChannel: string, raw: string) => {
    if (receivedChannel !== channel) return;
    try {
      const parsed = JSON.parse(raw) as FanOutEnvelope;
      onEnvelope(parsed);
    } catch (err) {
      // Malformed message — drop. Zod validator at the edge surfaces real
      // schema drift; here we just log the JSON parse failure.
      log.warn('fan-out message parse failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ioredis's 'message' event carries (channel, message) for plain SUBSCRIBE.
  (subscriber as unknown as { on: (ev: string, fn: (...a: unknown[]) => void) => void }).on(
    'message',
    messageHandler as (...a: unknown[]) => void,
  );
  await (subscriber as unknown as { subscribe: (ch: string) => Promise<number> }).subscribe(
    channel,
  );

  return async () => {
    try {
      await (subscriber as unknown as { unsubscribe: (ch: string) => Promise<number> }).unsubscribe(
        channel,
      );
    } catch (err) {
      // Subscriber may already be closed during graceful shutdown — log at debug.
      log.debug('fan-out unsubscribe failed (likely already closed)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    (subscriber as unknown as { off: (ev: string, fn: (...a: unknown[]) => void) => void }).off(
      'message',
      messageHandler as (...a: unknown[]) => void,
    );
  };
}
