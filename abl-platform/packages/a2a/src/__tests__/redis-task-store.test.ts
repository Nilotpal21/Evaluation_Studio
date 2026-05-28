import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisA2ATaskStore } from '../infrastructure/redis-task-store.js';
import type { A2ARedisClient } from '../infrastructure/redis-task-store.js';
import type { Task } from '@a2a-js/sdk';

describe('RedisA2ATaskStore', () => {
  let redis: A2ARedisClient;
  let store: RedisA2ATaskStore;
  let data: Map<string, string>;
  let zsets: Map<string, Array<{ score: number; member: string }>>;

  beforeEach(() => {
    data = new Map();
    zsets = new Map();

    redis = {
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      del: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
          if (data.delete(k)) count++;
        }
        return count;
      }),
      zadd: vi.fn(async (key: string, score: string | number, member: string | number) => {
        if (!zsets.has(key)) zsets.set(key, []);
        const entries = zsets.get(key)!;
        // Remove existing entry for same member (update)
        const idx = entries.findIndex((e) => e.member === String(member));
        if (idx >= 0) entries.splice(idx, 1);
        entries.push({ score: Number(score), member: String(member) });
        entries.sort((a, b) => a.score - b.score);
        return 1;
      }),
      zrangebyscore: vi.fn(
        async (key: string, _min: string | number, _max: string | number, ...args: string[]) => {
          const entries = zsets.get(key) || [];
          // Parse LIMIT offset count
          const limitIdx = args.indexOf('LIMIT');
          if (limitIdx >= 0) {
            const offset = parseInt(args[limitIdx + 1], 10);
            const count = parseInt(args[limitIdx + 2], 10);
            return entries.slice(offset, offset + count).map((e) => e.member);
          }
          return entries.map((e) => e.member);
        },
      ),
      zcard: vi.fn(async (key: string) => (zsets.get(key) || []).length),
      expire: vi.fn(async () => 1),
      mget: vi.fn(async (...keys: string[]) => keys.map((k) => data.get(k) ?? null)),
    };
    store = new RedisA2ATaskStore(redis, 'tenant-test', 3600);
  });

  describe('save / load', () => {
    it('stores Task JSON in Redis with TTL', async () => {
      const task: Task = {
        id: 'task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'working' },
      };

      await store.save(task);
      expect(redis.set).toHaveBeenCalledWith('a2a:task:task-1', JSON.stringify(task), 'EX', 3600);
    });

    it('also indexes task in context ZSET on save', async () => {
      const task: Task = {
        id: 'task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'working' },
      };

      await store.save(task);
      expect(redis.zadd).toHaveBeenCalledWith(
        'a2a:ctx-tasks:tenant-test:ctx-1',
        expect.any(Number),
        'task-1',
      );
      expect(redis.expire).toHaveBeenCalledWith('a2a:ctx-tasks:tenant-test:ctx-1', 3600);
    });

    it('loads Task by taskId', async () => {
      const task: Task = {
        id: 'task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'completed' },
      };
      data.set('a2a:task:task-1', JSON.stringify(task));

      const loaded = await store.load('task-1');
      expect(loaded).toEqual(task);
    });

    it('returns undefined for non-existent task', async () => {
      const loaded = await store.load('non-existent');
      expect(loaded).toBeUndefined();
    });
  });

  describe('listByContext', () => {
    it('lists tasks belonging to a context', async () => {
      const task1: Task = {
        id: 'task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'completed' },
      };
      const task2: Task = {
        id: 'task-2',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'working' },
      };

      await store.save(task1);
      await store.save(task2);

      const result = await store.listByContext({ contextId: 'ctx-1', tenantId: 'tenant-test' });
      expect(result.tasks).toHaveLength(2);
      expect(result.totalSize).toBe(2);
    });

    it('filters by status', async () => {
      const task1: Task = {
        id: 'task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'completed' },
      };
      const task2: Task = {
        id: 'task-2',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'working' },
      };

      await store.save(task1);
      await store.save(task2);

      const result = await store.listByContext({
        contextId: 'ctx-1',
        tenantId: 'tenant-test',
        status: 'completed',
      });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('task-1');
    });

    it('returns empty for unknown context', async () => {
      const result = await store.listByContext({
        contextId: 'unknown-ctx',
        tenantId: 'tenant-test',
      });
      expect(result.tasks).toHaveLength(0);
      expect(result.totalSize).toBe(0);
    });

    it('paginates results', async () => {
      // Save 3 tasks
      for (let i = 1; i <= 3; i++) {
        const task: Task = {
          id: `task-${i}`,
          contextId: 'ctx-page',
          kind: 'task',
          status: { state: 'working' },
        };
        await store.save(task);
      }

      // Page 1 (size 2)
      const page1 = await store.listByContext({
        contextId: 'ctx-page',
        tenantId: 'tenant-test',
        pageSize: 2,
      });
      expect(page1.tasks).toHaveLength(2);
      expect(page1.nextPageToken).toBe('2');

      // Page 2
      const page2 = await store.listByContext({
        contextId: 'ctx-page',
        tenantId: 'tenant-test',
        pageSize: 2,
        pageToken: page1.nextPageToken,
      });
      expect(page2.tasks).toHaveLength(1);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });

  describe('savePushConfig / loadPushConfig', () => {
    it('stores push notification config with TTL', async () => {
      const config = { url: 'https://example.com/push', token: 'tok-1' };
      await store.savePushConfig('task-1', config);

      expect(redis.set).toHaveBeenCalledWith('a2a:push:task-1', JSON.stringify(config), 'EX', 3600);
    });

    it('loads push config by taskId', async () => {
      const config = { url: 'https://example.com/push', token: 'tok-1' };
      data.set('a2a:push:task-1', JSON.stringify(config));

      const loaded = await store.loadPushConfig('task-1');
      expect(loaded).toEqual(config);
    });

    it('returns undefined when no config saved', async () => {
      const loaded = await store.loadPushConfig('non-existent');
      expect(loaded).toBeUndefined();
    });
  });
});
