/**
 * TenantScopedRepository Unit Tests
 *
 * Tests the base repository class with a mock Mongoose model.
 * Validates:
 * - Every query includes tenantId (isolation)
 * - Cross-tenant access returns null
 * - CRUD operations delegate correctly to the model
 * - Pagination options are applied
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { TenantScopedRepository } from '../repos/base-repository.js';

// ─── Mock Model ─────────────────────────────────────────────────────────

interface MockModel {
  findOne: Mock;
  find: Mock;
  findOneAndUpdate: Mock;
  deleteOne: Mock;
  countDocuments: Mock;
  create: Mock;
}

function createMockModel(): MockModel {
  const mockQuery = {
    lean: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };

  return {
    findOne: vi.fn().mockReturnValue(mockQuery),
    find: vi.fn().mockReturnValue(mockQuery),
    findOneAndUpdate: vi.fn().mockReturnValue(mockQuery),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ toObject: () => ({ _id: 'new-1', tenantId: 't1' }) }),
  };
}

// ─── Concrete Test Repository ───────────────────────────────────────────

class TestRepository extends TenantScopedRepository<any> {
  public mockModel: MockModel;

  constructor(model: MockModel) {
    super();
    this.mockModel = model;
  }

  protected get model(): any {
    return this.mockModel;
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('TenantScopedRepository', () => {
  let repo: TestRepository;
  let mockModel: MockModel;

  beforeEach(() => {
    mockModel = createMockModel();
    repo = new TestRepository(mockModel);
  });

  // ── findByIdAndTenant ─────────────────────────────────────────────────

  describe('findByIdAndTenant', () => {
    test('passes _id and tenantId to findOne', async () => {
      await repo.findByIdAndTenant('doc-1', 'tenant-A');

      expect(mockModel.findOne).toHaveBeenCalledWith({ _id: 'doc-1', tenantId: 'tenant-A' });
    });

    test('returns null when document not found', async () => {
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await repo.findByIdAndTenant('nonexistent', 'tenant-A');
      expect(result).toBeNull();
    });

    test('returns document when found', async () => {
      const doc = { _id: 'doc-1', tenantId: 'tenant-A', name: 'test' };
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findByIdAndTenant('doc-1', 'tenant-A');
      expect(result).toEqual(doc);
    });

    test('returns null for cross-tenant access (isolation)', async () => {
      // Document exists for tenant-A but queried with tenant-B
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await repo.findByIdAndTenant('doc-1', 'tenant-B');
      expect(result).toBeNull();
      expect(mockModel.findOne).toHaveBeenCalledWith({ _id: 'doc-1', tenantId: 'tenant-B' });
    });
  });

  // ── findOneByTenant ───────────────────────────────────────────────────

  describe('findOneByTenant', () => {
    test('merges filter with tenantId', async () => {
      await repo.findOneByTenant({ status: 'active', projectId: 'proj-1' }, 'tenant-A');

      expect(mockModel.findOne).toHaveBeenCalledWith({
        status: 'active',
        projectId: 'proj-1',
        tenantId: 'tenant-A',
      });
    });

    test('tenantId in the call overrides any tenantId in the filter', async () => {
      await repo.findOneByTenant({ tenantId: 'tenant-EVIL' }, 'tenant-A');

      expect(mockModel.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-A' });
    });
  });

  // ── findManyByTenant ──────────────────────────────────────────────────

  describe('findManyByTenant', () => {
    test('passes filter with tenantId to find', async () => {
      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      mockModel.find.mockReturnValue(mockQuery);

      await repo.findManyByTenant({ projectId: 'proj-1' }, 'tenant-A');

      expect(mockModel.find).toHaveBeenCalledWith({ projectId: 'proj-1', tenantId: 'tenant-A' });
    });

    test('applies pagination options', async () => {
      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      mockModel.find.mockReturnValue(mockQuery);

      await repo.findManyByTenant({ projectId: 'proj-1' }, 'tenant-A', {
        sort: { createdAt: -1 },
        skip: 10,
        limit: 20,
      });

      expect(mockQuery.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(mockQuery.skip).toHaveBeenCalledWith(10);
      expect(mockQuery.limit).toHaveBeenCalledWith(20);
    });

    test('skips pagination when options are not provided', async () => {
      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      mockModel.find.mockReturnValue(mockQuery);

      await repo.findManyByTenant({}, 'tenant-A');

      expect(mockQuery.sort).not.toHaveBeenCalled();
      expect(mockQuery.skip).not.toHaveBeenCalled();
      expect(mockQuery.limit).not.toHaveBeenCalled();
    });
  });

  // ── countByTenant ─────────────────────────────────────────────────────

  describe('countByTenant', () => {
    test('passes filter with tenantId to countDocuments', async () => {
      mockModel.countDocuments.mockResolvedValue(5);

      const count = await repo.countByTenant({ status: 'active' }, 'tenant-A');

      expect(mockModel.countDocuments).toHaveBeenCalledWith({
        status: 'active',
        tenantId: 'tenant-A',
      });
      expect(count).toBe(5);
    });
  });

  // ── updateByIdAndTenant ───────────────────────────────────────────────

  describe('updateByIdAndTenant', () => {
    test('uses findOneAndUpdate with _id and tenantId', async () => {
      const updated = { _id: 'doc-1', tenantId: 'tenant-A', status: 'ended' };
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(updated) });

      const result = await repo.updateByIdAndTenant('doc-1', 'tenant-A', { status: 'ended' });

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'doc-1', tenantId: 'tenant-A' },
        { $set: { status: 'ended' } },
        { new: true },
      );
      expect(result).toEqual(updated);
    });

    test('returns null when document not found or wrong tenant', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await repo.updateByIdAndTenant('doc-1', 'tenant-B', { status: 'ended' });
      expect(result).toBeNull();
    });
  });

  // ── deleteByIdAndTenant ───────────────────────────────────────────────

  describe('deleteByIdAndTenant', () => {
    test('returns true when document is deleted', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await repo.deleteByIdAndTenant('doc-1', 'tenant-A');

      expect(mockModel.deleteOne).toHaveBeenCalledWith({ _id: 'doc-1', tenantId: 'tenant-A' });
      expect(result).toBe(true);
    });

    test('returns false when document not found or wrong tenant', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 0 });

      const result = await repo.deleteByIdAndTenant('doc-1', 'tenant-B');
      expect(result).toBe(false);
    });
  });

  // ── create ────────────────────────────────────────────────────────────

  describe('create', () => {
    test('delegates to model.create and returns plain object', async () => {
      const data = { tenantId: 'tenant-A', name: 'test', status: 'active' };
      const created = { _id: 'new-1', ...data };
      mockModel.create.mockResolvedValue({ toObject: () => created });

      const result = await repo.create(data);

      expect(mockModel.create).toHaveBeenCalledWith(data);
      expect(result).toEqual(created);
    });

    test('handles model.create returning plain object (no toObject)', async () => {
      const data = { tenantId: 'tenant-A', name: 'test' };
      const created = { _id: 'new-2', ...data };
      mockModel.create.mockResolvedValue(created);

      const result = await repo.create(data);
      expect(result).toEqual(created);
    });
  });
});
