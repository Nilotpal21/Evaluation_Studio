/**
 * Platform Admin — Tenant Attachment Config Proxy Route Tests
 *
 * Tests the proxy route that forwards attachment configuration requests
 * to the multimodal-service admin API. All middleware is mocked to test
 * the route logic in isolation.
 *
 * Covers:
 * 1. GET / — proxies to multimodal-service, validates tenantId query param
 * 2. PUT / — validates body with Zod, proxies valid requests, writes audit log
 * 3. Error handling — proxy failure returns 502
 * 4. Body validation — rejects invalid field types and out-of-range values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

// Mock auth middleware — inject admin context by default
vi.mock('../middleware/auth.js', () => ({
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

// Mock rate limiter
vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock permission guards
vi.mock('@agent-platform/shared-auth', () => ({
  requirePlatformAdmin: () => (_req: any, _res: any, next: any) => next(),
  requirePlatformAdminIp: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock observability
vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: () => 'test-req-id',
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
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

// =============================================================================
// GLOBAL FETCH MOCK
// =============================================================================

const mockFetch = vi.fn();

// =============================================================================
// IMPORT AFTER MOCKS
// =============================================================================

import platformAdminAttachmentConfigRouter from '../routes/platform-admin-attachment-config.js';

// =============================================================================
// HELPERS
// =============================================================================

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/tenant-attachment-config', platformAdminAttachmentConfigRouter);
  return app;
}

function mockFetchSuccess(data: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    status,
    json: () => Promise.resolve(data),
  });
}

function mockFetchFailure(): void {
  mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
}

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin — Tenant Attachment Config Proxy', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockWriteAuditLog.mockReset();
    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // GET /
  // ===========================================================================

  describe('GET /', () => {
    it('returns 400 when tenantId query param is missing', async () => {
      const res = await request(app).get('/api/platform/admin/tenant-attachment-config');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when tenantId query param is empty', async () => {
      const res = await request(app).get('/api/platform/admin/tenant-attachment-config?tenantId=');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('proxies to multimodal-service and returns 200 with config', async () => {
      const mockConfig = {
        success: true,
        data: {
          config: {
            tenantId: 'tenant-1',
            maxFileSizeBytes: 20 * 1024 * 1024,
            scanEnabled: true,
          },
        },
      };
      mockFetchSuccess(mockConfig);

      const res = await request(app).get(
        '/api/platform/admin/tenant-attachment-config?tenantId=tenant-1',
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockConfig);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/config/tenant-1'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    it('returns 502 when multimodal-service is unreachable', async () => {
      mockFetchFailure();

      const res = await request(app).get(
        '/api/platform/admin/tenant-attachment-config?tenantId=tenant-1',
      );

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PROXY_ERROR');
    });
  });

  // ===========================================================================
  // PUT /
  // ===========================================================================

  describe('PUT /', () => {
    it('returns 400 when tenantId query param is missing', async () => {
      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config')
        .send({ maxFileSizeBytes: 5 * 1024 * 1024 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid body (maxFileSizeBytes too small)', async () => {
      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({ maxFileSizeBytes: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid body (unknown field in strict mode)', async () => {
      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({ unknownField: 'bad' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-boolean scanEnabled', async () => {
      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({ scanEnabled: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('proxies valid update and writes audit log', async () => {
      const mockResponse = {
        success: true,
        data: {
          config: {
            tenantId: 'tenant-1',
            maxFileSizeBytes: 50 * 1024 * 1024,
            scanEnabled: false,
          },
        },
      };
      mockFetchSuccess(mockResponse);

      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({
          maxFileSizeBytes: 50 * 1024 * 1024,
          scanEnabled: false,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResponse);

      // Verify fetch was called with correct body
      expect(mockFetch).toHaveBeenCalledOnce();
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toContain('/admin/config/tenant-1');
      expect(fetchCall[1].method).toBe('PUT');
      expect(JSON.parse(fetchCall[1].body)).toEqual({
        maxFileSizeBytes: 50 * 1024 * 1024,
        scanEnabled: false,
      });

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith({
        action: 'platform-admin:update-attachment-config',
        userId: 'admin-user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({
          updatedFields: ['maxFileSizeBytes', 'scanEnabled'],
        }),
      });
    });

    it('does not write audit log when proxy returns error status', async () => {
      mockFetchSuccess(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'DB error' } },
        500,
      );

      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({ maxFileSizeBytes: 5 * 1024 * 1024 });

      expect(res.status).toBe(500);
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });

    it('returns 502 when multimodal-service is unreachable', async () => {
      mockFetchFailure();

      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({ maxFileSizeBytes: 5 * 1024 * 1024 });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PROXY_ERROR');
    });

    it('accepts valid retentionDays update', async () => {
      const mockResponse = {
        success: true,
        data: { config: { tenantId: 'tenant-1' } },
      };
      mockFetchSuccess(mockResponse);

      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({
          retentionDays: { image: 30, document: 60 },
        });

      expect(res.status).toBe(200);
    });

    it('rejects retentionDays with invalid category', async () => {
      const res = await request(app)
        .put('/api/platform/admin/tenant-attachment-config?tenantId=tenant-1')
        .send({
          retentionDays: { spreadsheet: 30 },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
