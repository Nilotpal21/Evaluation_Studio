import type { Execution } from './types.js';

/**
 * ExecutionQueue — per-session FIFO queue of pending executions.
 *
 * Used by ExecutionCoordinator to manage message ordering within a session.
 * Each session has its own independent queue. The queue also tracks the
 * currently active (running) execution per session.
 *
 * Implementations:
 *   - InMemoryExecutionQueue (this file) — for testing and single-pod dev
 *   - RedisExecutionQueue (Task 11) — for production distributed use
 */
export interface ExecutionQueue {
  enqueue(sessionId: string, execution: Execution): Promise<void>;
  dequeue(sessionId: string): Promise<Execution | null>;
  peek(sessionId: string): Promise<Execution | null>;
  length(sessionId: string): Promise<number>;
  cancelAll(sessionId: string): Promise<Execution[]>;
  getActive(sessionId: string): Promise<Execution | null>;
  setActive(sessionId: string, execution: Execution): Promise<void>;
  clearActive(sessionId: string): Promise<void>;
}

export class InMemoryExecutionQueue implements ExecutionQueue {
  private queues = new Map<string, Execution[]>();
  private active = new Map<string, Execution>();
  private readonly maxQueueSize: number;

  constructor(options?: { maxQueueSize?: number }) {
    this.maxQueueSize = options?.maxQueueSize ?? 100;
  }

  async enqueue(sessionId: string, execution: Execution): Promise<void> {
    const q = this.queues.get(sessionId) ?? [];
    if (q.length >= this.maxQueueSize) {
      throw new Error(
        `Queue full: session ${sessionId} has ${q.length} pending executions (max: ${this.maxQueueSize})`,
      );
    }
    q.push(execution);
    this.queues.set(sessionId, q);
  }

  async dequeue(sessionId: string): Promise<Execution | null> {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    return q.shift()!;
  }

  async peek(sessionId: string): Promise<Execution | null> {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    return q[0];
  }

  async length(sessionId: string): Promise<number> {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  async cancelAll(sessionId: string): Promise<Execution[]> {
    const q = this.queues.get(sessionId) ?? [];
    const cancelled = q.map((e) => ({ ...e, status: 'cancelled' as const }));
    this.queues.set(sessionId, []);
    return cancelled;
  }

  async getActive(sessionId: string): Promise<Execution | null> {
    return this.active.get(sessionId) ?? null;
  }

  async setActive(sessionId: string, execution: Execution): Promise<void> {
    this.active.set(sessionId, execution);
  }

  async clearActive(sessionId: string): Promise<void> {
    this.active.delete(sessionId);
  }
}
