/**
 * Connection Resolver Tenant Isolation Tests
 *
 * Verifies that resolveConnectionById scopes the query by tenantId when provided.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockFindById = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    findOne: vi.fn((..._args: unknown[]) => ({
      lean: mockFindOne,
    })),
    findById: vi.fn((..._args: unknown[]) => ({
      lean: mockFindById,
    })),
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: () => false,
  getEncryptionService: () => ({}),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  resolveConnectionById,
  resolveConnectionByIdUnsafe,
} from '../channels/connection-resolver.js';

describe('resolveConnectionById tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tenantId does not match', async () => {
    // findOne returns null because the filter includes wrong tenantId
    mockFindOne.mockResolvedValue(null);

    const result = await resolveConnectionById('conn-1', 'tenant-B');
    expect(result).toBeNull();
  });

  it('returns connection when tenantId matches', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'conn-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      agentId: 'agent-1',
      channelType: 'web',
      externalIdentifier: 'ext-1',
      status: 'active',
    });

    const result = await resolveConnectionById('conn-1', 'tenant-A');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('conn-1');
    expect(result!.tenantId).toBe('tenant-A');
  });

  it('always scopes query by tenantId', async () => {
    const { ChannelConnection } = await import('@agent-platform/database/models');
    mockFindOne.mockResolvedValue(null);

    await resolveConnectionById('conn-1', 'tenant-A');

    expect(ChannelConnection.findOne).toHaveBeenCalledWith({
      _id: 'conn-1',
      tenantId: 'tenant-A',
    });
  });

  it('resolveConnectionByIdUnsafe does not scope by tenantId (bootstrap lookup)', async () => {
    const { ChannelConnection } = await import('@agent-platform/database/models');
    mockFindOne.mockResolvedValue(null);

    await resolveConnectionByIdUnsafe('conn-1');

    expect(ChannelConnection.findOne).toHaveBeenCalledWith({ _id: 'conn-1' });
  });
});
