/**
 * Tenant Model Repo Tenant Isolation Tests
 *
 * Verifies that tenant-model-repo functions use findOne({_id, tenantId})
 * instead of findById when tenantId is provided, preventing cross-tenant access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findById: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findOneAndUpdate: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOneAndUpdate,
    })),
    findByIdAndUpdate: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOneAndUpdate,
    })),
  },
  TenantServiceInstance: {
    findOne: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findById: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  },
}));

import {
  findTenantModel,
  findTenantModelWithConnections,
  findTenantModelAdmin,
  findTenantModelWithConnectionsAdmin,
  updateTenantModel,
  updateTenantModelAdmin,
  findTenantModelConnections,
  findTenantServiceInstance,
  updateTenantServiceInstance,
  deleteTenantServiceInstance,
} from '../repos/tenant-model-repo.js';

describe('tenant-model-repo tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockFindOneAndUpdate.mockResolvedValue(null);
  });

  describe('findTenantModel', () => {
    it('scopes by tenantId when provided', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await findTenantModel('model-1', 'tenant-A');
      expect(TenantModel.findOne).toHaveBeenCalledWith({ _id: 'model-1', tenantId: 'tenant-A' });
    });

    it('returns null when tenantId does not match', async () => {
      mockFindOne.mockResolvedValue(null);
      const result = await findTenantModel('model-1', 'tenant-B');
      expect(result).toBeNull();
    });

    it('returns model when tenantId matches', async () => {
      mockFindOne.mockResolvedValue({
        _id: 'model-1',
        tenantId: 'tenant-A',
        displayName: 'Test',
      });
      const result = await findTenantModel('model-1', 'tenant-A');
      expect(result).not.toBeNull();
      expect(result.id).toBe('model-1');
    });

    it('rejects missing tenantId on tenant-scoped lookups', async () => {
      await expect(findTenantModel('model-1', '' as string)).rejects.toThrow(
        'tenantId is required',
      );
    });

    it('uses explicit admin lookup for system/admin access', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await findTenantModelAdmin('model-1');
      expect(TenantModel.findOne).toHaveBeenCalledWith({ _id: 'model-1' });
    });
  });

  describe('findTenantModelWithConnections', () => {
    it('scopes by tenantId when provided', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await findTenantModelWithConnections('model-1', 'tenant-A');
      expect(TenantModel.findOne).toHaveBeenCalledWith({ _id: 'model-1', tenantId: 'tenant-A' });
    });

    it('uses explicit admin lookup for unscoped connection reads', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await findTenantModelWithConnectionsAdmin('model-1');
      expect(TenantModel.findOne).toHaveBeenCalledWith({ _id: 'model-1' });
    });
  });

  describe('updateTenantModel', () => {
    it('scopes update by tenantId when provided', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await updateTenantModel('model-1', { displayName: 'Updated' }, 'tenant-A');
      expect(TenantModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'model-1', tenantId: 'tenant-A' },
        { $set: { displayName: 'Updated' } },
        { new: true },
      );
    });

    it('rejects missing tenantId on tenant-scoped updates', async () => {
      await expect(
        updateTenantModel('model-1', { displayName: 'Updated' }, '' as string),
      ).rejects.toThrow('tenantId is required');
    });

    it('uses explicit admin update path for unscoped updates', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      await updateTenantModelAdmin('model-1', { displayName: 'Updated' });
      expect(TenantModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'model-1' },
        { $set: { displayName: 'Updated' } },
        { new: true },
      );
    });
  });

  describe('findTenantModelConnections', () => {
    it('scopes by tenantId when provided in opts', async () => {
      const { TenantModel } = await import('@agent-platform/database/models');
      mockFindOne.mockResolvedValue(null);
      await findTenantModelConnections('model-1', { tenantId: 'tenant-A' });
      expect(TenantModel.findOne).toHaveBeenCalledWith(
        { _id: 'model-1', tenantId: 'tenant-A' },
        { connections: 1 },
      );
    });
  });

  describe('findTenantServiceInstance', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(findTenantServiceInstance('inst-1', '')).rejects.toThrow('tenantId is required');
    });

    it('scopes by tenantId', async () => {
      const { TenantServiceInstance } = await import('@agent-platform/database/models');
      await findTenantServiceInstance('inst-1', 'tenant-A');
      expect(TenantServiceInstance.findOne).toHaveBeenCalledWith({
        _id: 'inst-1',
        tenantId: 'tenant-A',
      });
    });
  });

  describe('deleteTenantServiceInstance', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(deleteTenantServiceInstance('inst-1', '')).rejects.toThrow(
        'tenantId is required',
      );
    });

    it('scopes delete by tenantId', async () => {
      const { TenantServiceInstance } = await import('@agent-platform/database/models');
      await deleteTenantServiceInstance('inst-1', 'tenant-A');
      expect(TenantServiceInstance.deleteOne).toHaveBeenCalledWith({
        _id: 'inst-1',
        tenantId: 'tenant-A',
      });
    });
  });
});
