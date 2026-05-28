import { describe, it, expect } from 'vitest';
import { ProviderSemaphoreMap } from '../services/llm/provider-semaphore.js';

describe('ProviderSemaphoreMap', () => {
  it('creates separate semaphores per provider', () => {
    const map = new ProviderSemaphoreMap(10, 3);
    const anthropic = map.getSemaphore('anthropic');
    const openai = map.getSemaphore('openai');
    expect(anthropic).not.toBe(openai);
  });

  it('returns same semaphore for same provider', () => {
    const map = new ProviderSemaphoreMap(10, 3);
    const first = map.getSemaphore('anthropic');
    const second = map.getSemaphore('anthropic');
    expect(first).toBe(second);
  });

  it('divides permits evenly across expected providers', () => {
    const map = new ProviderSemaphoreMap(12, 3);
    expect(map.getPermitsPerProvider()).toBe(4); // 12 / 3
  });

  it('enforces minimum 2 permits per provider', () => {
    const map = new ProviderSemaphoreMap(3, 10);
    expect(map.getPermitsPerProvider()).toBe(2); // floor(3/10)=0, clamped to 2
  });

  it('handles single provider (all permits)', () => {
    const map = new ProviderSemaphoreMap(10, 1);
    expect(map.getPermitsPerProvider()).toBe(10);
  });

  it('handles zero expected providers gracefully', () => {
    const map = new ProviderSemaphoreMap(10, 0);
    // Math.max(1, 0) = 1 → floor(10/1) = 10
    expect(map.getPermitsPerProvider()).toBe(10);
  });

  it('tracks all created providers', () => {
    const map = new ProviderSemaphoreMap(10, 3);
    map.getSemaphore('anthropic');
    map.getSemaphore('openai');
    map.getSemaphore('google');
    expect(map.getProviders()).toEqual(expect.arrayContaining(['anthropic', 'openai', 'google']));
    expect(map.getProviders()).toHaveLength(3);
  });

  it('creates semaphore with correct permit count', () => {
    const map = new ProviderSemaphoreMap(12, 3);
    const sem = map.getSemaphore('anthropic');
    expect(sem.availablePermits).toBe(4); // 12 / 3 = 4
  });

  it('isolates providers so one cannot starve another', async () => {
    // 2 providers, 4 permits each (8 total / 2)
    const map = new ProviderSemaphoreMap(8, 2);

    const anthropicSem = map.getSemaphore('anthropic');
    const openaiSem = map.getSemaphore('openai');

    // Exhaust all anthropic permits
    await anthropicSem.acquire();
    await anthropicSem.acquire();
    await anthropicSem.acquire();
    await anthropicSem.acquire();

    expect(anthropicSem.availablePermits).toBe(0);
    // OpenAI should still have all its permits — provider isolation works
    expect(openaiSem.availablePermits).toBe(4);
  });

  it('queues waiters when provider permits are exhausted', async () => {
    const map = new ProviderSemaphoreMap(4, 2); // 2 permits per provider

    const sem = map.getSemaphore('anthropic');
    await sem.acquire();
    await sem.acquire();
    expect(sem.availablePermits).toBe(0);

    // Third acquire should queue a waiter, not resolve immediately
    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });

    // Give microtask queue a chance to flush
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(sem.pendingCount).toBe(1);

    // Release one permit — the waiter should resolve
    sem.release();
    await pending;
    expect(acquired).toBe(true);
  });
});
