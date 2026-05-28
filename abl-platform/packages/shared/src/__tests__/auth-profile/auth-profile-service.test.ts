import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock fns are available when vi.mock's factory runs at module-init time
// (the validation schema imports AUTH_PROFILE_STATUSES from this module at top-level).
const { mockLinkedAppFindOne, mockEndUserOAuthTokenFindOne, mockEndUserOAuthTokenCountDocuments } =
  vi.hoisted(() => ({
    mockLinkedAppFindOne: vi.fn(),
    mockEndUserOAuthTokenFindOne: vi.fn(),
    mockEndUserOAuthTokenCountDocuments: vi.fn(),
  }));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockLinkedAppFindOne },
  EndUserOAuthToken: {
    findOne: mockEndUserOAuthTokenFindOne,
    countDocuments: mockEndUserOAuthTokenCountDocuments,
  },
  // ABLP-619: schema layer reads AUTH_PROFILE_STATUSES from the model as a single source of truth.
  // Keep this in sync with packages/database/src/models/auth-profile.model.ts AUTH_PROFILE_STATUSES.
  AUTH_PROFILE_STATUSES: [
    'active',
    'expired',
    'revoked',
    'invalid',
    'pending_authorization',
  ] as const,
}));

import { AuthProfileService } from '../../services/auth-profile.service.js';

// ── Mock AuthProfile model ────────────────────────────────────────

const mockAuthProfileModel = {
  create: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOneAndDelete: vi.fn(),
  countDocuments: vi.fn(),
};

// ── Mock Redis client ─────────────────────────────────────────────

const mockRedis = {
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
};

const service = new AuthProfileService({
  model: mockAuthProfileModel as any,
  redis: mockRedis as any,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEndUserOAuthTokenFindOne.mockResolvedValue(null);
  mockEndUserOAuthTokenCountDocuments.mockResolvedValue(0);
});

describe('AuthProfileService.create', () => {
  const validInput = {
    name: 'Gmail API Key',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project' as const,
    visibility: 'shared' as const,
    createdBy: 'user-1',
    authType: 'api_key' as const,
    config: { headerName: 'X-Api-Key', placement: 'header' },
    secrets: { apiKey: 'sk-123' },
  };

  it('passes JSON-stringified secrets as encryptedSecrets (plugin encrypts on save)', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1', ...validInput });
    await service.create(validInput);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.encryptedSecrets).toBe(JSON.stringify(validInput.secrets));
    expect(createArg).not.toHaveProperty('secrets');
  });

  it('sets default status to active', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1', ...validInput });
    await service.create(validInput);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.status).toBe('active');
  });

  it('accepts signing addon and passes to model', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    const signing = { algorithm: 'hmac-sha256', signedComponents: ['body'] };
    await service.create({
      ...validInput,
      signing,
      secrets: { ...validInput.secrets, signingSecret: 'sign-key' },
    } as any);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.signing).toEqual(signing);
  });

  it('accepts webhookVerification addon and passes to model', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    const wh = { method: 'hmac-sha256', signatureHeader: 'X-Sig' };
    await service.create({
      ...validInput,
      webhookVerification: wh,
      secrets: { ...validInput.secrets, webhookSecret: 'wh-secret' },
    } as any);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.webhookVerification).toEqual(wh);
  });

  it('rejects invalid addon combination (aws_iam + signing)', async () => {
    const signing = { algorithm: 'hmac-sha256', signedComponents: ['body'] };
    await expect(
      service.create({
        ...validInput,
        authType: 'aws_iam',
        signing,
        secrets: { ...validInput.secrets, signingSecret: 'key' },
      } as any),
    ).rejects.toThrow(/aws_iam.*signing/i);
  });

  it('rejects missing addon secrets (signing without signingSecret)', async () => {
    const signing = { algorithm: 'hmac-sha256', signedComponents: ['body'] };
    await expect(service.create({ ...validInput, signing } as any)).rejects.toThrow(
      /signingSecret/,
    );
  });

  it('accepts proxy addon and passes to model', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    const proxy = { url: 'https://proxy.corp.com:8080' };
    await service.create({ ...validInput, proxy } as any);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.proxy).toEqual(proxy);
  });

  it('still rejects rotationPolicy (deferred to Phase 3)', async () => {
    await expect(
      service.create({ ...validInput, rotationPolicy: { interval: 90 } } as any),
    ).rejects.toThrow(/rotation/i);
  });

  it('sets createdBy from input (route layer enforces auth context)', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    await service.create(validInput);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.createdBy).toBe('user-1');
  });

  it('stores environment as explicit null when not provided', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    await service.create({ ...validInput, environment: undefined });
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.environment).toBeNull();
  });

  it('rejects oauth2_token creation because legacy token profiles are read-only', async () => {
    await expect(
      service.create({
        ...validInput,
        authType: 'oauth2_token',
        config: { provider: 'github', tokenType: 'bearer' },
        secrets: { accessToken: 'token-1' },
        linkedAppProfileId: 'app-1',
      }),
    ).rejects.toThrow(/legacy migration records/i);
    expect(mockAuthProfileModel.create).not.toHaveBeenCalled();
    expect(mockLinkedAppFindOne).not.toHaveBeenCalled();
  });

  it('rejects incompatible usageMode values on create', async () => {
    await expect(
      service.create({
        ...validInput,
        usageMode: 'preflight' as const,
      }),
    ).rejects.toThrow(/usageMode/i);
  });

  it('rejects linkedAppProfileId for non-oauth2_token profiles', async () => {
    await expect(service.create({ ...validInput, linkedAppProfileId: 'app-1' })).rejects.toThrow(
      /only valid for oauth2_token/i,
    );
  });

  it('rejects oauth2_token profiles without linkedAppProfileId', async () => {
    await expect(
      service.create({
        ...validInput,
        authType: 'oauth2_token',
        config: { provider: 'github' },
        secrets: { accessToken: 'token-1' },
      }),
    ).rejects.toThrow(/legacy migration records/i);
  });

  it('normalizes oauth2_app legacy scopes to defaultScopes on create', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });

    await service.create({
      ...validInput,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['openid', 'email'],
      },
      secrets: { clientId: 'client-id', clientSecret: 'client-secret' },
    });

    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.config).toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['openid', 'email'],
    });
  });

  it('passes through connector, category, and tags', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1' });
    await service.create({
      ...validInput,
      connector: 'gmail',
      category: 'email',
      tags: ['production'],
    });
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.connector).toBe('gmail');
    expect(createArg.category).toBe('email');
    expect(createArg.tags).toEqual(['production']);
  });
});

describe('AuthProfileService.update', () => {
  it('uses findOne + save (not findOneAndUpdate) to trigger encryption plugin', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key', placement: 'header' },
      encryptedSecrets: JSON.stringify({ apiKey: 'old-key' }),
      save: vi.fn().mockResolvedValue(undefined),
      toObject: vi.fn().mockReturnValue({ _id: 'ap-1' }),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: { secrets: { apiKey: 'new-key' } },
    });

    expect(mockDoc.encryptedSecrets).toBe(JSON.stringify({ apiKey: 'new-key' }));
    expect(mockDoc.save).toHaveBeenCalled();
  });

  it('returns 404 when profile not found', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);
    await expect(
      service.update({
        id: 'nonexistent',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: { name: 'New' },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('updates name and description fields', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'Old Name',
      description: 'Old desc',
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: { name: 'New Name', description: 'New desc' },
    });

    expect(mockDoc.name).toBe('New Name');
    expect(mockDoc.description).toBe('New desc');
    expect(mockDoc.save).toHaveBeenCalled();
  });

  it('rejects oauth2_token updates because legacy token profiles are read-only', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      createdBy: 'user-1',
      config: { provider: 'github', tokenType: 'bearer' },
      encryptedSecrets: JSON.stringify({ accessToken: 'token-1' }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await expect(
      service.update({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: { name: 'Updated name' },
      }),
    ).rejects.toThrow(/legacy migration records/i);
    expect(mockDoc.save).not.toHaveBeenCalled();
  });

  it('merges partial config updates without touching stored secrets', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'api_key',
      config: { headerName: 'X-Old', placement: 'header' },
      encryptedSecrets: JSON.stringify({ apiKey: 'existing-key' }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: { config: { placement: 'query' } },
    });

    expect(mockDoc.config).toEqual({ headerName: 'X-Old', placement: 'query' });
    expect(mockDoc.encryptedSecrets).toBe(JSON.stringify({ apiKey: 'existing-key' }));
  });

  it('normalizes oauth2_app legacy scopes to defaultScopes on update', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['openid'],
      },
      encryptedSecrets: JSON.stringify({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: {
        config: { scopes: ['openid', 'email'] },
      },
    });

    expect(mockDoc.config).toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['openid', 'email'],
    });
  });

  it('merges partial secret updates with existing values', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
      },
      encryptedSecrets: JSON.stringify({
        clientId: 'existing-client-id',
        clientSecret: 'keep-me',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: {
        secrets: { clientSecret: 'rotated-secret' },
      },
    });

    expect(JSON.parse(mockDoc.encryptedSecrets)).toEqual({
      clientId: 'existing-client-id',
      clientSecret: 'rotated-secret',
    });
  });

  it('queries with $or to match both project-level and tenant-level profiles', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await service
      .update({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: { name: 'Test' },
      })
      .catch(() => {});

    const query = mockAuthProfileModel.findOne.mock.calls[0][0];
    expect(query._id).toBe('ap-1');
    expect(query.tenantId).toBe('tenant-1');
    expect(query.$or).toEqual([{ projectId: null }, { projectId: 'proj-1' }]);
  });

  it('rejects updates that leave advanced auth secrets structurally invalid', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'kerberos',
      config: {
        realm: 'EXAMPLE.COM',
        kdc: 'kdc.example.com',
        servicePrincipal: 'HTTP/api.example.com',
      },
      encryptedSecrets: JSON.stringify({
        principal: 'svc@EXAMPLE.COM',
        password: 'secret',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await expect(
      service.update({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: {
          secrets: {
            password: '',
          },
        },
      }),
    ).rejects.toThrow(/secrets\.password/i);
    expect(mockDoc.save).not.toHaveBeenCalled();
  });

  it('rejects incompatible usageMode values on update', async () => {
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key', placement: 'header' },
      encryptedSecrets: JSON.stringify({ apiKey: 'old-key' }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await expect(
      service.update({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: { usageMode: 'preflight' as const },
      }),
    ).rejects.toThrow(/usageMode/i);
  });
});

describe('AuthProfileService.delete', () => {
  it('blocks deletion if consumers exist', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
    });
    mockAuthProfileModel.countDocuments.mockResolvedValue(3);
    mockEndUserOAuthTokenCountDocuments.mockResolvedValue(0);

    await expect(
      service.delete({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    ).rejects.toThrow(/active connections/i);
  });

  it('deletes when no consumers reference the profile', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
    });
    mockAuthProfileModel.countDocuments.mockResolvedValue(0);
    mockEndUserOAuthTokenCountDocuments.mockResolvedValue(0);
    mockAuthProfileModel.findOneAndDelete.mockResolvedValue({ _id: 'ap-1' });

    const result = await service.delete({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(result).toBeDefined();
  });

  it('returns 404 for cross-tenant attempt', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(
      service.delete({
        id: 'ap-1',
        tenantId: 'other-tenant',
        projectId: 'proj-1',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('skips consumer check for non-oauth2_app types', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'bearer',
    });
    mockAuthProfileModel.findOneAndDelete.mockResolvedValue({ _id: 'ap-1' });

    await service.delete({ id: 'ap-1', tenantId: 'tenant-1', projectId: 'proj-1' });

    expect(mockAuthProfileModel.countDocuments).not.toHaveBeenCalled();
    expect(mockEndUserOAuthTokenCountDocuments).not.toHaveBeenCalled();
    expect(mockAuthProfileModel.findOneAndDelete).toHaveBeenCalled();
  });

  it('uses findOneAndDelete with tenant isolation', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
    });
    mockAuthProfileModel.findOneAndDelete.mockResolvedValue({ _id: 'ap-1' });

    await service.delete({ id: 'ap-1', tenantId: 'tenant-1', projectId: 'proj-1' });

    const deleteQuery = mockAuthProfileModel.findOneAndDelete.mock.calls[0][0];
    expect(deleteQuery._id).toBe('ap-1');
    expect(deleteQuery.tenantId).toBe('tenant-1');
    expect(deleteQuery.$or).toEqual([{ projectId: null }, { projectId: 'proj-1' }]);
  });
});

describe('AuthProfileService.resolve', () => {
  it('resolves a shared connector via a durable oauth grant backed by oauth2_app', async () => {
    mockAuthProfileModel.findOne.mockResolvedValueOnce({
      _id: 'app-shared',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      projectId: 'proj-1',
      visibility: 'shared',
      config: {
        authorizationUrl: 'https://accounts.example.com/auth',
        tokenUrl: 'https://accounts.example.com/token',
      },
      encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce({
      encryptedAccessToken: 'durable-access-token',
      encryptedRefreshToken: 'durable-refresh-token',
      scope: 'read write',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      environment: 'production',
    });

    expect(result).toEqual({
      profileId: 'app-shared',
      authType: 'oauth2_token',
      config: {
        provider: 'auth-profile:app-shared',
        tokenType: 'bearer',
        grantedScopes: ['read', 'write'],
        expiresAt: expect.any(String),
      },
      secrets: {
        accessToken: 'durable-access-token',
        refreshToken: 'durable-refresh-token',
      },
    });
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: '__tenant__',
        provider: 'auth-profile:app-shared',
        revokedAt: null,
      },
      {
        encryptedAccessToken: 1,
        encryptedRefreshToken: 1,
        scope: 1,
        expiresAt: 1,
      },
    );
  });

  it('resolves a per-user connector via a durable oauth grant on a shared oauth2_app', async () => {
    mockAuthProfileModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'app-user-shared',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      projectId: 'proj-1',
      visibility: 'shared',
      config: {
        authorizationUrl: 'https://accounts.example.com/auth',
        tokenUrl: 'https://accounts.example.com/token',
      },
      encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce({
      encryptedAccessToken: 'user-durable-token',
      scope: 'openid email',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'per_user',
      userId: 'user-1',
      environment: 'production',
    });

    expect(result.profileId).toBe('app-user-shared');
    expect(result.authType).toBe('oauth2_token');
    expect(result.secrets).toEqual({ accessToken: 'user-durable-token' });
    expect(result.config).toMatchObject({
      provider: 'auth-profile:app-user-shared',
      tokenType: 'bearer',
      grantedScopes: ['openid', 'email'],
    });
    expect(mockAuthProfileModel.findOne.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      visibility: 'personal',
      createdBy: 'user-1',
      environment: 'production',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[1][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      visibility: 'shared',
      environment: 'production',
    });
  });

  it('ignores legacy oauth2_token profiles when no durable oauth grant exists', async () => {
    mockAuthProfileModel.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (
        filter.authType === 'oauth2_app' &&
        filter.projectId === 'proj-1' &&
        filter.environment === 'production'
      ) {
        return {
          _id: 'app-no-grant',
          tenantId: 'tenant-1',
          authType: 'oauth2_app',
          projectId: 'proj-1',
          visibility: 'shared',
          config: {
            authorizationUrl: 'https://accounts.example.com/auth',
            tokenUrl: 'https://accounts.example.com/token',
          },
          encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
        };
      }

      if (
        typeof filter.authType === 'object' &&
        Array.isArray((filter.authType as { $nin?: string[] }).$nin) &&
        (filter.authType as { $nin?: string[] }).$nin?.includes('oauth2_token')
      ) {
        return {
          _id: 'api-key-fallback',
          tenantId: 'tenant-1',
          authType: 'api_key',
          projectId: 'proj-1',
          visibility: 'shared',
          config: { headerName: 'X-Api-Key', placement: 'header' },
          encryptedSecrets: JSON.stringify({ apiKey: 'fallback-key' }),
        };
      }

      return null;
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce(null);

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      environment: 'production',
    });

    expect(result.profileId).toBe('api-key-fallback');
    expect(result.authType).toBe('api_key');
    expect(result.secrets).toEqual({ apiKey: 'fallback-key' });
    for (const [query] of mockAuthProfileModel.findOne.mock.calls) {
      expect(query.authType).not.toBe('oauth2_token');
    }
  });

  it('falls back to non-oauth profiles when oauth2_app has no durable grant', async () => {
    mockAuthProfileModel.findOne
      .mockResolvedValueOnce({
        _id: 'app-no-grant',
        tenantId: 'tenant-1',
        authType: 'oauth2_app',
        projectId: 'proj-1',
        visibility: 'shared',
        config: {
          authorizationUrl: 'https://accounts.example.com/auth',
          tokenUrl: 'https://accounts.example.com/token',
        },
        encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
      })
      .mockResolvedValueOnce({
        _id: 'api-key-fallback',
        tenantId: 'tenant-1',
        authType: 'api_key',
        projectId: 'proj-1',
        visibility: 'shared',
        config: { headerName: 'X-Api-Key', placement: 'header' },
        encryptedSecrets: JSON.stringify({ apiKey: 'fallback-key' }),
      });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce(null);

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      environment: 'production',
    });

    expect(result.profileId).toBe('api-key-fallback');
    expect(result.authType).toBe('api_key');
    expect(result.secrets).toEqual({ apiKey: 'fallback-key' });
    expect(mockAuthProfileModel.findOne.mock.calls[1][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: { $nin: ['oauth2_app', 'oauth2_token'] },
      environment: 'production',
      visibility: 'shared',
    });
  });

  it('skips expired durable grants and continues to fallback credentials', async () => {
    mockAuthProfileModel.findOne
      .mockResolvedValueOnce({
        _id: 'app-expired-grant',
        tenantId: 'tenant-1',
        authType: 'oauth2_app',
        projectId: 'proj-1',
        visibility: 'shared',
        config: {
          authorizationUrl: 'https://accounts.example.com/auth',
          tokenUrl: 'https://accounts.example.com/token',
        },
        encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
      })
      .mockResolvedValueOnce({
        _id: 'api-key-fallback',
        tenantId: 'tenant-1',
        authType: 'api_key',
        projectId: 'proj-1',
        visibility: 'shared',
        config: { headerName: 'X-Api-Key', placement: 'header' },
        encryptedSecrets: JSON.stringify({ apiKey: 'fallback-key' }),
      });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce({
      encryptedAccessToken: 'expired-grant-token',
      scope: 'read',
      expiresAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      environment: 'production',
    });

    expect(result.profileId).toBe('api-key-fallback');
    expect(result.authType).toBe('api_key');
    expect(result.secrets).toEqual({ apiKey: 'fallback-key' });
  });

  it('returns extracted credentials for matching profile', async () => {
    const matchedProfile = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      visibility: 'shared',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key' },
      encryptedSecrets: JSON.stringify({ apiKey: 'sk-123' }),
    };
    mockAuthProfileModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(matchedProfile);

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
    });

    expect(result).toBeDefined();
    expect(result.secrets).toEqual({ apiKey: 'sk-123' });
  });

  it('evaluates shared resolution candidates in explicit priority order', async () => {
    mockAuthProfileModel.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        environment: 'production',
      })
      .catch(() => {});

    expect(mockAuthProfileModel.findOne).toHaveBeenCalledTimes(8);
    expect(mockAuthProfileModel.findOne.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      visibility: 'shared',
      environment: 'production',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[1][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: { $nin: ['oauth2_app', 'oauth2_token'] },
      environment: 'production',
      visibility: 'shared',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[2][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      environment: null,
      visibility: 'shared',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[7][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: null,
      connector: 'gmail',
      authType: { $nin: ['oauth2_app', 'oauth2_token'] },
      environment: null,
      visibility: 'shared',
    });
  });

  it('resolves directly when explicit authProfileId is provided', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-explicit',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      visibility: 'shared',
      authType: 'bearer',
      config: {},
      encryptedSecrets: JSON.stringify({ token: 'tok-123' }),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      authProfileId: 'ap-explicit',
    });

    expect(result.profileId).toBe('ap-explicit');
    expect(result.secrets).toEqual({ token: 'tok-123' });
  });

  it('resolves explicit oauth2_app authProfileId through the shared durable grant store', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-explicit-app',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      visibility: 'shared',
      projectId: 'proj-1',
      config: {
        authorizationUrl: 'https://accounts.example.com/auth',
        tokenUrl: 'https://accounts.example.com/token',
      },
      encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce({
      encryptedAccessToken: 'shared-explicit-token',
      encryptedRefreshToken: 'shared-refresh-token',
      scope: 'read write',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
      authProfileId: 'ap-explicit-app',
    });

    expect(result).toEqual({
      profileId: 'ap-explicit-app',
      authType: 'oauth2_token',
      config: {
        provider: 'auth-profile:ap-explicit-app',
        tokenType: 'bearer',
        grantedScopes: ['read', 'write'],
        expiresAt: expect.any(String),
      },
      secrets: {
        accessToken: 'shared-explicit-token',
        refreshToken: 'shared-refresh-token',
      },
    });
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: '__tenant__',
        provider: 'auth-profile:ap-explicit-app',
        revokedAt: null,
      },
      {
        encryptedAccessToken: 1,
        encryptedRefreshToken: 1,
        scope: 1,
        expiresAt: 1,
      },
    );
  });

  it('resolves explicit oauth2_app authProfileId through the per-user durable grant store', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-explicit-user-app',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      visibility: 'shared',
      projectId: 'proj-1',
      config: {
        authorizationUrl: 'https://accounts.example.com/auth',
        tokenUrl: 'https://accounts.example.com/token',
      },
      encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce({
      encryptedAccessToken: 'per-user-explicit-token',
      scope: 'openid email',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'per_user',
      authProfileId: 'ap-explicit-user-app',
      requestingUserId: 'user-1',
    });

    expect(result.profileId).toBe('ap-explicit-user-app');
    expect(result.authType).toBe('oauth2_token');
    expect(result.secrets).toEqual({ accessToken: 'per-user-explicit-token' });
    expect(result.config).toMatchObject({
      provider: 'auth-profile:ap-explicit-user-app',
      tokenType: 'bearer',
      grantedScopes: ['openid', 'email'],
    });
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'auth-profile:ap-explicit-user-app',
        revokedAt: null,
      },
      {
        encryptedAccessToken: 1,
        encryptedRefreshToken: 1,
        scope: 1,
        expiresAt: 1,
      },
    );
  });

  it('treats explicit oauth2_app authProfileId without a durable grant as inaccessible', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-explicit-app-missing-grant',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      visibility: 'shared',
      projectId: 'proj-1',
      config: {
        authorizationUrl: 'https://accounts.example.com/auth',
        tokenUrl: 'https://accounts.example.com/token',
      },
      encryptedSecrets: JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValueOnce(null);

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        authProfileId: 'ap-explicit-app-missing-grant',
      }),
    ).rejects.toThrow(/not accessible/i);
  });

  it('treats explicit oauth2_token profiles as inaccessible legacy records', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-explicit-token',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'proj-1',
      config: { provider: 'google' },
      encryptedSecrets: JSON.stringify({ accessToken: 'oauth-token-123' }),
    });

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        authProfileId: 'ap-explicit-token',
      }),
    ).rejects.toThrow(/not accessible/i);

    expect(mockLinkedAppFindOne).not.toHaveBeenCalled();
  });

  it('fails closed when per_user resolution is attempted without user context', async () => {
    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'per_user',
      }),
    ).rejects.toThrow(/requires user context/i);

    expect(mockAuthProfileModel.findOne).not.toHaveBeenCalled();
  });

  it('rejects explicit personal authProfileId when requesting user does not own it', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'per_user',
        authProfileId: 'ap-personal',
        requestingUserId: 'user-2',
      }),
    ).rejects.toThrow(/not accessible/i);

    expect(mockAuthProfileModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'ap-personal',
        tenantId: 'tenant-1',
        status: 'active',
      }),
    );
    expect(mockAuthProfileModel.findOne.mock.calls[0][0].$and).toContainEqual({
      $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: 'user-2' }],
    });
  });

  it('allows explicit personal authProfileId for the owning user', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-personal',
      tenantId: 'tenant-1',
      authType: 'bearer',
      config: {},
      encryptedSecrets: JSON.stringify({ token: 'tok-owner' }),
      visibility: 'personal',
      createdBy: 'user-1',
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'per_user',
      authProfileId: 'ap-personal',
      requestingUserId: 'user-1',
    });

    expect(result.profileId).toBe('ap-personal');
    expect(result.secrets).toEqual({ token: 'tok-owner' });
    expect(mockAuthProfileModel.findOne.mock.calls[0][0].$and).toContainEqual({
      $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: 'user-1' }],
    });
  });

  it('throws NotFound when explicit authProfileId not accessible', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        authProfileId: 'ap-wrong-tenant',
      }),
    ).rejects.toThrow(/not accessible/i);
  });

  it('throws NotFound when no profile matches at any level', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'nonexistent',
        connectionMode: 'shared',
      }),
    ).rejects.toThrow(/no auth profile found/i);
  });

  it('evaluates personal oauth2_app before shared and then non-oauth fallback for per_user mode', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'per_user',
        userId: 'user-1',
        environment: 'production',
      })
      .catch(() => {});

    expect(mockAuthProfileModel.findOne.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      visibility: 'personal',
      createdBy: 'user-1',
      environment: 'production',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[1][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: 'oauth2_app',
      visibility: 'shared',
      environment: 'production',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[2][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      authType: { $nin: ['oauth2_app', 'oauth2_token'] },
      environment: 'production',
      $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: 'user-1' }],
    });
  });

  it('never queries oauth2_token candidates during connector resolution', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
      })
      .catch(() => {});

    for (const [query] of mockAuthProfileModel.findOne.mock.calls) {
      expect(query.authType).not.toBe('oauth2_token');
    }
    expect(mockLinkedAppFindOne).not.toHaveBeenCalled();
  });

  it('never queries personal visibility during shared-mode resolution', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        environment: 'production',
      })
      .catch(() => {});

    for (const [call] of mockAuthProfileModel.findOne.mock.calls) {
      expect(call.visibility === 'personal' || call.createdBy).toBeFalsy();
    }
  });

  it('includes env-specific and null-env tenant fallback candidates', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        environment: 'production',
      })
      .catch(() => {});

    expect(mockAuthProfileModel.findOne.mock.calls[2][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      environment: null,
      authType: 'oauth2_app',
      visibility: 'shared',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[4][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: null,
      connector: 'gmail',
      environment: 'production',
      authType: 'oauth2_app',
      visibility: 'shared',
    });
    expect(mockAuthProfileModel.findOne.mock.calls[7][0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: null,
      connector: 'gmail',
      environment: null,
      authType: { $nin: ['oauth2_app', 'oauth2_token'] },
      visibility: 'shared',
    });
  });

  it('handles encryptedSecrets as object (non-string)', async () => {
    mockAuthProfileModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'ap-obj',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      visibility: 'shared',
      authType: 'api_key',
      config: {},
      encryptedSecrets: { apiKey: 'direct-object' },
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
    });

    expect(result.secrets).toEqual({ apiKey: 'direct-object' });
  });

  it('handles invalid JSON in encryptedSecrets gracefully', async () => {
    mockAuthProfileModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'ap-bad',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      visibility: 'shared',
      authType: 'api_key',
      config: {},
      encryptedSecrets: 'not-valid-json{',
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
    });

    expect(result.secrets).toEqual({ _raw: 'not-valid-json{' });
  });

  it('handles null/undefined encryptedSecrets', async () => {
    mockAuthProfileModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'ap-null',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      visibility: 'shared',
      authType: 'none',
      config: {},
      encryptedSecrets: null,
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'test',
      connectionMode: 'shared',
    });

    expect(result.secrets).toEqual({});
  });
});

describe('AuthProfileService.validateAccess', () => {
  it('returns profile when tenant matches and scope allows access', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: null, // tenant-level
    });

    const result = await service.validateAccess('ap-1', 'tenant-1', 'proj-1');
    expect(result).toBeDefined();
    expect(result._id).toBe('ap-1');
  });

  it('throws NotFound for cross-tenant access', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(service.validateAccess('ap-1', 'other-tenant', 'proj-1')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('AuthProfileService.getConsumerCount', () => {
  it('counts linked oauth2_token profiles and durable oauth grants for oauth2_app', async () => {
    mockAuthProfileModel.countDocuments.mockResolvedValue(5);
    mockEndUserOAuthTokenCountDocuments.mockResolvedValue(2);

    const count = await service.getConsumerCount('ap-1', 'tenant-1');
    expect(count).toBe(7);
    expect(mockAuthProfileModel.countDocuments).toHaveBeenCalledWith({
      linkedAppProfileId: 'ap-1',
      tenantId: 'tenant-1',
    });
    expect(mockEndUserOAuthTokenCountDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'auth-profile:ap-1',
      revokedAt: null,
    });
  });

  it('blocks oauth2_app deletion when durable oauth grants still exist', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-oauth-app',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
    });
    mockAuthProfileModel.countDocuments.mockResolvedValue(0);
    mockEndUserOAuthTokenCountDocuments.mockResolvedValue(1);

    await expect(
      service.delete({
        id: 'ap-oauth-app',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    ).rejects.toThrow(/active connections/i);
  });
});

// Task 7: Distributed lock contention tests
describe('AuthProfileService.refreshToken', () => {
  it('acquires Redis lock before rejecting legacy oauth2_token refresh', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'proj-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    await expect(service.refreshToken('ap-1', 'tenant-1')).rejects.toThrow(
      /legacy migration records/i,
    );

    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth-profile:op-lock:tenant-1:ap-1',
      '1',
      'NX',
      'PX',
      '30000',
    );
  });

  it('releases lock after rejecting legacy oauth2_token refresh', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'proj-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    await expect(service.refreshToken('ap-1', 'tenant-1')).rejects.toThrow(
      /legacy migration records/i,
    );

    expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:op-lock:tenant-1:ap-1');
  });

  it('still rejects legacy oauth2_token refresh when Redis is unavailable', async () => {
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'proj-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    await expect(service.refreshToken('ap-1', 'tenant-1')).rejects.toThrow(
      /legacy migration records/i,
    );
  });
});
