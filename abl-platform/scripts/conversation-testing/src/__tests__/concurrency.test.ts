import { describe, expect, it } from 'vitest';
import { makeLimit } from '../concurrency.js';

describe('makeLimit', () => {
  it('executes tasks and returns results via Promise.all', async () => {
    const limit = makeLimit(2);
    const results = await Promise.all([
      limit(() => Promise.resolve('a')),
      limit(() => Promise.resolve('b')),
      limit(() => Promise.resolve('c')),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('respects concurrency limit', async () => {
    const limit = makeLimit(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        // Use setTimeout to simulate async work and allow interleaving
        setTimeout(() => {
          active--;
          resolve();
        }, 10);
      });

    await Promise.all([limit(task), limit(task), limit(task), limit(task), limit(task)]);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('preserves return order via Promise.all', async () => {
    const limit = makeLimit(2);

    // Task with varying delays — order should still match input order
    const results = await Promise.all([
      limit(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 30))),
      limit(() => new Promise<number>((resolve) => setTimeout(() => resolve(2), 10))),
      limit(() => new Promise<number>((resolve) => setTimeout(() => resolve(3), 20))),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  it('propagates rejections', async () => {
    const limit = makeLimit(2);

    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('continues processing after a rejection', async () => {
    const limit = makeLimit(1);

    // First task fails
    const p1 = limit(() => Promise.reject(new Error('fail')));
    // Second task should still run
    const p2 = limit(() => Promise.resolve('ok'));

    await expect(p1).rejects.toThrow('fail');
    await expect(p2).resolves.toBe('ok');
  });

  it('works with concurrency of 1 (sequential)', async () => {
    const limit = makeLimit(1);
    const order: number[] = [];

    await Promise.all([
      limit(async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
      }),
      limit(async () => {
        order.push(3);
        await new Promise((r) => setTimeout(r, 10));
        order.push(4);
      }),
    ]);

    // With concurrency 1, task 2 starts only after task 1 finishes
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
