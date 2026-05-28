/**
 * build-emit-adapter — translates v1 SSE events from the build orchestrator
 * into v2 TurnEvent envelopes.
 *
 * The build orchestrator (runParallelGeneration) emits v1 ArchSSEEvent objects
 * via an emit callback. This adapter wraps those events in v2 TurnEvent envelopes
 * and forwards them to the v2 fan-out channel and SSE response stream.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §7.2
 */

import type { ArchSSEEvent } from '@agent-platform/arch-ai';
import type { TurnEvent } from '@agent-platform/arch-ai';

export interface V1ToV2EmitAdapterOptions {
  sessionId: string;
  turnId: string;
  /** Forward a v2 TurnEvent to the live SSE stream. */
  publishLive: (event: TurnEvent) => void;
  /** Forward a v2 TurnEvent to the durable fan-out channel. */
  publishDurable: (event: TurnEvent) => void;
}

/** v1-compatible SSE emit function signature. */
export type V1EmitFn = (event: ArchSSEEvent) => void;

let _seq = 0;

/**
 * Create a v1 → v2 emit adapter.
 *
 * Returns a function that accepts v1 ArchSSEEvent objects and wraps them
 * in v2 TurnEvent envelopes before forwarding to both live and durable channels.
 *
 * TODO(v4): Implement full v1→v2 event mapping once build orchestrator is ported.
 * For now, wraps v1 events as `activity_updated` payloads so they reach the UI.
 */
export function createV1ToV2EmitAdapter(opts: V1ToV2EmitAdapterOptions): V1EmitFn {
  return (event: ArchSSEEvent): void => {
    const seq = ++_seq;
    const envelope = {
      eventId: `${opts.turnId}-${seq}`,
      schemaVersion: 2 as const,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      seq,
      timestamp: Date.now(),
    };

    // Wrap v1 event as an activity_updated payload for v2 consumers.
    const v2Event: TurnEvent = {
      ...envelope,
      type: 'activity_updated',
      groups: [],
      v1Event: event as unknown,
    } as unknown as TurnEvent;

    opts.publishLive(v2Event);
    opts.publishDurable(v2Event);
  };
}
