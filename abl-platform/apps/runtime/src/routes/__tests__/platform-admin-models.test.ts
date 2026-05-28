/**
 * Platform Admin Model Provisioning Route Tests
 *
 * Tests for the platform admin routes that provision, update, revoke,
 * and manage LLM model connections for tenants.
 *
 * Connections reference LLMCredential documents via credentialId — API keys
 * are never stored directly on the connection subdocument.
 *
 * Mount: /api/platform/admin/tenant-models
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock auth middleware to bypass authentication and inject tenant context
vi.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = { userId: 'admin-user-1', tenantId: 'admin-tenant', isSuperAdmin: true };
    next();
  },
  platformAdminAuthMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = { userId: 'admin-user-1', tenantId: 'admin-tenant', isSuperAdmin: true };
    next();
  },
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePlatformAdmin: () => (_req: any, _res: any, next: any) => next(),
  requirePlatformAdminIp: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: () => 'test-request-id',
}));

vi.mock('../../config/index', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
}));

vi.mock('../../middleware/rate-limiter', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// model-cache-invalidation transitively pulls chat-resolution-service and runtime-executor
const mockInvalidateModelResolutionCaches = vi.fn();
vi.mock('../../services/llm/model-cache-invalidation', () => ({
  invalidateModelResolutionCaches: (...args: any[]) => mockInvalidateModelResolutionCaches(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock tenant-model-repo
const mockFindTenantModel = vi.fn();
const mockFindTenantModelWithConnections = vi.fn();
const mockListTenantModels = vi.fn();
const mockCountTenantModels = vi.fn();
const mockCreateTenantModel = vi.fn();
const mockUpdateTenantModel = vi.fn();
const mockFindTenantModelConnectionById = vi.fn();
const mockCreateTenantModelConnection = vi.fn();
const mockUpdateTenantModelConnection = vi.fn();
const mockDeleteTenantModelConnection = vi.fn();

vi.mock('../../repos/tenant-model-repo', () => ({
  findTenantModelAdmin: (...args: any[]) => mockFindTenantModel(...args),
  findTenantModel: (...args: any[]) => mockFindTenantModel(...args),
  findTenantModelWithConnectionsAdmin: (...args: any[]) =>
    mockFindTenantModelWithConnections(...args),
  findTenantModelWithConnections: (...args: any[]) => mockFindTenantModelWithConnections(...args),
  listTenantModels: (...args: any[]) => mockListTenantModels(...args),
  countTenantModels: (...args: any[]) => mockCountTenantModels(...args),
  createTenantModel: (...args: any[]) => mockCreateTenantModel(...args),
  updateTenantModelAdmin: (...args: any[]) => mockUpdateTenantModel(...args),
  updateTenantModel: (...args: any[]) => mockUpdateTenantModel(...args),
  findTenantModelConnectionById: (...args: any[]) => mockFindTenantModelConnectionById(...args),
  createTenantModelConnection: (...args: any[]) => mockCreateTenantModelConnection(...args),
  updateTenantModelConnection: (...args: any[]) => mockUpdateTenantModelConnection(...args),
  deleteTenantModelConnection: (...args: any[]) => mockDeleteTenantModelConnection(...args),
}));

// Mock auth-repo
const mockWriteAuditLog = vi.fn();

vi.mock('../../repos/auth-repo', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

// Mock LLMCredential model used in the route for credential creation/lookup
const mockLLMCredentialCreate = vi.fn();
const mockLLMCredentialFindById = vi.fn();
const mockLLMCredentialFindOne = vi.fn();
const mockLLMCredentialUpdateOne = vi.fn();
const mockTenantModelUpdateMany = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  LLMCredential: {
    create: (...args: any[]) => mockLLMCredentialCreate(...args),
    findById: (...args: any[]) => mockLLMCredentialFindById(...args),
    findOne: (...args: any[]) => mockLLMCredentialFindOne(...args),
    updateOne: (...args: any[]) => mockLLMCredentialUpdateOne(...args),
  },
  TenantModel: {
    updateMany: (...args: any[]) => mockTenantModelUpdateMany(...args),
  },
}));

// Mock session-llm-client
const mockClearProviderCache = vi.fn();
const mockCreateVercelProviderForValidation = vi.fn().mockReturnValue({ modelId: 'test' });
const mockCheckConnectionHealth = vi.fn();
const mockResolveConnectionHealthInputFromCredential = vi.fn();

vi.mock('../../services/llm/session-llm-client', () => ({
  clearProviderCache: (...args: any[]) => mockClearProviderCache(...args),
  createVercelProviderForValidation: (...args: any[]) =>
    mockCreateVercelProviderForValidation(...args),
}));

vi.mock('../../services/llm/model-health-service.js', () => ({
  checkConnectionHealth: (...args: any[]) => mockCheckConnectionHealth(...args),
  resolveConnectionHealthInputFromCredential: (...args: any[]) =>
    mockResolveConnectionHealthInputFromCredential(...args),
}));

// Mock Vercel AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'ok' }),
}));

// ─── Test App Setup ───────────────────────────────────────────────────────

async function createTestApp() {
  const { default: router } = await import('../../routes/platform-admin-models.js');
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/tenant-models', router);
  return app;
}

// ─── Test Data ────────────────────────────────────────────────────────────

const NOW = new Date('2026-02-20T00:00:00.000Z');

function makeProvisionedModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: 'target-tenant-1',
    displayName: 'Claude Sonnet Provisioned',
    integrationType: 'easy',
    modelId: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    endpointUrl: null,
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsStructured: false,
    capabilities: ['text'],
    tier: 'balanced',
    isDefault: false,
    isActive: true,
    inferenceEnabled: true,
    provisionedBy: 'admin-user-1',
    provisionedAt: NOW,
    provisioningNote: 'Enterprise agreement',
    connections: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    credentialId: 'cred-1',
    connectionType: 'http',
    isActive: true,
    isPrimary: true,
    healthStatus: 'unchecked',
    tenantModelId: 'model-1',
    createdBy: 'admin-user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Platform Admin Model Provisioning Routes', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: LLMCredential.create returns a credential with an _id
    mockLLMCredentialCreate.mockResolvedValue({ _id: 'cred-new' });
    mockResolveConnectionHealthInputFromCredential.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-decrypted-key',
      modelId: 'claude-sonnet-4-20250514',
    });
    mockCheckConnectionHealth.mockResolvedValue({
      valid: true,
      message: 'Credential is valid — inference test passed',
      status: 'healthy',
    });
    mockTenantModelUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    app = await createTestApp();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET / — List provisioned models
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET / — list provisioned models', () => {
    test('lists only provisioned models (provisionedBy !== null)', async () => {
      const provisionedModel = makeProvisionedModel();
      mockListTenantModels.mockResolvedValue([provisionedModel]);
      mockCountTenantModels.mockResolvedValue(1);

      const res = await request(app).get('/api/platform/admin/tenant-models').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.models).toHaveLength(1);
      expect(res.body.models[0].id).toBe('model-1');
      expect(res.body.models[0].provisionedBy).toBe('admin-user-1');
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 1,
        totalPages: 1,
      });

      // Verify the query includes the provisionedBy filter
      expect(mockListTenantModels).toHaveBeenCalledWith(
        expect.objectContaining({ provisionedBy: { $ne: null } }),
        expect.any(Object),
      );
    });

    test('filters by targetTenantId when provided', async () => {
      const model = makeProvisionedModel({ tenantId: 'specific-tenant' });
      mockListTenantModels.mockResolvedValue([model]);
      mockCountTenantModels.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/platform/admin/tenant-models?targetTenantId=specific-tenant')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.models).toHaveLength(1);

      // Verify the query includes both provisionedBy and tenantId filters
      expect(mockListTenantModels).toHaveBeenCalledWith(
        expect.objectContaining({
          provisionedBy: { $ne: null },
          tenantId: 'specific-tenant',
        }),
        expect.any(Object),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST / — Provision model for tenant
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST / — provision model for tenant', () => {
    test('provisions model with targetTenantId, sets provisionedBy and provisionedAt', async () => {
      const createdModel = makeProvisionedModel();
      mockCreateTenantModel.mockResolvedValue(createdModel);
      mockFindTenantModelWithConnections.mockResolvedValue(createdModel);

      const res = await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'Claude Sonnet Provisioned',
          modelId: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.model.provisionedBy).toBe('admin-user-1');

      // Verify createTenantModel was called with provisionedBy and provisionedAt
      expect(mockCreateTenantModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant-1',
          displayName: 'Claude Sonnet Provisioned',
          modelId: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          provisionedBy: 'admin-user-1',
          provisionedAt: expect.any(Date),
        }),
      );

      // Verify audit log was written
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:provision-model',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
        }),
      );
    });

    test('provisions model with initial connection — creates LLMCredential and links via credentialId', async () => {
      const createdModel = makeProvisionedModel();
      mockCreateTenantModel.mockResolvedValue(createdModel);
      mockLLMCredentialCreate.mockResolvedValue({ _id: 'cred-initial' });
      const createdConn = makeConnection({ credentialId: 'cred-initial' });
      mockCreateTenantModelConnection.mockResolvedValue(createdConn);
      mockFindTenantModelWithConnections.mockResolvedValue({
        ...createdModel,
        connections: [createdConn],
      });

      const res = await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'Claude Sonnet Provisioned',
          modelId: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          connection: {
            credentialName: 'Primary Key',
            apiKey: 'sk-ant-test-key',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);

      // Verify LLMCredential was created with the raw API key (plugin auto-encrypts)
      expect(mockLLMCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant-1',
          provider: 'anthropic',
          name: 'Primary Key',
          encryptedApiKey: 'sk-ant-test-key',
          authType: 'api_key',
          credentialScope: 'tenant',
        }),
      );

      // Verify connection was created with credentialId (not encryptedApiKey)
      expect(mockCreateTenantModelConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantModelId: 'model-1',
          credentialId: 'cred-initial',
          isPrimary: true,
        }),
      );

      // Response model should have connectionsCount
      expect(res.body.model.connectionsCount).toBe(1);
    });

    test('rejects when modelId missing for easy integration', async () => {
      const res = await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'Missing ModelId',
          integrationType: 'easy',
          // modelId intentionally omitted
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/modelId/i);
      expect(mockCreateTenantModel).not.toHaveBeenCalled();
    });

    test('rejects unknown model routing tier before provisioning', async () => {
      const res = await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'Invalid Tier Model',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          provider: 'openai',
          tier: 'voice-preview',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid request');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_enum_value',
            path: ['tier'],
          }),
        ]),
      );
      expect(mockCreateTenantModel).not.toHaveBeenCalled();
      expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
    });

    test('provisions voice tier model, clears same-tier default, and invalidates resolution cache', async () => {
      const createdModel = makeProvisionedModel({
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
        capabilities: ['text', 'streaming', 'realtime_voice'],
        isDefault: true,
      });
      mockCreateTenantModel.mockResolvedValue(createdModel);
      mockFindTenantModelWithConnections.mockResolvedValue(createdModel);

      const res = await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'GPT-4o Realtime Preview (2025-06-03)',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          provider: 'openai',
          tier: 'voice',
          capabilities: ['text', 'streaming', 'realtime_voice'],
          isDefault: true,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(mockTenantModelUpdateMany).toHaveBeenCalledWith(
        { tenantId: 'target-tenant-1', tier: 'voice', isDefault: true },
        { $set: { isDefault: false } },
      );
      expect(mockCreateTenantModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant-1',
          tier: 'voice',
          isDefault: true,
          capabilities: ['text', 'streaming', 'realtime_voice'],
        }),
      );
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('target-tenant-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /:id — Get provisioned model detail
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET /:id — get provisioned model detail', () => {
    test('returns provisioned model with connections (no API keys)', async () => {
      const conn = makeConnection();
      const model = makeProvisionedModel({ connections: [conn] });
      mockFindTenantModelWithConnections.mockResolvedValue(model);

      const res = await request(app).get('/api/platform/admin/tenant-models/model-1').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.model.id).toBe('model-1');
      expect(res.body.model.provisionedBy).toBe('admin-user-1');

      // Connections should be sanitized — credentialId present, no API key fields
      expect(res.body.connections).toHaveLength(1);
      expect(res.body.connections[0].id).toBe('conn-1');
      expect(res.body.connections[0].credentialId).toBe('cred-1');
      expect(res.body.connections[0].connectionType).toBe('http');
      expect(res.body.connections[0]).not.toHaveProperty('encryptedApiKey');
      expect(res.body.connections[0]).not.toHaveProperty('apiKey');
    });

    test('returns 404 for non-provisioned model', async () => {
      // Model exists but provisionedBy is null (tenant-created, not admin-provisioned)
      const tenantModel = makeProvisionedModel({ provisionedBy: null });
      mockFindTenantModelWithConnections.mockResolvedValue(tenantModel);

      const res = await request(app).get('/api/platform/admin/tenant-models/model-1').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PATCH /:id — Update provisioned model
  // ═══════════════════════════════════════════════════════════════════════

  describe('PATCH /:id — update provisioned model', () => {
    test('updates provisioned model settings', async () => {
      const existing = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(existing);
      const updatedModel = makeProvisionedModel({ temperature: 0.5, maxTokens: 8192 });
      mockUpdateTenantModel.mockResolvedValue(updatedModel);

      const res = await request(app)
        .patch('/api/platform/admin/tenant-models/model-1')
        .send({ temperature: 0.5, maxTokens: 8192 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.model.temperature).toBe(0.5);
      expect(res.body.model.maxTokens).toBe(8192);

      // Verify updateTenantModel was called
      expect(mockUpdateTenantModel).toHaveBeenCalledWith('model-1', {
        temperature: 0.5,
        maxTokens: 8192,
      });

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:update-model',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
        }),
      );

      // Verify provider cache is cleared
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalled();
    });

    test('clears same-tier default when updating provisioned model to default', async () => {
      const existing = makeProvisionedModel({ tier: 'balanced', isDefault: false });
      mockFindTenantModel.mockResolvedValue(existing);
      const updatedModel = makeProvisionedModel({ tier: 'voice', isDefault: true });
      mockUpdateTenantModel.mockResolvedValue(updatedModel);

      await request(app)
        .patch('/api/platform/admin/tenant-models/model-1')
        .send({ tier: 'voice', isDefault: true })
        .expect(200);

      expect(mockTenantModelUpdateMany).toHaveBeenCalledWith(
        {
          _id: { $ne: 'model-1' },
          tenantId: 'target-tenant-1',
          tier: 'voice',
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
      expect(mockUpdateTenantModel).toHaveBeenCalledWith('model-1', {
        tier: 'voice',
        isDefault: true,
      });
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('target-tenant-1');
    });

    test('returns 404 for non-provisioned model', async () => {
      // Model exists but not provisioned
      mockFindTenantModel.mockResolvedValue(makeProvisionedModel({ provisionedBy: null }));

      const res = await request(app)
        .patch('/api/platform/admin/tenant-models/model-1')
        .send({ temperature: 0.5 })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
      expect(mockUpdateTenantModel).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:id/connections — Add connection
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST /:id/connections — add connection', () => {
    test('creates LLMCredential then links via credentialId on connection', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      mockLLMCredentialCreate.mockResolvedValue({ _id: 'cred-new-conn' });

      const createdConn = makeConnection({
        id: 'conn-new',
        credentialId: 'cred-new-conn',
        isPrimary: false,
      });
      mockCreateTenantModelConnection.mockResolvedValue(createdConn);

      const res = await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections')
        .send({
          credentialName: 'Secondary Key',
          apiKey: 'sk-ant-new-key-123',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.connection.id).toBe('conn-new');
      expect(res.body.connection.credentialId).toBe('cred-new-conn');

      // Verify LLMCredential was created with the raw API key
      expect(mockLLMCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant-1',
          provider: 'anthropic',
          name: 'Secondary Key',
          encryptedApiKey: 'sk-ant-new-key-123',
          authType: 'api_key',
        }),
      );

      // Verify connection was created with credentialId (not encryptedApiKey)
      expect(mockCreateTenantModelConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantModelId: 'model-1',
          credentialId: 'cred-new-conn',
          createdBy: 'admin-user-1',
        }),
      );

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:add-connection',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-new',
            credentialId: 'cred-new-conn',
          }),
        }),
      );

      // Verify provider cache is cleared
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PATCH /:id/connections/:connId — Rotate API key
  // ═══════════════════════════════════════════════════════════════════════

  describe('PATCH /:id/connections/:connId — rotate API key', () => {
    test('rotates API key by updating linked LLMCredential', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const existingConn = makeConnection({ credentialId: 'cred-existing' });

      // Mock credential lookup and save
      const mockCredSave = vi.fn().mockResolvedValue(undefined);
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-existing',
        encryptedApiKey: 'old-key',
        authType: 'api_key',
        save: mockCredSave,
      });

      // Re-fetch returns updated connection
      const updatedConn = makeConnection({ credentialId: 'cred-existing' });
      // First call is the initial lookup, second is the re-fetch
      mockFindTenantModelConnectionById
        .mockResolvedValueOnce(existingConn)
        .mockResolvedValueOnce(updatedConn);

      const res = await request(app)
        .patch('/api/platform/admin/tenant-models/model-1/connections/conn-1')
        .send({ apiKey: 'sk-ant-rotated-key' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.connection.id).toBe('conn-1');

      // Verify the credential was looked up with tenant scoping and saved with new key
      expect(mockLLMCredentialFindOne).toHaveBeenCalledWith({
        _id: 'cred-existing',
        tenantId: 'target-tenant-1',
      });
      expect(mockCredSave).toHaveBeenCalled();

      // Verify audit log includes key rotation flag
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:update-connection',
          metadata: expect.objectContaining({
            hasKeyRotation: true,
          }),
        }),
      );

      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalled();
    });

    test('creates new credential when connection has no credentialId', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const existingConn = makeConnection({ credentialId: null });
      mockLLMCredentialCreate.mockResolvedValue({ _id: 'cred-brand-new' });

      const updatedConn = makeConnection({ credentialId: 'cred-brand-new' });
      mockFindTenantModelConnectionById
        .mockResolvedValueOnce(existingConn)
        .mockResolvedValueOnce(updatedConn);

      const res = await request(app)
        .patch('/api/platform/admin/tenant-models/model-1/connections/conn-1')
        .send({ apiKey: 'sk-ant-new-key' })
        .expect(200);

      expect(res.body.success).toBe(true);

      // Should have created a new credential
      expect(mockLLMCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant-1',
          encryptedApiKey: 'sk-ant-new-key',
        }),
      );

      // Should have updated connection with new credentialId
      expect(mockUpdateTenantModelConnection).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ credentialId: 'cred-brand-new' }),
        'target-tenant-1',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE /:id/connections/:connId — Remove connection
  // ═══════════════════════════════════════════════════════════════════════

  describe('DELETE /:id/connections/:connId — remove connection', () => {
    test('removes connection and deactivates linked credential', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const existingConn = makeConnection({ credentialId: 'cred-to-deactivate' });
      mockFindTenantModelConnectionById.mockResolvedValue(existingConn);
      mockDeleteTenantModelConnection.mockResolvedValue(undefined);
      mockLLMCredentialUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      const res = await request(app)
        .delete('/api/platform/admin/tenant-models/model-1/connections/conn-1')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe('conn-1');

      // Verify credential was deactivated (tenant-scoped)
      expect(mockLLMCredentialUpdateOne).toHaveBeenCalledWith(
        { _id: 'cred-to-deactivate', tenantId: 'target-tenant-1' },
        { $set: { isActive: false } },
      );

      expect(mockDeleteTenantModelConnection).toHaveBeenCalledWith('conn-1', 'target-tenant-1');

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:delete-connection',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-1',
          }),
        }),
      );

      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:id/revoke — Soft-revoke provisioned model
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST /:id/revoke — soft-revoke provisioned model', () => {
    test('sets isActive=false and inferenceEnabled=false', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      mockUpdateTenantModel.mockResolvedValue({
        ...model,
        isActive: false,
        inferenceEnabled: false,
      });

      const res = await request(app)
        .post('/api/platform/admin/tenant-models/model-1/revoke')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.revoked).toBe('model-1');

      // Verify the model was updated with both flags set to false
      expect(mockUpdateTenantModel).toHaveBeenCalledWith('model-1', {
        isActive: false,
        inferenceEnabled: false,
      });

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:revoke-model',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            displayName: 'Claude Sonnet Provisioned',
          }),
        }),
      );

      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:id/connections/:connId/validate — Validate connection
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST /:id/connections/:connId/validate — validate connection', () => {
    test('validates connection by looking up credential and calling provider', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const conn = makeConnection({ credentialId: 'cred-to-validate' });
      mockFindTenantModelConnectionById.mockResolvedValue(conn);

      // Encryption plugin auto-decrypts on findOne — returns plaintext
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-to-validate',
        encryptedApiKey: 'sk-decrypted-key',
        encryptedEndpoint: null,
        authConfig: null,
      });

      const res = await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections/conn-1/validate')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.valid).toBe(true);
      expect(res.body.message).toBe('Credential is valid — inference test passed');

      // Verify credential was looked up with tenant scoping
      expect(mockLLMCredentialFindOne).toHaveBeenCalledWith({
        _id: 'cred-to-validate',
        tenantId: 'target-tenant-1',
      });

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:validate-connection',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-1',
            valid: true,
            provider: 'anthropic',
          }),
        }),
      );
    });

    test('returns valid=false when no credential linked', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const conn = makeConnection({ credentialId: null });
      mockFindTenantModelConnectionById.mockResolvedValue(conn);
      mockLLMCredentialFindOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections/conn-1/validate')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.valid).toBe(false);
      expect(res.body.message).toMatch(/No API key configured/);
    });

    test('returns valid=false when the credential cannot be decrypted', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);

      const conn = makeConnection({ credentialId: 'cred-to-validate' });
      mockFindTenantModelConnectionById.mockResolvedValue(conn);
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-to-validate',
        encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
        _decryptionFailed: true,
      });
      mockResolveConnectionHealthInputFromCredential.mockRejectedValueOnce(
        new Error('bad ciphertext'),
      );

      const res = await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections/conn-1/validate')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.valid).toBe(false);
      expect(res.body.message).toContain('could not be decrypted');
      expect(mockCheckConnectionHealth).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Audit logging — every mutating operation
  // ═══════════════════════════════════════════════════════════════════════

  describe('Audit logging — platform-admin:* prefix on all mutations', () => {
    test('provision model writes audit log with platform-admin:provision-model', async () => {
      const createdModel = makeProvisionedModel();
      mockCreateTenantModel.mockResolvedValue(createdModel);
      mockFindTenantModelWithConnections.mockResolvedValue(createdModel);

      await request(app)
        .post('/api/platform/admin/tenant-models')
        .send({
          targetTenantId: 'target-tenant-1',
          displayName: 'Audit Test Model',
          modelId: 'claude-sonnet-4-20250514',
        })
        .expect(201);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:provision-model',
          userId: 'admin-user-1',
          tenantId: 'target-tenant-1',
          metadata: expect.objectContaining({
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('update model writes audit log with platform-admin:update-model', async () => {
      const existing = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(existing);
      mockUpdateTenantModel.mockResolvedValue({ ...existing, temperature: 0.3 });

      await request(app)
        .patch('/api/platform/admin/tenant-models/model-1')
        .send({ temperature: 0.3 })
        .expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:update-model',
          metadata: expect.objectContaining({
            fields: expect.arrayContaining(['temperature']),
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('add connection writes audit log with platform-admin:add-connection', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      mockLLMCredentialCreate.mockResolvedValue({ _id: 'cred-audit' });
      mockCreateTenantModelConnection.mockResolvedValue(
        makeConnection({ id: 'conn-audit', credentialId: 'cred-audit' }),
      );

      await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections')
        .send({ credentialName: 'Audit Conn', apiKey: 'sk-test' })
        .expect(201);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:add-connection',
          metadata: expect.objectContaining({
            connectionId: 'conn-audit',
            credentialId: 'cred-audit',
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('update connection writes audit log with platform-admin:update-connection', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      const conn = makeConnection();
      // First call is the initial lookup, second is the re-fetch after update
      mockFindTenantModelConnectionById.mockResolvedValueOnce(conn).mockResolvedValueOnce(conn);

      await request(app)
        .patch('/api/platform/admin/tenant-models/model-1/connections/conn-1')
        .send({ isActive: false })
        .expect(200);

      expect(mockUpdateTenantModelConnection).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ isActive: false }),
        'target-tenant-1',
      );

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:update-connection',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-1',
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('delete connection writes audit log with platform-admin:delete-connection', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      mockFindTenantModelConnectionById.mockResolvedValue(makeConnection());
      mockDeleteTenantModelConnection.mockResolvedValue(undefined);

      await request(app)
        .delete('/api/platform/admin/tenant-models/model-1/connections/conn-1')
        .expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:delete-connection',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-1',
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('revoke model writes audit log with platform-admin:revoke-model', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      mockUpdateTenantModel.mockResolvedValue({
        ...model,
        isActive: false,
        inferenceEnabled: false,
      });

      await request(app).post('/api/platform/admin/tenant-models/model-1/revoke').expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:revoke-model',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            requestId: 'test-request-id',
          }),
        }),
      );
    });

    test('validate connection writes audit log with platform-admin:validate-connection', async () => {
      const model = makeProvisionedModel();
      mockFindTenantModel.mockResolvedValue(model);
      const conn = makeConnection({ credentialId: 'cred-val' });
      mockFindTenantModelConnectionById.mockResolvedValue(conn);
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-val',
        encryptedApiKey: 'sk-test',
        encryptedEndpoint: null,
        authConfig: null,
      });

      await request(app)
        .post('/api/platform/admin/tenant-models/model-1/connections/conn-1/validate')
        .expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:validate-connection',
          metadata: expect.objectContaining({
            modelId: 'model-1',
            connectionId: 'conn-1',
            requestId: 'test-request-id',
          }),
        }),
      );
    });
  });
});
