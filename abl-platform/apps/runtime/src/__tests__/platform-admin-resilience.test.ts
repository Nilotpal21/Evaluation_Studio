/**
 * Platform Admin Resilience API Tests
 *
 * Verifies endpoints for inspecting and resetting circuit breakers
 * through the platform admin resilience API.
 *
 * Covers:
 * 1. GET /circuit-breakers — returns in-process CB states with backend info
 * 2. GET /tenants/:tenantId/health — returns tenant health from Redis registry
 * 3. POST /tenants/:tenantId/force-reset — force-resets all breakers for tenant
 * 4. POST /tenants/:tenantId/force-reset — validates body (rejects invalid targetState)
 * 5. POST /circuit-breakers/:breakerName/reset — resets single in-process breaker
 * 6. POST /circuit-breakers/:breakerName/reset — returns 404 for unknown breaker
 * 7. Audit logging: verify writeAuditLog called with correct action prefixes
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

// Mock auth middleware — inject admin context by default
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
  platformAdminAuthMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
}));

// Mock permission guards
vi.mock('@agent-platform/shared', async () => {
  const actual = await vi.importActual('@agent-platform/shared');
  return {
    ...actual,
    requirePlatformAdmin: () => (_req: any, _res: any, next: any) => next(),
    requirePlatformAdminIp: () => (_req: any, _res: any, next: any) => next(),
    getCurrentRequestId: () => 'test-req-id',
  };
});

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
}));

// Mock rate limiter
vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock audit log
const mockWriteAuditLog = vi.fn();
vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Mock hybrid CB registry
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockGetAllStates = vi.fn().mockReturnValue({
  'kms:local:tenant-1': { state: 'open', failures: 5 },
  'search-ai:tenant-1': { state: 'closed', failures: 0 },
});
const mockGetBreaker = vi.fn().mockReturnValue({
  reset: mockReset,
  isOpen: () => true,
  getState: () => 'open',
  getSnapshot: () => ({ state: 'open', failures: 5 }),
});
const mockIsUsingRedis = vi.fn().mockReturnValue(true);
vi.mock('../services/resilience/hybrid-cb-registry.js', () => ({
  getCircuitBreakerRegistry: () => ({
    getRegistry: () => ({
      getAllStates: mockGetAllStates,
    }),
    getBreaker: mockGetBreaker,
    isUsingRedis: mockIsUsingRedis,
  }),
}));

// Mock Redis client
vi.mock('../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => true,
  getRedisClient: () => ({}),
  getRedisHandle: () => ({
    client: {},
    isReady: () => true,
    duplicate: () => ({}).duplicate ? {}.duplicate() : {},
    disconnect: async () => {},
  }),
}));

// Mock @agent-platform/circuit-breaker — use a real class so `new` works correctly
const mockForceResetTenant = vi.fn().mockResolvedValue(undefined);
const mockGetTenantHealth = vi.fn().mockResolvedValue({
  tenantId: 'tenant-1',
  hasOpenCircuits: false,
  tenant: { state: 'CLOSED', failureCount: 0 },
  apps: [],
  llmProviders: [],
  toolServices: [],
});
vi.mock('@agent-platform/circuit-breaker', () => ({
  CircuitBreakerRegistry: class MockCircuitBreakerRegistry {
    getTenantHealth = mockGetTenantHealth;
    forceResetTenant = mockForceResetTenant;
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import platformAdminResilienceRouter from '../routes/platform-admin-resilience.js';

// =============================================================================
// HELPERS
// =============================================================================

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/resilience', platformAdminResilienceRouter);
  return app;
}

const TENANT_ID = 'tenant-1';

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin Resilience API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();

    // Reset default mock return values
    mockGetAllStates.mockReturnValue({
      'kms:local:tenant-1': { state: 'open', failures: 5 },
      'search-ai:tenant-1': { state: 'closed', failures: 0 },
    });
    mockIsUsingRedis.mockReturnValue(true);
  });

  // ─── GET /circuit-breakers ──────────────────────────────────────────────

  describe('GET /circuit-breakers', () => {
    test('returns breaker states with backend info', async () => {
      const res = await request(app).get('/api/platform/admin/resilience/circuit-breakers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.backend).toBe('redis');
      expect(res.body.data.breakers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'kms:local:tenant-1', state: 'open', failures: 5 }),
          expect.objectContaining({ name: 'search-ai:tenant-1', state: 'closed', failures: 0 }),
        ]),
      );
    });

    test('reports memory backend when Redis is not in use', async () => {
      mockIsUsingRedis.mockReturnValue(false);

      const res = await request(app).get('/api/platform/admin/resilience/circuit-breakers');

      expect(res.status).toBe(200);
      expect(res.body.data.backend).toBe('memory');
    });

    test('returns empty breakers array when no breakers exist', async () => {
      mockGetAllStates.mockReturnValue({});

      const res = await request(app).get('/api/platform/admin/resilience/circuit-breakers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.breakers).toEqual([]);
    });
  });

  // ─── GET /tenants/:tenantId/health ──────────────────────────────────────

  describe('GET /tenants/:tenantId/health', () => {
    test('returns tenant health from Redis registry', async () => {
      const res = await request(app).get(
        `/api/platform/admin/resilience/tenants/${TENANT_ID}/health`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tenantId).toBe(TENANT_ID);
      expect(res.body.data.healthy).toBe(true);
      expect(res.body.data.tenant).toEqual({ state: 'CLOSED', failureCount: 0 });
      expect(res.body.data.apps).toEqual([]);
      expect(res.body.data.llmProviders).toEqual([]);
      expect(res.body.data.toolServices).toEqual([]);
      expect(mockGetTenantHealth).toHaveBeenCalledWith(TENANT_ID);
    });

    test('reports healthy=false when tenant has open circuits', async () => {
      mockGetTenantHealth.mockResolvedValueOnce({
        tenantId: TENANT_ID,
        hasOpenCircuits: true,
        tenant: { state: 'OPEN', failureCount: 10 },
        apps: [{ appId: 'app-1', state: 'OPEN', failureCount: 5 }],
        llmProviders: [],
        toolServices: [],
      });

      const res = await request(app).get(
        `/api/platform/admin/resilience/tenants/${TENANT_ID}/health`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.healthy).toBe(false);
      expect(res.body.data.tenant.state).toBe('OPEN');
    });
  });

  // ─── POST /tenants/:tenantId/force-reset ────────────────────────────────

  describe('POST /tenants/:tenantId/force-reset', () => {
    test('resets all breakers for tenant and writes audit log', async () => {
      const res = await request(app)
        .post(`/api/platform/admin/resilience/tenants/${TENANT_ID}/force-reset`)
        .send({ targetState: 'CLOSED' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tenantId).toBe(TENANT_ID);
      expect(res.body.data.targetState).toBe('CLOSED');
      expect(res.body.data.message).toBe('All breakers reset');

      // Verify Redis registry force-reset was called
      expect(mockForceResetTenant).toHaveBeenCalledWith(TENANT_ID, 'CLOSED');

      // Verify in-process breaker reset for matching tenant
      expect(mockReset).toHaveBeenCalled();

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:force-reset-tenant-breakers',
          userId: 'admin-user-1',
          tenantId: TENANT_ID,
          metadata: expect.objectContaining({ targetState: 'CLOSED' }),
        }),
      );
    });

    test('defaults targetState to CLOSED when body is empty', async () => {
      const res = await request(app)
        .post(`/api/platform/admin/resilience/tenants/${TENANT_ID}/force-reset`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.targetState).toBe('CLOSED');
      expect(mockForceResetTenant).toHaveBeenCalledWith(TENANT_ID, 'CLOSED');
    });

    test('returns 400 for invalid targetState', async () => {
      const res = await request(app)
        .post(`/api/platform/admin/resilience/tenants/${TENANT_ID}/force-reset`)
        .send({ targetState: 'INVALID_STATE' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('resets only in-process breakers that match the tenant', async () => {
      // Two breakers: one matches tenant-1, the other does not
      mockGetAllStates.mockReturnValue({
        'kms:local:tenant-1': { state: 'open', failures: 5 },
        'search-ai:tenant-99': { state: 'open', failures: 3 },
      });

      await request(app)
        .post(`/api/platform/admin/resilience/tenants/${TENANT_ID}/force-reset`)
        .send({});

      // getBreaker should be called only for the breaker that includes 'tenant-1'
      expect(mockGetBreaker).toHaveBeenCalledWith('kms:local:tenant-1');
      // The 'tenant-99' breaker name does NOT contain 'tenant-1', so it should not be reset
      expect(mockGetBreaker).not.toHaveBeenCalledWith('search-ai:tenant-99');
    });
  });

  // ─── POST /circuit-breakers/:breakerName/reset ──────────────────────────

  describe('POST /circuit-breakers/:breakerName/reset', () => {
    test('resets named breaker and writes audit log', async () => {
      const breakerName = 'kms:local:tenant-1';

      const res = await request(app).post(
        `/api/platform/admin/resilience/circuit-breakers/${breakerName}/reset`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.breakerName).toBe(breakerName);
      expect(res.body.data.previousState).toBe('open');
      expect(res.body.data.newState).toBe('closed');

      // Verify breaker reset was called
      expect(mockGetBreaker).toHaveBeenCalledWith(breakerName);
      expect(mockReset).toHaveBeenCalled();

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:reset-circuit-breaker',
          userId: 'admin-user-1',
          tenantId: 'admin-tenant',
          metadata: expect.objectContaining({
            breakerName,
            previousState: 'open',
          }),
        }),
      );
    });

    test('returns 404 for unknown breaker name', async () => {
      const res = await request(app).post(
        '/api/platform/admin/resilience/circuit-breakers/nonexistent-breaker/reset',
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('nonexistent-breaker');
    });

    test('does not write audit log when breaker is not found', async () => {
      await request(app).post(
        '/api/platform/admin/resilience/circuit-breakers/unknown-breaker/reset',
      );

      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });
  });

  // ─── Audit Logging ────────────────────────────────────────────────────

  describe('Audit Logging', () => {
    test('all mutation endpoints log with platform-admin: prefix', async () => {
      // POST force-reset
      await request(app)
        .post(`/api/platform/admin/resilience/tenants/${TENANT_ID}/force-reset`)
        .send({});

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );

      mockWriteAuditLog.mockClear();

      // POST single breaker reset
      await request(app).post(
        '/api/platform/admin/resilience/circuit-breakers/kms:local:tenant-1/reset',
      );

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );
    });
  });
});
