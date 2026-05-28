/**
 * DirectQueue - synchronous pass-through queue with zero latency.
 *
 * No queue infrastructure required. Events are immediately passed to the handler.
 * Default queue type for embedded mode with ClickHouse BufferedWriter.
 *
 * Flow: emit() → enqueue() → handler() → store.write() → BufferedWriter
 *
 * This is the optimal configuration when the store already has buffering (ClickHouse),
 * and you want minimum latency with no extra infrastructure.
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventQueue } from '../interfaces/event-queue.js';

const log = createLogger('eventstore:direct-queue');

export class DirectQueue implements IEventQueue {
  readonly queueName = 'direct';
  private handler: ((event: unknown) => void | Promise<void>) | null = null;

  get pendingCount(): number {
    return 0; // No queue - events processed immediately
  }

  enqueue(event: unknown): void {
    if (!this.handler) {
      throw new Error('DirectQueue: No handler registered. Call onProcess() first.');
    }

    // Synchronous pass-through - call handler immediately
    const result = this.handler(event);

    // If handler returns a promise, we don't await it (fire-and-forget)
    // This maintains the non-blocking contract of enqueue()
    if (result instanceof Promise) {
      result.catch((err) => {
        log.error('Handler error (async)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  enqueueBatch(events: unknown[]): void {
    events.forEach((event) => this.enqueue(event));
  }

  onProcess(handler: (event: unknown) => void | Promise<void>): void {
    if (this.handler) {
      throw new Error('DirectQueue: Handler already registered');
    }
    this.handler = handler;
  }

  async flush(): Promise<void> {
    // No-op - no queue to flush, events processed immediately
  }

  async close(): Promise<void> {
    // No-op - no resources to release
    this.handler = null;
  }

  isHealthy(): boolean {
    return true; // No external dependencies - always healthy
  }
}
