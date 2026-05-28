import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockFindTenantModel = vi.fn();
const mockCreateTenantModelConnection = vi.fn();
const mockFindTenantModelConnectionById = vi.fn();
const mockUpdateTenantModelConnection = vi.fn();
const mockSetConnectionPrimary = vi.fn();
const mockFindCredentialById = vi.fn();
const mockIsTenantEncryptionReady = vi.fn(() => true);
const mockCheckConnectionHealth = vi.fn();
const mockUpdateConnectionHealthStatus = vi.fn();

vi.mock('../repos/tenant-model-repo.js', () => ({
  findTenantModel: (...args: any[]) => mockFindTenantModel(...args),
  findTenantModelWithConnections: vi.fn(),
  listTenantModels: vi.fn(),
  countTenantModels: vi.fn(),
  createTenantModel: vi.fn(),
  updateTenantModel: vi.fn(),
  deleteTenantModel: vi.fn(),
  updateTenantModelInference: vi.fn(),
  findTenantModelConnections: vi.fn(),
  createTenantModelConnection: (...args: any[]) => mockCreateTenantModelConnection(...args),
  findTenantModelConnectionById: (...args: any[]) => mockFindTenantModelConnectionById(...args),
  updateTenantModelConnection: (...args: any[]) => mockUpdateTenantModelConnection(...args),
  deleteTenantModelConnection: vi.fn(),
  setConnectionPrimary: (...args: any[]) => mockSetConnectionPrimary(...args),
  findProjectsUsingTenantModel: vi.fn(),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../repos/llm-resolution-repo.js', () => ({
  findCredentialById: (...args: any[]) => mockFindCredentialById(...args),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-test-1'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: (...args: any[]) => mockIsTenantEncryptionReady(...args),
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(),
    decryptForTenant: vi.fn(),
  })),
}));

vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: vi.fn(),
}));

vi.mock('../services/llm/session-llm-client.js', () => ({
  createVercelProviderForValidation: vi.fn().mockReturnValue({ modelId: 'test' }),
}));

vi.mock('../services/llm/model-health-service.js', () => ({
  checkConnectionHealth: (...args: any[]) => mockCheckConnectionHealth(...args),
  updateConnectionHealthStatus: (...args: any[]) => mockUpdateConnectionHealthStatus(...args),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'ok' }),
}));

vi.mock('@agent-platform/shared-kernel/security', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDevSSRFOptions: vi.fn(() => ({})),
  };
});

const MODELS_BASE = '/api/tenants/tenant-1/models';

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: 'tenant-1',
    displayName: 'GPT-4',
    integrationType: 'easy',
    modelId: 'gpt-4',
    provider: 'openai',
    isActive: true,
    inferenceEnabled: true,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    credentialId: 'cred-1',
    isActive: true,
    isPrimary: true,
    tenantModelId: 'model-1',
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: Record<string, unknown>; headers?: Record<string, string> },
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

describe('Tenant model credential ownership route isolation', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      const authType = req.headers['x-auth-type'] === 'api_key' ? 'api_key' : 'user';
      const userId = authType === 'api_key' ? 'creator-user-1' : 'user-1';
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId,
        permissions: ['*:*'],
        authType,
        role: authType === 'api_key' ? 'api_key' : 'OWNER',
        isSuperAdmin: false,
      };
      req.user = { id: userId, email: 'test@test.com' };
      next();
    });

    const tenantModelsRouter = (await import('../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', tenantModelsRouter);

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 60_000);

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantEncryptionReady.mockReturnValue(true);
    mockFindTenantModel.mockResolvedValue(makeModel());
    mockCreateTenantModelConnection.mockResolvedValue(makeConnection({ isPrimary: false }));
    mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
    mockUpdateTenantModelConnection.mockResolvedValue(makeConnection({ credentialId: 'cred-1' }));
    mockSetConnectionPrimary.mockResolvedValue(undefined);
    mockCheckConnectionHealth.mockResolvedValue({
      valid: true,
      message: 'Connection healthy',
    });
    mockUpdateConnectionHealthStatus.mockResolvedValue(undefined);
    mockFindCredentialById.mockResolvedValue({
      _id: 'cred-1',
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-1',
      encryptedApiKey: 'sk-test',
    });
  });

  test('create connection looks up credentials with caller ownership scope', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${MODELS_BASE}/model-1/connections`, {
      body: { credentialId: 'cred-1' },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(mockFindCredentialById).toHaveBeenCalledWith(
      'cred-1',
      'tenant-1',
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  test('create connection conceals same-tenant foreign user credentials', async () => {
    mockFindCredentialById.mockResolvedValueOnce(null);

    const { status, body } = await request(baseUrl, 'POST', `${MODELS_BASE}/model-1/connections`, {
      body: { credentialId: 'cred-other-user' },
    });

    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: 'Credential not found',
    });
  });

  test('update connection conceals same-tenant foreign user credentials', async () => {
    const existing = makeConnection();
    mockFindTenantModelConnectionById.mockResolvedValue(existing);
    mockFindCredentialById.mockResolvedValueOnce(null);

    const { status, body } = await request(
      baseUrl,
      'PATCH',
      `${MODELS_BASE}/model-1/connections/conn-1`,
      {
        body: { credentialId: 'cred-other-user' },
      },
    );

    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: 'Credential not found',
    });
  });

  test('validate hides same-tenant foreign user credentials behind a generic invalid result', async () => {
    mockFindTenantModelConnectionById.mockResolvedValue(
      makeConnection({ credentialId: 'cred-other-user' }),
    );
    mockFindCredentialById.mockResolvedValueOnce(null);

    const { status, body } = await request(
      baseUrl,
      'POST',
      `${MODELS_BASE}/model-1/connections/conn-1/validate`,
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.valid).toBe(false);
    expect(body.message).toContain('No API key');
    expect(mockFindCredentialById).toHaveBeenCalledWith(
      'cred-other-user',
      'tenant-1',
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  test('api-key callers do not inherit creator user scope for credential lookups', async () => {
    mockFindCredentialById.mockResolvedValueOnce(null);

    const { status, body } = await request(baseUrl, 'POST', `${MODELS_BASE}/model-1/connections`, {
      body: { credentialId: 'cred-private-user' },
      headers: { 'x-auth-type': 'api_key' },
    });

    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: 'Credential not found',
    });
    expect(mockFindCredentialById).toHaveBeenCalledWith(
      'cred-private-user',
      'tenant-1',
      expect.objectContaining({ actorUserId: undefined }),
    );
  });
});
