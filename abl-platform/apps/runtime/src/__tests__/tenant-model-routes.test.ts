/**
 * Tenant Model Route Integration Tests
 *
 * Mounts the tenant-models router on a real Express app and exercises
 * all 8 endpoints via Node's built-in fetch against an http.createServer listener.
 *
 * Endpoints under test:
 *   GET    /api/tenants/:tenantId/models
 *   POST   /api/tenants/:tenantId/models
 *   GET    /api/tenants/:tenantId/models/:id
 *   PATCH  /api/tenants/:tenantId/models/:id
 *   DELETE /api/tenants/:tenantId/models/:id
 *   POST   /api/tenants/:tenantId/models/:id/toggle-inference
 *   GET    /api/tenants/:tenantId/models/:modelId/connections
 *   POST   /api/tenants/:tenantId/models/:modelId/connections
 *   PATCH  /api/tenants/:tenantId/models/:modelId/connections/:connId
 *   DELETE /api/tenants/:tenantId/models/:modelId/connections/:connId
 *   POST   /api/tenants/:tenantId/models/:modelId/connections/:connId/validate
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

const mockFindTenantModel = vi.fn();
const mockFindTenantModelWithConnections = vi.fn();
const mockListTenantModels = vi.fn();
const mockCountTenantModels = vi.fn();
const mockCreateTenantModel = vi.fn();
const mockUpdateTenantModel = vi.fn();
const mockDeleteTenantModel = vi.fn();
const mockUpdateTenantModelInference = vi.fn();
const mockFindTenantModelConnections = vi.fn();
const mockCreateTenantModelConnection = vi.fn();
const mockFindTenantModelConnectionById = vi.fn();
const mockUpdateTenantModelConnection = vi.fn();
const mockDeleteTenantModelConnection = vi.fn();
const mockSetConnectionPrimary = vi.fn();
const mockFindProjectsUsingTenantModel = vi.fn();
const mockInvalidateModelResolutionCaches = vi.fn();

vi.mock('../repos/tenant-model-repo.js', () => ({
  findTenantModel: (...args: any[]) => mockFindTenantModel(...args),
  findTenantModelWithConnections: (...args: any[]) => mockFindTenantModelWithConnections(...args),
  listTenantModels: (...args: any[]) => mockListTenantModels(...args),
  countTenantModels: (...args: any[]) => mockCountTenantModels(...args),
  createTenantModel: (...args: any[]) => mockCreateTenantModel(...args),
  updateTenantModel: (...args: any[]) => mockUpdateTenantModel(...args),
  deleteTenantModel: (...args: any[]) => mockDeleteTenantModel(...args),
  updateTenantModelInference: (...args: any[]) => mockUpdateTenantModelInference(...args),
  findTenantModelConnections: (...args: any[]) => mockFindTenantModelConnections(...args),
  createTenantModelConnection: (...args: any[]) => mockCreateTenantModelConnection(...args),
  findTenantModelConnectionById: (...args: any[]) => mockFindTenantModelConnectionById(...args),
  updateTenantModelConnection: (...args: any[]) => mockUpdateTenantModelConnection(...args),
  deleteTenantModelConnection: (...args: any[]) => mockDeleteTenantModelConnection(...args),
  setConnectionPrimary: (...args: any[]) => mockSetConnectionPrimary(...args),
  findProjectsUsingTenantModel: (...args: any[]) => mockFindProjectsUsingTenantModel(...args),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const mockIsTenantEncryptionReady = vi.fn(() => true);
const mockEncryptForTenant = vi.fn((_val: string, _tid: string) => 'encrypted-value');
const mockDecryptForTenant = vi.fn((_val: string, _tid: string) => 'decrypted-key');
const mockCheckConnectionHealth = vi.fn();
const mockResolveConnectionHealthInputFromCredential = vi.fn();
const mockUpdateConnectionHealthStatus = vi.fn();

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: (...args: any[]) => mockIsTenantEncryptionReady(...args),
  getEncryptionService: () => ({
    encryptForTenant: mockEncryptForTenant,
    decryptForTenant: mockDecryptForTenant,
  }),
}));

vi.mock('../services/llm/session-llm-client.js', () => ({
  clearProviderCache: vi.fn(),
  createVercelProviderForValidation: vi.fn().mockReturnValue({ modelId: 'test' }),
}));

vi.mock('../services/llm/model-health-service.js', () => ({
  checkConnectionHealth: (...args: any[]) => mockCheckConnectionHealth(...args),
  resolveConnectionHealthInputFromCredential: (...args: any[]) =>
    mockResolveConnectionHealthInputFromCredential(...args),
  updateConnectionHealthStatus: (...args: any[]) => mockUpdateConnectionHealthStatus(...args),
}));

vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: any[]) => mockInvalidateModelResolutionCaches(...args),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'ok' }),
}));

const mockFindCredentialById = vi.fn();
const mockReportAccessDenied = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
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
  getRequestAccessDeniedReporter: vi.fn(
    () =>
      (...args: any[]) =>
        mockReportAccessDenied(...args),
  ),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-test-1'),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  setLogLevel: vi.fn(),
  setLogHandler: vi.fn(),
  redactSensitive: vi.fn((value: unknown) => value),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getMCPServerManager: vi.fn(() => ({
    listServers: vi.fn(() => []),
    registerServer: vi.fn(),
    unregisterServer: vi.fn(),
    getServer: vi.fn(() => undefined),
  })),
  MCPServerManager: class {},
}));

// Mock SSRF validator — in test mode getDevSSRFOptions allows localhost/private,
// but we need to test SSRF blocking behavior, so mock getDevSSRFOptions to return strict defaults.
vi.mock('@agent-platform/shared-kernel/security', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDevSSRFOptions: vi.fn(() => ({})), // No allowLocalhost, no allowPrivateRanges
  };
});

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';

let baseUrl: string;
let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Inject tenantContext for every request (default: authenticated tenant-1)
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1', permissions: ['*:*'] };
    req.user = { id: 'user-1', email: 'test@test.com' };
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
  mockCheckConnectionHealth.mockResolvedValue({
    valid: true,
    message: 'Connection healthy',
  });
  mockResolveConnectionHealthInputFromCredential.mockResolvedValue({
    provider: 'openai',
    apiKey: 'sk-test',
    modelId: 'gpt-4',
  });
  mockUpdateConnectionHealthStatus.mockResolvedValue(undefined);
  mockFindCredentialById.mockResolvedValue({
    _id: 'cred-1',
    tenantId: 'tenant-1',
    encryptedApiKey: 'sk-test',
  });
});

// =============================================================================
// HELPERS
// =============================================================================

async function request(method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const MODELS_BASE = '/api/tenants/tenant-1/models';

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: 'tenant-1',
    displayName: 'GPT-4',
    integrationType: 'easy',
    modelId: 'gpt-4',
    provider: 'openai',
    endpointUrl: null,
    providerStructure: null,
    customEndpoint: null,
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsStructured: false,
    tier: 'balanced',
    isDefault: false,
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
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tenantModelId: 'model-1',
    ...overrides,
  };
}

// =============================================================================
// MODEL ROUTES
// =============================================================================

describe('Tenant Model Routes', () => {
  // ---------------------------------------------------------------------------
  // GET / — list models
  // ---------------------------------------------------------------------------
  describe('GET / (list models)', () => {
    test('returns 200 with models and pagination', async () => {
      mockListTenantModels.mockResolvedValue([makeModel()]);
      mockCountTenantModels.mockResolvedValue(1);

      const { status, body } = await request('GET', MODELS_BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
      expect(body.pagination.page).toBe(1);
    });

    test('returns explicit response API and streaming mode overrides', async () => {
      mockListTenantModels.mockResolvedValue([
        makeModel({ useResponsesApi: false, useStreaming: false, connections: [] }),
      ]);
      mockCountTenantModels.mockResolvedValue(1);

      const { status, body } = await request('GET', MODELS_BASE);

      expect(status).toBe(200);
      expect(mockListTenantModels).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          select: expect.objectContaining({
            useResponsesApi: true,
            useStreaming: true,
          }),
        }),
      );
      expect(body.models[0].useResponsesApi).toBe(false);
      expect(body.models[0].useStreaming).toBe(false);
    });

    test('returns empty list when no models exist', async () => {
      mockListTenantModels.mockResolvedValue([]);
      mockCountTenantModels.mockResolvedValue(0);

      const { status, body } = await request('GET', MODELS_BASE);

      expect(status).toBe(200);
      expect(body.models).toHaveLength(0);
      expect(body.pagination.total).toBe(0);
    });

    test('supports pagination query params', async () => {
      mockListTenantModels.mockResolvedValue([makeModel()]);
      mockCountTenantModels.mockResolvedValue(50);

      const { status, body } = await request('GET', `${MODELS_BASE}?page=2&limit=10`);

      expect(status).toBe(200);
      expect(body.pagination.page).toBe(2);
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.totalPages).toBe(5);
    });

    test('returns 404 when tenant context mismatch', async () => {
      // Request to a different tenant's path
      const { status, body } = await request('GET', '/api/tenants/other-tenant/models');

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Tenant not found');
    });
  });

  // ---------------------------------------------------------------------------
  // POST / — create model
  // ---------------------------------------------------------------------------
  describe('POST / (create model)', () => {
    test('returns 201 on successful model creation', async () => {
      const model = makeModel();
      mockCreateTenantModel.mockResolvedValue(model);

      const { status, body } = await request('POST', MODELS_BASE, {
        body: { displayName: 'GPT-4', modelId: 'gpt-4' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.model.displayName).toBe('GPT-4');
    });

    test('returns 400 when displayName is missing', async () => {
      const { status, body } = await request('POST', MODELS_BASE, {
        body: { modelId: 'gpt-4' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('displayName');
    });

    test('returns 400 when easy integration missing modelId', async () => {
      const { status, body } = await request('POST', MODELS_BASE, {
        body: { displayName: 'Test', integrationType: 'easy' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('modelId');
    });

    test('returns 400 when api integration missing endpointUrl', async () => {
      const { status, body } = await request('POST', MODELS_BASE, {
        body: { displayName: 'Test', integrationType: 'api' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('endpointUrl');
    });

    test('returns 400 for SSRF-like endpointUrl', async () => {
      const { status, body } = await request('POST', MODELS_BASE, {
        body: {
          displayName: 'Test',
          integrationType: 'api',
          endpointUrl: 'http://localhost:8080/api',
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid endpointUrl');
    });

    test('returns 400 for blocked custom header', async () => {
      const { status, body } = await request('POST', MODELS_BASE, {
        body: {
          displayName: 'Test',
          modelId: 'gpt-4',
          customHeaders: { Authorization: 'Bearer evil' },
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not allowed');
    });

    test('returns 409 on duplicate display name (mongo 11000)', async () => {
      const err: any = new Error('duplicate');
      err.code = 11000;
      mockCreateTenantModel.mockRejectedValue(err);

      const { status, body } = await request('POST', MODELS_BASE, {
        body: { displayName: 'GPT-4', modelId: 'gpt-4' },
      });

      expect(status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('DUPLICATE_MODEL');
      expect(body.error.message).toContain('already exists');
    });

    test('rejects unknown routing tiers before creating tenant model', async () => {
      mockCreateTenantModel.mockResolvedValue(makeModel());

      const { status, body } = await request('POST', MODELS_BASE, {
        body: {
          displayName: 'Premium Custom',
          modelId: 'gpt-4o',
          tier: 'premium',
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(mockCreateTenantModel).not.toHaveBeenCalled();
      expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
    });

    test('invalidates model-resolution caches after successful model creation', async () => {
      const model = makeModel({
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        tier: 'voice',
        capabilities: ['text', 'realtime_voice'],
      });
      mockCreateTenantModel.mockResolvedValue(model);

      const { status, body } = await request('POST', MODELS_BASE, {
        body: {
          displayName: 'GPT-4o Realtime Preview (2025-06-03)',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          provider: 'openai',
          tier: 'voice',
          capabilities: ['text', 'realtime_voice'],
        },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(mockCreateTenantModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: 'voice',
          capabilities: ['text', 'realtime_voice'],
        }),
      );
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-1');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:id — get model detail
  // ---------------------------------------------------------------------------
  describe('GET /:id (get model)', () => {
    test('returns 200 with model detail', async () => {
      mockFindTenantModelWithConnections.mockResolvedValue(makeModel());

      const { status, body } = await request('GET', `${MODELS_BASE}/model-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.model.id).toBe('model-1');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModelWithConnections.mockResolvedValue(null);

      const { status, body } = await request('GET', `${MODELS_BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 404 when model belongs to different tenant', async () => {
      // Repo now enforces tenantId at DB level — returns null for mismatched tenant
      mockFindTenantModelWithConnections.mockResolvedValue(null);

      const { status, body } = await request('GET', `${MODELS_BASE}/model-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 404 when tenant path does not match authenticated tenant', async () => {
      const { status, body } = await request('GET', '/api/tenants/other-tenant/models/model-1');

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Tenant not found');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /:id — update model
  // ---------------------------------------------------------------------------
  describe('PATCH /:id (update model)', () => {
    test('returns 200 on successful update', async () => {
      const existing = makeModel();
      mockFindTenantModel.mockResolvedValue(existing);
      const updated = makeModel({ displayName: 'GPT-4 Updated' });
      mockUpdateTenantModel.mockResolvedValue(updated);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
        body: { displayName: 'GPT-4 Updated' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.model.displayName).toBe('GPT-4 Updated');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/nonexistent`, {
        body: { displayName: 'New Name' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when model belongs to different tenant', async () => {
      // Repo now enforces tenantId at DB level — returns null for mismatched tenant
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
        body: { displayName: 'Hack' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 400 for invalid endpointUrl in update', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
        body: { endpointUrl: 'http://169.254.169.254/metadata' },
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Invalid endpointUrl');
    });

    test('returns 409 on duplicate name (mongo 11000)', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      const err: any = new Error('duplicate');
      err.code = 11000;
      mockUpdateTenantModel.mockRejectedValue(err);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
        body: { displayName: 'Taken' },
      });

      expect(status).toBe(409);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id — deactivate model
  // ---------------------------------------------------------------------------
  describe('DELETE /:id (deactivate model)', () => {
    test('returns 200 on successful deactivation', async () => {
      mockFindTenantModelWithConnections.mockResolvedValue(makeModel());
      mockFindProjectsUsingTenantModel.mockResolvedValue([]);
      mockDeleteTenantModel.mockResolvedValue(makeModel({ isActive: false }));

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deleted).toBe('model-1');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModelWithConnections.mockResolvedValue(null);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 409 when model has active project bindings', async () => {
      mockFindTenantModelWithConnections.mockResolvedValue(makeModel());
      mockFindProjectsUsingTenantModel.mockResolvedValue([
        { projectId: 'proj-1', projectName: 'Project One', tier: 'balanced' },
        { projectId: 'proj-2', projectName: 'Project Two', tier: 'fast' },
        { projectId: 'proj-3', projectName: 'Project Three', tier: 'quality' },
      ]);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1`);

      expect(status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error).toContain('projects');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:id/toggle-inference
  // ---------------------------------------------------------------------------
  describe('POST /:id/toggle-inference', () => {
    test('returns 200 when enabling inference', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel({ inferenceEnabled: false }));
      mockUpdateTenantModelInference.mockResolvedValue(undefined);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/toggle-inference`, {
        body: { inferenceEnabled: true },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.model.inferenceEnabled).toBe(true);
    });

    test('returns 200 when disabling inference', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel({ inferenceEnabled: true }));
      mockUpdateTenantModelInference.mockResolvedValue(undefined);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/toggle-inference`, {
        body: { inferenceEnabled: false },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.model.inferenceEnabled).toBe(false);
    });

    test('returns 400 when inferenceEnabled is not boolean', async () => {
      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/toggle-inference`, {
        body: { inferenceEnabled: 'yes' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('inferenceEnabled');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/toggle-inference`, {
        body: { inferenceEnabled: true },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });
  });
});

// =============================================================================
// CONNECTION SUB-ROUTES
// =============================================================================

describe('Tenant Model Connection Routes', () => {
  // ---------------------------------------------------------------------------
  // GET /:modelId/connections — list connections
  // ---------------------------------------------------------------------------
  describe('GET /:modelId/connections', () => {
    test('returns 200 with connections list', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnections.mockResolvedValue([makeConnection()]);

      const { status, body } = await request('GET', `${MODELS_BASE}/model-1/connections`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.connections).toHaveLength(1);
    });

    test('returns empty list when no connections', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnections.mockResolvedValue([]);

      const { status, body } = await request('GET', `${MODELS_BASE}/model-1/connections`);

      expect(status).toBe(200);
      expect(body.connections).toHaveLength(0);
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('GET', `${MODELS_BASE}/nonexistent/connections`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when model belongs to different tenant', async () => {
      // Repo now enforces tenantId at DB level — returns null for mismatched tenant
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('GET', `${MODELS_BASE}/model-1/connections`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:modelId/connections — create connection
  // ---------------------------------------------------------------------------
  describe('POST /:modelId/connections', () => {
    test('returns 201 on successful connection creation', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      const conn = makeConnection();
      mockCreateTenantModelConnection.mockResolvedValue(conn);
      mockSetConnectionPrimary.mockResolvedValue(undefined);
      mockFindTenantModelConnectionById.mockResolvedValue(conn);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-1' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.connection.credentialId).toBe('cred-1');
      expect(mockCreateTenantModelConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantModelId: 'model-1',
          tenantId: 'tenant-1',
          credentialId: 'cred-1',
        }),
      );
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-1',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns 201 with credentialId and isPrimary', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      const conn = makeConnection({ isPrimary: true });
      mockCreateTenantModelConnection.mockResolvedValue(conn);
      mockSetConnectionPrimary.mockResolvedValue(undefined);
      mockFindTenantModelConnectionById.mockResolvedValue(conn);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-1', isPrimary: true },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.connection.credentialId).toBe('cred-1');
    });

    test('returns 400 when credentialId is missing', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: {},
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('credentialId');
    });

    test('returns 404 when credential belongs to another tenant', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-foreign' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-foreign',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns 404 when credential belongs to another same-tenant user', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-other-user' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-other-user',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns 201 when creating connection without isPrimary', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      const conn = makeConnection({ isPrimary: false });
      mockCreateTenantModelConnection.mockResolvedValue(conn);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-2' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('POST', `${MODELS_BASE}/nonexistent/connections`, {
        body: { credentialId: 'cred-1' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 409 on duplicate connection (mongo 11000)', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      const err: any = new Error('duplicate');
      err.code = 11000;
      mockCreateTenantModelConnection.mockRejectedValue(err);

      const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
        body: { credentialId: 'cred-dup' },
      });

      expect(status).toBe(409);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /:modelId/connections/:connId — update connection
  // ---------------------------------------------------------------------------
  describe('PATCH /:modelId/connections/:connId', () => {
    test('returns 200 on successful connection update', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      const updated = makeConnection({ credentialId: 'cred-updated' });
      mockUpdateTenantModelConnection.mockResolvedValue(updated);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { credentialId: 'cred-updated' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.connection.credentialId).toBe('cred-updated');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { credentialId: 'cred-x' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('model not found');
    });

    test('returns 404 when connection not found', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/bad-id`, {
        body: { credentialId: 'cred-x' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Connection not found');
    });

    test('returns 404 when connection belongs to different model', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ tenantModelId: 'other-model' }),
      );

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { credentialId: 'cred-x' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when updated credential belongs to another tenant', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      mockFindCredentialById
        .mockResolvedValueOnce({
          _id: 'cred-1',
          tenantId: 'tenant-1',
          encryptedApiKey: 'sk-test',
        })
        .mockResolvedValueOnce(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { credentialId: 'cred-foreign' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockFindCredentialById).toHaveBeenNthCalledWith(
        2,
        'cred-foreign',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns 404 when updated credential belongs to another same-tenant user', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      mockFindCredentialById
        .mockResolvedValueOnce({
          _id: 'cred-1',
          tenantId: 'tenant-1',
          encryptedApiKey: 'sk-test',
        })
        .mockResolvedValueOnce(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { credentialId: 'cred-other-user' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockFindCredentialById).toHaveBeenNthCalledWith(
        2,
        'cred-other-user',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns 200 when updating isActive', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      const updated = makeConnection({ isActive: false });
      mockUpdateTenantModelConnection.mockResolvedValue(updated);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { isActive: false },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('returns 404 when existing connection is linked to another same-tenant user credential', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ credentialId: 'cred-other-user' }),
      );
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1/connections/conn-1`, {
        body: { isActive: false },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockUpdateTenantModelConnection).not.toHaveBeenCalled();
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-other-user',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:modelId/connections/:connId — delete connection
  // ---------------------------------------------------------------------------
  describe('DELETE /:modelId/connections/:connId', () => {
    test('returns 200 on successful connection deletion', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      mockDeleteTenantModelConnection.mockResolvedValue(undefined);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1/connections/conn-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deleted).toBe('conn-1');
    });

    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1/connections/conn-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when connection not found', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(null);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1/connections/bad-id`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when connection belongs to different model', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ tenantModelId: 'other-model' }),
      );

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1/connections/conn-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when existing connection is linked to another same-tenant user credential', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ credentialId: 'cred-other-user' }),
      );
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1/connections/conn-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Credential not found');
      expect(mockDeleteTenantModelConnection).not.toHaveBeenCalled();
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-other-user',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:modelId/connections/:connId/validate
  // ---------------------------------------------------------------------------
  describe('POST /:modelId/connections/:connId/validate', () => {
    test('returns 404 when model not found', async () => {
      mockFindTenantModel.mockResolvedValue(null);

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when connection not found', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(null);

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 503 when encryption unavailable', async () => {
      mockIsTenantEncryptionReady.mockReturnValue(false);

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(503);
      expect(body.success).toBe(false);
    });

    test('returns valid=false when no API key configured', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ credentialId: 'cred-no-key' }),
      );
      mockFindCredentialById.mockResolvedValueOnce({ encryptedApiKey: null });

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.valid).toBe(false);
      expect(body.message).toContain('No API key');
    });

    test('returns valid=false when linked credential is outside the tenant', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ credentialId: 'cred-foreign' }),
      );
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.valid).toBe(false);
      expect(body.message).toContain('No API key');
      expect(mockFindCredentialById).toHaveBeenCalledWith(
        'cred-foreign',
        'tenant-1',
        expect.objectContaining({ actorUserId: 'user-1' }),
      );
    });

    test('returns valid=false when linked credential belongs to another same-tenant user', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(
        makeConnection({ credentialId: 'cred-other-user' }),
      );
      mockFindCredentialById.mockResolvedValueOnce(null);

      const { status, body } = await request(
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

    test('returns valid=false when the linked credential cannot be decrypted', async () => {
      mockFindTenantModel.mockResolvedValue(makeModel());
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      mockResolveConnectionHealthInputFromCredential.mockRejectedValueOnce(
        new Error('bad ciphertext'),
      );

      const { status, body } = await request(
        'POST',
        `${MODELS_BASE}/model-1/connections/conn-1/validate`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.valid).toBe(false);
      expect(body.message).toContain('could not be decrypted');
      expect(mockCheckConnectionHealth).not.toHaveBeenCalled();
    });
  });
});
