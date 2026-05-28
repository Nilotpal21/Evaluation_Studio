/**
 * MemoryEventQueue - in-memory array queue for testing.
 *
 * Events are pushed to an array and processed on flush().
 * Useful for:
 * - Unit tests (deterministic, synchronous processing)
 * - Integration tests (verify event ordering)
 * - Backend swap tests (verify no Redis/Kafka dependency)
 */

import type { IEventQueue } from '../interfaces/event-queue.js';

export class MemoryEventQueue implements IEventQueue {
  readonly queueName = 'memory';
  private queue: unknown[] = [];
  private handler: ((event: unknown) => void | Promise<void>) | null = null;
  private readonly maxSize: number;

  constructor(config?: { maxSize?: number }) {
    this.maxSize = config?.maxSize ?? 100_000;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  enqueue(event: unknown): void {
    if (this.queue.length >= this.maxSize) {
      throw new Error(
        `MemoryEventQueue overflow: ${this.queue.length} events (max ${this.maxSize})`,
      );
    }
    this.queue.push(event);
  }

  enqueueBatch(events: unknown[]): void {
    if (this.queue.length + events.length > this.maxSize) {
      throw new Error(
        `MemoryEventQueue overflow: ${this.queue.length + events.length} events (max ${this.maxSize})`,
      );
    }
    this.queue.push(...events);
  }

  onProcess(handler: (event: unknown) => void | Promise<void>): void {
    if (this.handler) {
      throw new Error('MemoryEventQueue: Handler already registered');
    }
    this.handler = handler;
  }

  async flush(): Promise<void> {
    if (!this.handler) {
      throw new Error('MemoryEventQueue: No handler registered. Call onProcess() first.');
    }

    // Drain the queue - process all events in order
    const eventsToProcess = [...this.queue];
    this.queue = [];

    for (const event of eventsToProcess) {
      await Promise.resolve(this.handler(event));
    }
  }

  async close(): Promise<void> {
    // Flush remaining events before closing
    if (this.queue.length > 0 && this.handler) {
      await this.flush();
    }
    this.queue = [];
    this.handler = null;
  }

  isHealthy(): boolean {
    return true; // No external dependencies - always healthy
  }

  /**
   * Test helper: peek at queued events without processing them.
   */
  peekQueue(): unknown[] {
    return [...this.queue];
  }

  /**
   * Test helper: clear the queue without processing.
   */
  clear(): void {
    this.queue = [];
  }
}
