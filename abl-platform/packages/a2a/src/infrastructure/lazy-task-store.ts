/**
 * LazyTaskStore — proxy TaskStore that starts with InMemoryTaskStore
 * and upgrades to a durable store (e.g. Redis) once available.
 *
 * This solves the temporal ordering problem: A2A handlers must be
 * attached to Express synchronously at startup, but Redis is only
 * available after async config loading. The proxy ensures seamless
 * upgrade without restarting routes.
 */

import { InMemoryTaskStore, type TaskStore, type ServerCallContext } from '@a2a-js/sdk/server';
import type { Task } from '@a2a-js/sdk';
import type { ListTasksParams, ListTasksResult } from './redis-task-store.js';

export class LazyTaskStore implements TaskStore {
  private delegate: TaskStore;

  constructor() {
    this.delegate = new InMemoryTaskStore();
  }

  /**
   * Upgrade the backing store. After this call, all save/load
   * operations go to the new store. Previously saved in-memory
   * tasks are NOT migrated — they were ephemeral pre-Redis requests.
   */
  upgrade(store: TaskStore, onUpgrade?: (info: { message: string }) => void): void {
    onUpgrade?.({
      message: 'LazyTaskStore upgraded — in-memory tasks from startup window are not migrated',
    });
    this.delegate = store;
  }

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    return this.delegate.save(task, context);
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    return this.delegate.load(taskId, context);
  }

  /**
   * List tasks by context. Only available when the backing store
   * supports listing (RedisA2ATaskStore). Returns empty results
   * when using InMemoryTaskStore fallback.
   */
  async listByContext(params: ListTasksParams): Promise<ListTasksResult> {
    if ('listByContext' in this.delegate && typeof this.delegate.listByContext === 'function') {
      return (
        this.delegate as { listByContext: (p: ListTasksParams) => Promise<ListTasksResult> }
      ).listByContext(params);
    }
    return { tasks: [], totalSize: 0 };
  }
}
