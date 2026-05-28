/**
 * Tests for MCP Server API Routes
 *
 * Covers:
 *   GET/POST   /api/projects/:id/mcp-servers                              - List / create MCP server configs
 *   GET/PUT/DELETE /api/projects/:id/mcp-servers/:serverId                 - Single server CRUD
 *   POST       /api/projects/:id/mcp-servers/:serverId/test-connection     - Test connectivity
 *   GET        /api/projects/:id/mcp-servers/:serverId/tools               - List discovered tools
 *   POST       /api/projects/:id/mcp-servers/:serverId/tools/discover      - Discover and persist tools
 *   POST       /api/projects/:id/mcp-servers/:serverId/tools/discover/preview - Preview discovery
 *   POST       /api/projects/:id/mcp-servers/:serverId/tools/:toolName/test  - Test single tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — Auth
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  formatUserLabel: (user: { name?: string; email?: string; id?: string }) =>
    user.name || user.email || user.id || 'unknown',
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

// ---------------------------------------------------------------------------
// Mocks — Permission resolver (used by withRouteHandler)
// ---------------------------------------------------------------------------

vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Mocks — Shared validation (used by withRouteHandler for bodySchema)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/validation', () => ({
  parseInput: vi.fn((schema: unknown, data: unknown) => ({ success: true, data })),
}));

// ---------------------------------------------------------------------------
// Mocks — Shared repos
// ---------------------------------------------------------------------------

const mockFindWithToolCount = vi.fn();
const mockCreate = vi.fn();
const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockDeleteCascade = vi.fn();
const mockFindProjectToolsByProject = vi.fn();

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsWithToolCount: mockFindWithToolCount,
  createMcpServerConfig: mockCreate,
  findMcpServerConfigById: mockFindById,
  updateMcpServerConfig: mockUpdate,
  updateProjectScopedMcpServerConfig: mockUpdate,
  deleteMcpServerConfigWithCascade: mockDeleteCascade,
  deleteProjectScopedMcpServerConfigWithCascade: mockDeleteCascade,
  findProjectToolsByProject: mockFindProjectToolsByProject,
}));

// ---------------------------------------------------------------------------
// Mocks — Shared validation (SSRF)
// ---------------------------------------------------------------------------

const mockValidateUrlForSSRF = vi.fn();

vi.mock('@agent-platform/shared', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/shared')>('@agent-platform/shared');
  return {
    ...actual,
    validateUrlForSSRF: mockValidateUrlForSSRF,
    MCP_AUTH_TYPES: ['none', 'bearer', 'api_key', 'custom_headers', 'oauth2_client_credentials'],
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Mocks — MCP auth-profile compatibility
// ---------------------------------------------------------------------------

const mockValidateMcpAuthProfileCompatibility = vi.fn();
const mockValidateMcpEnvProfileCompatibility = vi.fn();
const mockRefreshProjectAgentDraftMetadataForMcpServerMutation = vi.fn();

vi.mock('@/lib/mcp-auth-profile-compat', () => ({
  validateMcpAuthProfileCompatibility: (...args: unknown[]) =>
    mockValidateMcpAuthProfileCompatibility(...args),
  validateMcpEnvProfileCompatibility: (...args: unknown[]) =>
    mockValidateMcpEnvProfileCompatibility(...args),
}));

vi.mock('@/lib/project-mcp-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForMcpServerMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForMcpServerMutation(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — Encryption
// ---------------------------------------------------------------------------

const mockEncryptForTenant = vi.fn();

vi.mock('@agent-platform/shared/encryption', () => {
  // Must use a real function (not arrow) so it can be called with `new`
  function MockEncryptionService() {
    return { encryptForTenant: mockEncryptForTenant };
  }
  const mockEncryptionServiceInstance = {
    encryptForTenant: mockEncryptForTenant,
  };
  return {
    EncryptionService: MockEncryptionService,
    getEncryptionService: vi.fn(() => mockEncryptionServiceInstance),
    isTenantEncryptionReady: vi.fn(() => true),
    isDEKEnvelopeFormat: vi.fn(() => true),
  };
});

// ---------------------------------------------------------------------------
// Mocks — MCP Discovery Service
// ---------------------------------------------------------------------------

const mockTestConnection = vi.fn();
const mockListDiscovered = vi.fn();
const mockDiscoverPersist = vi.fn();
const mockDiscoverPreview = vi.fn();
const mockTestMcpTool = vi.fn();

vi.mock('@/services/mcp-discovery-service', () => ({
  testConnection: mockTestConnection,
  listDiscoveredTools: mockListDiscovered,
  discoverAndPersist: mockDiscoverPersist,
  discoverPreview: mockDiscoverPreview,
  testMcpTool: mockTestMcpTool,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'test@test.com',
  name: 'Test User',
  permissions: ['*:*'],
};

const testProject = {
  id: 'proj-1',
  tenantId: 'tenant-1',
  name: 'Test Project',
};

function makeRequest(url: string, body?: unknown, method = 'GET'): NextRequest {
  const opts: any = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-jwt',
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

const authErrorResponse = { status: 401, json: async () => ({ error: 'Unauthorized' }) };
const accessErrorResponse = { status: 403, json: async () => ({ error: 'Forbidden' }) };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);

  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);

  mockValidateUrlForSSRF.mockReturnValue({ safe: true });
  mockEncryptForTenant.mockResolvedValue('encrypted-env-blob');
  mockValidateMcpAuthProfileCompatibility.mockResolvedValue({ ok: true });
  mockValidateMcpEnvProfileCompatibility.mockResolvedValue({ ok: true });
  mockRefreshProjectAgentDraftMetadataForMcpServerMutation.mockResolvedValue(undefined);
});

// ===========================================================================
// MCP Servers — List (GET) & Create (POST)
// ===========================================================================

describe('GET/POST /api/projects/:id/mcp-servers', () => {
  let GET: Function;
  let POST: Function;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/mcp-servers/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  // ── GET (List) ──────────────────────────────────────────────────────────

  describe('GET — list servers', () => {
    it('returns servers with tool count and parsed tags', async () => {
      const serverRow = {
        id: 'srv-1',
        name: 'My MCP Server',
        transport: 'sse',
        command: null,
        url: 'https://example.com/mcp',
        priority: 0,
        tags: '["production","ai"]',
        connectionTimeoutMs: 15000,
        requestTimeoutMs: 30000,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        createdBy: 'user-1',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
        _count: { discoveredTools: 5 },
      };
      mockFindWithToolCount.mockResolvedValue([serverRow]);

      const req = makeRequest('/api/projects/proj-1/mcp-servers');
      const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.servers).toHaveLength(1);
      expect(json.servers[0].tags).toEqual(['production', 'ai']);
      expect(json.servers[0].discoveredToolCount).toBe(5);
      expect(mockFindWithToolCount).toHaveBeenCalledWith('tenant-1', 'proj-1');
    });

    it('handles servers with null tags gracefully', async () => {
      mockFindWithToolCount.mockResolvedValue([
        {
          id: 'srv-2',
          name: 'No Tags',
          transport: 'http',
          command: null,
          url: 'https://example.com',
          priority: 0,
          tags: null,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 30000,
          autoReconnect: true,
          maxReconnectAttempts: 3,
          createdBy: 'user-1',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-02',
          _count: undefined,
        },
      ]);

      const req = makeRequest('/api/projects/proj-1/mcp-servers');
      const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(json.servers[0].tags).toEqual([]);
      expect(json.servers[0].discoveredToolCount).toBe(0);
    });
  });

  // ── POST (Create) ──────────────────────────────────────────────────────

  describe('POST — create server', () => {
    const validBody = {
      name: 'New Server',
      transport: 'sse',
      url: 'https://example.com/mcp',
      env: { API_KEY: 'secret123' },
    };

    it('creates server with encrypted env and returns 201', async () => {
      const createdServer = {
        id: 'srv-new',
        name: 'New Server',
        transport: 'sse',
        url: 'https://example.com/mcp',
        priority: 0,
        tags: null,
        connectionTimeoutMs: 15000,
        requestTimeoutMs: 30000,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        createdAt: '2025-01-01',
      };
      mockCreate.mockResolvedValue(createdServer);

      const req = makeRequest('/api/projects/proj-1/mcp-servers', validBody, 'POST');
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.server.id).toBe('srv-new');
      // Encryption is handled by a pre-save hook; route stores raw JSON
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          name: 'New Server',
          transport: 'sse',
          encryptedEnv: JSON.stringify({ API_KEY: 'secret123' }),
          createdBy: 'Test User',
        }),
      );
    });

    it('passes user context when validating authProfileId compatibility', async () => {
      mockCreate.mockResolvedValue({
        id: 'srv-auth-profile',
        name: 'Auth Profile Server',
        transport: 'http',
        url: 'https://example.com/mcp',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          transport: 'http',
          authProfileId: 'auth-profile-1',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(201);
      expect(mockValidateMcpAuthProfileCompatibility).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        authProfileId: 'auth-profile-1',
        transport: 'http',
        userId: 'user-1',
      });
    });

    it('ignores inline auth payload when authProfileId is present', async () => {
      mockCreate.mockResolvedValue({
        id: 'srv-auth-profile-inline-mixed',
        name: 'Auth Profile Server',
        transport: 'http',
        url: 'https://example.com/mcp',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          transport: 'http',
          authProfileId: 'auth-profile-1',
          authType: 'bearer',
          authConfig: { token: 'stale-inline-token' },
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: 'auth-profile-1',
          authType: undefined,
          encryptedAuthConfig: undefined,
        }),
      );
    });

    it('rejects create when envProfileId is not accessible', async () => {
      mockValidateMcpEnvProfileCompatibility.mockResolvedValue({
        ok: false,
        status: 404,
        code: 'AUTH_PROFILE_NOT_FOUND',
        message: 'Auth profile not found',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          envProfileId: 'env-profile-1',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.errors[0].code).toBe('AUTH_PROFILE_NOT_FOUND');
      expect(mockValidateMcpEnvProfileCompatibility).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        envProfileId: 'env-profile-1',
        userId: 'user-1',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns 400 when name is missing', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        { transport: 'sse', url: 'https://example.com' },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
    });

    it('returns 400 when name exceeds 128 characters', async () => {
      const longName = 'a'.repeat(129);
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          name: longName,
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.errors[0].msg).toContain('128');
    });

    it('returns 400 for invalid transport value', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          transport: 'websocket',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('transport');
    });

    it('returns 400 when SSRF validation fails on URL', async () => {
      mockValidateUrlForSSRF.mockReturnValue({
        safe: false,
        reason: 'URL targets a private IP range',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          url: 'http://169.254.169.254/metadata',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('private IP');
    });

    it('returns 400 when env exceeds 50 entries', async () => {
      const bigEnv: Record<string, string> = {};
      for (let i = 0; i < 51; i++) bigEnv[`KEY_${i}`] = 'val';

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          env: bigEnv,
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('50');
    });

    it('returns 400 when env value is not a string', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          env: { KEY: 123 },
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('env values must be strings');
    });

    it('returns 400 when custom headers is not an object', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          headers: 'Authorization: Bearer token',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('headers must be an object');
    });

    it('returns 400 when tags is not an array', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          tags: 'not-array',
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('tags must be an array');
    });

    it('creates server with bearer auth and encrypts config', async () => {
      mockCreate.mockResolvedValue({
        id: 'srv-auth',
        name: 'Auth Server',
        transport: 'http',
        url: 'https://a.com',
      });
      mockEncryptForTenant.mockResolvedValue('encrypted-auth-blob');

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          authType: 'bearer',
          authConfig: { token: 'my-secret-token' },
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(201);
      // Encryption is handled by a pre-save hook; route stores raw JSON
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          authType: 'bearer',
          encryptedAuthConfig: JSON.stringify({ token: 'my-secret-token' }),
        }),
      );
    });

    it('returns 400 for invalid authType', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        { ...validBody, authType: 'kerberos', authConfig: {} },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('authType must be one of');
    });

    it('returns 400 for bearer auth without token', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        { ...validBody, authType: 'bearer', authConfig: {} },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('bearer auth requires');
    });

    it('returns 400 when custom_headers auth contains non-string header values', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          authType: 'custom_headers',
          authConfig: { headers: { Authorization: 123 } },
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('custom_headers auth header values must be strings');
    });

    it('returns 400 for oauth2 with HTTP tokenEndpoint', async () => {
      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers',
        {
          ...validBody,
          authType: 'oauth2_client_credentials',
          authConfig: {
            clientId: 'id',
            clientSecret: 'secret',
            tokenEndpoint: 'http://auth.example.com/token',
          },
        },
        'POST',
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('HTTPS');
    });
  });
});

// ===========================================================================
// MCP Servers — Single server CRUD (GET / PUT / DELETE)
// ===========================================================================

describe('GET/PUT/DELETE /api/projects/:id/mcp-servers/:serverId', () => {
  let GET: Function;
  let PUT: Function;
  let DELETE: Function;

  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1' });

  const existingServer = {
    id: 'srv-1',
    name: 'Existing Server',
    transport: 'http',
    command: null,
    url: 'https://example.com/mcp',
    priority: 0,
    tags: '["test"]',
    connectionTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    autoReconnect: true,
    maxReconnectAttempts: 3,
    projectId: 'proj-1',
    createdBy: 'user-1',
    createdAt: '2025-01-01',
    updatedAt: '2025-01-02',
  };

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/mcp-servers/[serverId]/route');
    GET = mod.GET;
    PUT = mod.PUT;
    DELETE = mod.DELETE;
  });

  // ── GET (Single) ────────────────────────────────────────────────────────

  describe('GET — single server', () => {
    it('returns server with tool count', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockFindProjectToolsByProject.mockResolvedValue({
        data: [{ id: 't1' }, { id: 't2' }],
        pagination: { total: 2, page: 1, limit: 1 },
      });

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1');
      const res = await GET(req, { params: routeParams });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.server.id).toBe('srv-1');
      expect(json.server.discoveredToolCount).toBe(2);
      expect(json.server.tags).toEqual(['test']);
      expect(mockFindById).toHaveBeenCalledWith('srv-1', 'tenant-1');
    });

    it('returns 404 when server not found', async () => {
      mockFindById.mockResolvedValue(null);

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-missing');
      const res = await GET(req, { params: routeParams });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });

  // ── PUT (Update) ────────────────────────────────────────────────────────

  describe('PUT — update server', () => {
    it('updates server and re-encrypts env', async () => {
      mockFindById.mockResolvedValue(existingServer);
      const updatedServer = { ...existingServer, updatedAt: '2025-02-01' };
      mockUpdate.mockResolvedValue(updatedServer);

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        {
          env: { NEW_KEY: 'new-val' },
        },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });
      const json = await res.json();

      expect(json.success).toBe(true);
      // Encryption is handled by a pre-save hook; route stores raw JSON
      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({
          encryptedEnv: JSON.stringify({ NEW_KEY: 'new-val' }),
        }),
      );
    });

    it('performs SSRF validation on URL update', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockValidateUrlForSSRF.mockReturnValue({
        safe: false,
        reason: 'URL targets a private IP range',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        {
          url: 'http://10.0.0.1/internal',
        },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(400);
      expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('http://10.0.0.1/internal', {});
    });

    it('returns 404 when server does not exist', async () => {
      mockFindById.mockResolvedValue(null);

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', { name: 'Updated' }, 'PUT');
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(404);
    });

    it('revalidates existing authProfileId when transport changes', async () => {
      mockFindById.mockResolvedValue({
        ...existingServer,
        authProfileId: 'auth-profile-1',
        transport: 'http',
      });
      mockValidateMcpAuthProfileCompatibility.mockResolvedValue({
        ok: false,
        status: 400,
        code: 'MCP_TRANSPORT_NOT_TLS_CAPABLE',
        message: 'mTLS auth profiles require HTTP transport',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { transport: 'sse' },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.errors[0].code).toBe('MCP_TRANSPORT_NOT_TLS_CAPABLE');
      expect(mockValidateMcpAuthProfileCompatibility).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        authProfileId: 'auth-profile-1',
        transport: 'sse',
        userId: 'user-1',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns 409 on version conflict', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockUpdate.mockResolvedValue(null);

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', { name: 'Updated' }, 'PUT');
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('conflict');
    });

    it('clears env when null is sent', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockUpdate.mockResolvedValue({ ...existingServer, encryptedEnv: null });

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', { env: null }, 'PUT');
      await PUT(req, { params: routeParams });

      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({ encryptedEnv: null }),
      );
      expect(mockEncryptForTenant).not.toHaveBeenCalled();
    });

    it('updates auth config and encrypts it', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockUpdate.mockResolvedValue({ ...existingServer, authType: 'bearer' });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { authType: 'bearer', authConfig: { token: 'new-token' } },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(200);
      // Encryption is handled by a pre-save hook; route stores raw JSON
      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({
          authType: 'bearer',
          encryptedAuthConfig: JSON.stringify({ token: 'new-token' }),
        }),
      );
    });

    it('rejects update when envProfileId is not accessible', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockValidateMcpEnvProfileCompatibility.mockResolvedValue({
        ok: false,
        status: 404,
        code: 'AUTH_PROFILE_NOT_FOUND',
        message: 'Auth profile not found',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        {
          envProfileId: 'env-profile-1',
        },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.errors[0].code).toBe('AUTH_PROFILE_NOT_FOUND');
      expect(mockValidateMcpEnvProfileCompatibility).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        envProfileId: 'env-profile-1',
        userId: 'user-1',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('clears auth config when switching to none', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockUpdate.mockResolvedValue({
        ...existingServer,
        authType: 'none',
        encryptedAuthConfig: null,
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { authType: 'none' },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({
          authType: 'none',
          encryptedAuthConfig: null,
        }),
      );
    });

    it('returns 400 for invalid auth config on update', async () => {
      mockFindById.mockResolvedValue(existingServer);

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { authType: 'api_key', authConfig: {} },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('api_key auth requires');
    });

    it('ignores inline auth update when authProfileId is provided and clears inline auth', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockUpdate.mockResolvedValue({
        ...existingServer,
        authType: 'none',
        authProfileId: 'auth-profile-2',
        encryptedAuthConfig: null,
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        {
          authProfileId: 'auth-profile-2',
          authType: 'not-a-real-auth-type',
          authConfig: { token: 'stale-inline-token' },
        },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({
          authProfileId: 'auth-profile-2',
          authType: 'none',
          encryptedAuthConfig: null,
        }),
      );
    });

    it('supports switching from authProfileId to inline auth in one update request', async () => {
      mockFindById.mockResolvedValue({
        ...existingServer,
        authProfileId: 'auth-profile-1',
        authType: 'none',
      });
      mockUpdate.mockResolvedValue({
        ...existingServer,
        authProfileId: null,
        authType: 'bearer',
      });

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        {
          authProfileId: null,
          authType: 'bearer',
          authConfig: { token: 'new-inline-token' },
        },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'srv-1',
        'tenant-1',
        'proj-1',
        expect.objectContaining({
          authProfileId: null,
          authType: 'bearer',
          encryptedAuthConfig: JSON.stringify({ token: 'new-inline-token' }),
        }),
      );
    });

    it('returns 400 when custom_headers auth update contains non-string header values', async () => {
      mockFindById.mockResolvedValue(existingServer);

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { authType: 'custom_headers', authConfig: { headers: { Authorization: 123 } } },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('custom_headers auth header values must be strings');
    });

    it('returns 400 when custom header values are not strings', async () => {
      mockFindById.mockResolvedValue(existingServer);

      const req = makeRequest(
        '/api/projects/proj-1/mcp-servers/srv-1',
        { headers: { Authorization: 123 } },
        'PUT',
      );
      const res = await PUT(req, { params: routeParams });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('header values must be strings');
    });
  });

  // ── DELETE ──────────────────────────────────────────────────────────────

  describe('DELETE — cascade delete server', () => {
    it('deletes server and returns deleted id', async () => {
      mockFindById.mockResolvedValue(existingServer);
      mockDeleteCascade.mockResolvedValue(undefined);

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', undefined, 'DELETE');
      const res = await DELETE(req, { params: routeParams });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.deleted).toBe('srv-1');
      expect(mockDeleteCascade).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
    });

    it('returns 404 when server not found', async () => {
      mockFindById.mockResolvedValue(null);

      const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', undefined, 'DELETE');
      const res = await DELETE(req, { params: routeParams });

      expect(res.status).toBe(404);
    });
  });
});

// ===========================================================================
// MCP Discovery — Test Connection
// ===========================================================================

describe('POST /api/projects/:id/mcp-servers/:serverId/test-connection', () => {
  let POST: Function;
  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1' });

  beforeEach(async () => {
    const mod =
      await import('@/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route');
    POST = mod.POST;
  });

  it('calls testConnection with correct tenant-scoped args', async () => {
    mockTestConnection.mockResolvedValue({ connected: true, latencyMs: 42 });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/test-connection', {}, 'POST');
    const res = await POST(req, { params: routeParams });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.result).toEqual({ connected: true, latencyMs: 42 });
    expect(mockTestConnection).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
  });

  it('returns error status from service when connection fails', async () => {
    mockTestConnection.mockResolvedValue({ status: 502, error: 'Connection refused' });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/test-connection', {}, 'POST');
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});

// ===========================================================================
// MCP Discovery — List Discovered Tools
// ===========================================================================

describe('GET /api/projects/:id/mcp-servers/:serverId/tools', () => {
  let GET: Function;
  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1' });

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/mcp-servers/[serverId]/tools/route');
    GET = mod.GET;
  });

  it('returns discovered tools list', async () => {
    const tools = [
      { name: 'search', description: 'Search the web' },
      { name: 'fetch', description: 'Fetch a URL' },
    ];
    mockListDiscovered.mockResolvedValue(tools);

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/tools');
    const res = await GET(req, { params: routeParams });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.tools).toEqual(tools);
    expect(mockListDiscovered).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
  });

  it('returns error status from service', async () => {
    mockListDiscovered.mockResolvedValue({ status: 404, error: 'Server not found' });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/tools');
    const res = await GET(req, { params: routeParams });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// MCP Discovery — Discover & Persist
// ===========================================================================

describe('POST /api/projects/:id/mcp-servers/:serverId/tools/discover', () => {
  let POST: Function;
  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1' });

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/route');
    POST = mod.POST;
  });

  it('discovers and persists all tools when no toolNames provided', async () => {
    mockDiscoverPersist.mockResolvedValue({ discovered: 3, persisted: 3 });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/tools/discover', {}, 'POST');
    const res = await POST(req, { params: routeParams });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.discovered).toBe(3);
    expect(mockDiscoverPersist).toHaveBeenCalledWith(
      'srv-1',
      'tenant-1',
      'proj-1',
      'user-1',
      undefined,
    );
  });

  it('filters to specific tool names (strings only)', async () => {
    mockDiscoverPersist.mockResolvedValue({ discovered: 1, persisted: 1 });

    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers/srv-1/tools/discover',
      {
        toolNames: ['search', 123, null, 'fetch'],
      },
      'POST',
    );
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(200);
    expect(mockDiscoverPersist).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1', 'user-1', [
      'search',
      'fetch',
    ]);
  });

  it('returns error status from service', async () => {
    mockDiscoverPersist.mockResolvedValue({ status: 500, error: 'Discovery failed' });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/tools/discover', {}, 'POST');
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(500);
  });

  it('handles missing body gracefully', async () => {
    mockDiscoverPersist.mockResolvedValue({ discovered: 3, persisted: 3 });

    // Create a request with no body — route does .json().catch(() => ({}))
    const req = new NextRequest(
      new URL('/api/projects/proj-1/mcp-servers/srv-1/tools/discover', 'http://localhost:3000'),
      { method: 'POST', headers: { Authorization: 'Bearer test-jwt' } },
    );
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(200);
    expect(mockDiscoverPersist).toHaveBeenCalledWith(
      'srv-1',
      'tenant-1',
      'proj-1',
      'user-1',
      undefined,
    );
  });
});

// ===========================================================================
// MCP Discovery — Preview (No Persistence)
// ===========================================================================

describe('POST /api/projects/:id/mcp-servers/:serverId/tools/discover/preview', () => {
  let POST: Function;
  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1' });

  beforeEach(async () => {
    const mod =
      await import('@/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/preview/route');
    POST = mod.POST;
  });

  it('returns preview without persisting', async () => {
    mockDiscoverPreview.mockResolvedValue({
      tools: [{ name: 'search', description: 'Search' }],
    });

    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers/srv-1/tools/discover/preview',
      {},
      'POST',
    );
    const res = await POST(req, { params: routeParams });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.tools).toHaveLength(1);
    expect(mockDiscoverPreview).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
  });

  it('returns error status from service', async () => {
    mockDiscoverPreview.mockResolvedValue({ status: 404, error: 'Server not found' });

    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers/srv-1/tools/discover/preview',
      {},
      'POST',
    );
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// MCP Tools — Test Single Tool
// ===========================================================================

describe('POST /api/projects/:id/mcp-servers/:serverId/tools/:toolName/test', () => {
  let POST: Function;
  const routeParams = Promise.resolve({ id: 'proj-1', serverId: 'srv-1', toolName: 'search' });

  beforeEach(async () => {
    const mod =
      await import('@/app/api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test/route');
    POST = mod.POST;
  });

  it('tests tool with provided input', async () => {
    mockTestMcpTool.mockResolvedValue({ output: 'result-data' });

    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers/srv-1/tools/search/test',
      { input: { query: 'hello world' } },
      'POST',
    );
    const res = await POST(req, { params: routeParams });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.result).toEqual({ output: 'result-data' });
    expect(mockTestMcpTool).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1', 'search', {
      query: 'hello world',
    });
  });

  it('defaults input to empty object when body has no input', async () => {
    mockTestMcpTool.mockResolvedValue({ output: 'ok' });

    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/tools/search/test', {}, 'POST');
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(200);
    expect(mockTestMcpTool).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1', 'search', {});
  });

  it('defaults input to empty object when no body is sent', async () => {
    mockTestMcpTool.mockResolvedValue({ output: 'ok' });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/mcp-servers/srv-1/tools/search/test', 'http://localhost:3000'),
      { method: 'POST', headers: { Authorization: 'Bearer test-jwt' } },
    );
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(200);
    expect(mockTestMcpTool).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1', 'search', {});
  });

  it('returns error status from service', async () => {
    mockTestMcpTool.mockResolvedValue({ status: 400, error: 'Invalid tool' });

    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers/srv-1/tools/search/test',
      { input: {} },
      'POST',
    );
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Auth & Tenant Isolation — Shared Across All Routes
// ===========================================================================

describe('Auth & Tenant Isolation', () => {
  it('returns auth error when requireAuth fails (list route)', async () => {
    mockRequireAuth.mockResolvedValue(authErrorResponse);
    mockIsAuthError.mockReturnValue(true);

    const { GET } = await import('@/app/api/projects/[id]/mcp-servers/route');
    const req = makeRequest('/api/projects/proj-1/mcp-servers');
    const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(401);
    expect(mockRequireProjectAccess).not.toHaveBeenCalled();
  });

  it('returns access error when project access denied (list route)', async () => {
    mockRequireProjectAccess.mockResolvedValue(accessErrorResponse);
    mockIsAccessError.mockReturnValue(true);

    const { GET } = await import('@/app/api/projects/[id]/mcp-servers/route');
    const req = makeRequest('/api/projects/proj-1/mcp-servers');
    const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(403);
    expect(mockFindWithToolCount).not.toHaveBeenCalled();
  });

  it('returns 403 when tenantId is missing', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    const authResponse = new Response(
      JSON.stringify({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Tenant context required' },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'proj-1' } });

    const { GET } = await import('@/app/api/projects/[id]/mcp-servers/route');
    const req = makeRequest('/api/projects/proj-1/mcp-servers');
    const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(403);
  });

  it('passes tenantId to all repo/service calls (create route)', async () => {
    const createdServer = {
      id: 'srv-new',
      name: 'S',
      transport: 'http',
      url: 'https://a.com',
      priority: 0,
      tags: null,
      connectionTimeoutMs: 15000,
      requestTimeoutMs: 30000,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      createdAt: '2025-01-01',
    };
    mockCreate.mockResolvedValue(createdServer);

    const { POST } = await import('@/app/api/projects/[id]/mcp-servers/route');
    const req = makeRequest(
      '/api/projects/proj-1/mcp-servers',
      {
        name: 'S',
        transport: 'http',
        url: 'https://a.com',
      },
      'POST',
    );
    await POST(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
  });

  it('passes tenantId to delete cascade call', async () => {
    mockFindById.mockResolvedValue({ id: 'srv-1', tenantId: 'tenant-1', projectId: 'proj-1' });
    mockDeleteCascade.mockResolvedValue(undefined);

    const { DELETE } = await import('@/app/api/projects/[id]/mcp-servers/[serverId]/route');
    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1', undefined, 'DELETE');
    await DELETE(req, { params: Promise.resolve({ id: 'proj-1', serverId: 'srv-1' }) });

    expect(mockDeleteCascade).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
  });

  it('passes tenantId to discovery service calls', async () => {
    mockTestConnection.mockResolvedValue({ connected: true });

    const { POST } =
      await import('@/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route');
    const req = makeRequest('/api/projects/proj-1/mcp-servers/srv-1/test-connection', {}, 'POST');
    await POST(req, { params: Promise.resolve({ id: 'proj-1', serverId: 'srv-1' }) });

    expect(mockTestConnection).toHaveBeenCalledWith('srv-1', 'tenant-1', 'proj-1');
  });
});
