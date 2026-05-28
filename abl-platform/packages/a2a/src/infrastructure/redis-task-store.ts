/**
 * RedisA2ATaskStore — Redis-backed A2A task store.
 *
 * Replaces InMemoryTaskStore for distributed multi-pod deployments.
 * Tasks are stored with a configurable TTL (default 24 hours) to
 * support long-running async operations.
 *
 * Key structure:
 *   a2a:task:{taskId}                    STRING  JSON(Task)                TTL: configurable
 *   a2a:push:{taskId}                    STRING  JSON(PushNotificationConfig)  TTL: same
 *   a2a:ctx-tasks:{tenantId}:{contextId} ZSET   taskId members, score=timestamp  TTL: same
 */

import type { Task } from '@a2a-js/sdk';
import type { TaskStore, ServerCallContext } from '@a2a-js/sdk/server';

/**
 * Minimal Redis client interface — ioredis Redis and Cluster both satisfy
 * this at runtime.
 */
export interface A2ARedisClient {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  zadd(key: string, ...args: (string | number)[]): Promise<number>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: string[]
  ): Promise<string[]>;
  zcard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: { schemes: string[] };
}

/** Parameters for listing tasks by context. */
export interface ListTasksParams {
  contextId: string;
  tenantId: string;
  status?: string;
  pageSize?: number;
  pageToken?: string;
}

/** Result from listing tasks. */
export interface ListTasksResult {
  tasks: Task[];
  nextPageToken?: string;
  totalSize: number;
}

export class RedisA2ATaskStore implements TaskStore {
  constructor(
    private readonly redis: A2ARedisClient,
    private readonly tenantId: string,
    private readonly ttlSeconds: number = 86400, // 24 hours default
  ) {}

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.redis.set(`a2a:task:${task.id}`, JSON.stringify(task), 'EX', this.ttlSeconds);

    // Maintain context-task index scoped to tenant (platform invariant #1)
    if (task.contextId) {
      const indexKey = `a2a:ctx-tasks:${this.tenantId}:${task.contextId}`;
      await this.redis.zadd(indexKey, Date.now(), task.id);
      await this.redis.expire(indexKey, this.ttlSeconds);
    }
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    const data = await this.redis.get(`a2a:task:${taskId}`);
    return data ? (JSON.parse(data) as Task) : undefined;
  }

  /**
   * List tasks belonging to a context, with optional status filter and pagination.
   * Uses MGET for batch loading instead of N individual GETs.
   */
  async listByContext(params: ListTasksParams): Promise<ListTasksResult> {
    const indexKey = `a2a:ctx-tasks:${params.tenantId}:${params.contextId}`;
    const pageSize = params.pageSize ?? 50;
    const offset = params.pageToken ? parseInt(params.pageToken, 10) : 0;

    const totalSize = await this.redis.zcard(indexKey);

    const taskIds = await this.redis.zrangebyscore(
      indexKey,
      '-inf',
      '+inf',
      'LIMIT',
      String(offset),
      String(pageSize),
    );

    // Load individually via GET (cluster-safe — avoids CROSSSLOT with MGET)
    const tasks: Task[] = [];
    if (taskIds.length > 0) {
      const keys = taskIds.map((id) => `a2a:task:${id}`);
      const values = await Promise.all(keys.map((k) => this.redis.get(k)));
      for (const val of values) {
        if (val) {
          const task = JSON.parse(val) as Task;
          if (params.status && task.status.state !== params.status) continue;
          tasks.push(task);
        }
      }
    }

    const nextOffset = offset + pageSize;
    const nextPageToken = nextOffset < totalSize ? String(nextOffset) : undefined;

    return { tasks, nextPageToken, totalSize };
  }

  async savePushConfig(taskId: string, config: PushNotificationConfig): Promise<void> {
    await this.redis.set(`a2a:push:${taskId}`, JSON.stringify(config), 'EX', this.ttlSeconds);
  }

  async loadPushConfig(taskId: string): Promise<PushNotificationConfig | undefined> {
    const data = await this.redis.get(`a2a:push:${taskId}`);
    return data ? (JSON.parse(data) as PushNotificationConfig) : undefined;
  }
}
