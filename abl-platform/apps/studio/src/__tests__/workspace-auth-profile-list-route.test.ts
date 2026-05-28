import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockEnsureDb = vi.fn();
const mockAuthProfileFind = vi.fn();
const mockAuthProfileCountDocuments = vi.fn();

// Entity-based consumer count models
const mockTenantGuardrailProviderConfigAggregate = vi.fn();
const mockTenantServiceInstanceAggregate = vi.fn();
const mockConnectorConfigAggregate = vi.fn();
const mockArchWorkspaceConfigAggregate = vi.fn();
const mockTenantModelAggregate = vi.fn();

const mockLoggerError = vi.fn();
const mockLoggerDebug = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: vi.fn(),
  isAccessError: () => false,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: (...args: unknown[]) => mockAuthProfileFind(...args),
    countDocuments: (...args: unknown[]) => mockAuthProfileCountDocuments(...args),
  },
  TenantGuardrailProviderConfig: {
    aggregate: (...args: unknown[]) => mockTenantGuardrailProviderConfigAggregate(...args),
  },
  TenantServiceInstance: {
    aggregate: (...args: unknown[]) => mockTenantServiceInstanceAggregate(...args),
  },
  ConnectorConfig: {
    aggregate: (...args: unknown[]) => mockConnectorConfigAggregate(...args),
  },
  ArchWorkspaceConfig: {
    aggregate: (...args: unknown[]) => mockArchWorkspaceConfigAggregate(...args),
  },
  TenantModel: {
    aggregate: (...args: unknown[]) => mockTenantModelAggregate(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  }),
}));

vi.mock('@agent-platform/shared/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared/validation')>();
  return {
    ...actual,
    resolveAuthProfileUsageMode: (authType: string, usageMode?: string) =>
      usageMode || (authType.startsWith('oauth2') ? 'oauth2' : 'credential'),
  };
});

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  getAuthProfileMigrationState: (p: { authType: string; linkedAppProfileId?: string }) => {
    if (p.authType === 'oauth2_token') {
      return {
        status: 'legacy_read_only',
        message: 'These are migration records from older OAuth2 flows.',
        replacementAuthProfileId: p.linkedAppProfileId || null,
        replacementAuthType: 'oauth2_app',
      };
    }
    return null;
  },
}));

vi.mock('@agent-platform/shared/repos', () => ({
  withTransaction: vi.fn((fn: (session: null) => Promise<unknown>) => fn(null)),
}));

import { GET as WorkspaceListGET } from '@/app/api/auth-profiles/route';

describe('GET /api/auth-profiles (workspace list)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDb.mockResolvedValue(undefined);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:read'],
    });
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: 'profile-1',
              tenantId: 'tenant-1',
              projectId: null,
              scope: 'tenant',
              visibility: 'shared',
              authType: 'oauth2_app',
              status: 'active',
              encryptedSecrets: '{}',
            },
          ]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(1);

    // Default: all entity aggregations return empty
    mockTenantGuardrailProviderConfigAggregate.mockResolvedValue([]);
    mockTenantServiceInstanceAggregate.mockResolvedValue([]);
    mockConnectorConfigAggregate.mockResolvedValue([]);
    mockArchWorkspaceConfigAggregate.mockResolvedValue([]);
    mockTenantModelAggregate.mockResolvedValue([]);
  });

  it('applies entity-based consumer aggregation for workspace profiles', async () => {
    // Simulate 2 consumers from ConnectorConfig
    mockConnectorConfigAggregate.mockResolvedValue([{ _id: 'profile-1', count: 2 }]);

    const response = await WorkspaceListGET(
      new NextRequest('http://localhost:3000/api/auth-profiles'),
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data[0].linkedConsumerCount).toBe(2);

    // Entity models should be aggregated, not AuthProfile/EndUserOAuthToken
    expect(mockConnectorConfigAggregate).toHaveBeenCalledTimes(1);
    expect(mockTenantGuardrailProviderConfigAggregate).toHaveBeenCalledTimes(1);
    expect(mockTenantServiceInstanceAggregate).toHaveBeenCalledTimes(1);
    expect(mockArchWorkspaceConfigAggregate).toHaveBeenCalledTimes(1);
    expect(mockTenantModelAggregate).toHaveBeenCalledTimes(1);
  });

  it('fails open when consumer aggregation throws', async () => {
    mockConnectorConfigAggregate.mockRejectedValueOnce(new Error('aggregate exploded'));

    const response = await WorkspaceListGET(
      new NextRequest('http://localhost:3000/api/auth-profiles'),
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data[0].linkedConsumerCount).toBe(0);
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Consumer aggregation failed for workspace auth profile list',
      expect.objectContaining({
        tenantId: 'tenant-1',
        profileCount: 1,
        error: 'aggregate exploded',
      }),
    );
  });

  it('marks legacy oauth2_token workspace profiles as migration records', async () => {
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: 'profile-1',
              tenantId: 'tenant-1',
              projectId: null,
              scope: 'tenant',
              visibility: 'shared',
              authType: 'oauth2_token',
              status: 'active',
              linkedAppProfileId: 'app-1',
              encryptedSecrets: '{}',
            },
          ]),
        }),
      }),
    });

    const response = await WorkspaceListGET(
      new NextRequest('http://localhost:3000/api/auth-profiles'),
      {
        params: Promise.resolve({}),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].migration).toEqual({
      status: 'legacy_read_only',
      message: expect.stringContaining('migration records'),
      replacementAuthProfileId: 'app-1',
      replacementAuthType: 'oauth2_app',
    });
  });
});
