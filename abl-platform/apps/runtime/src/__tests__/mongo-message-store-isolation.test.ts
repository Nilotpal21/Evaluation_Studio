/**
 * MongoMessageStore Tenant Isolation Tests
 *
 * Verifies that getMessages includes tenantId in the MongoDB filter
 * when provided in QueryMessagesParams.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFind = vi.fn();
const mockSort = vi.fn();
const mockSkip = vi.fn();
const mockLimit = vi.fn();
const mockLean = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Message: {
    find: vi.fn((..._args: unknown[]) => {
      mockFind(..._args);
      return { sort: mockSort };
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    create: vi.fn(),
    findOne: vi.fn(),
    collection: { updateMany: vi.fn() },
  },
  Session: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockResolvedValue({ limits: {} }),
    resolveProjectMessageRetention: vi.fn().mockResolvedValue(null),
  }),
  PLAN_LIMITS: { TEAM: { messageRetentionDays: 90 } },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { MongoMessageStore } from '../services/stores/mongo-message-store.js';

describe('MongoMessageStore tenant isolation', () => {
  let store: MongoMessageStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MongoMessageStore({ type: 'mongodb' });

    // Set up chain: find → sort → skip → limit → lean
    mockSort.mockReturnValue({ skip: mockSkip });
    mockSkip.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ lean: mockLean });
    mockLean.mockResolvedValue([]);
  });

  it('includes tenantId in filter when provided', async () => {
    await store.getMessages({ sessionId: 'sess-1', tenantId: 'tenant-A' });

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        tenantId: 'tenant-A',
      }),
    );
  });

  it('throws when tenantId is not provided', async () => {
    await expect(store.getMessages({ sessionId: 'sess-1' } as any)).rejects.toThrow(
      'tenantId is required',
    );
  });

  it('includes tenantId alongside role filter', async () => {
    await store.getMessages({
      sessionId: 'sess-1',
      tenantId: 'tenant-A',
      roles: ['user', 'assistant'],
    });

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        tenantId: 'tenant-A',
        role: { $in: ['user', 'assistant'] },
      }),
    );
  });
});
