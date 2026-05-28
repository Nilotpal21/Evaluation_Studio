/**
 * Pipeline Config E2E Tests (E2E-1, E2E-2, E2E-4, E2E-6, E2E-7)
 *
 * Exercises the pipeline configuration API through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real middleware chain.
 *
 * Routes under test:
 *   GET    /api/projects/:projectId/pipeline-config                                  — list all
 *   GET    /api/projects/:projectId/pipeline-config/:pipelineType                    — get effective
 *   PUT    /api/projects/:projectId/pipeline-config/:pipelineType                    — create/update
 *   GET    /api/projects/:projectId/pipeline-config/:pipelineType/history            — version history
 *   PATCH  /api/projects/:projectId/pipeline-config/:pipelineType/toggle             — enable/disable
 *   GET    /api/projects/:projectId/pipeline-config/:pipelineType/schema             — config schema
 *   GET    /api/projects/:projectId/pipeline-config/:pipelineType/triggers           — trigger states
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import pipelineConfigRouter from '../routes/pipeline-config.js';
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

interface PipelineConfigData {
  pipelineType: string;
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  activeTriggers?: string[];
  triggerConfigs?: Record<string, unknown>;
  projectId?: string;
  lastProcessedAt?: string | null;
  backfillStatus?: string;
}

interface PipelineConfigResponse {
  success: boolean;
  data: PipelineConfigData;
}

interface PipelineConfigListResponse {
  success: boolean;
  data: Array<Record<string, unknown>>;
}

interface PipelineConfigHistoryResponse {
  success: boolean;
  data: {
    history: Array<Record<string, unknown>>;
    currentVersion: number;
  };
}

interface PipelineToggleResponse {
  success: boolean;
  data: {
    enabled: boolean;
    pipelineType: string;
  };
}

interface PipelineSchemaResponse {
  success: boolean;
  data: {
    fields: Array<Record<string, unknown>>;
    sharedFields: Array<Record<string, unknown>>;
  };
}

interface ErrorResponse {
  success: boolean;
  error?: string;
  issues?: unknown[];
}

interface PipelineTriggersResponse {
  success: boolean;
  data: {
    triggers: Array<{
      id: string;
      type: string;
      label: string;
      active: boolean;
      samplingRate: number;
      executionMode: string;
      [key: string]: unknown;
    }>;
    defaultTriggerIds: string[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE = '/api/projects';
function configPath(projectId: string, pipelineType?: string): string {
  const base = `${BASE}/${projectId}/pipeline-config`;
  return pipelineType ? `${base}/${pipelineType}` : base;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Pipeline Config E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/pipeline-config', pipelineConfigRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterEach(async () => {
    // Clean up pipeline configs and definitions between tests
    const { PipelineConfigModel, PipelineDefinitionModel } =
      await import('@agent-platform/pipeline-engine/schemas');
    await PipelineConfigModel.deleteMany({});
    await PipelineDefinitionModel.deleteMany({});
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-1: Pipeline Config CRUD Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-1: Pipeline Config CRUD Lifecycle', () => {
    test('GET / returns list of pipeline types', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-list'),
        uniqueSlug('tenant-pc-list'),
        uniqueSlug('proj-pc-list'),
      );

      const res = await requestJson<PipelineConfigListResponse>(
        harness,
        configPath(admin.projectId),
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('GET /:pipelineType returns platform defaults when no project config saved', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-empty'),
        uniqueSlug('tenant-pc-empty'),
        uniqueSlug('proj-pc-empty'),
      );

      const res = await requestJson<{ success: boolean; data: PipelineConfigData | null }>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Tenant bootstrap seeds disabled tenant-level configs at version 1.
      // Projects without overrides inherit that tenant-level default record.
      if (res.body.data) {
        expect(res.body.data.pipelineType).toBe('sentiment_analysis');
        expect(res.body.data.version).toBe(1);
        expect(res.body.data.projectId).toBeNull();
      }
    });

    test('PUT creates config, GET returns it, PUT again increments version', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-crud'),
        uniqueSlug('tenant-pc-crud'),
        uniqueSlug('proj-pc-crud'),
      );

      // PUT: create config
      const putRes = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.5 } },
        },
      );

      expect(putRes.status).toBe(200);
      expect(putRes.body.success).toBe(true);
      expect(putRes.body.data.pipelineType).toBe('sentiment_analysis');
      expect(putRes.body.data.version).toBe(1);
      expect(putRes.body.data.config.samplingRate).toBe(0.5);

      // GET: verify persistence
      const getRes = await requestJson<{ success: boolean; data: PipelineConfigData }>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.pipelineType).toBe('sentiment_analysis');
      expect(getRes.body.data.version).toBe(1);
      expect(getRes.body.data.config.samplingRate).toBe(0.5);

      // PUT again: version increments
      const put2Res = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.8 } },
        },
      );

      expect(put2Res.status).toBe(200);
      expect(put2Res.body.data.version).toBe(2);
      expect(put2Res.body.data.config.samplingRate).toBe(0.8);
    });

    test('PATCH toggle enables and disables pipeline', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-toggle'),
        uniqueSlug('tenant-pc-toggle'),
        uniqueSlug('proj-pc-toggle'),
      );

      // Toggle on (upserts if no config exists)
      const enableRes = await requestJson<PipelineToggleResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/toggle`,
        {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: { enabled: true },
        },
      );

      expect(enableRes.status).toBe(200);
      expect(enableRes.body.success).toBe(true);
      expect(enableRes.body.data.enabled).toBe(true);
      expect(enableRes.body.data.pipelineType).toBe('sentiment_analysis');

      // Toggle off
      const disableRes = await requestJson<PipelineToggleResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/toggle`,
        {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: { enabled: false },
        },
      );

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.data.enabled).toBe(false);
    });

    test('GET history tracks version changes', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-history'),
        uniqueSlug('tenant-pc-history'),
        uniqueSlug('proj-pc-history'),
      );

      // No history initially
      const emptyHistory = await requestJson<PipelineConfigHistoryResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/history`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(emptyHistory.status).toBe(200);
      expect(emptyHistory.body.data.history).toEqual([]);
      expect(emptyHistory.body.data.currentVersion).toBe(1);

      // Create config
      await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.5 } },
        },
      );

      // Update config
      await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.9 } },
        },
      );

      // History should have entries
      const history = await requestJson<PipelineConfigHistoryResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/history`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(history.status).toBe(200);
      expect(history.body.data.currentVersion).toBe(2);
      expect(history.body.data.history.length).toBeGreaterThanOrEqual(1);
    });

    test('GET schema returns shared config fields', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-schema'),
        uniqueSlug('tenant-pc-schema'),
        uniqueSlug('proj-pc-schema'),
      );

      const res = await requestJson<PipelineSchemaResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/schema`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // sharedFields are always returned (from SHARED_CONFIG_FIELDS constant)
      expect(Array.isArray(res.body.data.sharedFields)).toBe(true);
      expect(res.body.data.sharedFields.length).toBeGreaterThan(0);
      // fields may be empty if no pipeline definition is seeded
      expect(Array.isArray(res.body.data.fields)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-2: Pipeline Config Isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-2: Pipeline Config Isolation', () => {
    test('cross-project configs are independent within same tenant', async () => {
      // Create admin with project A
      const adminA = await bootstrapProject(
        harness,
        uniqueEmail('pc-iso-pa'),
        uniqueSlug('tenant-pc-iso-proj'),
        uniqueSlug('proj-pc-iso-a'),
      );

      // Create project B under the same tenant
      const { createProject } = await import('./helpers/channel-e2e-bootstrap.js');
      const projectB = await createProject(
        harness,
        adminA.token,
        adminA.tenantId,
        'Project B',
        uniqueSlug('proj-pc-iso-b'),
      );

      // Save config on project A
      const putA = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(adminA.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(adminA.token),
          body: { config: { samplingRate: 0.3 } },
        },
      );
      expect(putA.status).toBe(200);

      // Project B should NOT see project A's saved config.
      // It inherits the seeded tenant-level default (version 1), not project A's override.
      const getB = await requestJson<{ success: boolean; data: PipelineConfigData | null }>(
        harness,
        configPath(projectB._id, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(adminA.token) },
      );
      expect(getB.status).toBe(200);
      // Project B has no project-level config — it gets the seeded tenant default.
      if (getB.body.data) {
        expect(getB.body.data.version).toBe(1);
        expect(getB.body.data.config.samplingRate).not.toBe(0.3);
      }

      // Save a different config on project B
      const putB = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(projectB._id, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(adminA.token),
          body: { config: { samplingRate: 0.7 } },
        },
      );
      expect(putB.status).toBe(200);
      expect(putB.body.data.config.samplingRate).toBe(0.7);

      // Verify project A's config is unchanged
      const getA = await requestJson<{ success: boolean; data: PipelineConfigData }>(
        harness,
        configPath(adminA.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(adminA.token) },
      );
      expect(getA.status).toBe(200);
      expect(getA.body.data.config.samplingRate).toBe(0.3);
    });

    test('cross-tenant access returns 404', async () => {
      // Create Tenant A with project
      const tenantA = await bootstrapProject(
        harness,
        uniqueEmail('pc-iso-ta'),
        uniqueSlug('tenant-pc-iso-ta'),
        uniqueSlug('proj-pc-iso-ta'),
      );

      // Save config on Tenant A's project
      await requestJson<PipelineConfigResponse>(
        harness,
        configPath(tenantA.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(tenantA.token),
          body: { config: { samplingRate: 0.5 } },
        },
      );

      // Create Tenant B
      const tenantB = await bootstrapProject(
        harness,
        uniqueEmail('pc-iso-tb'),
        uniqueSlug('tenant-pc-iso-tb'),
        uniqueSlug('proj-pc-iso-tb'),
      );

      // Tenant B tries to GET Tenant A's project config -> 404
      const crossGet = await requestJson<ErrorResponse>(
        harness,
        configPath(tenantA.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(tenantB.token) },
      );
      expect(crossGet.status).toBe(404);

      // Tenant B tries to PUT Tenant A's project config -> 404
      const crossPut = await requestJson<ErrorResponse>(
        harness,
        configPath(tenantA.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(tenantB.token),
          body: { config: { samplingRate: 0.1 } },
        },
      );
      expect(crossPut.status).toBe(404);

      // Tenant B tries to PATCH toggle on Tenant A's project -> 404
      const crossToggle = await requestJson<ErrorResponse>(
        harness,
        `${configPath(tenantA.projectId, 'sentiment_analysis')}/toggle`,
        {
          method: 'PATCH',
          headers: authHeaders(tenantB.token),
          body: { enabled: false },
        },
      );
      expect(crossToggle.status).toBe(404);

      // Verify Tenant A's config is unchanged
      const tenantAGet = await requestJson<{ success: boolean; data: PipelineConfigData }>(
        harness,
        configPath(tenantA.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(tenantA.token) },
      );
      expect(tenantAGet.status).toBe(200);
      expect(tenantAGet.body.data.config.samplingRate).toBe(0.5);
    });

    test('unauthenticated request returns 401', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-iso-noauth'),
        uniqueSlug('tenant-pc-iso-noauth'),
        uniqueSlug('proj-pc-iso-noauth'),
      );

      // No auth header
      const noAuth = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET' },
      );
      expect(noAuth.status).toBe(401);

      // Invalid token
      const badAuth = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders('invalid-token-value') },
      );
      expect(badAuth.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-4: Pipeline Config Validation at API Boundary
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-4: Pipeline Config Validation', () => {
    test('PUT with samplingRate > 1.0 returns 400 with Zod issues', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-val-hi'),
        uniqueSlug('tenant-pc-val-hi'),
        uniqueSlug('proj-pc-val-hi'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 1.5 } },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Config validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
      expect(res.body.issues!.length).toBeGreaterThan(0);
    });

    test('PUT with samplingRate < 0 returns 400 with Zod issues', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-val-lo'),
        uniqueSlug('tenant-pc-val-lo'),
        uniqueSlug('proj-pc-val-lo'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: -0.1 } },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Config validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    test('PUT with invalid frustrationThreshold returns 400', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-val-frust'),
        uniqueSlug('tenant-pc-val-frust'),
        uniqueSlug('proj-pc-val-frust'),
      );

      // frustrationThreshold must be between -1 and 0
      const res = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { frustrationThreshold: 0.5 } },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Config validation failed');
    });

    test('PUT valid intent_classification with taxonomy succeeds', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-val-intent'),
        uniqueSlug('tenant-pc-val-intent'),
        uniqueSlug('proj-pc-val-intent'),
      );

      const res = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'intent_classification'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            config: {
              taxonomy: [
                { name: 'billing', description: 'Billing and payment questions' },
                {
                  name: 'support',
                  description: 'Technical support',
                  examples: ['help me', 'not working'],
                },
              ],
              confidenceThreshold: 0.7,
              inputMessageStrategy: 'last_n_user',
              inputMessageCount: 5,
            },
          },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pipelineType).toBe('intent_classification');
      expect(res.body.data.version).toBe(1);
      expect((res.body.data.config as any).taxonomy).toHaveLength(2);
      expect((res.body.data.config as any).confidenceThreshold).toBe(0.7);
    });

    test('PUT valid config with boundary samplingRate values succeeds', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-val-boundary'),
        uniqueSlug('tenant-pc-val-boundary'),
        uniqueSlug('proj-pc-val-boundary'),
      );

      // samplingRate = 0 (process nothing)
      const resZero = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0 } },
        },
      );
      expect(resZero.status).toBe(200);
      expect(resZero.body.data.config.samplingRate).toBe(0);

      // samplingRate = 1 (process all)
      const resOne = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 1 } },
        },
      );
      expect(resOne.status).toBe(200);
      expect(resOne.body.data.config.samplingRate).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-6: Trigger States API
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-6: Trigger States API', () => {
    test('GET triggers for pipeline with no definition returns empty', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-trig-empty'),
        uniqueSlug('tenant-pc-trig-empty'),
        uniqueSlug('proj-pc-trig-empty'),
      );

      const res = await requestJson<PipelineTriggersResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/triggers`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.triggers).toEqual([]);
      expect(res.body.data.defaultTriggerIds).toEqual([]);
    });

    test('GET triggers with seeded definition returns trigger list with active states', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-trig-def'),
        uniqueSlug('tenant-pc-trig-def'),
        uniqueSlug('proj-pc-trig-def'),
      );

      // Seed a pipeline definition with supported triggers
      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      await PipelineDefinitionModel.create({
        _id: `test-def-${Date.now()}`,
        tenantId: admin.tenantId,
        name: 'Sentiment Analysis',
        pipelineType: 'sentiment_analysis',
        version: 1,
        status: 'active',
        configSchema: { fields: [] },
        supportedTriggers: [
          {
            id: 'on-session-end',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'On Session End',
            description: 'Triggered when a session ends',
          },
          {
            id: 'manual',
            type: 'manual',
            strategy: 'batch',
            label: 'Manual Trigger',
            description: 'Manually triggered by user',
          },
        ],
        defaultTriggerIds: ['on-session-end'],
        strategies: new Map([
          ['batch', { executionMode: 'batch', steps: [], onStepFailure: 'stop' }],
        ]),
        createdBy: admin.userId,
      });

      const res = await requestJson<PipelineTriggersResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/triggers`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.triggers).toHaveLength(2);
      expect(res.body.data.defaultTriggerIds).toEqual(['on-session-end']);

      // Default trigger should be active (from defaultTriggerIds)
      const sessionEnd = res.body.data.triggers.find(
        (t: { id: string }) => t.id === 'on-session-end',
      );
      expect(sessionEnd).toBeDefined();
      expect(sessionEnd!.active).toBe(true);
      expect(sessionEnd!.executionMode).toBe('batch');

      // Manual trigger should not be active (not in defaultTriggerIds)
      const manual = res.body.data.triggers.find((t: { id: string }) => t.id === 'manual');
      expect(manual).toBeDefined();
      expect(manual!.active).toBe(false);
    });

    test('PUT config with activeTriggers changes which triggers are active', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-trig-update'),
        uniqueSlug('tenant-pc-trig-update'),
        uniqueSlug('proj-pc-trig-update'),
      );

      // Seed definition
      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      await PipelineDefinitionModel.create({
        _id: `test-def-update-${Date.now()}`,
        tenantId: admin.tenantId,
        name: 'Sentiment Analysis',
        pipelineType: 'sentiment_analysis',
        version: 1,
        status: 'active',
        configSchema: { fields: [] },
        supportedTriggers: [
          {
            id: 'on-session-end',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'On Session End',
            description: 'Triggered on session end',
          },
          {
            id: 'manual',
            type: 'manual',
            strategy: 'batch',
            label: 'Manual',
            description: 'Manual trigger',
          },
          {
            id: 'on-schedule',
            type: 'schedule',
            schedule: '0 */6 * * *',
            strategy: 'batch',
            label: 'Every 6 Hours',
            description: 'Scheduled every 6 hours',
          },
        ],
        defaultTriggerIds: ['on-session-end'],
        strategies: new Map([
          ['batch', { executionMode: 'batch', steps: [], onStepFailure: 'stop' }],
        ]),
        createdBy: admin.userId,
      });

      // Save config with custom activeTriggers (manual + on-schedule, NOT on-session-end)
      const putRes = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            config: { samplingRate: 0.8 },
            activeTriggers: ['manual', 'on-schedule'],
          },
        },
      );
      expect(putRes.status).toBe(200);

      // GET triggers — should reflect the config-level activeTriggers
      const res = await requestJson<PipelineTriggersResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/triggers`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.data.triggers).toHaveLength(3);

      // on-session-end should now be INACTIVE (replaced by config-level activeTriggers)
      const sessionEnd = res.body.data.triggers.find(
        (t: { id: string }) => t.id === 'on-session-end',
      );
      expect(sessionEnd!.active).toBe(false);

      // manual and on-schedule should be ACTIVE
      const manual = res.body.data.triggers.find((t: { id: string }) => t.id === 'manual');
      expect(manual!.active).toBe(true);

      const schedule = res.body.data.triggers.find((t: { id: string }) => t.id === 'on-schedule');
      expect(schedule!.active).toBe(true);
    });

    test('GET triggers for invalid pipeline type returns 400', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-trig-invalid'),
        uniqueSlug('tenant-pc-trig-invalid'),
        uniqueSlug('proj-pc-trig-invalid'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        `${configPath(admin.projectId, 'nonexistent_pipeline')}/triggers`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-7: Pipeline Config Permission Checks (RBAC)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E2E-7: Pipeline Config Permission Checks', () => {
    test('viewer can read config but cannot write or toggle', async () => {
      // Admin creates project and saves a config
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-rbac'),
        uniqueSlug('tenant-pc-rbac'),
        uniqueSlug('proj-pc-rbac'),
      );

      // Admin saves config
      const adminPut = await requestJson<PipelineConfigResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.6 } },
        },
      );
      expect(adminPut.status).toBe(200);

      // Create a second user as tenant MEMBER (no project:* bypass)
      const viewerEmail = uniqueEmail('pc-viewer');
      const viewer = await devLogin(harness, viewerEmail);
      await addMember(harness, admin.token, admin.tenantId, viewerEmail, 'MEMBER');

      clearPermissionCache();

      // Add as project member with 'viewer' role (direct model insert —
      // no runtime API exists for project member management)
      await ProjectMember.create({
        projectId: admin.projectId,
        userId: viewer.user.id,
        role: 'viewer',
      });

      // Re-login to get fresh token with tenant context
      const viewerLogin = await devLogin(harness, viewerEmail);
      clearPermissionCache();

      // Viewer CAN read config (session:read is in viewer permissions)
      const viewerGet = await requestJson<{ success: boolean; data: PipelineConfigData }>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(viewerLogin.accessToken) },
      );
      expect(viewerGet.status).toBe(200);
      expect(viewerGet.body.success).toBe(true);
      expect(viewerGet.body.data.config.samplingRate).toBe(0.6);

      // Viewer CAN read config list
      const viewerList = await requestJson<PipelineConfigListResponse>(
        harness,
        configPath(admin.projectId),
        { method: 'GET', headers: authHeaders(viewerLogin.accessToken) },
      );
      expect(viewerList.status).toBe(200);

      // Viewer CAN read history
      const viewerHistory = await requestJson<PipelineConfigHistoryResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/history`,
        { method: 'GET', headers: authHeaders(viewerLogin.accessToken) },
      );
      expect(viewerHistory.status).toBe(200);

      // Viewer CANNOT PUT (project:write not in viewer permissions)
      const viewerPut = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(viewerLogin.accessToken),
          body: { config: { samplingRate: 0.1 } },
        },
      );
      expect(viewerPut.status).toBe(403);

      // Viewer CANNOT toggle (project:write not in viewer permissions)
      const viewerToggle = await requestJson<ErrorResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/toggle`,
        {
          method: 'PATCH',
          headers: authHeaders(viewerLogin.accessToken),
          body: { enabled: false },
        },
      );
      expect(viewerToggle.status).toBe(403);

      // Verify admin's config is unchanged
      const adminGet = await requestJson<{ success: boolean; data: PipelineConfigData }>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        { method: 'GET', headers: authHeaders(admin.token) },
      );
      expect(adminGet.status).toBe(200);
      expect(adminGet.body.data.config.samplingRate).toBe(0.6);
    });

    test('PUT with invalid pipeline type returns 400', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-invalid-type'),
        uniqueSlug('tenant-pc-invalid'),
        uniqueSlug('proj-pc-invalid'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'nonexistent_pipeline'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { config: { samplingRate: 0.5 } },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('PUT with missing config body returns 400', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-no-body'),
        uniqueSlug('tenant-pc-nobody'),
        uniqueSlug('proj-pc-nobody'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        configPath(admin.projectId, 'sentiment_analysis'),
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {},
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('PATCH toggle with non-boolean enabled returns 400', async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('pc-bad-toggle'),
        uniqueSlug('tenant-pc-badtoggle'),
        uniqueSlug('proj-pc-badtoggle'),
      );

      const res = await requestJson<ErrorResponse>(
        harness,
        `${configPath(admin.projectId, 'sentiment_analysis')}/toggle`,
        {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: { enabled: 'yes' },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
