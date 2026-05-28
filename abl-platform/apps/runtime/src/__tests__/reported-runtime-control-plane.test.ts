import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import tenantSdkChannelsRouter from '../routes/tenant-sdk-channels.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';

const CONTROL_PLANE_E2E_TIMEOUT_MS = 90_000;

describe('Reported runtime control-plane regressions', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/tenants/:tenantId/sdk-channels', tenantSdkChannelsRouter);
    });
  }, CONTROL_PLANE_E2E_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, CONTROL_PLANE_E2E_TIMEOUT_MS);

  test('tenant-scoped Web SDK route is mounted on the real runtime app', async () => {
    const response = await requestJson(harness, '/api/tenants/tenant-mount-smoke/sdk-channels');

    expect(response.status).toBe(401);
  });

  test(
    'tenant-scoped Web SDK CRUD works across repeated admin requests through the real runtime route',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('reported-tenant-sdk'),
        uniqueSlug('reported-tenant-sdk'),
        uniqueSlug('reported-project-sdk'),
      );

      const create = await requestJson<{
        success: boolean;
        data: {
          id: string;
          name: string;
          projectId: string;
          tenantId: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'reported-web-sdk',
          rateLimitRpm: 120,
          allowedOrigins: ['https://widget.example.com'],
        },
      });

      expect(create.status).toBe(201);
      expect(create.body.success).toBe(true);
      expect(create.body.data.projectId).toBe(admin.projectId);
      expect(create.body.data.tenantId).toBe(admin.tenantId);
      expect(create.body.data.name).toBe('reported-web-sdk');
      expect(create.body.data.apiKey).toMatch(/^pk_/);
      expect(create.body.data.rateLimitRpm).toBe(120);
      expect(create.body.data.allowedOrigins).toEqual(['https://widget.example.com']);

      const listAfterCreate = await requestJson<{
        success: boolean;
        data: Array<{
          id: string;
          name: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        }>;
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        headers: authHeaders(admin.token),
      });

      expect(listAfterCreate.status).toBe(200);
      expect(listAfterCreate.body.success).toBe(true);
      const createdChannel = listAfterCreate.body.data.find(
        (channel) => channel.id === create.body.data.id,
      );
      expect(createdChannel).toBeTruthy();
      expect(createdChannel?.apiKey).toMatch(/^pk_/);
      expect(createdChannel?.rateLimitRpm).toBe(120);
      expect(createdChannel?.allowedOrigins).toEqual(['https://widget.example.com']);

      const update = await requestJson<{
        success: boolean;
        data: {
          id: string;
          name: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${create.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          name: 'reported-web-sdk-renamed',
          isActive: false,
          rateLimitRpm: 240,
          allowedOrigins: ['https://updated.example.com'],
        },
      });

      expect(update.status).toBe(200);
      expect(update.body.success).toBe(true);
      expect(update.body.data.name).toBe('reported-web-sdk-renamed');
      expect(update.body.data.isActive).toBe(false);
      expect(update.body.data.apiKey).toMatch(/^pk_/);
      expect(update.body.data.rateLimitRpm).toBe(240);
      expect(update.body.data.allowedOrigins).toEqual(['https://updated.example.com']);

      const getAfterUpdate = await requestJson<{
        success: boolean;
        data: {
          id: string;
          name: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${create.body.data.id}`, {
        headers: authHeaders(admin.token),
      });

      expect(getAfterUpdate.status).toBe(200);
      expect(getAfterUpdate.body.success).toBe(true);
      expect(getAfterUpdate.body.data.name).toBe('reported-web-sdk-renamed');
      expect(getAfterUpdate.body.data.isActive).toBe(false);
      expect(getAfterUpdate.body.data.apiKey).toMatch(/^pk_/);
      expect(getAfterUpdate.body.data.rateLimitRpm).toBe(240);
      expect(getAfterUpdate.body.data.allowedOrigins).toEqual(['https://updated.example.com']);

      const clearConvenienceFields = await requestJson<{
        success: boolean;
        data: {
          id: string;
          name: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${create.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          rateLimitRpm: null,
          allowedOrigins: null,
        },
      });

      expect(clearConvenienceFields.status).toBe(200);
      expect(clearConvenienceFields.body.success).toBe(true);
      expect(clearConvenienceFields.body.data.apiKey).toMatch(/^pk_/);
      expect(clearConvenienceFields.body.data.rateLimitRpm).toBeUndefined();
      expect(clearConvenienceFields.body.data.allowedOrigins).toBeNull();

      const getAfterClear = await requestJson<{
        success: boolean;
        data: {
          id: string;
          name: string;
          apiKey: string | null;
          rateLimitRpm?: number;
          allowedOrigins?: string[] | null;
          isActive: boolean;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${create.body.data.id}`, {
        headers: authHeaders(admin.token),
      });

      expect(getAfterClear.status).toBe(200);
      expect(getAfterClear.body.success).toBe(true);
      expect(getAfterClear.body.data.name).toBe('reported-web-sdk-renamed');
      expect(getAfterClear.body.data.isActive).toBe(false);
      expect(getAfterClear.body.data.apiKey).toMatch(/^pk_/);
      expect(getAfterClear.body.data.rateLimitRpm).toBeUndefined();
      expect(getAfterClear.body.data.allowedOrigins).toBeNull();

      const deleteResponse = await requestJson<{ success: boolean }>(
        harness,
        `/api/tenants/${admin.tenantId}/sdk-channels/${create.body.data.id}`,
        {
          method: 'DELETE',
          headers: authHeaders(admin.token),
        },
      );

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.success).toBe(true);

      const listAfterDelete = await requestJson<{
        success: boolean;
        data: Array<{ id: string }>;
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        headers: authHeaders(admin.token),
      });

      expect(listAfterDelete.status).toBe(200);
      expect(listAfterDelete.body.success).toBe(true);
      expect(listAfterDelete.body.data.map((channel) => channel.id)).not.toContain(
        create.body.data.id,
      );
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'tenant-scoped SDK channel admin keeps allowed origins isolated per channel and accepts wildcard origins',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('reported-tenant-sdk-origins'),
        uniqueSlug('reported-tenant-sdk-origins'),
        uniqueSlug('reported-project-sdk-origins'),
      );

      const createA = await requestJson<{
        success: boolean;
        data: {
          id: string;
          publicApiKeyId: string;
          allowedOrigins?: string[] | null;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'reported-origins-a',
          allowedOrigins: ['https://*.example.com'],
        },
      });

      expect(createA.status).toBe(201);
      expect(createA.body.success).toBe(true);
      expect(createA.body.data.allowedOrigins).toEqual(['https://*.example.com']);

      const createB = await requestJson<{
        success: boolean;
        data: {
          id: string;
          publicApiKeyId: string;
          allowedOrigins?: string[] | null;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'reported-origins-b',
        },
      });

      expect(createB.status).toBe(201);
      expect(createB.body.success).toBe(true);
      expect(createB.body.data.publicApiKeyId).not.toBe(createA.body.data.publicApiKeyId);
      expect(createB.body.data.allowedOrigins).toBeNull();

      const updateA = await requestJson<{
        success: boolean;
        data: {
          allowedOrigins?: string[] | null;
          publicApiKeyId: string;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${createA.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          allowedOrigins: ['https://widget.example.com'],
        },
      });

      expect(updateA.status).toBe(200);
      expect(updateA.body.success).toBe(true);
      expect(updateA.body.data.allowedOrigins).toEqual(['https://widget.example.com']);

      const getB = await requestJson<{
        success: boolean;
        data: {
          publicApiKeyId: string;
          allowedOrigins?: string[] | null;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${createB.body.data.id}`, {
        headers: authHeaders(admin.token),
      });

      expect(getB.status).toBe(200);
      expect(getB.body.success).toBe(true);
      expect(getB.body.data.publicApiKeyId).toBe(createB.body.data.publicApiKeyId);
      expect(getB.body.data.allowedOrigins).toBeNull();
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );
});
