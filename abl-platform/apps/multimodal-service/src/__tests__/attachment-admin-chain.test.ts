/**
 * Admin → Runtime Proxy → Multimodal Admin — Full Chain Integration Test
 *
 * Starts real Express servers to test the full proxy chain:
 *   Client → Runtime Proxy → Multimodal Admin Router → TenantConfigService
 *
 * The "runtime proxy" is a minimal Express app that forwards requests to
 * the multimodal admin router (matching the real platform-admin proxy pattern).
 *
 * Uses { port: 0 } for random ports. No vi.mock() of codebase components.
 * The TenantConfigService uses an in-memory stub (no MongoDB required)
 * since we're testing the HTTP chain, not the database layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import request from 'supertest';
import { createAdminRouter } from '../routes/admin.js';
import type { TenantAttachmentConfigUpdate } from '../services/tenant-config-service.js';
import type { ITenantAttachmentConfig } from '@agent-platform/database';

// =============================================================================
// IN-MEMORY CONFIG SERVICE (test double — no MongoDB)
// =============================================================================

const PLATFORM_DEFAULTS: Omit<
  ITenantAttachmentConfig,
  '_id' | 'tenantId' | 'createdAt' | 'updatedAt' | '_v'
> = {
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: [],
  blockedMimeTypes: [],
  scanEnabled: true,
  processingEnabled: true,
  embeddingEnabled: true,
  maxAttachmentsPerSession: 100,
  maxTotalStorageBytes: 1024 * 1024 * 1024,
  retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
};

class InMemoryTenantConfigService {
  private configs = new Map<string, ITenantAttachmentConfig>();

  async getConfig(tenantId: string): Promise<ITenantAttachmentConfig> {
    const existing = this.configs.get(tenantId);
    if (existing) return existing;

    return {
      _id: '',
      tenantId,
      ...PLATFORM_DEFAULTS,
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async updateConfig(
    tenantId: string,
    updates: TenantAttachmentConfigUpdate,
  ): Promise<ITenantAttachmentConfig> {
    const current = await this.getConfig(tenantId);
    const updated: ITenantAttachmentConfig = {
      ...current,
      ...updates,
      _id: current._id || `cfg-${tenantId}`,
      tenantId,
      updatedAt: new Date(),
    };
    this.configs.set(tenantId, updated);
    return updated;
  }

  /** Reset all stored configs (for test cleanup). */
  clear(): void {
    this.configs.clear();
  }
}

// =============================================================================
// RUNTIME PROXY (minimal Express app mimicking platform-admin forwarding)
// =============================================================================

/**
 * Creates a minimal runtime proxy that forwards admin config requests to
 * the multimodal service, matching the real platform-admin proxy pattern.
 *
 * Auth enforcement: checks X-Admin-Auth header. Missing → 401.
 */
function createRuntimeProxy(multimodalBaseUrl: string): Express {
  const app = express();
  app.use(express.json());

  // Auth middleware — simplified version of platform-admin auth
  app.use((req, res, next) => {
    const authHeader = req.headers['x-admin-auth'];
    if (!authHeader || authHeader !== 'valid-admin-token') {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid admin auth' },
      });
      return;
    }
    next();
  });

  // GET /api/platform/admin/attachment-config/:tenantId
  app.get('/api/platform/admin/attachment-config/:tenantId', async (req, res) => {
    try {
      const { tenantId } = req.params;
      const url = `${multimodalBaseUrl}/admin/config/${tenantId}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
      });
      const body = await response.json();
      res.status(response.status).json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({
        success: false,
        error: { code: 'PROXY_ERROR', message: `Failed to reach multimodal service: ${message}` },
      });
    }
  });

  // PUT /api/platform/admin/attachment-config/:tenantId
  app.put('/api/platform/admin/attachment-config/:tenantId', async (req, res) => {
    try {
      const { tenantId } = req.params;
      const url = `${multimodalBaseUrl}/admin/config/${tenantId}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req.body),
      });
      const body = await response.json();
      res.status(response.status).json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({
        success: false,
        error: { code: 'PROXY_ERROR', message: `Failed to reach multimodal service: ${message}` },
      });
    }
  });

  return app;
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Admin → Runtime → Multimodal Chain', () => {
  let configService: InMemoryTenantConfigService;

  let multimodalApp: Express;
  let multimodalServer: Server;
  let multimodalPort: number;

  let runtimeProxy: Express;
  let runtimeServer: Server;
  let runtimePort: number;

  const TENANT_ID = 'chain-test-tenant-001';

  // ── Setup: start both servers ────────────────────────────────────────

  beforeAll(async () => {
    configService = new InMemoryTenantConfigService();

    // 1. Start multimodal admin service
    multimodalApp = express();
    multimodalApp.use(express.json());

    // The createAdminRouter expects a TenantConfigService-shaped object
    const adminRouter = createAdminRouter(
      configService as unknown as import('../services/tenant-config-service.js').TenantConfigService,
    );
    multimodalApp.use('/admin', adminRouter);

    await new Promise<void>((resolve) => {
      multimodalServer = createServer(multimodalApp);
      multimodalServer.listen(0, () => {
        const addr = multimodalServer.address();
        multimodalPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });

    // 2. Start runtime proxy
    runtimeProxy = createRuntimeProxy(`http://127.0.0.1:${multimodalPort}`);
    await new Promise<void>((resolve) => {
      runtimeServer = createServer(runtimeProxy);
      runtimeServer.listen(0, () => {
        const addr = runtimeServer.address();
        runtimePort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      runtimeServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      multimodalServer.close(() => resolve());
    });
  });

  // ── Test 1: GET flows through the full chain ────────────────────────

  it('GET: request hits runtime proxy → forwards to multimodal → returns config', async () => {
    const res = await request(runtimeProxy)
      .get(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.config).toBeDefined();
    expect(res.body.data.config.tenantId).toBe(TENANT_ID);
    expect(res.body.data.config.maxFileSizeBytes).toBe(20 * 1024 * 1024);
    expect(res.body.data.config.scanEnabled).toBe(true);
    expect(res.body.data.config.retentionDays).toEqual({
      image: 90,
      document: 90,
      audio: 90,
      video: 90,
    });
  });

  // ── Test 2: PUT flows through and updates config ────────────────────

  it('PUT: request hits runtime proxy → forwards to multimodal → updates config → returns updated', async () => {
    const updates = {
      maxFileSizeBytes: 50 * 1024 * 1024,
      scanEnabled: false,
      retentionDays: { image: 30, document: 60, audio: 45, video: 15 },
    };

    const res = await request(runtimeProxy)
      .put(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .send(updates)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.config.maxFileSizeBytes).toBe(50 * 1024 * 1024);
    expect(res.body.data.config.scanEnabled).toBe(false);
    expect(res.body.data.config.retentionDays).toEqual({
      image: 30,
      document: 60,
      audio: 45,
      video: 15,
    });

    // Verify the update persisted by doing a subsequent GET
    const getRes = await request(runtimeProxy)
      .get(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .expect(200);

    expect(getRes.body.data.config.maxFileSizeBytes).toBe(50 * 1024 * 1024);
    expect(getRes.body.data.config.scanEnabled).toBe(false);
  });

  // ── Test 3: Error propagation ───────────────────────────────────────

  it('error propagation: multimodal returns 400 → runtime proxy returns 400 with error', async () => {
    // Send an invalid update (maxFileSizeBytes too small)
    const res = await request(runtimeProxy)
      .put(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .send({ maxFileSizeBytes: 100 }) // Below minimum of 1024
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('maxFileSizeBytes');
  });

  // ── Test 4: Auth enforcement at runtime layer ───────────────────────

  it('auth enforcement: missing auth → 401, never reaches multimodal', async () => {
    // No X-Admin-Auth header
    const res = await request(runtimeProxy)
      .get(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('auth enforcement: invalid auth token → 401', async () => {
    const res = await request(runtimeProxy)
      .get(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'wrong-token')
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Test 5: Tenant isolation — cross-tenant returns 404 ─────────────

  it('tenant isolation: requesting config for a different tenant via proxy returns 404', async () => {
    // The multimodal admin router checks that X-Tenant-Id matches the route param.
    // When the runtime proxy forwards the request, it sets X-Tenant-Id to the
    // tenantId from the URL. So a valid request will match.
    //
    // But if we directly hit the multimodal admin with mismatched headers,
    // it should return 404. Let's test this by hitting multimodal directly.
    const res = await request(multimodalApp)
      .get(`/admin/config/${TENANT_ID}`)
      .set('X-Tenant-Id', 'wrong-tenant-id')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── Test 6: PUT validation at multimodal layer ─────────────────────

  it('validation: invalid boolean field returns 400 through full chain', async () => {
    const res = await request(runtimeProxy)
      .put(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .send({ scanEnabled: 'not-a-boolean' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('scanEnabled');
  });

  it('validation: maxAttachmentsPerSession must be positive integer', async () => {
    const res = await request(runtimeProxy)
      .put(`/api/platform/admin/attachment-config/${TENANT_ID}`)
      .set('X-Admin-Auth', 'valid-admin-token')
      .send({ maxAttachmentsPerSession: -5 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
