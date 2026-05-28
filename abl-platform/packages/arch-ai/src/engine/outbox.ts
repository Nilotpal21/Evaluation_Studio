// packages/arch-ai/src/engine/outbox.ts
//
// Per-turn outbox — durability gate for Arch turn-engine events (spec §8a).
//
// Contract:
//   * Callers enqueue durable events during tool execution.
//   * The engine MUST call flush() only AFTER TurnBuffer.commit() succeeds,
//     or discard() if the commit fails. Flushing before commit violates
//     the post-commit-only invariant for the fan-out ring buffer.
//   * Publisher errors propagate to the caller. Events already published
//     within the same flush batch are NOT rolled back, and `seq` has already
//     advanced for them — downstream consumers tolerate partial flushes via
//     reconnect-with-lastSeenSeq semantics. A failed flush is the caller's
//     signal to escalate (session-level error event + lock release); it is
//     NOT automatically retried by the outbox.
//   * discard() is idempotent and safe to call multiple times; once
//     discarded, subsequent enqueue and flush are no-ops.
export interface OutboxEvent {
  kind: string;
  payload: unknown;
}

export interface OutboxEnvelope extends OutboxEvent {
  sessionId: string;
  turnId: string;
  seq: number;
  at: string;
}

export interface OutboxHandle {
  enqueue(event: OutboxEvent): void;
  flush(): Promise<void>;
  discard(): void;
}

export interface CreateOutboxOpts {
  sessionId: string;
  turnId: string;
  publisher: (envelope: OutboxEnvelope) => Promise<void>;
  initialSeq?: number;
}

export function createOutbox(opts: CreateOutboxOpts): OutboxHandle {
  const buffered: OutboxEvent[] = [];
  let seq = opts.initialSeq ?? 0;
  let discarded = false;

  return {
    enqueue(event) {
      if (discarded) return;
      buffered.push(event);
    },
    async flush() {
      if (discarded) return;
      const toEmit = buffered.splice(0);
      for (const e of toEmit) {
        const envelope: OutboxEnvelope = {
          ...e,
          sessionId: opts.sessionId,
          turnId: opts.turnId,
          seq: seq++,
          at: new Date().toISOString(),
        };
        await opts.publisher(envelope);
      }
    },
    discard() {
      discarded = true;
      buffered.length = 0;
    },
  };
}
