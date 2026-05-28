/**
 * Event emitter interface.
 *
 * Validates events via EventRegistry and writes to IEventQueue (which delegates to IEventStore).
 * Optionally forwards to webhooks based on tenant subscriptions.
 */

export interface IEventEmitter {
  /**
   * Emit a single platform event.
   * Validates schema, enqueues for persistence, optionally forwards to webhooks.
   * Non-blocking, fire-and-forget.
   */
  emit(event: unknown): void;

  /**
   * Emit a batch of events.
   */
  emitBatch(events: unknown[]): void;

  /**
   * Number of events pending in the underlying queue/buffer.
   */
  readonly pendingCount: number;

  /**
   * Graceful shutdown: flush queue and close.
   */
  close(): Promise<void>;
}
