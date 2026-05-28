/**
 * MongoConversationStore Tenant Isolation Tests
 *
 * Verifies that all MongoConversationStore operations are scoped by tenant
 * via the withTenant() wrapper + Mongoose tenant-isolation plugin.
 *
 * The MongoConversationStore uses ALS-based tenant context (withTenantContext)
 * which triggers the Mongoose tenant-isolation plugin to inject tenantId into
 * all query filters. This test verifies:
 * 1. Operations fail without tenant context (fail-closed)
 * 2. Operations are scoped when tenant context is set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track calls to withTenantContext to verify it's being used
const mockWithTenantContext = vi.fn((ctx, fn) => fn());
const mockGetCurrentTenantId = vi.fn();

vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
}));

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  getCurrentTenantId: () => mockGetCurrentTenantId(),
}));

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    findOne: vi.fn((..._args: unknown[]) => ({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      lean: () => mockFindOne(..._args),
    })),
    findOneAndUpdate: vi.fn((..._args: unknown[]) => mockFindOneAndUpdate(..._args)),
    findOneAndDelete: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

import { MongoConversationStore } from '../services/stores/mongo-conversation-store.js';

describe('MongoConversationStore tenant isolation', () => {
  let store: MongoConversationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MongoConversationStore({ type: 'mongodb' });
  });

  describe('fail-closed behavior', () => {
    it('getSession throws when no tenant context is available', async () => {
      mockGetCurrentTenantId.mockReturnValue(undefined);

      await expect(store.getSession('sess-1')).rejects.toThrow('Tenant context required');
    });

    it('updateSession throws when no tenant context is available', async () => {
      mockGetCurrentTenantId.mockReturnValue(undefined);

      await expect(store.updateSession('sess-1', { status: 'ended' })).rejects.toThrow(
        'Tenant context required',
      );
    });

    it('endSession throws when no tenant context is available', async () => {
      mockGetCurrentTenantId.mockReturnValue(undefined);

      await expect(store.endSession('sess-1', 'completed')).rejects.toThrow(
        'Tenant context required',
      );
    });

    it('querySessions throws when no tenant context is available', async () => {
      mockGetCurrentTenantId.mockReturnValue(undefined);

      await expect(store.querySessions({})).rejects.toThrow('Tenant context required');
    });
  });

  describe('tenant context bridging', () => {
    it('getSession calls withTenantContext with correct tenantId', async () => {
      mockGetCurrentTenantId.mockReturnValue('tenant-A');
      mockFindOne.mockResolvedValue(null);

      await store.getSession('sess-1');

      expect(mockWithTenantContext).toHaveBeenCalledWith(
        { tenantId: 'tenant-A' },
        expect.any(Function),
      );
    });

    it('updateSession calls withTenantContext with correct tenantId', async () => {
      mockGetCurrentTenantId.mockReturnValue('tenant-A');
      // Pre-check findOne must return an existing session document
      mockFindOne.mockResolvedValue({
        _id: 'sess-1',
        tenantId: 'tenant-A',
        status: 'active',
        channel: 'web_chat',
        context: {},
        metadata: {},
        channelHistory: [],
      });
      mockFindOneAndUpdate.mockReturnValue({
        _id: 'sess-1',
        tenantId: 'tenant-A',
        status: 'ended',
        context: {},
        metadata: {},
        channelHistory: [],
      });

      await store.updateSession('sess-1', { status: 'ended' });

      expect(mockWithTenantContext).toHaveBeenCalledWith(
        { tenantId: 'tenant-A' },
        expect.any(Function),
      );
    });
  });
});
