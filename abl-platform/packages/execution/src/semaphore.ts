import type { Semaphore } from './types.js';

/**
 * Counting semaphore for limiting concurrent operations.
 * Used to cap parallel fan-out calls, LLM requests, etc.
 */
export class CountingSemaphore implements Semaphore {
  private _available: number;
  private _capacity: number;
  private waitQueue: Array<() => void> = [];

  constructor(capacity: number) {
    this._capacity = capacity;
    this._available = capacity;
  }

  get available(): number {
    return this._available;
  }

  get capacity(): number {
    return this._capacity;
  }

  async acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this._available = Math.min(this._available + 1, this._capacity);
    }
  }
}
