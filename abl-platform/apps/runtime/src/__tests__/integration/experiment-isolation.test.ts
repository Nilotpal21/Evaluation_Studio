/**
 * Experiment Isolation — Integration Tests
 *
 * Tests tenant isolation of experiment data through the real HTTP API
 * with real auth middleware, real RBAC, and real MongoDB.
 *
 * ZERO vi.mock() calls — exercises the full middleware chain.
 *
 * Pattern: follows observatory-api.integration.test.ts harness approach.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  requestJson,
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';

// ── Routers ──────────────────────────────────────────────────────────────────
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import projectAgentsRouter from '../../routes/project-agents.js';
import versionsRouter from '../../routes/versions.js';
import deploymentsRouter from '../../routes/deployments.js';
import projectIoRouter from '../../routes/project-io.js';
import experimentsRouter from '../../routes/experiments.js';

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 90_000;

const SIMPLE_AGENT_DSL = `AGENT: Isolation_Test_Agent

GOAL: "Answer user questions"

PERSONA: "Helpful assistant"
`;

// ── Types ────────────────────────────────────────────────────────────────────

interface ExperimentResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe(
  'Experiment Isolation Integration',
  () => {
    let harness: RuntimeApiHarness;
    let bootstrapA: BootstrapProjectResult;
    let bootstrapB: BootstrapProjectResult;
    let agentVersionIdA: string;

    beforeAll(async () => {
      harness = await startRuntimeApiHarness((app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/agents', projectAgentsRouter);
        app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/experiments', experimentsRouter);
      });

      // ── Bootstrap Tenant A ────────────────────────────────────────────
      bootstrapA = await bootstrapProject(
        harness,
        uniqueEmail('exp-iso-admin-a'),
        uniqueSlug('exp-iso-tenant-a'),
        uniqueSlug('exp-iso-project-a'),
      );

      await importProjectFiles(harness, bootstrapA.token, bootstrapA.projectId, {
        'agents/isolation-test.agent.abl': SIMPLE_AGENT_DSL,
      });

      const agentsResA = await requestJson<{
        success: boolean;
        agents: Array<{ name: string }>;
      }>(harness, `/api/projects/${bootstrapA.projectId}/agents`, {
        headers: authHeaders(bootstrapA.token),
      });
      const agentNameA = agentsResA.body.agents?.[0]?.name;
      expect(agentNameA).toBeTruthy();

      // Create a version from the working-copy DSL
      const createVersionResA = await requestJson<{
        success: boolean;
        version: string;
        versionId: string;
      }>(harness, `/api/projects/${bootstrapA.projectId}/agents/${agentNameA}/versions`, {
        method: 'POST',
        headers: authHeaders(bootstrapA.token),
        body: {},
      });
      expect(createVersionResA.status, JSON.stringify(createVersionResA.body)).toBe(201);
      agentVersionIdA = createVersionResA.body.version;

      // ── Bootstrap Tenant B ────────────────────────────────────────────
      bootstrapB = await bootstrapProject(
        harness,
        uniqueEmail('exp-iso-admin-b'),
        uniqueSlug('exp-iso-tenant-b'),
        uniqueSlug('exp-iso-project-b'),
      );

      // Restore both users as super admins
      await setSuperAdmins([bootstrapA.userId, bootstrapB.userId]);
    }, TIMEOUT_MS);

    afterAll(async () => {
      await harness?.close();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-10: Tenant isolation
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-10: Tenant isolation', () => {
      test('experiment created by tenant A → tenant B gets 404', async () => {
        // Create experiment in tenant A's project
        const createRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrapA.projectId}/experiments`,
          {
            method: 'POST',
            headers: authHeaders(bootstrapA.token),
            body: {
              name: 'Tenant A Experiment (INT-10)',
              controlVersion: agentVersionIdA,
              experimentVersion: agentVersionIdA,
              trafficSplit: 0.5,
              successMetrics: ['satisfaction_score'],
              channels: [],
            },
          },
        );
        expect(createRes.status).toBe(201);
        const expA = createRes.body.data!;

        // Start experiment A
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrapA.projectId}/experiments/${expA._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrapA.token) },
        );
        expect(startRes.status).toBe(200);

        // Tenant B tries to access tenant A's experiment via tenant A's project
        // The project-scope middleware should deny access since tenant B
        // is not a member of tenant A's project.
        const getByB = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrapA.projectId}/experiments/${expA._id}`,
          { headers: authHeaders(bootstrapB.token) },
        );

        // Must return 404 to conceal existence (platform invariant: cross-scope = 404 not 403)
        expect(getByB.status).toBe(404);

        // Tenant B tries to list experiments in tenant A's project
        const listByB = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrapA.projectId}/experiments`,
          { headers: authHeaders(bootstrapB.token) },
        );
        expect(listByB.status).toBe(404);

        // Cleanup
        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrapA.projectId}/experiments/${expA._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrapA.token) },
        );
      });

      test('tenant A experiment not visible in tenant B project listing', async () => {
        // Import agent into tenant B's project
        await importProjectFiles(harness, bootstrapB.token, bootstrapB.projectId, {
          'agents/isolation-test-b.agent.abl': SIMPLE_AGENT_DSL,
        });

        // List experiments in tenant B's project — should be empty
        const listRes = await requestJson<{
          success: boolean;
          data?: Record<string, unknown>[];
        }>(harness, `/api/projects/${bootstrapB.projectId}/experiments`, {
          headers: authHeaders(bootstrapB.token),
        });

        expect(listRes.status).toBe(200);
        expect(listRes.body.success).toBe(true);
        // Tenant B's project should have no experiments
        expect(listRes.body.data).toHaveLength(0);
      });
    });
  },
  TIMEOUT_MS,
);
