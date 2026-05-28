/**
 * Local Concurrency Primitives
 *
 * Used as fallback when Redis/BullMQ is unavailable.
 * Provides per-session FIFO ordering with global concurrency cap.
 */

// =============================================================================
// SEMAPHORE — Global concurrency cap (p-limit pattern)
// =============================================================================

export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waiters: Array<() => void> = [];

  constructor(maxPermits: number) {
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Pass permit directly to next waiter (no increment/decrement)
      next();
    } else {
      this.permits = Math.min(this.permits + 1, this.maxPermits);
    }
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  get availablePermits(): number {
    return this.permits;
  }
}

// =============================================================================
// SESSION QUEUE — Per-session FIFO serialization
// =============================================================================

interface QueueEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class SessionQueue {
  private queues = new Map<string, Array<QueueEntry<any>>>();
  private active = new Set<string>();
  private semaphore: Semaphore;

  constructor(maxConcurrency: number) {
    this.semaphore = new Semaphore(maxConcurrency);
  }

  /**
   * Enqueue a task for a specific session.
   * Tasks for the same session run sequentially (FIFO).
   * Different sessions run concurrently (bounded by semaphore).
   */
  async enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let queue = this.queues.get(sessionId);
      if (!queue) {
        queue = [];
        this.queues.set(sessionId, queue);
      }

      queue.push({ fn, resolve, reject });

      // If session is not currently processing, start it
      if (!this.active.has(sessionId)) {
        this.processNext(sessionId);
      }
    });
  }

  private async processNext(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      this.active.delete(sessionId);
      this.queues.delete(sessionId);
      return;
    }

    this.active.add(sessionId);
    const entry = queue.shift()!;

    // Acquire global concurrency permit
    await this.semaphore.acquire();

    try {
      const result = await entry.fn();
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      this.semaphore.release();
      // Process next entry for this session
      this.processNext(sessionId);
    }
  }

  /** Total pending entries across all sessions */
  get pendingCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /** Number of sessions with pending or active work */
  get activeSessionCount(): number {
    return this.active.size;
  }
}
