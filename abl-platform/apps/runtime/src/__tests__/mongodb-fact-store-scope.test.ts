/**
 * MongoDBFactStore Scope Isolation Tests
 *
 * Verifies that:
 * 1. User-scoped facts are isolated by userId (user A cannot see user B's facts)
 * 2. Project-scoped facts are visible regardless of which user queries them
 * 3. createProjectFactStore() creates a store with the __project__ sentinel userId
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock FactModel before importing the store
// ---------------------------------------------------------------------------

const mockFindOneAndUpdate = vi.fn();
const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockCountDocuments = vi.fn();
const mockDeleteOne = vi.fn();
const mockDeleteMany = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Fact: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => ({ lean: () => mockFindOne(...args) }),
    find: (...args: unknown[]) => ({
      sort: () => ({ limit: () => ({ lean: () => mockFind(...args) }) }),
      lean: () => mockFind(...args),
    }),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
    deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
    deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
  },
}));

import {
  MongoDBFactStore,
  PROJECT_SCOPE_USER_ID,
  createMongoDBFactStore,
  createProjectFactStore,
} from '../services/stores/mongodb-fact-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'fact-1',
    key: 'preferences.chain',
    value: JSON.stringify('Hilton'),
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    sourceType: 'agent',
    sourceAgentName: null,
    sourceSessionId: null,
    sourceTraceId: null,
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MongoDBFactStore scope isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. User-scoped facts are isolated by userId
  // -------------------------------------------------------------------------

  describe('user-scoped isolation', () => {
    test('user A store queries include user A userId — not user B', async () => {
      const storeA = new MongoDBFactStore(
        { type: 'mongodb' },
        'tenant-1',
        'user-A',
        'project-1',
        'user',
      );

      mockFindOne.mockResolvedValue(makeFakeDoc());

      await storeA.get({ key: 'preferences.chain' });

      // The filter passed to findOne must scope to user-A
      const filter = mockFindOne.mock.calls[0][0];
      expect(filter).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-A',
          projectId: 'project-1',
          scope: 'user',
          key: 'preferences.chain',
        }),
      );
    });

    test('user B store queries include user B userId — separate from user A', async () => {
      const storeB = new MongoDBFactStore(
        { type: 'mongodb' },
        'tenant-1',
        'user-B',
        'project-1',
        'user',
      );

      mockFindOne.mockResolvedValue(null);

      await storeB.get({ key: 'preferences.chain' });

      const filter = mockFindOne.mock.calls[0][0];
      expect(filter).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-B',
          projectId: 'project-1',
          scope: 'user',
        }),
      );
    });

    test('set() on user A store writes with user A ownership filter', async () => {
      const storeA = new MongoDBFactStore(
        { type: 'mongodb' },
        'tenant-1',
        'user-A',
        'project-1',
        'user',
      );

      mockFindOneAndUpdate.mockResolvedValue(makeFakeDoc());

      await storeA.set({ key: 'preferences.chain', value: 'Marriott' });

      const [filterArg] = mockFindOneAndUpdate.mock.calls[0];
      expect(filterArg).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-A',
          projectId: 'project-1',
          scope: 'user',
          key: 'preferences.chain',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Project-scoped facts use __project__ sentinel and are visible to any user
  // -------------------------------------------------------------------------

  describe('project-scoped facts', () => {
    test('project-scoped store queries with __project__ userId regardless of caller', async () => {
      const projectStore = new MongoDBFactStore(
        { type: 'mongodb' },
        'tenant-1',
        PROJECT_SCOPE_USER_ID,
        'project-1',
        'project',
      );

      mockFindOne.mockResolvedValue(makeFakeDoc({ value: JSON.stringify('shared-value') }));

      const fact = await projectStore.get({ key: 'shared.setting' });

      const filter = mockFindOne.mock.calls[0][0];
      expect(filter).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: PROJECT_SCOPE_USER_ID,
          projectId: 'project-1',
          scope: 'project',
          key: 'shared.setting',
        }),
      );
      expect(fact).not.toBeNull();
      expect(fact!.value).toBe('shared-value');
    });

    test('project-scoped set() writes with __project__ userId and scope: project', async () => {
      const projectStore = new MongoDBFactStore(
        { type: 'mongodb' },
        'tenant-1',
        PROJECT_SCOPE_USER_ID,
        'project-1',
        'project',
      );

      mockFindOneAndUpdate.mockResolvedValue(
        makeFakeDoc({ value: JSON.stringify('new-shared-value') }),
      );

      await projectStore.set({ key: 'shared.setting', value: 'new-shared-value' });

      const [filterArg, updateArg] = mockFindOneAndUpdate.mock.calls[0];
      expect(filterArg).toEqual(
        expect.objectContaining({
          userId: PROJECT_SCOPE_USER_ID,
          scope: 'project',
        }),
      );
      expect(updateArg.$set).toEqual(
        expect.objectContaining({
          userId: PROJECT_SCOPE_USER_ID,
          scope: 'project',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. createProjectFactStore() factory
  // -------------------------------------------------------------------------

  describe('createProjectFactStore()', () => {
    test('creates a store with __project__ userId and scope: project', async () => {
      const store = createProjectFactStore('tenant-1', 'project-1');

      mockFindOne.mockResolvedValue(null);

      await store.get({ key: 'anything' });

      const filter = mockFindOne.mock.calls[0][0];
      expect(filter).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: PROJECT_SCOPE_USER_ID,
          projectId: 'project-1',
          scope: 'project',
        }),
      );
    });

    test('createMongoDBFactStore() creates a user-scoped store', async () => {
      const store = createMongoDBFactStore('tenant-1', 'user-1', 'project-1');

      mockFindOne.mockResolvedValue(null);

      await store.get({ key: 'anything' });

      const filter = mockFindOne.mock.calls[0][0];
      expect(filter).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          projectId: 'project-1',
          scope: 'user',
        }),
      );
    });
  });
});
