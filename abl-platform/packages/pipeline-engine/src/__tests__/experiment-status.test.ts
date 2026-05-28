/**
 * Experiment Service — Unit Tests
 *
 * Tests the ExperimentService class using in-test fake implementations
 * of RedisLike and model factory — no vi.mock() of platform components.
 *
 * The ExperimentService constructor takes:
 *   1. RedisLike (get, set, del, keys)
 *   2. Model factory function returning ExperimentModel
 *   3. Session lookup function for parent experiment group inheritance
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ExperimentService } from '../services/experiment.service.js';
import type { RedisLike } from '../pipeline/services/definition-cache.js';
import type { CachedExperiment } from '../services/experiment-assignment.js';

// ─── Fake Redis ────────────────────────────────────────────────────────

function createFakeRedis(initialData: Record<string, string> = {}): RedisLike & {
  _store: Map<string, string>;
  _deletedKeys: string[];
} {
  const store = new Map<string, string>(Object.entries(initialData));
  const deletedKeys: string[] = [];

  return {
    _store: store,
    _deletedKeys: deletedKeys,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _mode: string, _ttl: number): Promise<unknown> {
      store.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]): Promise<number> {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        deletedKeys.push(key);
      }
      return count;
    },
    async keys(pattern: string): Promise<string[]> {
      // Simple glob matching for prefix* patterns
      const prefix = pattern.replace('*', '');
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

// ─── Fake ExperimentModel ──────────────────────────────────────────────

interface FakeExperimentDoc {
  _id: string;
  projectId: string;
  status: string;
  controlVersion: string;
  experimentVersion: string;
  trafficSplit: number;
  channels: string[];
}

function createFakeModelFactory(docs: FakeExperimentDoc[]) {
  const fakeModel = {
    findOne(
      filter: Record<string, unknown>,
      projection?: Record<string, unknown>,
    ): { lean: <T>() => Promise<T | null> } {
      return {
        lean<T>(): Promise<T | null> {
          const match = docs.find((d) => {
            if (filter.projectId && d.projectId !== filter.projectId) return false;
            if (filter.status && d.status !== filter.status) return false;
            return true;
          });
          return Promise.resolve(match ? (match as unknown as T) : null);
        },
      };
    },
  };

  let callCount = 0;

  return {
    factory: async () => fakeModel as any,
    getCallCount: () => callCount,
    trackCalls: () => {
      const original = fakeModel.findOne.bind(fakeModel);
      fakeModel.findOne = (...args: Parameters<typeof fakeModel.findOne>) => {
        callCount++;
        return original(...args);
      };
    },
  };
}

// ─── Fake Session Lookup ───────────────────────────────────────────────

function createFakeSessionLookup(
  sessions: Record<
    string,
    { experimentId: string | null; experimentGroup: 'control' | 'experiment' | null }
  >,
) {
  return async (
    id: string,
    _tenantId: string,
    _projectId: string,
  ): Promise<{
    experimentId: string | null;
    experimentGroup: 'control' | 'experiment' | null;
  } | null> => {
    return sessions[id] ?? null;
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('ExperimentService', () => {
  const TEST_TENANT_ID = 'tenant-test-1';
  const TEST_PROJECT_ID = 'proj-test-1';

  describe('getActiveExperiment', () => {
    it('UNIT-1a: cache miss → queries MongoDB factory and caches result', async () => {
      const fakeRedis = createFakeRedis();
      const runningExperiment: FakeExperimentDoc = {
        _id: 'exp-running-1',
        projectId: TEST_PROJECT_ID,
        status: 'running',
        controlVersion: 'v1',
        experimentVersion: 'v2',
        trafficSplit: 0.5,
        channels: ['web'],
      };
      const { factory, trackCalls, getCallCount } = createFakeModelFactory([runningExperiment]);
      trackCalls();
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getActiveExperiment(TEST_TENANT_ID, TEST_PROJECT_ID);

      // Should return the cached experiment data
      expect(result).not.toBeNull();
      expect(result?.experimentId).toBe('exp-running-1');
      expect(result?.controlVersion).toBe('v1');
      expect(result?.experimentVersion).toBe('v2');
      expect(result?.trafficSplit).toBe(0.5);
      expect(result?.channels).toEqual(['web']);

      // Should have called the model factory
      expect(getCallCount()).toBe(1);

      // Should have cached the result in Redis
      const cachedValue = await fakeRedis.get(
        `experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`,
      );
      expect(cachedValue).not.toBeNull();
      const parsed = JSON.parse(cachedValue!) as CachedExperiment;
      expect(parsed.experimentId).toBe('exp-running-1');
    });

    it('UNIT-1b: cache hit → returns without querying MongoDB', async () => {
      const cachedData: CachedExperiment = {
        experimentId: 'exp-cached-1',
        controlVersion: 'v1',
        experimentVersion: 'v2',
        trafficSplit: 0.3,
        channels: [],
      };
      const fakeRedis = createFakeRedis({
        [`experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`]: JSON.stringify(cachedData),
      });
      const { factory, trackCalls, getCallCount } = createFakeModelFactory([]);
      trackCalls();
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getActiveExperiment(TEST_TENANT_ID, TEST_PROJECT_ID);

      // Should return the cached data
      expect(result).not.toBeNull();
      expect(result?.experimentId).toBe('exp-cached-1');
      expect(result?.trafficSplit).toBe(0.3);

      // Should NOT have called the model factory
      expect(getCallCount()).toBe(0);
    });

    it('UNIT-1c: "null" cached value → returns null without querying MongoDB', async () => {
      const fakeRedis = createFakeRedis({
        [`experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`]: 'null',
      });
      const { factory, trackCalls, getCallCount } = createFakeModelFactory([]);
      trackCalls();
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getActiveExperiment(TEST_TENANT_ID, TEST_PROJECT_ID);

      // Should return null (cached absence)
      expect(result).toBeNull();

      // Should NOT have called the model factory
      expect(getCallCount()).toBe(0);
    });

    it('caches null as "null" string when no running experiment exists', async () => {
      const fakeRedis = createFakeRedis();
      // No running experiments — only a draft
      const draftExperiment: FakeExperimentDoc = {
        _id: 'exp-draft-1',
        projectId: TEST_PROJECT_ID,
        status: 'draft',
        controlVersion: 'v1',
        experimentVersion: 'v2',
        trafficSplit: 0.5,
        channels: [],
      };
      const { factory } = createFakeModelFactory([draftExperiment]);
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getActiveExperiment(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(result).toBeNull();

      // Should have cached "null" string
      const cachedValue = await fakeRedis.get(
        `experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`,
      );
      expect(cachedValue).toBe('null');
    });
  });

  describe('invalidateCache', () => {
    it('UNIT-1d: calls redis.del with correct key', async () => {
      const fakeRedis = createFakeRedis({
        [`experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`]: JSON.stringify({
          experimentId: 'exp-1',
          controlVersion: 'v1',
          experimentVersion: 'v2',
          trafficSplit: 0.5,
          channels: [],
        }),
      });
      const { factory } = createFakeModelFactory([]);
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      await service.invalidateCache(TEST_TENANT_ID, TEST_PROJECT_ID);

      // Should have deleted the correct key
      expect(fakeRedis._deletedKeys).toContain(
        `experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`,
      );

      // Key should no longer exist
      const cachedValue = await fakeRedis.get(
        `experiment:active:${TEST_TENANT_ID}:${TEST_PROJECT_ID}`,
      );
      expect(cachedValue).toBeNull();
    });
  });

  describe('getParentExperimentGroup', () => {
    it('UNIT-1e: returns null when parent has no experiment', async () => {
      const fakeRedis = createFakeRedis();
      const { factory } = createFakeModelFactory([]);
      const sessionLookup = createFakeSessionLookup({
        'parent-session-1': {
          experimentId: null,
          experimentGroup: null,
        },
      });

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getParentExperimentGroup(
        'parent-session-1',
        'tenant-1',
        'project-1',
      );

      expect(result).toBeNull();
    });

    it('returns parent experiment group when parent has assignment', async () => {
      const fakeRedis = createFakeRedis();
      const { factory } = createFakeModelFactory([]);
      const sessionLookup = createFakeSessionLookup({
        'parent-session-2': {
          experimentId: 'exp-parent',
          experimentGroup: 'experiment',
        },
      });

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getParentExperimentGroup(
        'parent-session-2',
        'tenant-1',
        'project-1',
      );

      expect(result).not.toBeNull();
      expect(result?.experimentId).toBe('exp-parent');
      expect(result?.experimentGroup).toBe('experiment');
    });

    it('returns null when parent session does not exist', async () => {
      const fakeRedis = createFakeRedis();
      const { factory } = createFakeModelFactory([]);
      const sessionLookup = createFakeSessionLookup({});

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getParentExperimentGroup(
        'nonexistent-parent',
        'tenant-1',
        'project-1',
      );

      expect(result).toBeNull();
    });

    it('returns null when parent has experimentId but no experimentGroup', async () => {
      const fakeRedis = createFakeRedis();
      const { factory } = createFakeModelFactory([]);
      const sessionLookup = createFakeSessionLookup({
        'parent-session-3': {
          experimentId: 'exp-partial',
          experimentGroup: null,
        },
      });

      const service = new ExperimentService(fakeRedis, factory, sessionLookup);
      const result = await service.getParentExperimentGroup(
        'parent-session-3',
        'tenant-1',
        'project-1',
      );

      expect(result).toBeNull();
    });
  });
});
