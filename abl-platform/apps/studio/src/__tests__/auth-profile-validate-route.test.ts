import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockEnsureDb = vi.fn();
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockEndUserOAuthTokenFindOne = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  EndUserOAuthToken: {
    findOne: (...args: unknown[]) => mockEndUserOAuthTokenFindOne(...args),
  },
}));

import { POST as ProjectValidatePOST } from '@/app/api/projects/[id]/auth-profiles/[profileId]/validate/route';
import { POST as WorkspaceValidatePOST } from '@/app/api/auth-profiles/[profileId]/validate/route';

function makeProjectRequest(): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/projects/proj-1/auth-profiles/profile-1/validate',
    {
      method: 'POST',
    },
  );
}

function makeWorkspaceRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth-profiles/profile-1/validate', {
    method: 'POST',
  });
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project',
    visibility: 'shared',
    createdBy: 'user-1',
    authType: 'none',
    status: 'active',
    encryptedSecrets: '{}',
    config: {},
    ...overrides,
  };
}

function makeQueryResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

describe('auth profile validate routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDb.mockResolvedValue(undefined);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });
    mockFindOne.mockResolvedValue(makeProfile());
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockEndUserOAuthTokenFindOne.mockReturnValue(makeQueryResult(null));
  });

  it('requires auth-profile:write for project validation', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:read'],
    });

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });

    expect(response.status).toBe(403);
  });

  it('preserves 404 isolation for non-owner personal profiles on project validation', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write', 'auth-profile:decrypt'],
    });
    mockFindOne.mockResolvedValue(
      makeProfile({
        visibility: 'personal',
        createdBy: 'other-user',
      }),
    );

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(JSON.stringify(payload).toLowerCase()).toContain('not found');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('writes lastValidatedAt only after successful project validation', async () => {
    mockFindOne.mockResolvedValue(makeProfile());

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'profile-1',
        tenantId: 'tenant-1',
        $or: [{ projectId: 'proj-1' }, { projectId: null, scope: 'tenant' }],
      },
      {
        $set: {
          lastValidatedAt: expect.any(Date),
        },
      },
    );
  });

  it('returns invalid for project kerberos profiles missing a password and keytab', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        authType: 'kerberos',
        config: {
          realm: 'EXAMPLE.COM',
          kdc: 'kdc.example.com',
          servicePrincipal: 'HTTP/api.example.com',
        },
        encryptedSecrets: JSON.stringify({
          principal: 'svc@EXAMPLE.COM',
        }),
      }),
    );

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.valid).toBe(false);
    expect(payload.data.message).toContain('Either password or keytab');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('returns invalid for project oauth2_app preconfigured profiles without OAuth grant', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        authType: 'oauth2_app',
        usageMode: 'preconfigured',
        connectionMode: 'shared',
        config: {
          authorizationUrl: 'https://accounts.example.com/oauth/authorize',
          tokenUrl: 'https://accounts.example.com/oauth/token',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'cid',
          clientSecret: 'csecret',
        }),
      }),
    );
    mockEndUserOAuthTokenFindOne
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(null),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(null),
      });

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.valid).toBe(false);
    expect(payload.data.validationType).toBe('oauth_grant');
    expect(payload.data.message).toContain('OAuth authorization is required');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('returns valid informational result for project oauth2_app jit profiles', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        authType: 'oauth2_app',
        usageMode: 'jit',
        connectionMode: 'per_user',
        config: {
          authorizationUrl: 'https://accounts.example.com/oauth/authorize',
          tokenUrl: 'https://accounts.example.com/oauth/token',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'cid',
          clientSecret: 'csecret',
        }),
      }),
    );

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.valid).toBe(true);
    expect(payload.data.validationType).toBe('configuration');
    expect(payload.data.requiresUserAuthorization).toBe(true);
    expect(payload.data.message).toContain('JIT mode');
    expect(mockEndUserOAuthTokenFindOne).not.toHaveBeenCalled();
  });

  it('rejects project validation for legacy oauth2_token migration records', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        authType: 'oauth2_token',
        linkedAppProfileId: 'app-1',
        config: { provider: 'github', tokenType: 'bearer' },
      }),
    );

    const response = await ProjectValidatePOST(makeProjectRequest(), {
      params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(payload)).toContain('migration records');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('preserves 404 isolation for non-owner personal workspace validation', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write', 'auth-profile:decrypt'],
    });
    mockFindOne.mockResolvedValue(
      makeProfile({
        projectId: null,
        scope: 'tenant',
        visibility: 'personal',
        createdBy: 'other-user',
      }),
    );

    const response = await WorkspaceValidatePOST(makeWorkspaceRequest(), {
      params: Promise.resolve({ profileId: 'profile-1' }),
    });

    expect(response.status).toBe(404);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('returns invalid for workspace custom_header profiles when config and secrets drift', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        projectId: null,
        scope: 'tenant',
        authType: 'custom_header',
        config: {
          headers: {
            Authorization: 'auth-header',
          },
        },
        encryptedSecrets: JSON.stringify({
          headerValues: {
            'X-Api-Key': 'secret-value',
          },
        }),
      }),
    );

    const response = await WorkspaceValidatePOST(makeWorkspaceRequest(), {
      params: Promise.resolve({ profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.valid).toBe(false);
    expect(payload.data.message).toContain('headerValues');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('returns invalid for workspace profiles with status=invalid', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        projectId: null,
        scope: 'tenant',
        status: 'invalid',
      }),
    );

    const response = await WorkspaceValidatePOST(makeWorkspaceRequest(), {
      params: Promise.resolve({ profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.valid).toBe(false);
    expect(payload.data.message).toContain('Profile is invalid');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects workspace validation for legacy oauth2_token migration records', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        projectId: null,
        scope: 'tenant',
        authType: 'oauth2_token',
        linkedAppProfileId: 'app-1',
        config: { provider: 'github', tokenType: 'bearer' },
      }),
    );

    const response = await WorkspaceValidatePOST(makeWorkspaceRequest(), {
      params: Promise.resolve({ profileId: 'profile-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(payload)).toContain('migration records');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
