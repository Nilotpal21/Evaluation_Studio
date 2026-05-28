import { describe, it, expect, vi } from 'vitest';
import { LazyTaskStore } from '../infrastructure/lazy-task-store.js';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { Task } from '@a2a-js/sdk';

function makeTask(id: string): Task {
  return {
    id,
    contextId: `ctx-${id}`,
    kind: 'task',
    status: { state: 'completed' },
  } as Task;
}

describe('LazyTaskStore', () => {
  it('starts with InMemoryTaskStore and can save/load', async () => {
    const store = new LazyTaskStore();
    const task = makeTask('t1');

    await store.save(task);
    const loaded = await store.load('t1');

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('t1');
    expect(loaded!.contextId).toBe('ctx-t1');
  });

  it('returns undefined for unknown tasks', async () => {
    const store = new LazyTaskStore();
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('delegates to upgraded store after upgrade()', async () => {
    const store = new LazyTaskStore();

    // Save to InMemory before upgrade
    await store.save(makeTask('before-upgrade'));

    // Create a mock Redis store
    const redisStore: TaskStore = {
      save: vi.fn(),
      load: vi.fn().mockResolvedValue(makeTask('from-redis')),
    };

    store.upgrade(redisStore);

    // After upgrade, load goes to Redis store
    const loaded = await store.load('any-id');
    expect(redisStore.load).toHaveBeenCalledWith('any-id', undefined);
    expect(loaded!.id).toBe('from-redis');

    // Save goes to Redis store
    await store.save(makeTask('new-task'));
    expect(redisStore.save).toHaveBeenCalledOnce();
  });

  it('in-memory tasks are NOT migrated after upgrade', async () => {
    const store = new LazyTaskStore();
    await store.save(makeTask('inmem-task'));

    const redisStore: TaskStore = {
      save: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined), // Redis doesn't have it
    };

    store.upgrade(redisStore);

    // In-memory task is gone — Redis returns undefined
    const loaded = await store.load('inmem-task');
    expect(loaded).toBeUndefined();
  });

  it('calls onUpgrade callback when upgrading', () => {
    const store = new LazyTaskStore();
    const onUpgrade = vi.fn();
    const redisStore: TaskStore = { save: vi.fn(), load: vi.fn() };

    store.upgrade(redisStore, onUpgrade);

    expect(onUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it('listByContext returns empty when InMemory delegate is used', async () => {
    const store = new LazyTaskStore();
    const result = await store.listByContext({
      contextId: 'ctx-1',
      tenantId: 'tenant-1',
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.totalSize).toBe(0);
  });
});
