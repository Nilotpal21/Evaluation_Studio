/**
 * Attachment Config E2E Tests (E2E-1 through E2E-8)
 *
 * Exercises the attachment config API through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real middleware chain.
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
  startMultimodalServiceHarness,
  type MultimodalServiceHarness,
} from '../helpers/multimodal-service-harness.js';
import {
  authHeaders,
  bootstrapProject,
  devLogin,
  addMember,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { TenantAttachmentConfig, ProjectAttachmentConfig } from '@agent-platform/database';
import { ProjectMember, Session } from '@agent-platform/database/models';
import attachmentsRouter from '../../routes/attachments.js';

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

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Attachment Config E2E', () => {
  let harness: RuntimeApiHarness;
  let multimodal: MultimodalServiceHarness;

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/projects/:projectId/attachment-config', attachmentConfigRouter);
        app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);
      },
      { MULTIMODAL_SERVICE_URL: multimodal.baseUrl },
    );
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterEach(async () => {
    // Clean up tenant configs that may leak between tests
    await TenantAttachmentConfig.deleteMany({});
    await ProjectAttachmentConfig.deleteMany({});
  });

  afterAll(async () => {
    await harness.close();
    await multimodal.close();
  }, 30_000);

  // ─── E2E-1: View default config (no overrides) ────────────────────────────

  test('E2E-1: returns platform defaults when no overrides exist', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-default'),
      uniqueSlug('tenant-cfg-default'),
      uniqueSlug('proj-cfg-default'),
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
    expect(res.body.success).toBe(true);

    const { resolved, projectOverrides } = res.body.data;

    // Platform defaults
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxFileSizeBytes).toBe(20 * 1024 * 1024);
    expect(resolved.maxFilesPerSession).toBe(100);
    expect(resolved.piiPolicy).toBe('redact');
    expect(resolved.defaultProcessingMode).toBe('full');

    // Verify MIME types (platform defaults include 16 types)
    expect(resolved.allowedMimeTypes).toContain('image/jpeg');
    expect(resolved.allowedMimeTypes).toContain('image/png');
    expect(resolved.allowedMimeTypes).toContain('application/pdf');
    expect(resolved.allowedMimeTypes).toContain('text/markdown');
    expect(resolved.allowedMimeTypes).toContain('text/plain');
    expect(resolved.allowedMimeTypes).toContain('text/csv');
    expect(resolved.allowedMimeTypes).toContain('video/mp4');
    expect(resolved.allowedMimeTypes.length).toBe(18);

    // No project overrides
    expect(projectOverrides).toBeNull();
  });

  // ─── E2E-2: Override single field and verify persistence ──────────────────

  test('E2E-2: PUT override persists and is returned by GET', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-override'),
      uniqueSlug('tenant-cfg-override'),
      uniqueSlug('proj-cfg-override'),
    );

    // PUT: override maxFileSizeBytes
    const putRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { maxFileSizeBytes: 5 * 1024 * 1024 },
      },
    );

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.data.resolved.maxFileSizeBytes).toBe(5 * 1024 * 1024);

    // GET: verify override persisted
    const getRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.resolved.maxFileSizeBytes).toBe(5 * 1024 * 1024);
    expect(getRes.body.data.projectOverrides).not.toBeNull();
    expect(getRes.body.data.projectOverrides?.maxFileSizeBytes).toBe(5 * 1024 * 1024);

    // Other fields remain at platform defaults
    expect(getRes.body.data.resolved.enabled).toBe(true);
    expect(getRes.body.data.resolved.piiPolicy).toBe('redact');
    expect(getRes.body.data.resolved.defaultProcessingMode).toBe('full');
  });

  // ─── E2E-3: Reset field to default (send null) ───────────────────────────

  test('E2E-3: sending null resets field to platform default', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-reset'),
      uniqueSlug('tenant-cfg-reset'),
      uniqueSlug('proj-cfg-reset'),
    );

    // First, set an override
    await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { piiPolicy: 'block' },
      },
    );

    // Verify override is active
    const before = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(before.body.data.resolved.piiPolicy).toBe('block');

    // Reset by sending null
    await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { piiPolicy: null },
      },
    );

    // Verify it falls back to platform default
    const after = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(after.body.data.resolved.piiPolicy).toBe('redact');
  });

  // ─── E2E-4: Config change — disable / re-enable round-trip ───────────────

  test('E2E-4: disable and re-enable attachments round-trip', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-toggle'),
      uniqueSlug('tenant-cfg-toggle'),
      uniqueSlug('proj-cfg-toggle'),
    );

    // Default: enabled
    const initial = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(initial.body.data.resolved.enabled).toBe(true);

    // Disable
    const disableRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { enabled: false },
      },
    );
    expect(disableRes.body.data.resolved.enabled).toBe(false);

    // Verify disabled persists via GET
    const disabled = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(disabled.body.data.resolved.enabled).toBe(false);

    // Re-enable
    const enableRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { enabled: true },
      },
    );
    expect(enableRes.body.data.resolved.enabled).toBe(true);

    // Verify re-enabled persists via GET
    const reenabled = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(reenabled.body.data.resolved.enabled).toBe(true);
  });

  // ─── E2E-5: Permission gating (read vs write) ────────────────────────────

  test('E2E-5: clearPermissionCache refreshes attachment-config auth after a tenant role change', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-perm'),
      uniqueSlug('tenant-cfg-perm'),
      uniqueSlug('proj-cfg-perm'),
    );

    // Admin can read config (tenant owner has *:* permissions)
    const adminGet = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(adminGet.status).toBe(200);
    expect(adminGet.body.success).toBe(true);

    // Admin can write config
    const adminPut = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { piiPolicy: 'allow' },
      },
    );
    expect(adminPut.status).toBe(200);
    expect(adminPut.body.success).toBe(true);

    // Create a second user with MEMBER tenant role (no project:* bypass)
    const viewerEmail = uniqueEmail('cfg-viewer');
    const viewer = await devLogin(harness, viewerEmail);
    await addMember(harness, admin.token, admin.tenantId, viewerEmail, 'MEMBER');

    // Clear permission cache so the new member's permissions are resolved
    clearPermissionCache();

    // Add viewer as project member with viewer role (direct model insert —
    // no runtime API exists for project member management)
    await ProjectMember.create({
      projectId: admin.projectId,
      userId: viewer.user.id,
      role: 'viewer',
    });

    // Log in again to get fresh token with tenant context
    const viewerLogin = await devLogin(harness, viewerEmail);
    clearPermissionCache();

    // Viewer CAN read config (attachment:read is in viewer permissions)
    const viewerGet = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(viewerLogin.accessToken),
      },
    );
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.success).toBe(true);
    expect(viewerGet.body.data.resolved.piiPolicy).toBe('allow'); // admin's override

    // Viewer should be denied on PUT (attachment:write not in viewer permissions)
    const viewerPut = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(viewerLogin.accessToken),
        body: { enabled: false },
      },
    );
    expect(viewerPut.status).toBe(403);
    expect(viewerPut.body.success).toBe(false);

    const promotedViewer = await requestJson<{
      success: boolean;
      member: { role: string };
    }>(harness, `/api/platform/admin/tenants/${admin.tenantId}/members/${viewer.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { role: 'OWNER' },
    });
    expect(promotedViewer.status).toBe(200);
    expect(promotedViewer.body.success).toBe(true);
    expect(promotedViewer.body.member.role).toBe('OWNER');

    clearPermissionCache();

    const promotedViewerPut = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(viewerLogin.accessToken),
        body: { enabled: false },
      },
    );
    expect(promotedViewerPut.status).toBe(200);
    expect(promotedViewerPut.body.success).toBe(true);

    const demotedViewer = await requestJson<{
      success: boolean;
      member: { role: string };
    }>(harness, `/api/platform/admin/tenants/${admin.tenantId}/members/${viewer.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { role: 'MEMBER' },
    });
    expect(demotedViewer.status).toBe(200);
    expect(demotedViewer.body.success).toBe(true);
    expect(demotedViewer.body.member.role).toBe('MEMBER');

    const staleDemotedViewerPut = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(viewerLogin.accessToken),
        body: { enabled: true },
      },
    );
    expect(staleDemotedViewerPut.status).toBe(200);
    expect(staleDemotedViewerPut.body.success).toBe(true);

    clearPermissionCache();

    const refreshedDemotedViewerPut = await requestJson<{
      success: boolean;
      error?: { code: string };
    }>(harness, `/api/projects/${admin.projectId}/attachment-config`, {
      method: 'PUT',
      headers: authHeaders(viewerLogin.accessToken),
      body: { enabled: false },
    });
    expect(refreshedDemotedViewerPut.status).toBe(403);
    expect(refreshedDemotedViewerPut.body.success).toBe(false);
  });

  // ─── E2E-6: Falsy-but-valid overrides persist ────────────────────────────

  test('E2E-6: falsy-but-valid overrides persist (false, 0, empty array)', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-falsy'),
      uniqueSlug('tenant-cfg-falsy'),
      uniqueSlug('proj-cfg-falsy'),
    );

    // PUT: set falsy-but-valid values
    const putRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          enabled: false,
          maxFileSizeBytes: 0,
          allowedMimeTypes: [],
        },
      },
    );

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);

    // Verify via GET
    const getRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(getRes.body.data.resolved.enabled).toBe(false);
    expect(getRes.body.data.resolved.maxFileSizeBytes).toBe(0);
    expect(getRes.body.data.resolved.allowedMimeTypes).toEqual([]);

    // Verify project overrides reflect these values
    expect(getRes.body.data.projectOverrides).not.toBeNull();
    expect(getRes.body.data.projectOverrides?.enabled).toBe(false);
    expect(getRes.body.data.projectOverrides?.maxFileSizeBytes).toBe(0);
    expect(getRes.body.data.projectOverrides?.allowedMimeTypes).toEqual([]);
  });

  // ─── E2E-7: Tenant config fallback (3-tier resolution) ───────────────────

  test('E2E-7: tenant config provides fallback in 3-tier resolution', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-tenant'),
      uniqueSlug('tenant-cfg-tenant'),
      uniqueSlug('proj-cfg-tenant'),
    );

    // Seed TenantAttachmentConfig via direct model insert
    // (no API route exists for tenant attachment config)
    await TenantAttachmentConfig.create({
      tenantId: admin.tenantId,
      maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB (overrides platform 20 MB)
      allowedMimeTypes: ['image/png', 'application/pdf'],
      piiPolicy: 'block',
      maxAttachmentsPerSession: 50,
    });

    // GET: with no project overrides, should fall through to tenant config
    const getRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.resolved.maxFileSizeBytes).toBe(10 * 1024 * 1024);
    expect(getRes.body.data.resolved.allowedMimeTypes).toEqual(['image/png', 'application/pdf']);
    expect(getRes.body.data.resolved.piiPolicy).toBe('block');
    expect(getRes.body.data.resolved.maxFilesPerSession).toBe(50);

    // Fields not in tenant config should still be platform defaults
    expect(getRes.body.data.resolved.enabled).toBe(true);
    expect(getRes.body.data.resolved.defaultProcessingMode).toBe('full');

    // No project overrides
    expect(getRes.body.data.projectOverrides).toBeNull();

    // Now add a project override for maxFileSizeBytes — it should win over tenant
    await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { maxFileSizeBytes: 2 * 1024 * 1024 },
      },
    );

    const afterOverride = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    // Project override wins
    expect(afterOverride.body.data.resolved.maxFileSizeBytes).toBe(2 * 1024 * 1024);
    // Tenant config still provides other fields
    expect(afterOverride.body.data.resolved.allowedMimeTypes).toEqual([
      'image/png',
      'application/pdf',
    ]);
    expect(afterOverride.body.data.resolved.piiPolicy).toBe('block');
  });

  // ─── E2E-8: Cross-tenant isolation ────────────────────────────────────────

  test('E2E-8: cross-tenant access returns 404', async () => {
    // Create Tenant A with a project
    const tenantA = await bootstrapProject(
      harness,
      uniqueEmail('cfg-iso-a'),
      uniqueSlug('tenant-cfg-iso-a'),
      uniqueSlug('proj-cfg-iso-a'),
    );

    // Set overrides on Tenant A's project
    await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${tenantA.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(tenantA.token),
        body: { piiPolicy: 'allow' },
      },
    );

    // Create Tenant B
    const tenantB = await bootstrapProject(
      harness,
      uniqueEmail('cfg-iso-b'),
      uniqueSlug('tenant-cfg-iso-b'),
      uniqueSlug('proj-cfg-iso-b'),
    );

    // Tenant B tries to GET Tenant A's project config -> 404
    const crossGet = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${tenantA.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(tenantB.token),
      },
    );
    expect(crossGet.status).toBe(404);

    // Tenant B tries to PUT Tenant A's project config -> 404
    const crossPut = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${tenantA.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(tenantB.token),
        body: { enabled: false },
      },
    );
    expect(crossPut.status).toBe(404);

    // Verify Tenant A's config is unchanged
    const tenantAConfig = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${tenantA.projectId}/attachment-config`,
      {
        method: 'GET',
        headers: authHeaders(tenantA.token),
      },
    );
    expect(tenantAConfig.status).toBe(200);
    expect(tenantAConfig.body.data.resolved.piiPolicy).toBe('allow');
  });

  // ─── E2E-9: Disabling config blocks uploads (GAP-006) ───────────────────

  test('E2E-9: disabling attachments via config blocks upload endpoint', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-upload-block'),
      uniqueSlug('tenant-cfg-upload'),
      uniqueSlug('proj-cfg-upload'),
    );

    // Create a session for the upload endpoint (direct model — no session API in harness)
    const sessionId = 'sess-upload-block-test';
    const now = new Date();
    await Session.create({
      _id: sessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      initiatedById: admin.userId,
      currentAgent: 'test-agent',
      environment: 'dev',
      channel: 'api',
      channelHistory: ['api'],
      status: 'active',
      context: {},
      metadata: {},
      messageCount: 0,
      tokenCount: 0,
      estimatedCost: 0,
      errorCount: 0,
      handoffCount: 0,
      identityTier: 0,
      startedAt: now,
      lastActivityAt: now,
    });

    // Step 1: Disable attachments via config API
    const disableRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { enabled: false },
      },
    );
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.data.resolved.enabled).toBe(false);

    // Step 2: Attempt upload — should get 403 ATTACHMENTS_DISABLED
    const uploadBlocked = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
    }>(harness, `/api/projects/${admin.projectId}/sessions/${sessionId}/attachments`, {
      method: 'POST',
      headers: {
        ...authHeaders(admin.token),
        'content-type': 'multipart/form-data; boundary=----testboundary',
      },
    });
    expect(uploadBlocked.status).toBe(403);
    expect(uploadBlocked.body.success).toBe(false);
    expect(uploadBlocked.body.error?.code).toBe('ATTACHMENTS_DISABLED');

    // Step 3: Re-enable attachments
    const enableRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { enabled: true },
      },
    );
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.data.resolved.enabled).toBe(true);

    // Step 4: Attempt upload again — should NOT get ATTACHMENTS_DISABLED
    // (will get 400 INVALID_UPLOAD because the multipart body has no actual file,
    // but that proves the config gate is no longer blocking)
    const uploadUnblocked = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
    }>(harness, `/api/projects/${admin.projectId}/sessions/${sessionId}/attachments`, {
      method: 'POST',
      headers: {
        ...authHeaders(admin.token),
        'content-type': 'multipart/form-data; boundary=----testboundary',
      },
    });
    // Should NOT be ATTACHMENTS_DISABLED — any other error (400/500) is fine
    expect(uploadUnblocked.body.error?.code).not.toBe('ATTACHMENTS_DISABLED');

    // Cleanup session
    await Session.deleteOne({ _id: sessionId });
  });

  test('E2E-10: upload endpoint accepts markdown and PDF through wildcard config', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-doc-upload'),
      uniqueSlug('tenant-cfg-doc-upload'),
      uniqueSlug('proj-cfg-doc-upload'),
    );

    const sessionId = 'sess-doc-upload-test';
    const now = new Date();
    await Session.create({
      _id: sessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      initiatedById: admin.userId,
      currentAgent: 'test-agent',
      environment: 'dev',
      channel: 'api',
      channelHistory: ['api'],
      status: 'active',
      context: {},
      metadata: {},
      messageCount: 0,
      tokenCount: 0,
      estimatedCost: 0,
      errorCount: 0,
      handoffCount: 0,
      identityTier: 0,
      startedAt: now,
      lastActivityAt: now,
    });

    const configRes = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { allowedMimeTypes: ['text/*', 'application/*'] },
      },
    );
    expect(configRes.status).toBe(200);

    async function uploadFile(
      filename: string,
      content: string | Uint8Array,
      declaredMimeType: string,
    ): Promise<void> {
      const form = new FormData();
      form.append('file', new Blob([content], { type: declaredMimeType }), filename);

      const response = await fetch(
        `${harness.baseUrl}/api/projects/${admin.projectId}/sessions/${sessionId}/attachments`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: form,
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        attachmentId?: string;
        error?: { code: string; message: string };
      };

      expect(body).toMatchObject({ success: true });
      expect(response.status).toBe(201);
      expect(body.attachmentId).toBeTruthy();
    }

    await uploadFile(
      'architecture-notes.md',
      '# Architecture notes\n\n- multimodal markdown upload',
      'application/octet-stream',
    );
    await uploadFile(
      'runtime-brief.pdf',
      new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'),
      'application/octet-stream',
    );

    const listRes = await requestJson<{
      success: boolean;
      data: { attachments: Array<{ originalFilename: string; mimeType: string }> };
    }>(harness, `/api/projects/${admin.projectId}/sessions/${sessionId}/attachments`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalFilename: 'architecture-notes.md',
          mimeType: 'text/markdown',
        }),
        expect.objectContaining({
          originalFilename: 'runtime-brief.pdf',
          mimeType: 'application/pdf',
        }),
      ]),
    );

    await Session.deleteOne({ _id: sessionId });
  });

  // ─── E2E-10: Zod validation rejects invalid config (GAP-004) ────────────

  test('E2E-11: PUT rejects oversized file limit and invalid MIME types', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cfg-zod'),
      uniqueSlug('tenant-cfg-zod'),
      uniqueSlug('proj-cfg-zod'),
    );

    // Reject maxFileSizeBytes > 500 MB
    const tooBig = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { maxFileSizeBytes: 600 * 1024 * 1024 },
      },
    );
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.success).toBe(false);

    // Reject invalid MIME type format
    const badMime = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { allowedMimeTypes: ['not-a-mime'] },
      },
    );
    expect(badMime.status).toBe(400);
    expect(badMime.body.success).toBe(false);

    // Reject more than 50 MIME types
    const tooMany = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          allowedMimeTypes: Array.from({ length: 51 }, (_, i) => `image/type${i}`),
        },
      },
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.success).toBe(false);

    // Valid MIME types with wildcards and extensions should be accepted
    const validMime = await requestJson<AttachmentConfigResponse>(
      harness,
      `/api/projects/${admin.projectId}/attachment-config`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          allowedMimeTypes: [
            'image/jpeg',
            'application/pdf',
            'text/plain',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'image/*',
          ],
        },
      },
    );
    expect(validMime.status).toBe(200);
    expect(validMime.body.success).toBe(true);
  });
});
