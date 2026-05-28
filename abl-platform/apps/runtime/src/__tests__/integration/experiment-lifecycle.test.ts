/**
 * Experiment Lifecycle — Integration Tests
 *
 * Tests experiment CRUD and lifecycle transitions through the real HTTP API
 * with real auth middleware, real RBAC, and real MongoDB via MongoMemoryServer.
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

const SIMPLE_AGENT_DSL = `AGENT: Lifecycle_Test_Agent

GOAL: "Answer user questions"

PERSONA: "Helpful assistant"
`;

// ── Types ────────────────────────────────────────────────────────────────────

interface ExperimentResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface ExperimentListResponse {
  success: boolean;
  data?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe(
  'Experiment Lifecycle Integration',
  () => {
    let harness: RuntimeApiHarness;
    let bootstrap: BootstrapProjectResult;
    let agentVersionId: string;

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

      bootstrap = await bootstrapProject(
        harness,
        uniqueEmail('exp-lifecycle-admin'),
        uniqueSlug('exp-lifecycle-tenant'),
        uniqueSlug('exp-lifecycle-project'),
      );

      // Import an agent DSL
      await importProjectFiles(harness, bootstrap.token, bootstrap.projectId, {
        'agents/lifecycle-test.agent.abl': SIMPLE_AGENT_DSL,
      });

      // Get the agent name
      const agentsRes = await requestJson<{
        success: boolean;
        agents: Array<{ name: string }>;
      }>(harness, `/api/projects/${bootstrap.projectId}/agents`, {
        headers: authHeaders(bootstrap.token),
      });
      expect(agentsRes.status).toBe(200);
      const agentName = agentsRes.body.agents?.[0]?.name;
      expect(agentName).toBeTruthy();

      // Create a version from the working-copy DSL
      const createVersionRes = await requestJson<{
        success: boolean;
        version: string;
        versionId: string;
      }>(harness, `/api/projects/${bootstrap.projectId}/agents/${agentName}/versions`, {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {},
      });
      expect(createVersionRes.status, JSON.stringify(createVersionRes.body)).toBe(201);
      agentVersionId = createVersionRes.body.version;
    }, TIMEOUT_MS);

    afterAll(async () => {
      await harness?.close();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /** Stop all running experiments in the project to ensure test isolation. */
    async function stopAllRunning(): Promise<void> {
      const listRes = await requestJson<ExperimentListResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments?status=running`,
        { headers: authHeaders(bootstrap.token) },
      );
      if (listRes.status === 200 && Array.isArray(listRes.body.data)) {
        for (const exp of listRes.body.data) {
          await requestJson<ExperimentResponse>(
            harness,
            `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
            { method: 'POST', headers: authHeaders(bootstrap.token) },
          );
        }
      }
    }

    async function createExperiment(
      overrides: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const res = await requestJson<ExperimentResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments`,
        {
          method: 'POST',
          headers: authHeaders(bootstrap.token),
          body: {
            name: 'Test Experiment',
            controlVersion: agentVersionId,
            experimentVersion: agentVersionId,
            trafficSplit: 0.5,
            successMetrics: ['satisfaction_score'],
            channels: [],
            ...overrides,
          },
        },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.success).toBe(true);
      return res.body.data!;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INT-1: One-active experiment per project
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-1: One-active experiment per project', () => {
      test('create and start experiment A, then try to start experiment B → 409', async () => {
        await stopAllRunning();
        const expA = await createExperiment({ name: 'Experiment A (INT-1)' });
        expect(expA.status).toBe('draft');

        const startA = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expA._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startA.status, JSON.stringify(startA.body)).toBe(200);
        expect(startA.body.data?.status).toBe('running');

        const expB = await createExperiment({ name: 'Experiment B (INT-1)' });
        expect(expB.status).toBe('draft');

        const startB = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expB._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startB.status).toBe(409);
        expect(startB.body.success).toBe(false);
        expect(startB.body.error?.code).toBe('CONFLICT');

        // Cleanup: stop experiment A
        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expA._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-2: Version existence validation
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-2: Version existence validation', () => {
      test('start with nonexistent controlVersion → 400', async () => {
        const exp = await createExperiment({
          name: 'Bad Version (INT-2)',
          controlVersion: 'nonexistent-version-xyz',
          experimentVersion: agentVersionId,
        });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(400);
        expect(startRes.body.success).toBe(false);
        expect(startRes.body.error?.code).toBe('VERSION_NOT_FOUND');
        expect(startRes.body.error?.message).toContain('nonexistent-version-xyz');
      });

      test('start with nonexistent experimentVersion → 400', async () => {
        const exp = await createExperiment({
          name: 'Bad Exp Version (INT-2)',
          controlVersion: agentVersionId,
          experimentVersion: 'nonexistent-exp-version-abc',
        });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(400);
        expect(startRes.body.success).toBe(false);
        expect(startRes.body.error?.code).toBe('VERSION_NOT_FOUND');
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-3: Stop ceases routing
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-3: Stop ceases experiment', () => {
      test('start → running; stop → stopped; no running experiments left', async () => {
        await stopAllRunning();
        const exp = await createExperiment({ name: 'Stop Test (INT-3)' });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
        expect(startRes.body.data?.status).toBe('running');
        expect(startRes.body.data?.startedAt).toBeTruthy();

        const getRunning = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getRunning.status).toBe(200);
        expect(getRunning.body.data?.status).toBe('running');

        const stopRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(stopRes.status).toBe(200);
        expect(stopRes.body.data?.status).toBe('stopped');
        expect(stopRes.body.data?.stoppedReason).toBe('manual');
        expect(stopRes.body.data?.stoppedAt).toBeTruthy();

        const listRunning = await requestJson<ExperimentListResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments?status=running`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(listRunning.status).toBe(200);
        expect(listRunning.body.data).toHaveLength(0);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Additional lifecycle tests
    // ═══════════════════════════════════════════════════════════════════════

    describe('Lifecycle edge cases', () => {
      test('cannot start a non-draft experiment', async () => {
        await stopAllRunning();
        const exp = await createExperiment({ name: 'Already Started' });

        const start1 = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(start1.status, JSON.stringify(start1.body)).toBe(200);

        const start2 = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(start2.status).toBe(400);
        expect(start2.body.error?.code).toBe('INVALID_STATUS');

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });

      test('cannot stop a draft experiment', async () => {
        const exp = await createExperiment({ name: 'Draft Stop Attempt' });

        const stopRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(stopRes.status).toBe(400);
        expect(stopRes.body.error?.code).toBe('INVALID_STATUS');
      });

      test('can only delete draft experiments', async () => {
        await stopAllRunning();
        const exp = await createExperiment({ name: 'Delete Test' });

        // Start the experiment — verify it actually entered running state
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
        expect(startRes.body.data?.status).toBe('running');

        // Try to delete running experiment → 400
        const deleteRunning = await requestJson<{ success: boolean; error?: { code: string } }>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { method: 'DELETE', headers: authHeaders(bootstrap.token) },
        );
        expect(deleteRunning.status).toBe(400);
        expect(deleteRunning.body.error?.code).toBe('INVALID_STATUS');

        // Cleanup
        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });

      test('can delete a draft experiment', async () => {
        const exp = await createExperiment({ name: 'Delete Draft' });

        const deleteRes = await requestJson<{ success: boolean }>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { method: 'DELETE', headers: authHeaders(bootstrap.token) },
        );
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.success).toBe(true);

        const getRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getRes.status).toBe(404);
      });

      test('complete transitions running → completed', async () => {
        await stopAllRunning();
        const exp = await createExperiment({ name: 'Complete Test' });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
        expect(startRes.body.data?.status).toBe('running');

        const completeRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/complete`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(completeRes.status).toBe(200);
        expect(completeRes.body.data?.status).toBe('completed');
        expect(completeRes.body.data?.stoppedReason).toBe('completed');
      });
    });
  },
  TIMEOUT_MS,
);
