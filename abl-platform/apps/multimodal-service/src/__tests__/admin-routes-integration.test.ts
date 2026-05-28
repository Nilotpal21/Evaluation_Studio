/**
 * Integration Tests — Admin Routes (Tenant Attachment Configuration)
 *
 * Tests the admin router endpoints for reading and updating per-tenant
 * attachment configuration. Uses an in-memory Express app with injected
 * TenantConfigService mock.
 *
 * Auth: requireInternalAuth expects X-Tenant-Id header matching :tenantId param.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../routes/admin.js';
import type { TenantConfigService } from '../services/tenant-config-service.js';
import type { ITenantAttachmentConfig } from '@agent-platform/database';

// =============================================================================
// HELPERS
// =============================================================================

function makeDefaultConfig(tenantId: string): ITenantAttachmentConfig {
  return {
    _id: 'cfg-123',
    tenantId,
    maxFileSizeBytes: 20 * 1024 * 1024,
    allowedMimeTypes: [],
    blockedMimeTypes: [],
    scanEnabled: true,
    processingEnabled: true,
    embeddingEnabled: true,
    maxAttachmentsPerSession: 100,
    maxTotalStorageBytes: 1024 * 1024 * 1024,
    retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
    _v: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as ITenantAttachmentConfig;
}

function makeConfigService(overrides: Partial<TenantConfigService> = {}): TenantConfigService {
  return {
    getConfig: vi
      .fn()
      .mockImplementation((tenantId: string) => Promise.resolve(makeDefaultConfig(tenantId))),
    updateConfig: vi
      .fn()
      .mockImplementation((tenantId: string) => Promise.resolve(makeDefaultConfig(tenantId))),
    validateUpload: vi.fn().mockResolvedValue({ allowed: true }),
    ...overrides,
  } as unknown as TenantConfigService;
}

function createApp(configService: TenantConfigService): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter(configService));
  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Admin Routes — Tenant Attachment Configuration', () => {
  let configService: ReturnType<typeof makeConfigService>;
  let app: express.Express;

  beforeEach(() => {
    configService = makeConfigService();
    app = createApp(configService);
  });

  // ===========================================================================
  // AUTH — requireInternalAuth
  // ===========================================================================

  describe('Authentication (requireInternalAuth)', () => {
    it('returns 401 when X-Tenant-Id header is missing', async () => {
      const res = await request(app).get('/admin/config/tenant-1');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when X-Tenant-Id header is empty', async () => {
      const res = await request(app).get('/admin/config/tenant-1').set('X-Tenant-Id', '');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 404 when X-Tenant-Id does not match :tenantId param (cross-tenant)', async () => {
      const res = await request(app).get('/admin/config/tenant-1').set('X-Tenant-Id', 'tenant-2');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ===========================================================================
  // GET /admin/config/:tenantId
  // ===========================================================================

  describe('GET /admin/config/:tenantId', () => {
    it('returns 200 with tenant config when auth is valid', async () => {
      const res = await request(app).get('/admin/config/tenant-1').set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.config).toBeDefined();
      expect(res.body.data.config.tenantId).toBe('tenant-1');
      expect(res.body.data.config.maxFileSizeBytes).toBe(20 * 1024 * 1024);
    });

    it('calls configService.getConfig with the tenantId', async () => {
      await request(app).get('/admin/config/tenant-abc').set('X-Tenant-Id', 'tenant-abc');

      expect(configService.getConfig).toHaveBeenCalledWith('tenant-abc');
    });

    it('returns 500 when configService.getConfig throws', async () => {
      configService = makeConfigService({
        getConfig: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      app = createApp(configService);

      const res = await request(app).get('/admin/config/tenant-1').set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // PUT /admin/config/:tenantId
  // ===========================================================================

  describe('PUT /admin/config/:tenantId', () => {
    it('returns 200 and persists changes with valid body', async () => {
      const updatedConfig = makeDefaultConfig('tenant-1');
      updatedConfig.maxFileSizeBytes = 50 * 1024 * 1024;
      updatedConfig.scanEnabled = false;
      configService = makeConfigService({
        updateConfig: vi.fn().mockResolvedValue(updatedConfig),
      });
      app = createApp(configService);

      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({
          maxFileSizeBytes: 50 * 1024 * 1024,
          scanEnabled: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.config.maxFileSizeBytes).toBe(50 * 1024 * 1024);
      expect(configService.updateConfig).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          maxFileSizeBytes: 50 * 1024 * 1024,
          scanEnabled: false,
        }),
      );
    });

    it('returns 401 without X-Tenant-Id header', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .send({ maxFileSizeBytes: 1024 * 1024 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when maxFileSizeBytes is below minimum', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ maxFileSizeBytes: 100 }); // below 1KB minimum

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when maxFileSizeBytes exceeds maximum', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ maxFileSizeBytes: 600 * 1024 * 1024 }); // above 500MB

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when allowedMimeTypes contains non-string entries', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ allowedMimeTypes: ['image/png', 42] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when boolean fields are not booleans', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ scanEnabled: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when retentionDays has invalid category', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ retentionDays: { spreadsheet: 30 } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when retentionDays value is out of range', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ retentionDays: { image: 0 } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid partial update with only some fields', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({
          processingEnabled: false,
          embeddingEnabled: true,
          blockedMimeTypes: ['application/x-executable'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(configService.updateConfig).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          processingEnabled: false,
          embeddingEnabled: true,
          blockedMimeTypes: ['application/x-executable'],
        }),
      );
    });

    it('accepts valid retentionDays update', async () => {
      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({
          retentionDays: { image: 30, document: 60 },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 500 when configService.updateConfig throws', async () => {
      configService = makeConfigService({
        updateConfig: vi.fn().mockRejectedValue(new Error('Write failed')),
      });
      app = createApp(configService);

      const res = await request(app)
        .put('/admin/config/tenant-1')
        .set('X-Tenant-Id', 'tenant-1')
        .send({ maxFileSizeBytes: 5 * 1024 * 1024 });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
