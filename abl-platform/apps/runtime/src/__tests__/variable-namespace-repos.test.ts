/**
 * Variable Namespace and Membership Repository Tests
 *
 * Coverage:
 * - Variable Namespace Repo: CRUD operations, tenant isolation, ordering, member counts
 * - Variable Namespace Membership Repo: Join operations, move/delete operations, batch ops
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as namespaceRepo from '../repos/variable-namespace-repo.js';
import * as membershipRepo from '../repos/variable-namespace-membership-repo.js';

// ─── Mock Setup ──────────────────────────────────────────────────────────

interface MockModel {
  findOne: Mock;
  find: Mock;
  findOneAndUpdate: Mock;
  deleteOne: Mock;
  deleteMany: Mock;
  create: Mock;
  countDocuments: Mock;
  bulkWrite: Mock;
  insertMany: Mock;
  aggregate: Mock;
}

const mockVariableNamespace: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
  bulkWrite: vi.fn(),
  insertMany: vi.fn(),
  aggregate: vi.fn(),
};

const mockVariableNamespaceMembership: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
  bulkWrite: vi.fn(),
  insertMany: vi.fn(),
  aggregate: vi.fn(),
};

vi.mock('@agent-platform/database/models', () => ({
  VariableNamespace: mockVariableNamespace,
  VariableNamespaceMembership: mockVariableNamespaceMembership,
}));

// ─── Test Data ───────────────────────────────────────────────────────────

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_1 = 'project-1';
const NAMESPACE_1 = 'namespace-1';
const NAMESPACE_2 = 'namespace-2';
const VARIABLE_1 = 'variable-1';
const VARIABLE_2 = 'variable-2';
const USER_1 = 'user-1';
const now = new Date();

function makeNamespaceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: NAMESPACE_1,
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    name: 'default',
    displayName: 'Default',
    description: 'Default namespace',
    icon: 'folder',
    color: '#3b82f6',
    order: 0,
    isDefault: true,
    createdBy: USER_1,
    updatedBy: null,
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMembershipDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'membership-1',
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    namespaceId: NAMESPACE_1,
    variableId: VARIABLE_1,
    variableType: 'env',
    createdAt: now,
    ...overrides,
  };
}

// ─── Helper to Mock Method Chaining ──────────────────────────────────────

function createChainableMock(returnValue: unknown) {
  const chain = {
    lean: vi.fn().mockResolvedValue(returnValue),
    sort: vi.fn(),
    skip: vi.fn(),
    limit: vi.fn(),
    select: vi.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  return chain;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Variable Namespace Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================================
  // CREATE
  // =====================================================================

  describe('createVariableNamespace', () => {
    test('creates namespace and returns doc via toObject()', async () => {
      const doc = makeNamespaceDoc();
      mockVariableNamespace.create.mockResolvedValue({
        toObject: () => doc,
      });

      const result = await namespaceRepo.createVariableNamespace({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        name: 'default',
        displayName: 'Default',
        description: 'Default namespace',
        icon: 'folder',
        color: '#3b82f6',
        order: 0,
        isDefault: true,
        createdBy: USER_1,
      });

      expect(mockVariableNamespace.create).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        name: 'default',
        displayName: 'Default',
        description: 'Default namespace',
        icon: 'folder',
        color: '#3b82f6',
        order: 0,
        isDefault: true,
        createdBy: USER_1,
      });
      expect(result._id).toBe(NAMESPACE_1);
      expect(result.name).toBe('default');
    });

    test('creates namespace with minimal fields', async () => {
      const doc = makeNamespaceDoc({ description: null, icon: null, color: null });
      mockVariableNamespace.create.mockResolvedValue({
        toObject: () => doc,
      });

      const result = await namespaceRepo.createVariableNamespace({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        name: 'staging',
        displayName: 'Staging',
        createdBy: USER_1,
      });

      expect(result).toBeDefined();
    });
  });

  // =====================================================================
  // FIND / LIST
  // =====================================================================

  describe('findVariableNamespaces', () => {
    test('queries with tenantId and projectId, sorts by order', async () => {
      const docs = [
        makeNamespaceDoc({ _id: 'ns-1', order: 0 }),
        makeNamespaceDoc({ _id: 'ns-2', order: 1 }),
      ];
      const chain = createChainableMock(docs);
      mockVariableNamespace.find.mockReturnValue(chain);

      const result = await namespaceRepo.findVariableNamespaces(TENANT_A, PROJECT_1);

      expect(mockVariableNamespace.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
      expect(chain.sort).toHaveBeenCalledWith({ order: 1 });
      expect(result).toHaveLength(2);
    });

    test('returns empty array when no namespaces exist', async () => {
      const chain = createChainableMock([]);
      mockVariableNamespace.find.mockReturnValue(chain);

      const result = await namespaceRepo.findVariableNamespaces(TENANT_A, PROJECT_1);

      expect(result).toEqual([]);
    });
  });

  describe('findVariableNamespaceById', () => {
    test('queries with _id and tenantId, returns lean', async () => {
      const doc = makeNamespaceDoc();
      const chain = createChainableMock(doc);
      mockVariableNamespace.findOne.mockReturnValue(chain);

      const result = await namespaceRepo.findVariableNamespaceById(NAMESPACE_1, TENANT_A);

      expect(mockVariableNamespace.findOne).toHaveBeenCalledWith({
        _id: NAMESPACE_1,
        tenantId: TENANT_A,
      });
      expect(chain.lean).toHaveBeenCalled();
      expect(result._id).toBe(NAMESPACE_1);
    });

    test('returns null for wrong tenant', async () => {
      const chain = createChainableMock(null);
      mockVariableNamespace.findOne.mockReturnValue(chain);

      const result = await namespaceRepo.findVariableNamespaceById(NAMESPACE_1, TENANT_B);

      expect(result).toBeNull();
    });
  });

  describe('findDefaultVariableNamespace', () => {
    test('queries with isDefault: true', async () => {
      const doc = makeNamespaceDoc({ isDefault: true });
      const chain = createChainableMock(doc);
      mockVariableNamespace.findOne.mockReturnValue(chain);

      const result = await namespaceRepo.findDefaultVariableNamespace(TENANT_A, PROJECT_1);

      expect(mockVariableNamespace.findOne).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        isDefault: true,
      });
      expect(result.isDefault).toBe(true);
    });

    test('returns null when no default namespace exists', async () => {
      const chain = createChainableMock(null);
      mockVariableNamespace.findOne.mockReturnValue(chain);

      const result = await namespaceRepo.findDefaultVariableNamespace(TENANT_A, PROJECT_1);

      expect(result).toBeNull();
    });
  });

  // =====================================================================
  // UPDATE
  // =====================================================================

  describe('updateVariableNamespace', () => {
    test('uses findOneAndUpdate with $set', async () => {
      const updated = makeNamespaceDoc({ displayName: 'Updated Name' });
      const chain = createChainableMock(updated);
      mockVariableNamespace.findOneAndUpdate.mockReturnValue(chain);

      const result = await namespaceRepo.updateVariableNamespace(NAMESPACE_1, TENANT_A, {
        displayName: 'Updated Name',
        updatedBy: USER_1,
      });

      expect(mockVariableNamespace.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: NAMESPACE_1, tenantId: TENANT_A },
        { $set: { displayName: 'Updated Name', updatedBy: USER_1 } },
        { new: true },
      );
      expect(result.displayName).toBe('Updated Name');
    });

    test('returns null when namespace not found', async () => {
      const chain = createChainableMock(null);
      mockVariableNamespace.findOneAndUpdate.mockReturnValue(chain);

      const result = await namespaceRepo.updateVariableNamespace(NAMESPACE_1, TENANT_A, {
        displayName: 'Updated',
      });

      expect(result).toBeNull();
    });

    test('allows partial updates', async () => {
      const updated = makeNamespaceDoc({ icon: 'star' });
      const chain = createChainableMock(updated);
      mockVariableNamespace.findOneAndUpdate.mockReturnValue(chain);

      await namespaceRepo.updateVariableNamespace(NAMESPACE_1, TENANT_A, {
        icon: 'star',
      });

      expect(mockVariableNamespace.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: NAMESPACE_1, tenantId: TENANT_A },
        { $set: { icon: 'star' } },
        { new: true },
      );
    });
  });

  // =====================================================================
  // DELETE
  // =====================================================================

  describe('deleteVariableNamespace', () => {
    test('uses deleteOne with _id and tenantId', async () => {
      mockVariableNamespace.deleteOne.mockResolvedValue({ deletedCount: 1 });

      await namespaceRepo.deleteVariableNamespace(NAMESPACE_1, TENANT_A);

      expect(mockVariableNamespace.deleteOne).toHaveBeenCalledWith({
        _id: NAMESPACE_1,
        tenantId: TENANT_A,
      });
    });

    test('does not throw when namespace not found', async () => {
      mockVariableNamespace.deleteOne.mockResolvedValue({ deletedCount: 0 });

      await expect(
        namespaceRepo.deleteVariableNamespace('nonexistent', TENANT_A),
      ).resolves.not.toThrow();
    });
  });

  // =====================================================================
  // COUNT
  // =====================================================================

  describe('countVariableNamespaces', () => {
    test('uses countDocuments with tenantId and projectId', async () => {
      mockVariableNamespace.countDocuments.mockResolvedValue(5);

      const result = await namespaceRepo.countVariableNamespaces(TENANT_A, PROJECT_1);

      expect(mockVariableNamespace.countDocuments).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
      expect(result).toBe(5);
    });

    test('returns 0 when no namespaces exist', async () => {
      mockVariableNamespace.countDocuments.mockResolvedValue(0);

      const result = await namespaceRepo.countVariableNamespaces(TENANT_A, PROJECT_1);

      expect(result).toBe(0);
    });
  });

  // =====================================================================
  // REORDER
  // =====================================================================

  describe('reorderVariableNamespaces', () => {
    test('builds and executes bulkWrite ops', async () => {
      mockVariableNamespace.bulkWrite.mockResolvedValue({});

      await namespaceRepo.reorderVariableNamespaces(TENANT_A, PROJECT_1, [
        { namespaceId: NAMESPACE_1, order: 1 },
        { namespaceId: NAMESPACE_2, order: 2 },
      ]);

      expect(mockVariableNamespace.bulkWrite).toHaveBeenCalledWith([
        {
          updateOne: {
            filter: { _id: NAMESPACE_1, tenantId: TENANT_A, projectId: PROJECT_1 },
            update: { $set: { order: 1 } },
          },
        },
        {
          updateOne: {
            filter: { _id: NAMESPACE_2, tenantId: TENANT_A, projectId: PROJECT_1 },
            update: { $set: { order: 2 } },
          },
        },
      ]);
    });

    test('skips bulkWrite when order array is empty', async () => {
      mockVariableNamespace.bulkWrite.mockResolvedValue({});

      await namespaceRepo.reorderVariableNamespaces(TENANT_A, PROJECT_1, []);

      expect(mockVariableNamespace.bulkWrite).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // MEMBER COUNTS
  // =====================================================================

  describe('getVariableNamespaceMemberCounts', () => {
    test('runs aggregation pipeline and returns counts map', async () => {
      const aggregateResults = [
        { _id: { namespaceId: NAMESPACE_1, variableType: 'env' }, count: 3 },
        { _id: { namespaceId: NAMESPACE_1, variableType: 'config' }, count: 2 },
        { _id: { namespaceId: NAMESPACE_2, variableType: 'env' }, count: 1 },
      ];
      mockVariableNamespaceMembership.aggregate.mockResolvedValue(aggregateResults);

      const result = await namespaceRepo.getVariableNamespaceMemberCounts(TENANT_A, PROJECT_1, [
        NAMESPACE_1,
        NAMESPACE_2,
      ]);

      expect(mockVariableNamespaceMembership.aggregate).toHaveBeenCalledWith([
        {
          $match: {
            tenantId: TENANT_A,
            projectId: PROJECT_1,
            namespaceId: { $in: [NAMESPACE_1, NAMESPACE_2] },
          },
        },
        {
          $group: {
            _id: { namespaceId: '$namespaceId', variableType: '$variableType' },
            count: { $sum: 1 },
          },
        },
      ]);

      expect(result[NAMESPACE_1]).toEqual({ env: 3, config: 2 });
      expect(result[NAMESPACE_2]).toEqual({ env: 1, config: 0 });
    });

    test('initializes all namespace IDs with zero counts', async () => {
      mockVariableNamespaceMembership.aggregate.mockResolvedValue([]);

      const result = await namespaceRepo.getVariableNamespaceMemberCounts(TENANT_A, PROJECT_1, [
        NAMESPACE_1,
        NAMESPACE_2,
      ]);

      expect(result[NAMESPACE_1]).toEqual({ env: 0, config: 0 });
      expect(result[NAMESPACE_2]).toEqual({ env: 0, config: 0 });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// VARIABLE NAMESPACE MEMBERSHIP REPOSITORY
// ═════════════════════════════════════════════════════════════════════

describe('Variable Namespace Membership Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================================
  // ADD MEMBERSHIPS
  // =====================================================================

  describe('addVariableNamespaceMemberships', () => {
    test('calls insertMany with ordered: false', async () => {
      mockVariableNamespaceMembership.insertMany.mockResolvedValue([]);

      await membershipRepo.addVariableNamespaceMemberships(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
        [
          { variableId: VARIABLE_1, variableType: 'env' },
          { variableId: VARIABLE_2, variableType: 'config' },
        ],
        undefined,
      );

      expect(mockVariableNamespaceMembership.insertMany).toHaveBeenCalledWith(
        [
          {
            tenantId: TENANT_A,
            projectId: PROJECT_1,
            namespaceId: NAMESPACE_1,
            variableId: VARIABLE_1,
            variableType: 'env',
          },
          {
            tenantId: TENANT_A,
            projectId: PROJECT_1,
            namespaceId: NAMESPACE_1,
            variableId: VARIABLE_2,
            variableType: 'config',
          },
        ],
        { ordered: false, session: undefined },
      );
    });

    test('swallows duplicate key error (code 11000)', async () => {
      const duplicateError = { code: 11000, message: 'E11000 duplicate key error' };
      mockVariableNamespaceMembership.insertMany.mockRejectedValue(duplicateError);

      await expect(
        membershipRepo.addVariableNamespaceMemberships(
          TENANT_A,
          PROJECT_1,
          NAMESPACE_1,
          [{ variableId: VARIABLE_1, variableType: 'env' }],
          undefined,
        ),
      ).resolves.not.toThrow();
    });

    test('rethrows non-duplicate errors', async () => {
      const otherError = new Error('Network error');
      mockVariableNamespaceMembership.insertMany.mockRejectedValue(otherError);

      await expect(
        membershipRepo.addVariableNamespaceMemberships(
          TENANT_A,
          PROJECT_1,
          NAMESPACE_1,
          [{ variableId: VARIABLE_1, variableType: 'env' }],
          undefined,
        ),
      ).rejects.toThrow('Network error');
    });

    test('passes session parameter', async () => {
      const mockSession = { id: 'session-1' } as any;
      mockVariableNamespaceMembership.insertMany.mockResolvedValue([]);

      await membershipRepo.addVariableNamespaceMemberships(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
        [{ variableId: VARIABLE_1, variableType: 'env' }],
        mockSession,
      );

      expect(mockVariableNamespaceMembership.insertMany).toHaveBeenCalledWith(expect.any(Array), {
        ordered: false,
        session: mockSession,
      });
    });
  });

  // =====================================================================
  // REMOVE MEMBERSHIP
  // =====================================================================

  describe('removeVariableNamespaceMembership', () => {
    test('calls deleteOne with correct filter', async () => {
      mockVariableNamespaceMembership.deleteOne.mockResolvedValue({ deletedCount: 1 });

      await membershipRepo.removeVariableNamespaceMembership(
        TENANT_A,
        NAMESPACE_1,
        VARIABLE_1,
        'env',
        undefined,
      );

      expect(mockVariableNamespaceMembership.deleteOne).toHaveBeenCalledWith(
        {
          tenantId: TENANT_A,
          namespaceId: NAMESPACE_1,
          variableId: VARIABLE_1,
          variableType: 'env',
        },
        { session: undefined },
      );
    });

    test('passes session parameter', async () => {
      const mockSession = { id: 'session-1' } as any;
      mockVariableNamespaceMembership.deleteOne.mockResolvedValue({ deletedCount: 1 });

      await membershipRepo.removeVariableNamespaceMembership(
        TENANT_A,
        NAMESPACE_1,
        VARIABLE_1,
        'config',
        mockSession,
      );

      expect(mockVariableNamespaceMembership.deleteOne).toHaveBeenCalledWith(expect.any(Object), {
        session: mockSession,
      });
    });
  });

  // =====================================================================
  // FIND MEMBERSHIPS
  // =====================================================================

  describe('findMembershipsByVariableNamespace', () => {
    test('queries by tenantId, projectId, and namespaceId', async () => {
      const docs = [
        makeMembershipDoc(),
        makeMembershipDoc({ variableId: VARIABLE_2, variableType: 'config' }),
      ];
      const chain = createChainableMock(docs);
      mockVariableNamespaceMembership.find.mockReturnValue(chain);

      const result = await membershipRepo.findMembershipsByVariableNamespace(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
      );

      expect(mockVariableNamespaceMembership.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        namespaceId: NAMESPACE_1,
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('findVariableNamespaceMembershipsByVariable', () => {
    test('queries by tenantId, variableId, and variableType', async () => {
      const docs = [makeMembershipDoc()];
      const chain = createChainableMock(docs);
      mockVariableNamespaceMembership.find.mockReturnValue(chain);

      const result = await membershipRepo.findVariableNamespaceMembershipsByVariable(
        TENANT_A,
        VARIABLE_1,
        'env',
      );

      expect(mockVariableNamespaceMembership.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        variableId: VARIABLE_1,
        variableType: 'env',
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findVariableNamespaceMembershipsByVariableIds', () => {
    test('queries with variableId $in', async () => {
      const docs = [
        makeMembershipDoc({ variableId: VARIABLE_1 }),
        makeMembershipDoc({ variableId: VARIABLE_2 }),
      ];
      const chain = createChainableMock(docs);
      mockVariableNamespaceMembership.find.mockReturnValue(chain);

      const result = await membershipRepo.findVariableNamespaceMembershipsByVariableIds(TENANT_A, [
        VARIABLE_1,
        VARIABLE_2,
      ]);

      expect(mockVariableNamespaceMembership.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        variableId: { $in: [VARIABLE_1, VARIABLE_2] },
      });
      expect(result).toHaveLength(2);
    });
  });

  // =====================================================================
  // COUNT MEMBERSHIPS
  // =====================================================================

  describe('countVariableNamespaceMembershipsForVariable', () => {
    test('calls countDocuments with correct filter', async () => {
      mockVariableNamespaceMembership.countDocuments.mockResolvedValue(2);

      const result = await membershipRepo.countVariableNamespaceMembershipsForVariable(
        TENANT_A,
        VARIABLE_1,
        'env',
      );

      expect(mockVariableNamespaceMembership.countDocuments).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        variableId: VARIABLE_1,
        variableType: 'env',
      });
      expect(result).toBe(2);
    });
  });

  // =====================================================================
  // DELETE MEMBERSHIPS
  // =====================================================================

  describe('deleteAllVariableNamespaceMembershipsForVariable', () => {
    test('calls deleteMany with variableId and variableType', async () => {
      mockVariableNamespaceMembership.deleteMany.mockResolvedValue({ deletedCount: 3 });

      await membershipRepo.deleteAllVariableNamespaceMembershipsForVariable(
        VARIABLE_1,
        'env',
        undefined,
      );

      expect(mockVariableNamespaceMembership.deleteMany).toHaveBeenCalledWith(
        { variableId: VARIABLE_1, variableType: 'env' },
        { session: undefined },
      );
    });

    test('passes session parameter', async () => {
      const mockSession = { id: 'session-1' } as any;
      mockVariableNamespaceMembership.deleteMany.mockResolvedValue({ deletedCount: 3 });

      await membershipRepo.deleteAllVariableNamespaceMembershipsForVariable(
        VARIABLE_1,
        'config',
        mockSession,
      );

      expect(mockVariableNamespaceMembership.deleteMany).toHaveBeenCalledWith(expect.any(Object), {
        session: mockSession,
      });
    });
  });

  describe('deleteAllMembershipsForVariableNamespace', () => {
    test('calls deleteMany by namespaceId', async () => {
      mockVariableNamespaceMembership.deleteMany.mockResolvedValue({ deletedCount: 5 });

      await membershipRepo.deleteAllMembershipsForVariableNamespace(NAMESPACE_1, undefined);

      expect(mockVariableNamespaceMembership.deleteMany).toHaveBeenCalledWith(
        { namespaceId: NAMESPACE_1 },
        { session: undefined },
      );
    });

    test('passes session parameter', async () => {
      const mockSession = { id: 'session-1' } as any;
      mockVariableNamespaceMembership.deleteMany.mockResolvedValue({ deletedCount: 5 });

      await membershipRepo.deleteAllMembershipsForVariableNamespace(NAMESPACE_1, mockSession);

      expect(mockVariableNamespaceMembership.deleteMany).toHaveBeenCalledWith(expect.any(Object), {
        session: mockSession,
      });
    });
  });

  // =====================================================================
  // MOVE MEMBERSHIPS
  // =====================================================================

  describe('moveVariableNamespaceMemberships', () => {
    test('builds bulkWrite with deleteOne and insertOne pairs', async () => {
      mockVariableNamespaceMembership.bulkWrite.mockResolvedValue({});

      await membershipRepo.moveVariableNamespaceMemberships(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
        NAMESPACE_2,
        [
          { variableId: VARIABLE_1, variableType: 'env' },
          { variableId: VARIABLE_2, variableType: 'config' },
        ],
        undefined,
      );

      expect(mockVariableNamespaceMembership.bulkWrite).toHaveBeenCalledWith(
        [
          {
            deleteOne: {
              filter: {
                tenantId: TENANT_A,
                namespaceId: NAMESPACE_1,
                variableId: VARIABLE_1,
                variableType: 'env',
              },
            },
          },
          {
            insertOne: {
              document: {
                tenantId: TENANT_A,
                projectId: PROJECT_1,
                namespaceId: NAMESPACE_2,
                variableId: VARIABLE_1,
                variableType: 'env',
              },
            },
          },
          {
            deleteOne: {
              filter: {
                tenantId: TENANT_A,
                namespaceId: NAMESPACE_1,
                variableId: VARIABLE_2,
                variableType: 'config',
              },
            },
          },
          {
            insertOne: {
              document: {
                tenantId: TENANT_A,
                projectId: PROJECT_1,
                namespaceId: NAMESPACE_2,
                variableId: VARIABLE_2,
                variableType: 'config',
              },
            },
          },
        ],
        { session: undefined },
      );
    });

    test('skips bulkWrite when variables array is empty', async () => {
      mockVariableNamespaceMembership.bulkWrite.mockResolvedValue({});

      await membershipRepo.moveVariableNamespaceMemberships(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
        NAMESPACE_2,
        [],
        undefined,
      );

      expect(mockVariableNamespaceMembership.bulkWrite).not.toHaveBeenCalled();
    });

    test('passes session parameter', async () => {
      const mockSession = { id: 'session-1' } as any;
      mockVariableNamespaceMembership.bulkWrite.mockResolvedValue({});

      await membershipRepo.moveVariableNamespaceMemberships(
        TENANT_A,
        PROJECT_1,
        NAMESPACE_1,
        NAMESPACE_2,
        [{ variableId: VARIABLE_1, variableType: 'env' }],
        mockSession,
      );

      expect(mockVariableNamespaceMembership.bulkWrite).toHaveBeenCalledWith(expect.any(Array), {
        session: mockSession,
      });
    });
  });
});
