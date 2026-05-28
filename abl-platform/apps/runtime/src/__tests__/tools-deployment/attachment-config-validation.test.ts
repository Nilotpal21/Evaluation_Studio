/**
 * Attachment Config Validation & Integration Tests (INT-5 through INT-8)
 *
 * Tests Zod validation, upsert behavior, and resolver fallback using
 * real Express server + real MongoDB (MongoMemoryServer).
 *
 * Routes under test:
 *   GET  /api/projects/:projectId/attachment-config — resolved config
 *   PUT  /api/projects/:projectId/attachment-config — upsert overrides
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import attachmentConfigRouter from '../../routes/attachment-config.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { TenantAttachmentConfig, ProjectAttachmentConfig } from '@agent-platform/database';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AttachmentConfigResponse {
  success: boolean;
  data: {
    resolved: {
      enabled: boolean;
      maxFileSizeBytes: number;
      maxFilesPerSession: number;
      allowedMimeTypes: string[];
      piiPolicy: 'redact' | 'block' | 'allow';
      defaultProcessingMode: 'full' | 'metadata_only' | 'skip';
    };
    projectOverrides: {
      enabled?: boolean | null;
      maxFileSizeBytes?: number | null;
      allowedMimeTypes?: string[] | null;
      piiPolicy?: string | null;
      defaultProcessingMode?: string | null;
    } | null;
  };
  error?: { code: string; message: string };
}

interface ErrorResponse {
  success: boolean;
  error?: { code: string; message: string };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Attachment Config Validation & Integration', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/attachment-config', attachmentConfigRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterEach(async () => {
    await TenantAttachmentConfig.deleteMany({});
    await ProjectAttachmentConfig.deleteMany({});
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ─── INT-5: Zod rejects invalid body ─────────────────────────────────────

  describe('INT-5: Zod rejects invalid body', () => {
    let admin: { token: string; userId: string; tenantId: string; projectId: string };

    beforeEach(async () => {
      admin = await bootstrapProject(
        harness,
        uniqueEmail('cfg-zod-reject'),
        uniqueSlug('tenant-cfg-zod-reject'),
        uniqueSlug('proj-cfg-zod-reject'),
      );
    });

    test('rejects bad piiPolicy enum value', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { piiPolicy: 'invalid_policy' },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects negative maxFileSizeBytes', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { maxFileSizeBytes: -100 },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects non-integer maxFileSizeBytes', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { maxFileSizeBytes: 1024.5 },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects empty string in allowedMimeTypes array', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { allowedMimeTypes: ['image/png', ''] },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects wrong defaultProcessingMode enum', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { defaultProcessingMode: 'turbo' },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects enabled as string instead of boolean', async () => {
      const res = await requestJson<ErrorResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { enabled: 'yes' },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── INT-6: Zod accepts valid edge cases ──────────────────────────────────

  describe('INT-6: Zod accepts valid edge cases', () => {
    let admin: { token: string; userId: string; tenantId: string; projectId: string };

    beforeEach(async () => {
      admin = await bootstrapProject(
        harness,
        uniqueEmail('cfg-zod-accept'),
        uniqueSlug('tenant-cfg-zod-accept'),
        uniqueSlug('proj-cfg-zod-accept'),
      );
    });

    test('accepts null values for all fields', async () => {
      const res = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            enabled: null,
            maxFileSizeBytes: null,
            allowedMimeTypes: null,
            piiPolicy: null,
            defaultProcessingMode: null,
          },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('accepts empty allowedMimeTypes array', async () => {
      const res = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { allowedMimeTypes: [] },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resolved.allowedMimeTypes).toEqual([]);
    });

    test('accepts maxFileSizeBytes of zero', async () => {
      const res = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { maxFileSizeBytes: 0 },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resolved.maxFileSizeBytes).toBe(0);
    });

    test('accepts empty body (no fields to update)', async () => {
      const res = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {},
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('strips unknown fields', async () => {
      const res = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            maxFileSizeBytes: 1024,
            unknownField: 'should be stripped',
            anotherUnknown: 42,
          },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resolved.maxFileSizeBytes).toBe(1024);

      // Verify the unknown field is not stored
      const getRes = await requestJson<AttachmentConfigResponse>(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );
      const overrides = getRes.body.data.projectOverrides as Record<string, unknown>;
      expect(overrides).not.toHaveProperty('unknownField');
      expect(overrides).not.toHaveProperty('anotherUnknown');
    });

    test('accepts all valid processing modes', async () => {
      for (const mode of ['full', 'metadata_only', 'skip'] as const) {
        const res = await requestJson<AttachmentConfigResponse>(
          harness,
          `/api/projects/${admin.projectId}/attachment-config`,
          {
            method: 'PUT',
            headers: authHeaders(admin.token),
            body: { defaultProcessingMode: mode },
          },
        );
        expect(res.status).toBe(200);
        expect(res.body.data.resolved.defaultProcessingMode).toBe(mode);
      }
    });
  });

  // ─── INT-7: Config upsert creates and updates document ────────────────────

  test('INT-7: first PUT creates document, second PUT updates it', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-upsert'),
      uniqueSlug('tenant-cfg-upsert'),
      uniqueSlug('proj-cfg-upsert'),
    );

    // Initially no project overrides
    const initial = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(initial.body.data.projectOverrides).toBeNull();

    // First PUT: creates document
    const firstPut = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { piiPolicy: 'block', maxFileSizeBytes: 5000 },
      },
    );
    expect(firstPut.status).toBe(200);
    expect(firstPut.body.data.resolved.piiPolicy).toBe('block');
    expect(firstPut.body.data.resolved.maxFileSizeBytes).toBe(5000);

    // Verify document was created
    const afterFirst = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(afterFirst.body.data.projectOverrides).not.toBeNull();
    expect(afterFirst.body.data.projectOverrides?.piiPolicy).toBe('block');
    expect(afterFirst.body.data.projectOverrides?.maxFileSizeBytes).toBe(5000);

    // Second PUT: updates existing document, previous overrides preserved
    const secondPut = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { enabled: false },
      },
    );
    expect(secondPut.status).toBe(200);
    expect(secondPut.body.data.resolved.enabled).toBe(false);

    // Verify previous overrides are preserved
    const afterSecond = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(afterSecond.body.data.projectOverrides?.piiPolicy).toBe('block');
    expect(afterSecond.body.data.projectOverrides?.maxFileSizeBytes).toBe(5000);
    expect(afterSecond.body.data.projectOverrides?.enabled).toBe(false);
  });

  // ─── INT-8: Resolver falls through null fields to tenant config ───────────

  test('INT-8: resolver falls through null project fields to tenant config', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-fallthrough'),
      uniqueSlug('tenant-cfg-fallthrough'),
      uniqueSlug('proj-cfg-fallthrough'),
    );

    // Seed tenant config
    await TenantAttachmentConfig.create({
      tenantId: admin.tenantId,
      maxFileSizeBytes: 8 * 1024 * 1024,
      allowedMimeTypes: ['text/plain'],
      piiPolicy: 'allow',
      maxAttachmentsPerSession: 25,
    });

    // Set project overrides with some fields null
    await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          maxFileSizeBytes: 3 * 1024 * 1024, // project wins
          piiPolicy: null, // falls through to tenant
          allowedMimeTypes: null, // falls through to tenant
        },
      },
    );

    const res = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(res.status).toBe(200);

    // Project override wins
    expect(res.body.data.resolved.maxFileSizeBytes).toBe(3 * 1024 * 1024);

    // Null project fields fall through to tenant config
    expect(res.body.data.resolved.piiPolicy).toBe('allow');
    expect(res.body.data.resolved.allowedMimeTypes).toEqual(['text/plain']);
    expect(res.body.data.resolved.maxFilesPerSession).toBe(25);

    // Fields not in tenant config fall through to platform defaults
    expect(res.body.data.resolved.enabled).toBe(true);
    expect(res.body.data.resolved.defaultProcessingMode).toBe('full');
  });
});
