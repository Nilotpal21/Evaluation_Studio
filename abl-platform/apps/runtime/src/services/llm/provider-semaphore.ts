/**
 * Per-LLM-Provider Concurrency Cap
 *
 * Divides a global concurrency budget across LLM providers so that one
 * provider's outage (slow timeouts exhausting permits) cannot starve
 * healthy providers. Each provider gets its own Semaphore with an
 * equal share of the total permits, subject to a minimum floor.
 */

import { Semaphore } from './local-semaphore.js';

const MIN_PERMITS_PER_PROVIDER = 2;

export class ProviderSemaphoreMap {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly permitsPerProvider: number;

  constructor(globalMaxPermits: number, expectedProviders: number) {
    this.permitsPerProvider = Math.max(
      MIN_PERMITS_PER_PROVIDER,
      Math.floor(globalMaxPermits / Math.max(1, expectedProviders)),
    );
  }

  /** Get (or lazily create) the semaphore for a given provider. */
  getSemaphore(provider: string): Semaphore {
    let sem = this.semaphores.get(provider);
    if (!sem) {
      sem = new Semaphore(this.permitsPerProvider);
      this.semaphores.set(provider, sem);
    }
    return sem;
  }

  /** Get number of permits allocated per provider. */
  getPermitsPerProvider(): number {
    return this.permitsPerProvider;
  }

  /** Get all tracked provider names. */
  getProviders(): string[] {
    return Array.from(this.semaphores.keys());
  }
}
