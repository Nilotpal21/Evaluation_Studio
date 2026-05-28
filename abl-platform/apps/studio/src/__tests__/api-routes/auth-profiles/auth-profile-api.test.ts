/**
 * Auth Profile API Route E2E-Style Tests
 *
 * Tests the actual route handler business logic by importing the route modules
 * and mocking DB models and auth middleware.
 *
 * Covers:
 *   CREATE (POST): valid api_key, valid bearer, reject invalid authType, reject missing fields,
 *                  reject scope/projectId mismatch, verify encryptedSecrets NOT in response
 *   READ (GET):    get by ID, verify no encryptedSecrets in response, 404 for missing, 404 for cross-tenant
 *   LIST (GET):    list profiles, filter by authType, empty list returns []
 *   UPDATE (PUT):  update name, update config, reject empty body, 404 for missing
 *   DELETE:        delete successfully, 404 for missing, block delete of oauth2_app with linked tokens
 *   CROSS-TENANT:  create in tenant A, read/update/delete from tenant B -> 404
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — auth
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — project access
// ---------------------------------------------------------------------------

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks — database models (AuthProfile)
// ---------------------------------------------------------------------------

const mockAuthProfileFind = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockAuthProfileCreate = vi.fn();
const mockAuthProfileCountDocuments = vi.fn();
const mockAuthProfileFindOneAndDelete = vi.fn();
const mockAuthProfileAggregate = vi.fn();
const mockRelatedModelCountDocuments = vi.fn();
const mockRelatedModelAggregate = vi.fn();
const mockEndUserOAuthTokenCountDocuments = vi.fn();
const mockEndUserOAuthTokenAggregate = vi.fn();
const mockEndUserOAuthTokenDeleteMany = vi.fn();
const mockSDKChannelCountDocuments = vi.fn();
const mockAuditEventDeleteMany = vi.fn();
const mockProjectToolFind = vi.fn();

// For the save() path in PUT handler
const mockSave = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    find: mockAuthProfileFind,
    findOne: mockAuthProfileFindOne,
    create: mockAuthProfileCreate,
    countDocuments: mockAuthProfileCountDocuments,
    findOneAndDelete: mockAuthProfileFindOneAndDelete,
    aggregate: mockAuthProfileAggregate,
  },
  ChannelConnection: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  TenantModel: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  ConnectorConfig: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  ConnectorConnection: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  EndUserOAuthToken: {
    countDocuments: mockEndUserOAuthTokenCountDocuments,
    aggregate: mockEndUserOAuthTokenAggregate,
    deleteMany: mockEndUserOAuthTokenDeleteMany,
  },
  MCPServerConfig: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  ServiceNode: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  TenantGuardrailProviderConfig: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  GuardrailPolicy: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  GitIntegration: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  SDKChannel: {
    countDocuments: mockSDKChannelCountDocuments,
  },
  WebhookSubscription: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  WebhookSubscriptionConnector: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  ModelConfig: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  TenantServiceInstance: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  OrgProxyConfig: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  ArchWorkspaceConfig: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  TriggerRegistration: {
    countDocuments: mockRelatedModelCountDocuments,
    aggregate: mockRelatedModelAggregate,
  },
  ProjectSettings: {
    countDocuments: mockRelatedModelCountDocuments,
  },
  Workflow: {
    countDocuments: mockRelatedModelCountDocuments,
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
  },
  AuthProfileAuditEvent: {
    create: vi.fn().mockResolvedValue({}),
    deleteMany: mockAuditEventDeleteMany,
  },
  ProjectTool: {
    find: mockProjectToolFind,
  },
  AUTH_PROFILE_AUDIT_EVENT_TYPES: [
    'authorized',
    'authorize_failed',
    'token_refreshed',
    'token_refresh_failed',
    'profile_revoked',
    'tokens_revoked',
    'profile_updated',
    'sensitive_field_changed',
    'profile_deleted',
    'scope_insufficient_detected',
  ],
}));

// ---------------------------------------------------------------------------
// Mocks — SSRF validation
// ---------------------------------------------------------------------------

const mockValidateUrlForSSRF = vi.fn().mockReturnValue({ safe: true });

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: mockValidateUrlForSSRF,
}));

// ---------------------------------------------------------------------------
// Mocks — validation (use real schemas for body validation)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/validation', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/shared/validation')>(
    '@agent-platform/shared/validation',
  );
  return {
    ...actual,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';

function makeUser(tenantId = TENANT_A, perms: string[] = ['*:*'], id = USER_ID) {
  return {
    id,
    email: `${id}@test.com`,
    name: 'Test User',
    tenantId,
    role: 'editor',
    permissions: perms,
  };
}

function makeProject(tenantId = TENANT_A, projectId = PROJECT_ID) {
  return {
    id: projectId,
    name: 'Test Project',
    slug: 'test-project',
    ownerId: USER_ID,
    tenantId,
  };
}

type RouteCtx = { params: Promise<Record<string, string>> };

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
  const opts: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-jwt',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

/** Builds a valid api_key create body */
function apiKeyCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My API Key Profile',
    description: 'Test api key',
    projectId: PROJECT_ID,
    scope: 'project',
    visibility: 'shared',
    authType: 'api_key',
    config: { headerName: 'X-Api-Key', placement: 'header' },
    secrets: { apiKey: 'sk-test-key-12345' },
    ...overrides,
  };
}

/** Builds a valid bearer create body */
function bearerCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Bearer Profile',
    description: 'Test bearer token',
    projectId: PROJECT_ID,
    scope: 'project',
    visibility: 'shared',
    authType: 'bearer',
    config: {},
    secrets: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test' },
    ...overrides,
  };
}

/** Simulates a stored profile document from MongoDB */
function storedProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROFILE_ID,
    name: 'My API Key Profile',
    description: 'Test api key',
    tenantId: TENANT_A,
    projectId: PROJECT_ID,
    scope: 'project',
    visibility: 'shared',
    createdBy: USER_ID,
    authType: 'api_key',
    config: { headerName: 'X-Api-Key', placement: 'header' },
    encryptedSecrets: '{"apiKey":"encrypted-value"}',
    previousEncryptedSecrets: '{"apiKey":"old-encrypted"}',
    encryptionKeyVersion: 1,
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAuth.mockResolvedValue(makeUser());
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: makeProject() });
  mockIsAccessError.mockReturnValue(false);
  mockValidateUrlForSSRF.mockReturnValue({ safe: true });
  mockAuthProfileAggregate.mockResolvedValue([]);
  mockRelatedModelAggregate.mockResolvedValue([]);
  mockRelatedModelCountDocuments.mockResolvedValue(0);
  mockEndUserOAuthTokenCountDocuments.mockResolvedValue(0);
  mockEndUserOAuthTokenAggregate.mockResolvedValue([]);
  mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockSDKChannelCountDocuments.mockResolvedValue(0);
  mockAuditEventDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockProjectToolFind.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  });

  // Default: find returns empty, countDocuments returns 0
  // Route uses cursor-based pagination: .sort().limit().lean() (no .skip())
  mockAuthProfileFind.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  });
  mockAuthProfileCountDocuments.mockResolvedValue(0);
  mockAuthProfileFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
});

// ===========================================================================
// LIST — GET /api/projects/:id/auth-profiles
// ===========================================================================

describe('GET /api/projects/:id/auth-profiles (list)', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/route');
    handler = mod.GET;
  }, 60_000);

  it('returns paginated profile list', async () => {
    const profiles = [storedProfile(), storedProfile({ _id: 'profile-2', name: 'Second' })];
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(profiles),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(2);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({
      nextCursor: null,
      total: 2,
    });
  });

  it('redacts encryptedSecrets and previousEncryptedSecrets from list response', async () => {
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([storedProfile()]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(1);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data[0].encryptedSecrets).toBeUndefined();
    expect(body.data[0].previousEncryptedSecrets).toBeUndefined();
  });

  it('marks inherited tenant-level profiles', async () => {
    const tenantProfile = storedProfile({ projectId: null, scope: 'tenant' });
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([tenantProfile]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(1);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data[0].inherited).toBe(true);
  });

  it('includes migration metadata for legacy oauth2_token profiles', async () => {
    const legacyTokenProfile = storedProfile({
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-profile-1',
      config: { provider: 'github', tokenType: 'bearer' },
    });
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([legacyTokenProfile]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(1);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data[0].migration).toEqual({
      status: 'legacy_read_only',
      message: expect.stringContaining('migration records'),
      replacementAuthProfileId: 'app-profile-1',
      replacementAuthType: 'oauth2_app',
    });
  });

  it('passes authType filter to DB query', async () => {
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(0);

    const req = makeRequest('/api/projects/proj-1/auth-profiles?authType=bearer');
    await handler(req, routeCtx({ id: PROJECT_ID }));

    // The filter passed to AuthProfile.find should include authType
    const filterArg = mockAuthProfileFind.mock.calls[0][0];
    expect(filterArg.authType).toBe('bearer');
  });

  it('returns empty array for no matching profiles', async () => {
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(0);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ nextCursor: null, total: 0 });
  });

  it('skips all consumer-count aggregation on list (ABLP-1123: moved to on-demand endpoint)', async () => {
    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([storedProfile()]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(1);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));

    expect(res.status).toBe(200);
    expect(mockAuthProfileAggregate).not.toHaveBeenCalled();
    expect(mockEndUserOAuthTokenAggregate).not.toHaveBeenCalled();
    // ABLP-1123: consumer-count aggregation fully removed from the list route.
    // The UI no longer reads linkedConsumerCount; cross-collection aggregations
    // are available on-demand via /[profileId]/consumers instead.
    expect(mockRelatedModelAggregate).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// CREATE — POST /api/projects/:id/auth-profiles
// ===========================================================================

describe('POST /api/projects/:id/auth-profiles (create)', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/route');
    handler = mod.POST;
  }, 60_000);

  it('creates a valid api_key profile and returns 201', async () => {
    const created = storedProfile();
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', apiKeyCreateBody());
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('My API Key Profile');
    expect(body.data.id).toBe(PROFILE_ID);
  });

  it('creates a valid bearer profile and returns 201', async () => {
    const created = storedProfile({
      authType: 'bearer',
      name: 'My Bearer Profile',
      config: {},
    });
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', bearerCreateBody());
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('My Bearer Profile');
  });

  it('redacts encryptedSecrets from create response', async () => {
    const created = storedProfile();
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', apiKeyCreateBody());
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.encryptedSecrets).toBeUndefined();
    expect(body.data.previousEncryptedSecrets).toBeUndefined();
  });

  it('rejects missing required fields (no name)', async () => {
    const invalid = apiKeyCreateBody();
    delete (invalid as Record<string, unknown>).name;

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', invalid);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid authType', async () => {
    const invalid = apiKeyCreateBody({ authType: 'totally_bogus' });

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', invalid);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);
  });

  it('rejects scope/projectId mismatch — tenant scope with non-null projectId', async () => {
    const invalid = apiKeyCreateBody({
      scope: 'tenant',
      projectId: 'proj-1',
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', invalid);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('rejects scope/projectId mismatch — project scope with null projectId', async () => {
    const invalid = apiKeyCreateBody({
      scope: 'project',
      projectId: null,
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', invalid);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);
  });

  it('validates SSRF on oauth2_app URL fields', async () => {
    mockValidateUrlForSSRF.mockReturnValue({ safe: false, reason: 'private IP' });

    const oauthBody = {
      name: 'OAuth App',
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'http://169.254.169.254/latest/meta-data',
        tokenUrl: 'https://oauth.example.com/token',
      },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    };

    mockAuthProfileCreate.mockResolvedValue([
      {
        ...storedProfile({ authType: 'oauth2_app' }),
        toObject: () => storedProfile({ authType: 'oauth2_app' }),
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', oauthBody);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    const failureText = JSON.stringify(body);
    expect(failureText.includes('SSRF') || failureText.includes('must use HTTPS')).toBeTruthy();
  });

  it('normalizes oauth2_app legacy scopes to defaultScopes on create', async () => {
    const created = storedProfile({
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://oauth.example.com/auth',
        tokenUrl: 'https://oauth.example.com/token',
        defaultScopes: ['repo'],
      },
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
    });
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const oauthBody = {
      name: 'OAuth App',
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://oauth.example.com/auth',
        tokenUrl: 'https://oauth.example.com/token',
        refreshUrl: 'https://oauth.example.com/token',
        scopes: ['repo'],
      },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    };

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', oauthBody);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(201);

    expect(mockAuthProfileCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          config: {
            authorizationUrl: 'https://oauth.example.com/auth',
            tokenUrl: 'https://oauth.example.com/token',
            refreshUrl: 'https://oauth.example.com/token',
            defaultScopes: ['repo'],
          },
        }),
      ],
      expect.anything(),
    );
  });

  it('rejects manual oauth2_token create requests for project auth profiles', async () => {
    const createBody = {
      ...apiKeyCreateBody({
        authType: 'oauth2_token',
        config: { provider: 'oauth2' },
        secrets: { accessToken: 'token-1' },
      }),
      linkedAppProfileId: 'app-profile-1',
    };

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', createBody);
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('system-managed');
  });

  it('does not persist manual oauth2_token create requests for project auth profiles', async () => {
    const createBody = {
      ...apiKeyCreateBody({
        authType: 'oauth2_token',
        config: { provider: 'oauth2' },
        secrets: { accessToken: 'token-1' },
      }),
      linkedAppProfileId: 'app-profile-1',
    };

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', createBody);
    await handler(req, routeCtx({ id: PROJECT_ID }));

    expect(mockAuthProfileCreate).not.toHaveBeenCalled();
  });

  it('stores secrets as JSON string in encryptedSecrets field', async () => {
    const created = storedProfile();
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', apiKeyCreateBody());
    await handler(req, routeCtx({ id: PROJECT_ID }));

    expect(mockAuthProfileCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          encryptedSecrets: JSON.stringify({ apiKey: 'sk-test-key-12345' }),
        }),
      ],
      expect.anything(),
    );
  });

  it('sets projectId to null for tenant-scoped profiles', async () => {
    const tenantBody = apiKeyCreateBody({
      scope: 'tenant',
      projectId: null,
      visibility: 'shared',
    });
    const created = storedProfile({ projectId: null, scope: 'tenant' });
    mockAuthProfileCreate.mockResolvedValue([
      {
        ...created,
        toObject: () => created,
      },
    ]);

    const req = makeRequest('/api/projects/proj-1/auth-profiles', 'POST', tenantBody);
    await handler(req, routeCtx({ id: PROJECT_ID }));

    expect(mockAuthProfileCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          projectId: null,
          scope: 'tenant',
        }),
      ],
      expect.anything(),
    );
  });
});

// ===========================================================================
// GET by ID — GET /api/projects/:id/auth-profiles/:profileId
// ===========================================================================

describe('GET /api/projects/:id/auth-profiles/:profileId (detail)', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    handler = mod.GET;
  }, 60_000);

  it('returns profile by ID with secrets redacted', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(PROFILE_ID);
    expect(body.data.name).toBe('My API Key Profile');
    expect(body.data.encryptedSecrets).toBeUndefined();
    expect(body.data.previousEncryptedSecrets).toBeUndefined();
  });

  it('includes migration metadata for legacy oauth2_token detail responses', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(
        storedProfile({
          authType: 'oauth2_token',
          linkedAppProfileId: 'app-profile-1',
          config: { provider: 'github', tokenType: 'bearer' },
        }),
      ),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.migration).toEqual({
      status: 'legacy_read_only',
      message: expect.stringContaining('migration records'),
      replacementAuthProfileId: 'app-profile-1',
      replacementAuthType: 'oauth2_app',
    });
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/nonexistent');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 404 for cross-tenant access (tenant isolation)', async () => {
    // User is in tenant-b but profile belongs to tenant-a
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    // findOne with tenant-b tenantId will not find the profile (scoped query)
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('rejects delete of legacy oauth2_token migration records', async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    const deleteHandler = mod.DELETE;
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(
        storedProfile({
          authType: 'oauth2_token',
          linkedAppProfileId: 'app-profile-1',
          config: { provider: 'github', tokenType: 'bearer' },
        }),
      ),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await deleteHandler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('migration records');
    expect(mockAuthProfileFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('hides personal profiles from non-owners (unless admin)', async () => {
    const personalProfile = storedProfile({
      visibility: 'personal',
      createdBy: 'other-user',
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(personalProfile),
    });

    // User without decrypt permission
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_A, ['auth-profile:read'], 'user-1'));

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('allows admin to see personal profiles of other users', async () => {
    const personalProfile = storedProfile({
      visibility: 'personal',
      createdBy: 'other-user',
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(personalProfile),
    });

    // Admin user with decrypt permission
    mockRequireAuth.mockResolvedValue(
      makeUser(TENANT_A, ['auth-profile:read', 'auth-profile:decrypt'], 'admin-user'),
    );

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// UPDATE — PUT /api/projects/:id/auth-profiles/:profileId
// ===========================================================================

describe('PUT /api/projects/:id/auth-profiles/:profileId (update)', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    handler = mod.PUT;
  }, 60_000);

  it('updates profile name', async () => {
    const existing = storedProfile();
    // First findOne (lean) for SSRF check / existence
    mockAuthProfileFindOne
      .mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(existing),
      })
      // Second findOne (hydrated document) for save
      .mockResolvedValueOnce({
        ...existing,
        name: existing.name,
        config: existing.config,
        encryptedSecrets: existing.encryptedSecrets,
        save: mockSave.mockResolvedValue(undefined),
        toObject: () => ({
          ...existing,
          name: 'Updated Name',
        }),
      });

    mockSave.mockResolvedValue(undefined);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Updated Name',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.encryptedSecrets).toBeUndefined();
    expect(body.data.previousEncryptedSecrets).toBeUndefined();
  });

  it('updates profile config', async () => {
    const existing = storedProfile();
    mockAuthProfileFindOne
      .mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(existing),
      })
      .mockResolvedValueOnce({
        ...existing,
        config: existing.config,
        encryptedSecrets: existing.encryptedSecrets,
        save: mockSave.mockResolvedValue(undefined),
        toObject: () => ({
          ...existing,
          config: { headerName: 'X-Custom-Key', placement: 'query' },
        }),
      });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { headerName: 'X-Custom-Key', placement: 'query' },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);
  });

  it('merges partial config and secret updates with existing values', async () => {
    const existing = storedProfile({
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        defaultScopes: ['repo'],
        pkceRequired: true,
      },
      encryptedSecrets: JSON.stringify({
        clientId: 'existing-client-id',
        clientSecret: 'keep-me',
      }),
    });
    const doc = {
      ...existing,
      config: { ...(existing.config as Record<string, unknown>) },
      encryptedSecrets: existing.encryptedSecrets,
      save: mockSave.mockResolvedValue(undefined),
      toObject: () => ({
        ...existing,
        config: doc.config,
        encryptedSecrets: doc.encryptedSecrets,
      }),
    };

    mockAuthProfileFindOne
      .mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(existing),
      })
      .mockResolvedValueOnce(doc);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { defaultScopes: ['repo', 'user:email'] },
      secrets: { clientSecret: 'rotated-secret' },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);
    expect(doc.config).toEqual({
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      defaultScopes: ['repo', 'user:email'],
      pkceRequired: true,
    });
    expect(JSON.parse(doc.encryptedSecrets)).toEqual({
      clientId: 'existing-client-id',
      clientSecret: 'rotated-secret',
    });
  });

  it('rejects empty update body', async () => {
    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {});
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/nonexistent', 'PUT', {
      name: 'Updated',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-tenant update attempt', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    // findOne with wrong tenantId returns null
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Hacked!',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when updating another user's personal profile", async () => {
    const personalProfile = storedProfile({
      visibility: 'personal',
      createdBy: 'other-user',
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(personalProfile),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Not Allowed',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(404);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('performs SSRF validation on OAuth config URL updates', async () => {
    const existing = storedProfile({ authType: 'oauth2_app' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });
    mockValidateUrlForSSRF.mockReturnValue({ safe: false, reason: 'private IP' });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { tokenUrl: 'http://169.254.169.254/metadata' },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('SSRF');
  });

  it('performs SSRF validation on OAuth docs and setup guide URL updates', async () => {
    const existing = storedProfile({ authType: 'oauth2_app' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });
    mockValidateUrlForSSRF.mockReturnValue({ safe: false, reason: 'private IP' });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { docsUrl: 'http://169.254.169.254/docs', setupGuideUrl: 'http://10.0.0.5/guide' },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);
    expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('http://10.0.0.5/guide', {
      allowLocalhost: true,
      allowPrivateRanges: true,
    });

    const body = await res.json();
    expect(body.errors[0].msg).toContain('SSRF');
  });

  it('rejects invalid merged secrets for advanced auth methods', async () => {
    const existing = storedProfile({
      authType: 'kerberos',
      config: {
        realm: 'EXAMPLE.COM',
        kdc: 'kdc.example.com',
        servicePrincipal: 'HTTP/api.example.com',
      },
      encryptedSecrets: JSON.stringify({
        principal: 'svc@EXAMPLE.COM',
        password: 'existing-password',
      }),
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      secrets: { password: '' },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('secrets.password');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects custom_header updates when header config and secret keys diverge', async () => {
    const existing = storedProfile({
      authType: 'custom_header',
      config: { headers: { 'X-Key': 'header-name' } },
      encryptedSecrets: JSON.stringify({
        headerValues: { 'X-Key': 'secret-value' },
      }),
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { headers: { Authorization: 'auth-header' } },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('headerValues');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects manual oauth2_token edits for project auth profiles', async () => {
    const existing = storedProfile({
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      config: { provider: 'oauth2', tokenType: 'bearer' },
      encryptedSecrets: JSON.stringify({
        accessToken: 'token-1',
      }),
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Renamed token profile',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('migration records');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('normalizes oauth2_app legacy scopes to defaultScopes on update', async () => {
    const existing = storedProfile({
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://oauth.example.com/auth',
        tokenUrl: 'https://oauth.example.com/token',
        defaultScopes: ['openid'],
      },
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
    });
    const doc = {
      ...existing,
      config: { ...(existing.config as Record<string, unknown>) },
      encryptedSecrets: existing.encryptedSecrets,
      save: mockSave.mockResolvedValue(undefined),
      toObject: () => ({
        ...existing,
        config: doc.config,
        encryptedSecrets: doc.encryptedSecrets,
      }),
    };

    mockAuthProfileFindOne
      .mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(existing),
      })
      .mockResolvedValueOnce(doc);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { scopes: ['openid', 'email'] },
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);
    expect(doc.config).toEqual({
      authorizationUrl: 'https://oauth.example.com/auth',
      tokenUrl: 'https://oauth.example.com/token',
      defaultScopes: ['openid', 'email'],
    });
  });
});

// ===========================================================================
// DELETE — DELETE /api/projects/:id/auth-profiles/:profileId
// ===========================================================================

describe('DELETE /api/projects/:id/auth-profiles/:profileId', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    handler = mod.DELETE;
  }, 60_000);

  it('deletes profile successfully', async () => {
    // DELETE requires status='revoked' since ABLP-1123 (MUST_REVOKE_FIRST gate)
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile({ status: 'revoked' })),
    });
    mockAuthProfileFindOneAndDelete.mockResolvedValue(storedProfile({ status: 'revoked' }));

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(PROFILE_ID);
  });

  it('does not count SDKChannel as a delete blocker', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile({ status: 'revoked' })),
    });
    mockRelatedModelCountDocuments.mockResolvedValue(0);
    mockSDKChannelCountDocuments.mockResolvedValue(5);
    mockAuthProfileFindOneAndDelete.mockResolvedValue(storedProfile({ status: 'revoked' }));

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(200);
    expect(mockSDKChannelCountDocuments).not.toHaveBeenCalled();
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/nonexistent', 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('blocks delete of oauth2_app with active linked tokens (409)', async () => {
    const oauthApp = storedProfile({ authType: 'oauth2_app', status: 'revoked' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(oauthApp),
    });
    // 3 active tokens reference this app
    mockAuthProfileCountDocuments.mockResolvedValue(3);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.message).toContain('3 active linked tokens');
  });

  it('blocks delete of oauth2_app with active durable OAuth grants (409)', async () => {
    const oauthApp = storedProfile({ authType: 'oauth2_app', status: 'revoked' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(oauthApp),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(0);
    mockEndUserOAuthTokenCountDocuments.mockResolvedValue(2);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.message).toContain('2 active OAuth grants');
  });

  it('allows delete of oauth2_app with no linked tokens', async () => {
    const oauthApp = storedProfile({ authType: 'oauth2_app', status: 'revoked' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(oauthApp),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(0);
    mockAuthProfileFindOneAndDelete.mockResolvedValue(oauthApp);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);
  });

  it('returns 404 for cross-tenant delete attempt', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting another user's personal profile", async () => {
    const personalProfile = storedProfile({
      visibility: 'personal',
      createdBy: 'other-user',
      status: 'revoked',
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(personalProfile),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(404);
    expect(mockAuthProfileFindOneAndDelete).not.toHaveBeenCalled();
  });

  // ABLP-1123: MUST_REVOKE_FIRST gate — boundary tests
  it('returns 409 MUST_REVOKE_FIRST when deleting an active profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile({ status: 'active' })),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('MUST_REVOKE_FIRST');
    expect(body.error.currentStatus).toBe('active');
    expect(mockAuthProfileFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('allows delete of pending_authorization profiles (rollback path)', async () => {
    // EditConnectionDialog / AgentDesktopConnectionDialog rely on being able
    // to delete a just-created profile that was never authorized.
    const pending = storedProfile({ status: 'pending_authorization' });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(pending),
    });
    mockAuthProfileFindOneAndDelete.mockResolvedValue(pending);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(200);
    expect(mockAuthProfileFindOneAndDelete).toHaveBeenCalled();
  });

  it('returns 409 MUST_REVOKE_FIRST when deleting an expired profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile({ status: 'expired' })),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('MUST_REVOKE_FIRST');
  });
});

// ===========================================================================
// CROSS-TENANT ISOLATION — Full lifecycle
// ===========================================================================

describe('Cross-tenant isolation', () => {
  it('tenant B cannot read profile created by tenant A', async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    const handler = mod.GET;

    // Simulate tenant B auth context
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    // DB returns null because tenantId filter doesn't match
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('tenant B cannot update profile created by tenant A', async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    const handler = mod.PUT;

    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Hacked!',
    });
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('tenant B cannot delete profile created by tenant A', async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');
    const handler = mod.DELETE;

    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('tenant B cannot list profiles from tenant A project', async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/route');
    const handler = mod.GET;

    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    mockAuthProfileFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockAuthProfileCountDocuments.mockResolvedValue(0);

    const req = makeRequest('/api/projects/proj-1/auth-profiles');
    await handler(req, routeCtx({ id: PROJECT_ID }));

    // Verify the DB query uses tenant B's tenantId (not tenant A's)
    const filterArg = mockAuthProfileFind.mock.calls[0][0];
    expect(filterArg.tenantId).toBe(TENANT_B);
  });
});

describe('Workspace oauth2_token guardrails', () => {
  let createHandler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;
  let updateHandler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;
  let deleteHandler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const createMod = await import('@/app/api/auth-profiles/route');
    createHandler = createMod.POST;
    const updateMod = await import('@/app/api/auth-profiles/[profileId]/route');
    updateHandler = updateMod.PUT;
    deleteHandler = updateMod.DELETE;
  }, 60_000);

  it('rejects manual oauth2_token create requests for workspace auth profiles', async () => {
    const req = makeRequest('/api/auth-profiles', 'POST', {
      name: 'Workspace token profile',
      description: 'Should be blocked',
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-profile-1',
      config: { provider: 'oauth2' },
      secrets: { accessToken: 'token-1' },
    });

    const res = await createHandler(req, routeCtx({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('system-managed');
    expect(mockAuthProfileCreate).not.toHaveBeenCalled();
  });

  it('rejects manual oauth2_token edits for workspace auth profiles', async () => {
    const existing = storedProfile({
      projectId: null,
      scope: 'tenant',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      config: { provider: 'oauth2', tokenType: 'bearer' },
      encryptedSecrets: JSON.stringify({
        accessToken: 'token-1',
      }),
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });

    const req = makeRequest(`/api/auth-profiles/${PROFILE_ID}`, 'PUT', {
      name: 'Updated workspace token profile',
    });
    const res = await updateHandler(req, routeCtx({ profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('migration records');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects deleting workspace oauth2_token migration records', async () => {
    const existing = storedProfile({
      projectId: null,
      scope: 'tenant',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      config: { provider: 'oauth2', tokenType: 'bearer' },
      encryptedSecrets: JSON.stringify({
        accessToken: 'token-1',
      }),
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });

    const req = makeRequest(`/api/auth-profiles/${PROFILE_ID}`, 'DELETE');
    const res = await deleteHandler(req, routeCtx({ profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('migration records');
    expect(mockAuthProfileFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('performs SSRF validation on workspace OAuth docs and setup guide URL updates', async () => {
    const existing = storedProfile({
      projectId: null,
      scope: 'tenant',
      authType: 'oauth2_app',
    });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(existing),
    });
    mockValidateUrlForSSRF.mockReturnValue({ safe: false, reason: 'private IP' });

    const req = makeRequest(`/api/auth-profiles/${PROFILE_ID}`, 'PUT', {
      config: { setupGuideUrl: 'http://10.0.0.5/guide' },
    });
    const res = await updateHandler(req, routeCtx({ profileId: PROFILE_ID }));
    expect(res.status).toBe(400);
    expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('http://10.0.0.5/guide', {
      allowLocalhost: true,
      allowPrivateRanges: true,
    });

    const body = await res.json();
    expect(body.errors[0].msg).toContain('SSRF');
    expect(mockSave).not.toHaveBeenCalled();
  });
});
