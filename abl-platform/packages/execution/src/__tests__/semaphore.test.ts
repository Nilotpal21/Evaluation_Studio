import { describe, test, expect } from 'vitest';
import { CountingSemaphore } from '../semaphore.js';

describe('CountingSemaphore', () => {
  test('acquire succeeds immediately when permits available', async () => {
    const sem = new CountingSemaphore(3);
    expect(sem.available).toBe(3);
    await sem.acquire();
    expect(sem.available).toBe(2);
  });

  test('release restores a permit', async () => {
    const sem = new CountingSemaphore(2);
    await sem.acquire();
    expect(sem.available).toBe(1);
    sem.release();
    expect(sem.available).toBe(2);
  });

  test('acquire blocks when no permits and unblocks on release', async () => {
    const sem = new CountingSemaphore(1);
    await sem.acquire();
    let acquired = false;
    const promise = sem.acquire().then(() => {
      acquired = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);
    sem.release();
    await promise;
    expect(acquired).toBe(true);
  });

  test('FIFO ordering: waiters are unblocked in order', async () => {
    const sem = new CountingSemaphore(1);
    await sem.acquire();
    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    sem.release();
    await p1;
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  test('capacity property returns initial count', () => {
    const sem = new CountingSemaphore(5);
    expect(sem.capacity).toBe(5);
  });

  test('release does not exceed capacity', () => {
    const sem = new CountingSemaphore(2);
    sem.release();
    expect(sem.available).toBe(2);
  });
});
