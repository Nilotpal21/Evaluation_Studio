/**
 * Agentic Compat Binding Repo — Unit Tests
 *
 * Tests cache behavior (TTL, invalidation, max size) and pure helpers
 * (isDuplicateKeyError, bindingCacheKey) via DI. No vi.mock.
 *
 * The model is injected as a test double conforming to BindingModelLike.
 * Integration tests (real Mongo) live in the integration/ directory.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { LRUTTLCache } from '@agent-platform/shared-kernel';
import {
  createAgentAssistBindingRepo,
  bindingCacheKey,
  isDuplicateKeyError,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
  type BindingModelLike,
} from '../../repos/agent-assist-binding-repo.js';

// Use the interface shape directly to avoid importing the full database barrel
// which transitively loads shared-auth and triggers missing `jwks-rsa` errors.
interface IAgentAssistBinding {
  _id: string;
  tenantId: string;
  projectId: string;
  appId: string;
  environment: string;
  status: 'active' | 'disabled';
  deploymentId: string | null;
  apiKeyId: string | null;
  displayName: string | null;
  createdBy: string;
  updatedBy: string | null;
  disabledAt: Date | null;
  disabledBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeBinding(overrides: Partial<IAgentAssistBinding> = {}): IAgentAssistBinding {
  return {
    _id: 'bind-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    appId: 'aa-test',
    environment: 'production',
    status: 'active',
    deploymentId: null,
    apiKeyId: null,
    displayName: null,
    createdBy: 'actor-1',
    updatedBy: null,
    disabledAt: null,
    disabledBy: null,
    _v: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockModel(store: Map<string, IAgentAssistBinding>): BindingModelLike {
  return {
    findOne(filter: Record<string, unknown>) {
      return {
        lean() {
          const match = [...store.values()].find((doc) =>
            Object.entries(filter).every(
              ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
            ),
          );
          return Promise.resolve(match ?? null);
        },
      };
    },
    find(filter: Record<string, unknown>) {
      const matches = [...store.values()].filter((doc) =>
        Object.entries(filter).every(
          ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
        ),
      );
      return {
        sort() {
          return {
            skip(n: number) {
              return {
                limit(l: number) {
                  return {
                    lean() {
                      return Promise.resolve(matches.slice(n, n + l));
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      _opts: Record<string, unknown>,
    ) {
      return {
        lean() {
          const match = [...store.values()].find((doc) =>
            Object.entries(filter).every(
              ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
            ),
          );
          if (!match) return Promise.resolve(null);
          const $set = (update as { $set?: Record<string, unknown> }).$set;
          if ($set) Object.assign(match, $set);
          return Promise.resolve(match);
        },
      };
    },
    findOneAndDelete(filter: Record<string, unknown>) {
      return {
        lean() {
          const match = [...store.values()].find((doc) =>
            Object.entries(filter).every(
              ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
            ),
          );
          if (match) store.delete(match._id);
          return Promise.resolve(match ?? null);
        },
      };
    },
    countDocuments(filter: Record<string, unknown>) {
      const count = [...store.values()].filter((doc) =>
        Object.entries(filter).every(
          ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
        ),
      ).length;
      return Promise.resolve(count);
    },
    create(data: Record<string, unknown>) {
      // Check for duplicate key
      const existing = [...store.values()].find(
        (d) =>
          d.tenantId === data.tenantId &&
          d.appId === data.appId &&
          d.environment === data.environment,
      );
      if (existing) {
        const err = new Error('E11000 duplicate key') as Error & { code: number };
        err.code = 11000;
        return Promise.reject(err);
      }
      const id = data._id ?? `gen-${Date.now()}`;
      const doc = { ...data, _id: id } as unknown as IAgentAssistBinding;
      store.set(String(id), doc);
      return Promise.resolve({ toObject: () => doc });
    },
    deleteMany(filter: Record<string, unknown>) {
      let count = 0;
      for (const [id, doc] of store.entries()) {
        const matches = Object.entries(filter).every(
          ([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v,
        );
        if (matches) {
          store.delete(id);
          count++;
        }
      }
      return Promise.resolve({ deletedCount: count });
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('bindingCacheKey', () => {
  test('formats as tenantId:appId:lowercaseEnvironment', () => {
    expect(bindingCacheKey('t1', 'app-x', 'Production')).toBe('t1:app-x:production');
  });
});

describe('isDuplicateKeyError', () => {
  test('returns true for E11000 errors', () => {
    const err = new Error('E11000') as Error & { code: number };
    err.code = 11000;
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  test('returns false for other errors', () => {
    expect(isDuplicateKeyError(new Error('some error'))).toBe(false);
  });

  test('returns false for non-Error values', () => {
    expect(isDuplicateKeyError('string')).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
  });
});

describe('AgentAssistBindingRepo — cache behavior', () => {
  let clock: number;
  let store: Map<string, IAgentAssistBinding>;
  let cache: LRUTTLCache<IAgentAssistBinding>;

  beforeEach(() => {
    clock = 1000;
    store = new Map();
    cache = new LRUTTLCache<IAgentAssistBinding>({
      maxEntries: 3,
      ttlMs: 5000,
      now: () => clock,
    });
  });

  test('get() populates cache from model on miss', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    const result = await repo.get(
      { tenantId: 'tenant-1' },
      { appId: 'aa-test', environment: 'production' },
    );
    expect(result).toEqual(binding);
    expect(cache.size).toBe(1);

    // Second call should hit cache (even if store is cleared)
    store.clear();
    const cached = await repo.get(
      { tenantId: 'tenant-1' },
      { appId: 'aa-test', environment: 'production' },
    );
    expect(cached).toEqual(binding);
  });

  test('get() returns null for non-existent binding', async () => {
    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    const result = await repo.get({ tenantId: 'tenant-1' }, { appId: 'nope', environment: 'dev' });
    expect(result).toBeNull();
    expect(cache.size).toBe(0);
  });

  test('cache expires after TTL', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-test', environment: 'production' });
    expect(cache.size).toBe(1);

    // Advance clock past TTL
    clock = 6001;

    // Store is cleared — cache should be expired, so get returns null
    store.clear();
    const result = await repo.get(
      { tenantId: 'tenant-1' },
      { appId: 'aa-test', environment: 'production' },
    );
    expect(result).toBeNull();
  });

  test('invalidate() removes entry from cache', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-test', environment: 'production' });
    expect(cache.size).toBe(1);

    repo.invalidate('tenant-1', 'aa-test', 'production');
    expect(cache.size).toBe(0);
  });

  test('create() caches the new binding', async () => {
    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    const result = await repo.create(
      { tenantId: 'tenant-1', actor: 'user-1' },
      { projectId: 'project-1', appId: 'aa-new', environment: 'dev' },
    );

    expect(result.appId).toBe('aa-new');
    expect(cache.size).toBe(1);
  });

  test('create() throws AgentAssistBindingDuplicateError on E11000', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    await expect(
      repo.create(
        { tenantId: 'tenant-1', actor: 'user-1' },
        { projectId: 'project-1', appId: 'aa-test', environment: 'production' },
      ),
    ).rejects.toThrow(AgentAssistBindingDuplicateError);
  });

  test('update() invalidates cache', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    // Populate cache
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-test', environment: 'production' });
    expect(cache.size).toBe(1);

    await repo.update({ tenantId: 'tenant-1', actor: 'user-1' }, 'bind-1', {
      displayName: 'updated',
    });

    expect(cache.size).toBe(0);
  });

  test('update() throws AgentAssistBindingNotFoundError for missing binding', async () => {
    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    await expect(
      repo.update({ tenantId: 'tenant-1', actor: 'user-1' }, 'missing-id', {
        displayName: 'x',
      }),
    ).rejects.toThrow(AgentAssistBindingNotFoundError);
  });

  test('setStatus() invalidates cache', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    // Populate cache
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-test', environment: 'production' });
    expect(cache.size).toBe(1);

    await repo.setStatus({ tenantId: 'tenant-1', actor: 'user-1' }, 'bind-1', 'disabled');
    expect(cache.size).toBe(0);
  });

  test('remove() invalidates cache', async () => {
    const binding = makeBinding();
    store.set(binding._id, binding);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    // Populate cache
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-test', environment: 'production' });
    expect(cache.size).toBe(1);

    await repo.remove({ tenantId: 'tenant-1', actor: 'user-1' }, 'bind-1');
    expect(cache.size).toBe(0);
  });

  test('remove() throws AgentAssistBindingNotFoundError for missing binding', async () => {
    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    await expect(
      repo.remove({ tenantId: 'tenant-1', actor: 'user-1' }, 'missing-id'),
    ).rejects.toThrow(AgentAssistBindingNotFoundError);
  });

  test('cascadeOnProjectDelete() clears cache', async () => {
    const b1 = makeBinding({ _id: 'b1', appId: 'aa-1' });
    const b2 = makeBinding({ _id: 'b2', appId: 'aa-2' });
    store.set(b1._id, b1);
    store.set(b2._id, b2);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    // Populate cache
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-1', environment: 'production' });
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-2', environment: 'production' });
    expect(cache.size).toBe(2);

    const deleted = await repo.cascadeOnProjectDelete('tenant-1', 'project-1');
    expect(deleted).toBe(2);
    expect(cache.size).toBe(0);
    expect(store.size).toBe(0);
  });

  test('cache evicts oldest entry when maxEntries exceeded', async () => {
    const b1 = makeBinding({ _id: 'b1', appId: 'aa-1' });
    const b2 = makeBinding({ _id: 'b2', appId: 'aa-2' });
    const b3 = makeBinding({ _id: 'b3', appId: 'aa-3' });
    const b4 = makeBinding({ _id: 'b4', appId: 'aa-4' });
    store.set(b1._id, b1);
    store.set(b2._id, b2);
    store.set(b3._id, b3);
    store.set(b4._id, b4);

    const repo = createAgentAssistBindingRepo({
      cache,
      model: createMockModel(store),
    });

    // Fill cache to maxEntries=3
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-1', environment: 'production' });
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-2', environment: 'production' });
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-3', environment: 'production' });
    expect(cache.size).toBe(3);

    // Adding 4th should evict aa-1 from cache
    await repo.get({ tenantId: 'tenant-1' }, { appId: 'aa-4', environment: 'production' });
    expect(cache.size).toBe(3);
    // aa-1 cache key should be gone
    expect(cache.has(bindingCacheKey('tenant-1', 'aa-1', 'production'))).toBe(false);
    expect(cache.has(bindingCacheKey('tenant-1', 'aa-4', 'production'))).toBe(true);
  });
});
