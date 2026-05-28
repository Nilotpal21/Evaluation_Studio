/**
 * Pipeline Management E2E Tests (E2E-8)
 *
 * Exercises the pipeline activate/deactivate API through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real middleware chain.
 *
 * Routes under test (pipelineManagementRouter):
 *   POST /api/projects/:projectId/pipelines/:pipelineId/activate   — activate a pipeline
 *   POST /api/projects/:projectId/pipelines/:pipelineId/deactivate — deactivate a pipeline
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { pipelineManagementRouter } from '../routes/pipeline-config.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  devLogin,
  addMember,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import { ProjectMember } from '@agent-platform/database/models';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  status: string;
}

interface ActivateResponse {
  success: boolean;
  data: PipelineDoc;
}

interface ErrorResponse {
  success: boolean;
  error: string;
  details?: unknown[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE = '/api/projects';

function managementPath(projectId: string, pipelineId: string, action: 'activate' | 'deactivate') {
  return `${BASE}/${projectId}/pipelines/${pipelineId}/${action}`;
}

let _pipelineSeq = 0;
function uniquePipelineId(prefix: string) {
  return `${prefix}-${++_pipelineSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

async function seedPipeline(
  tenantId: string,
  projectId: string,
  overrides: Partial<PipelineDoc> = {},
): Promise<string> {
  const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
  const id = uniquePipelineId('test-pipeline');
  await PipelineDefinitionModel.create({
    _id: id,
    tenantId,
    projectId,
    name: 'Test Pipeline',
    status: 'draft',
    version: 1,
    ...overrides,
  });
  return id;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Pipeline Management E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/pipelines', pipelineManagementRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterEach(async () => {
    const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
    await PipelineDefinitionModel.deleteMany({});
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-8: Pipeline Activate / Deactivate Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-8: Pipeline Activate/Deactivate Lifecycle', () => {
    test('POST activate sets pipeline status to active', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-activate'),
        uniqueSlug('tenant-pm-activate'),
        uniqueSlug('proj-pm-activate'),
      );

      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId);

      const res = await requestJson<ActivateResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'activate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data._id).toBe(pipelineId);
    });

    test('POST deactivate sets pipeline status back to draft', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-deactivate'),
        uniqueSlug('tenant-pm-deactivate'),
        uniqueSlug('proj-pm-deactivate'),
      );

      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId, {
        status: 'active',
      });

      const res = await requestJson<ActivateResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'deactivate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('draft');
    });

    test('POST activate then deactivate round-trips status correctly', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-roundtrip'),
        uniqueSlug('tenant-pm-roundtrip'),
        uniqueSlug('proj-pm-roundtrip'),
      );

      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId);

      const activateRes = await requestJson<ActivateResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'activate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );
      expect(activateRes.status).toBe(200);
      expect(activateRes.body.data.status).toBe('active');

      const deactivateRes = await requestJson<ActivateResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'deactivate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.data.status).toBe('draft');
    });

    test('POST activate on non-existent pipeline returns 404', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-notfound-act'),
        uniqueSlug('tenant-pm-notfound-act'),
        uniqueSlug('proj-pm-notfound-act'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        managementPath(admin.projectId, 'does-not-exist', 'activate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('POST deactivate on non-existent pipeline returns 404', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-notfound-dea'),
        uniqueSlug('tenant-pm-notfound-dea'),
        uniqueSlug('proj-pm-notfound-dea'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        managementPath(admin.projectId, 'does-not-exist', 'deactivate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-8b: Tenant and Project Isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-8b: Isolation', () => {
    test('cross-tenant activate returns 404 and does not change status', async () => {
      const tenantA = await bootstrapProject(
        harness,
        uniqueEmail('pm-iso-ta'),
        uniqueSlug('tenant-pm-iso-ta'),
        uniqueSlug('proj-pm-iso-ta'),
      );
      const tenantB = await bootstrapProject(
        harness,
        uniqueEmail('pm-iso-tb'),
        uniqueSlug('tenant-pm-iso-tb'),
        uniqueSlug('proj-pm-iso-tb'),
      );

      const pipelineId = await seedPipeline(tenantA.tenantId, tenantA.projectId);

      // Tenant B tries to activate Tenant A's pipeline via Tenant A's project path
      const crossRes = await requestJson<ErrorResponse>(
        harness,
        managementPath(tenantA.projectId, pipelineId, 'activate'),
        { method: 'POST', headers: authHeaders(tenantB.token) },
      );
      expect(crossRes.status).toBe(404);

      // Verify pipeline is still draft
      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      const pipeline = await PipelineDefinitionModel.findOne({
        _id: pipelineId,
        tenantId: tenantA.tenantId,
      }).lean();
      expect(pipeline?.status).toBe('draft');
    });

    test('cross-project activate returns 404 within same tenant', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-xproj'),
        uniqueSlug('tenant-pm-xproj'),
        uniqueSlug('proj-pm-xproj-a'),
      );

      // Pipeline belongs to projectA but request uses a different projectId in path
      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId);
      const otherProjectId = uniqueSlug('proj-pm-xproj-b');

      const res = await requestJson<ErrorResponse>(
        harness,
        managementPath(otherProjectId, pipelineId, 'activate'),
        { method: 'POST', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated activate returns 401', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-noauth'),
        uniqueSlug('tenant-pm-noauth'),
        uniqueSlug('proj-pm-noauth'),
      );

      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId);

      const res = await requestJson<ErrorResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'activate'),
        { method: 'POST' },
      );

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-8c: RBAC
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-8c: RBAC', () => {
    test('viewer cannot activate or deactivate (project:write required)', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pm-rbac'),
        uniqueSlug('tenant-pm-rbac'),
        uniqueSlug('proj-pm-rbac'),
      );

      const pipelineId = await seedPipeline(admin.tenantId, admin.projectId);

      const viewerEmail = uniqueEmail('pm-viewer');
      const viewer = await devLogin(harness, viewerEmail);
      await addMember(harness, admin.token, admin.tenantId, viewerEmail, 'MEMBER');
      clearPermissionCache();

      await ProjectMember.create({
        projectId: admin.projectId,
        userId: viewer.user.id,
        role: 'viewer',
      });

      const viewerLogin = await devLogin(harness, viewerEmail);
      clearPermissionCache();

      const activateRes = await requestJson<ErrorResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'activate'),
        { method: 'POST', headers: authHeaders(viewerLogin.accessToken) },
      );
      expect(activateRes.status).toBe(403);

      const deactivateRes = await requestJson<ErrorResponse>(
        harness,
        managementPath(admin.projectId, pipelineId, 'deactivate'),
        { method: 'POST', headers: authHeaders(viewerLogin.accessToken) },
      );
      expect(deactivateRes.status).toBe(403);

      // Pipeline status must be unchanged
      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      const pipeline = await PipelineDefinitionModel.findOne({
        _id: pipelineId,
        tenantId: admin.tenantId,
      }).lean();
      expect(pipeline?.status).toBe('draft');
    });
  });
});
