/**
 * Channel Repo Tenant Isolation Tests
 *
 * Verifies that tenant-scoped repo queries include tenantId at query time.
 * These tests mock the database layer to inspect the filter objects passed
 * to Mongoose operations, ensuring isolation is enforced at the repo level
 * rather than post-query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindProjectByIdAndTenant = vi.fn();

// ── PublicApiKey mocks ────────────────────────────────────────────────────
const mockPublicApiKeyFindOneLean = vi.fn();
const mockPublicApiKeyFindOne = vi.fn((..._args: unknown[]) => ({
  lean: mockPublicApiKeyFindOneLean,
}));
const mockPublicApiKeyFindLean = vi.fn();
const mockPublicApiKeyFindSort = vi.fn((..._args: unknown[]) => ({
  lean: mockPublicApiKeyFindLean,
}));
const mockPublicApiKeyFind = vi.fn((..._args: unknown[]) => ({
  lean: mockPublicApiKeyFindLean,
  sort: mockPublicApiKeyFindSort,
}));
const mockPublicApiKeyFindOneAndUpdateLean = vi.fn();
const mockPublicApiKeyFindOneAndUpdate = vi.fn((..._args: unknown[]) => ({
  lean: mockPublicApiKeyFindOneAndUpdateLean,
}));
const mockPublicApiKeyCreate = vi.fn();

// ── SDKChannel mocks ─────────────────────────────────────────────────────
const mockSdkChannelUpdateMany = vi.fn();
const mockSdkChannelFindLean = vi.fn();
const mockSdkChannelFindSort = vi.fn((..._args: unknown[]) => ({
  lean: mockSdkChannelFindLean,
}));
const mockSdkChannelFind = vi.fn((..._args: unknown[]) => ({
  sort: mockSdkChannelFindSort,
}));
const mockSdkChannelFindOneLean = vi.fn();
const mockSdkChannelFindOne = vi.fn((..._args: unknown[]) => ({
  lean: mockSdkChannelFindOneLean,
}));
const mockSdkChannelDeleteOne = vi.fn();
const mockSdkChannelCreate = vi.fn();

// ── WidgetConfig mocks ──────────────────────────────────────────────────
const mockWidgetConfigFindOneLean = vi.fn();
const mockWidgetConfigFindOne = vi.fn((..._args: unknown[]) => ({
  lean: mockWidgetConfigFindOneLean,
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: (...args: unknown[]) => mockFindProjectByIdAndTenant(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  PublicApiKey: {
    findOne: (...args: unknown[]) => mockPublicApiKeyFindOne(...args),
    find: (...args: unknown[]) => mockPublicApiKeyFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockPublicApiKeyFindOneAndUpdate(...args),
    create: (...args: unknown[]) => mockPublicApiKeyCreate(...args),
  },
  SDKChannel: {
    updateMany: (...args: unknown[]) => mockSdkChannelUpdateMany(...args),
    find: (...args: unknown[]) => mockSdkChannelFind(...args),
    findOne: (...args: unknown[]) => mockSdkChannelFindOne(...args),
    deleteOne: (...args: unknown[]) => mockSdkChannelDeleteOne(...args),
    create: (...args: unknown[]) => mockSdkChannelCreate(...args),
  },
  WidgetConfig: {
    findOne: (...args: unknown[]) => mockWidgetConfigFindOne(...args),
  },
  Project: {
    findOne: (...args: unknown[]) => ({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

import {
  bulkUpdateChannelDeployment,
  createPublicApiKey,
  createSDKChannel,
  deleteSDKChannel,
  findPublicApiKey,
  findPublicApiKeys,
  findPublicApiKeysByIds,
  findSDKChannelById,
  findSDKChannels,
  findWidgetConfig,
  getOrCreateDefaultPublicApiKey,
  updatePublicApiKey,
} from '../repos/channel-repo.js';

describe('channel-repo tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublicApiKeyFindOneLean.mockResolvedValue(null);
    mockPublicApiKeyFindLean.mockResolvedValue([]);
    mockPublicApiKeyFindOneAndUpdateLean.mockResolvedValue(null);
    mockSdkChannelUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockSdkChannelFindLean.mockResolvedValue([]);
    mockSdkChannelFindOneLean.mockResolvedValue(null);
    mockSdkChannelDeleteOne.mockResolvedValue({ deletedCount: 0 });
    mockWidgetConfigFindOneLean.mockResolvedValue(null);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PublicApiKey isolation
  // ═══════════════════════════════════════════════════════════════════════

  it('scopes findPublicApiKey by tenantId in the MongoDB filter', async () => {
    await findPublicApiKey({
      id: 'key-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });

    expect(mockPublicApiKeyFindOne).toHaveBeenCalledWith({
      _id: 'key-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
    expect(mockFindProjectByIdAndTenant).not.toHaveBeenCalled();
  });

  it('findPublicApiKey omits tenantId from filter when not provided', async () => {
    await findPublicApiKey({ id: 'key-1', projectId: 'proj-1' });

    expect(mockPublicApiKeyFindOne).toHaveBeenCalledWith({
      _id: 'key-1',
      projectId: 'proj-1',
    });
  });

  it('scopes findPublicApiKeys by tenantId in the MongoDB filter', async () => {
    await findPublicApiKeys({
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });

    expect(mockPublicApiKeyFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
  });

  it('findPublicApiKeys omits tenantId when not provided', async () => {
    await findPublicApiKeys({ projectId: 'proj-1' });

    expect(mockPublicApiKeyFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
    });
  });

  it('scopes legacy findPublicApiKeysByIds fallback to the requested tenant or legacy records', async () => {
    mockPublicApiKeyFindLean
      .mockResolvedValueOnce([
        {
          _id: 'key-1',
          projectId: 'proj-1',
          tenantId: 'tenant-A',
          isActive: true,
        },
      ])
      .mockResolvedValueOnce([]);

    await findPublicApiKeysByIds({
      ids: ['key-1', 'key-2'],
      tenantId: 'tenant-A',
    });

    expect(mockPublicApiKeyFind).toHaveBeenNthCalledWith(1, {
      _id: { $in: ['key-1', 'key-2'] },
      tenantId: 'tenant-A',
    });
    expect(mockPublicApiKeyFind).toHaveBeenNthCalledWith(2, {
      _id: { $in: ['key-2'] },
      $or: [{ tenantId: 'tenant-A' }, { tenantId: null }, { tenantId: { $exists: false } }],
    });
  });

  it('scopes updatePublicApiKey by tenantId in the MongoDB filter', async () => {
    await updatePublicApiKey('key-1', 'proj-1', { name: 'Updated' }, 'tenant-A');

    expect(mockPublicApiKeyFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'key-1', projectId: 'proj-1', tenantId: 'tenant-A' },
      { $set: { name: 'Updated' } },
      { new: true },
    );
  });

  it('updatePublicApiKey omits tenantId when not provided', async () => {
    await updatePublicApiKey('key-1', 'proj-1', { name: 'Updated' });

    expect(mockPublicApiKeyFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'key-1', projectId: 'proj-1' },
      { $set: { name: 'Updated' } },
      { new: true },
    );
  });

  it('scopes updatePublicApiKey legacy fallback writes to the requested tenant or legacy records', async () => {
    mockPublicApiKeyFindOneAndUpdateLean.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'key-1',
      projectId: 'proj-1',
      tenantId: null,
      name: 'Updated',
    });

    await updatePublicApiKey('key-1', 'proj-1', { name: 'Updated' }, 'tenant-A');

    expect(mockPublicApiKeyFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: 'key-1', projectId: 'proj-1', tenantId: 'tenant-A' },
      { $set: { name: 'Updated' } },
      { new: true },
    );
    expect(mockPublicApiKeyFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        _id: 'key-1',
        projectId: 'proj-1',
        $or: [{ tenantId: 'tenant-A' }, { tenantId: null }, { tenantId: { $exists: false } }],
      },
      { $set: { name: 'Updated' } },
      { new: true },
    );
  });

  it('createPublicApiKey validates project-tenant ownership before insert', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);

    await expect(
      createPublicApiKey({
        projectId: 'proj-1',
        tenantId: 'tenant-A',
        keyPrefix: 'pk_',
        keyHash: 'hash123',
        name: 'Test Key',
      }),
    ).rejects.toThrow('Project not found for tenant');

    expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-A');
    expect(mockPublicApiKeyCreate).not.toHaveBeenCalled();
  });

  it('getOrCreateDefaultPublicApiKey asserts project-tenant ownership', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);

    await expect(getOrCreateDefaultPublicApiKey('proj-1', 'tenant-A')).rejects.toThrow(
      'Project not found for tenant',
    );

    expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-A');
  });

  it('getOrCreateDefaultPublicApiKey queries with tenantId first', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-A' });
    mockPublicApiKeyFindOneLean.mockResolvedValue({
      _id: 'key-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
      isActive: true,
    });

    const result = await getOrCreateDefaultPublicApiKey('proj-1', 'tenant-A');

    // First call should include tenantId for precise scoping
    expect(mockPublicApiKeyFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-A',
      isActive: true,
    });
    expect(result.id).toBe('key-1');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SDKChannel isolation
  // ═══════════════════════════════════════════════════════════════════════

  it('scopes bulk deployment updates by tenantId', async () => {
    mockSdkChannelUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const updated = await bulkUpdateChannelDeployment('tenant-A', 'proj-1', 'production', 'dep-2');

    expect(updated).toBe(2);
    expect(mockSdkChannelUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        environment: 'production',
        followEnvironment: true,
        isActive: true,
      },
      { $set: { deploymentId: 'dep-2' } },
    );
  });

  it('scopes findSDKChannels by tenantId and projectId', async () => {
    await findSDKChannels({ projectId: 'proj-1', tenantId: 'tenant-A' });

    expect(mockSdkChannelFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
  });

  it('scopes findSDKChannelById by tenantId, projectId, and id', async () => {
    await findSDKChannelById('chan-1', 'proj-1', 'tenant-A');

    expect(mockSdkChannelFindOne).toHaveBeenCalledWith({
      _id: 'chan-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
  });

  it('scopes deleteSDKChannel by tenantId, projectId, and id', async () => {
    await deleteSDKChannel('chan-1', 'proj-1', 'tenant-A');

    expect(mockSdkChannelDeleteOne).toHaveBeenCalledWith({
      _id: 'chan-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
  });

  it('createSDKChannel validates project-tenant ownership before insert', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);

    await expect(
      createSDKChannel({
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        name: 'Test Channel',
        channelType: 'web',
        publicApiKeyId: 'key-1',
      }),
    ).rejects.toThrow('Project not found for tenant');

    expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-A');
    expect(mockSdkChannelCreate).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WidgetConfig isolation
  // ═══════════════════════════════════════════════════════════════════════

  it('scopes widget config lookup by tenantId', async () => {
    mockWidgetConfigFindOneLean.mockResolvedValue({
      _id: 'widget-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      mode: 'chat',
      position: 'bottom-right',
      voiceEnabled: false,
      chatEnabled: true,
    });

    const widget = await findWidgetConfig('proj-1', 'tenant-A');

    expect(mockWidgetConfigFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
    expect(widget).toMatchObject({
      id: 'widget-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });
  });

  it('findWidgetConfig returns null when tenantId does not match', async () => {
    mockWidgetConfigFindOneLean.mockResolvedValue(null);

    const widget = await findWidgetConfig('proj-1', 'tenant-B');

    expect(mockWidgetConfigFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-B',
    });
    expect(widget).toBeNull();
  });
});
