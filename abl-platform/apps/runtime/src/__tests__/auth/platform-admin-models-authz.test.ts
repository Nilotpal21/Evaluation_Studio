/**
 * Platform Admin Models Authorization Tests
 *
 * Verifies that all endpoints on the platform-admin-models route enforce
 * `requirePlatformAdmin()` — only callers with `isSuperAdmin: true` are allowed.
 *
 * Strategy:
 * - Mount the real platform-admin-models router on a real Express app with http.createServer
 * - Inject tenant context via the auth-context helper with varying roles / isSuperAdmin flag
 * - Do NOT mock requirePlatformAdmin — exercise the real middleware from @agent-platform/shared
 * - Mock all other dependencies (auth middleware, IP guard, repos, services) as stubs
 *
 * Endpoints under test (representative subset — all share the same middleware):
 *   GET    /api/platform-admin/models          (list provisioned models)
 *   POST   /api/platform-admin/models          (provision model)
 *   PATCH  /api/platform-admin/models/:id      (update model)
 *
 * Expected access matrix:
 *   isSuperAdmin: true   -> all pass (not 403)
 *   OWNER (no superAdmin) -> all 403
 *   ADMIN (no superAdmin) -> all 403
 *   Unauthenticated       -> all 401
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

const mockListTenantModels = vi.fn();
const mockCountTenantModels = vi.fn();
const mockFindTenantModelAdmin = vi.fn();
const mockFindTenantModelWithConnectionsAdmin = vi.fn();
const mockCreateTenantModel = vi.fn();
const mockUpdateTenantModelAdmin = vi.fn();
const mockFindTenantModelConnectionById = vi.fn();
const mockCreateTenantModelConnection = vi.fn();
const mockUpdateTenantModelConnection = vi.fn();
const mockDeleteTenantModelConnection = vi.fn();
const mockInvalidateModelResolutionCaches = vi.fn();
const mockTenantModelUpdateMany = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  platformAdminAuthMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Keep real requirePlatformAdmin but mock requirePlatformAdminIp (IP check is not under test)
vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requirePlatformAdminIp: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

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

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/tenant-model-repo.js', () => ({
  listTenantModels: (...args: any[]) => mockListTenantModels(...args),
  countTenantModels: (...args: any[]) => mockCountTenantModels(...args),
  findTenantModelAdmin: (...args: any[]) => mockFindTenantModelAdmin(...args),
  findTenantModelWithConnectionsAdmin: (...args: any[]) =>
    mockFindTenantModelWithConnectionsAdmin(...args),
  createTenantModel: (...args: any[]) => mockCreateTenantModel(...args),
  updateTenantModelAdmin: (...args: any[]) => mockUpdateTenantModelAdmin(...args),
  findTenantModelConnectionById: (...args: any[]) => mockFindTenantModelConnectionById(...args),
  createTenantModelConnection: (...args: any[]) => mockCreateTenantModelConnection(...args),
  updateTenantModelConnection: (...args: any[]) => mockUpdateTenantModelConnection(...args),
  deleteTenantModelConnection: (...args: any[]) => mockDeleteTenantModelConnection(...args),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  clearProviderCache: vi.fn(),
}));

// model-cache-invalidation transitively pulls chat-resolution-service and runtime-executor
vi.mock('../../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: any[]) => mockInvalidateModelResolutionCaches(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    updateMany: (...args: any[]) => mockTenantModelUpdateMany(...args),
  },
  LLMCredential: {
    create: vi.fn().mockResolvedValue({ _id: 'cred-1' }),
    findById: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    server: { publicUrl: 'http://localhost:3112' },
    security: { platformAdminAllowedIps: [] },
  })),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const MOUNT_PATH = '/api/platform-admin/models';

/**
 * Create a fresh Express app + HTTP server with the platform-admin-models router,
 * optionally injecting tenant context for the specified configuration.
 */
async function createAppWithContext(contextConfig?: {
  role: string;
  isSuperAdmin?: boolean;
}): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const app = express();
  app.use(express.json());

  if (contextConfig) {
    const overrides =
      contextConfig.isSuperAdmin !== undefined
        ? { isSuperAdmin: contextConfig.isSuperAdmin }
        : undefined;
    app.use(
      injectTenantContext(
        makeTenantContext('tenant-A', 'user-1', contextConfig.role as any, overrides),
      ),
    );
  }
  // When contextConfig is undefined, no tenantContext is injected (unauthenticated)

  const router = (await import('../../routes/platform-admin-models.js')).default;
  app.use(MOUNT_PATH, router);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ server, baseUrl });
    });
  });
}

/** JSON fetch helper with Content-Type header. */
async function jsonFetch(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function makeProvisionedModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    _id: 'model-1',
    tenantId: 'tenant-B',
    displayName: 'Test Model',
    integrationType: 'easy',
    modelId: 'gpt-4',
    provider: 'openai',
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
    provisionedBy: 'user-1',
    provisionedAt: new Date('2026-05-03T00:00:00.000Z'),
    provisioningNote: null,
    connections: [],
    createdAt: new Date('2026-05-03T00:00:00.000Z'),
    updatedAt: new Date('2026-05-03T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockListTenantModels.mockReset().mockResolvedValue([]);
  mockCountTenantModels.mockReset().mockResolvedValue(0);
  mockFindTenantModelAdmin.mockReset().mockResolvedValue(null);
  mockFindTenantModelWithConnectionsAdmin.mockReset().mockResolvedValue(null);
  mockCreateTenantModel.mockReset().mockResolvedValue(makeProvisionedModel());
  mockUpdateTenantModelAdmin.mockReset().mockResolvedValue(null);
  mockFindTenantModelConnectionById.mockReset().mockResolvedValue(null);
  mockCreateTenantModelConnection.mockReset().mockResolvedValue({ _id: 'conn-1', id: 'conn-1' });
  mockUpdateTenantModelConnection.mockReset().mockResolvedValue(null);
  mockDeleteTenantModelConnection.mockReset().mockResolvedValue(true);
  mockInvalidateModelResolutionCaches.mockReset();
  mockTenantModelUpdateMany.mockReset().mockResolvedValue({ modifiedCount: 0 });
});

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin Models Authorization', () => {
  // ---------------------------------------------------------------------------
  // Super Admin (isSuperAdmin: true) — should pass authorization on all endpoints
  // ---------------------------------------------------------------------------
  describe('Super Admin (isSuperAdmin: true) allowed', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createAppWithContext({ role: 'OWNER', isSuperAdmin: true });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / passes auth — returns 200', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${MOUNT_PATH}`);
      expect(status).toBe(200);
      expect(json.success).toBe(true);
    });

    test('POST / passes auth — returns non-403 (400 for missing fields or 201)', async () => {
      // Provision a model with required fields
      const { status } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'Test Model',
        integrationType: 'easy',
        modelId: 'gpt-4',
      });
      // Should not be 403 — passes auth; expect 201 for successful creation
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / rejects unknown model routing tier before provisioning', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'Invalid Tier Model',
        integrationType: 'easy',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice-preview',
      });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid request');
      expect(json.details).toEqual(
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

    test('POST / provisions voice tier model, clears same-tier default, and invalidates cache', async () => {
      const createdModel = makeProvisionedModel({
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        capabilities: ['text', 'streaming', 'realtime_voice'],
        tier: 'voice',
        isDefault: true,
      });
      mockCreateTenantModel.mockResolvedValue(createdModel);
      mockFindTenantModelWithConnectionsAdmin.mockResolvedValue(createdModel);

      const { status, json } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
        integrationType: 'easy',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        capabilities: ['text', 'streaming', 'realtime_voice'],
        tier: 'voice',
        isDefault: true,
      });

      expect(status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.model.tier).toBe('voice');
      expect(mockTenantModelUpdateMany).toHaveBeenCalledWith(
        { tenantId: 'tenant-B', tier: 'voice', isDefault: true },
        { $set: { isDefault: false } },
      );
      expect(mockCreateTenantModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-B',
          tier: 'voice',
          isDefault: true,
          capabilities: ['text', 'streaming', 'realtime_voice'],
        }),
      );
      expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-B');
    });

    test('PATCH /:id passes auth — returns non-403 (404 model not found)', async () => {
      const { status } = await jsonFetch(baseUrl, 'PATCH', `${MOUNT_PATH}/model-999`, {
        displayName: 'Updated',
      });
      // Model does not exist in mock, so expect 404, but NOT 403
      expect(status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // OWNER (without isSuperAdmin) — should be denied (403) on all endpoints
  // ---------------------------------------------------------------------------
  describe('OWNER (without isSuperAdmin) denied', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createAppWithContext({ role: 'OWNER' });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${MOUNT_PATH}`);
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });

    test('POST / returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'Test Model',
      });
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });

    test('PATCH /:id returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PATCH', `${MOUNT_PATH}/model-1`, {
        displayName: 'Updated',
      });
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });
  });

  // ---------------------------------------------------------------------------
  // ADMIN (without isSuperAdmin) — should be denied (403) on all endpoints
  // ---------------------------------------------------------------------------
  describe('ADMIN (without isSuperAdmin) denied', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createAppWithContext({ role: 'ADMIN' });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${MOUNT_PATH}`);
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });

    test('POST / returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'Test Model',
      });
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });

    test('PATCH /:id returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PATCH', `${MOUNT_PATH}/model-1`, {
        displayName: 'Updated',
      });
      expect(status).toBe(403);
      expect(json.error).toMatchObject({ message: 'Forbidden' });
      expect(json.message).toBe('This endpoint requires platform administrator access');
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated — no tenant context at all — should get 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests denied', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      // No context injected — simulates unauthenticated request
      const result = await createAppWithContext(undefined);
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / returns 401 without tenantContext', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${MOUNT_PATH}`);
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST / returns 401 without tenantContext', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'POST', `${MOUNT_PATH}`, {
        targetTenantId: 'tenant-B',
        displayName: 'Test Model',
      });
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PATCH /:id returns 401 without tenantContext', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PATCH', `${MOUNT_PATH}/model-1`, {
        displayName: 'Updated',
      });
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});
