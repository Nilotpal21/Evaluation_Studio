/**
 * Contact Store Tenant Isolation Tests
 *
 * Verifies that contact CRUD operations in routes/contacts.ts pass tenantId
 * to the store, preventing cross-tenant data access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database models
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Contact: {
    findOne: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findById: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findOneAndUpdate: vi.fn((..._args: unknown[]) => mockFindOneAndUpdate()),
  },
}));

import { MongoContactStore } from '../services/stores/mongo-contact-store.js';

describe('MongoContactStore tenant isolation', () => {
  let store: MongoContactStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MongoContactStore({ type: 'mongodb' });
  });

  describe('getById', () => {
    it('returns null when contact belongs to different tenant', async () => {
      // Contact exists for tenant-A, but we query with tenant-B
      mockFindOne.mockResolvedValue(null);
      const result = await store.getById('contact-1', 'tenant-B');
      expect(result).toBeNull();
    });

    it('returns contact when tenantId matches', async () => {
      mockFindOne.mockResolvedValue({
        _id: 'contact-1',
        tenantId: 'tenant-A',
        type: 'customer',
        metadata: {},
        tags: [],
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
      const result = await store.getById('contact-1', 'tenant-A');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('contact-1');
    });

    it('scopes query by tenantId when provided', async () => {
      const { Contact: ContactModel } = await import('@agent-platform/database/models');
      mockFindOne.mockResolvedValue(null);

      await store.getById('contact-1', 'tenant-A');

      expect(ContactModel.findOne).toHaveBeenCalledWith({ _id: 'contact-1', tenantId: 'tenant-A' });
    });
  });

  describe('update', () => {
    it('scopes update query by tenantId when provided', async () => {
      const { Contact: ContactModel } = await import('@agent-platform/database/models');
      mockFindOneAndUpdate.mockReturnValue({
        _id: 'contact-1',
        tenantId: 'tenant-A',
        type: 'customer',
        metadata: {},
        tags: [],
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });

      await store.update('contact-1', { displayName: 'Test' }, 'tenant-A');

      expect(ContactModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'contact-1', tenantId: 'tenant-A' },
        { $set: { displayName: 'Test' } },
        { new: true, lean: true },
      );
    });
  });

  describe('softDelete', () => {
    it('scopes delete query by tenantId when provided', async () => {
      const { Contact: ContactModel } = await import('@agent-platform/database/models');
      mockFindOneAndUpdate.mockResolvedValue(null);

      await store.softDelete('contact-1', 'tenant-A');

      expect(ContactModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'contact-1', tenantId: 'tenant-A' },
        expect.objectContaining({
          $set: expect.objectContaining({
            type: 'anonymous',
            deletedAt: expect.any(Date),
          }),
        }),
      );
    });
  });
});
