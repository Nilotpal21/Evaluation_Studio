/**
 * Experiment Deployment Mode — Integration Tests
 *
 * Tests deployment-mode (V2) experiments end-to-end through the real HTTP API:
 * creating two deployments, linking them in a deployment-mode experiment,
 * validating lifecycle transitions, and verifying the deployment IDs persist
 * through create → GET → start.
 *
 * ZERO vi.mock() calls — exercises the full middleware chain.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  requestJson,
  authHeaders,
  bootstrapProject,
  createDeployment,
  importProjectFiles,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
  type DeploymentRecord,
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

// ── Pure assignment functions ────────────────────────────────────────────────
import {
  assignExperimentGroup,
  getAssignmentKey,
  checkSessionEligibility,
} from '@agent-platform/pipeline-engine';
import type { CachedExperiment } from '@agent-platform/pipeline-engine';

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 90_000;

const AGENT_DSL = `AGENT: Deployment_Mode_Test_Agent

GOAL: "Answer user questions for deployment mode experiment tests"

PERSONA: "Test assistant"
`;

// ── Types ────────────────────────────────────────────────────────────────────

interface ExperimentResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe(
  'Experiment Deployment Mode Integration',
  () => {
    let harness: RuntimeApiHarness;
    let bootstrap: BootstrapProjectResult;
    let agentName: string;
    let controlDeployment: DeploymentRecord;
    let experimentDeployment: DeploymentRecord;

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
        uniqueEmail('exp-deploy-admin'),
        uniqueSlug('exp-deploy-tenant'),
        uniqueSlug('exp-deploy-project'),
      );

      await importProjectFiles(harness, bootstrap.token, bootstrap.projectId, {
        'agents/deployment-mode-test.agent.abl': AGENT_DSL,
      });

      const agentsRes = await requestJson<{
        success: boolean;
        agents: Array<{ name: string }>;
      }>(harness, `/api/projects/${bootstrap.projectId}/agents`, {
        headers: authHeaders(bootstrap.token),
      });
      expect(agentsRes.status).toBe(200);
      agentName = agentsRes.body.agents?.[0]?.name;
      expect(agentName).toBeTruthy();

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
      const agentVersion = createVersionRes.body.version;
      expect(agentVersion).toBeTruthy();

      // Create the CONTROL deployment (production environment).
      // force=true bypasses model/credential preflight — the test doesn't need actual LLM calls.
      controlDeployment = await createDeployment(harness, bootstrap.token, bootstrap.projectId, {
        environment: 'production',
        entryAgentName: agentName,
        agentVersionManifest: { [agentName]: agentVersion },
        label: 'control-v1',
        force: true,
      });

      // Create the EXPERIMENT deployment (staging environment — same version, distinct deployment)
      experimentDeployment = await createDeployment(harness, bootstrap.token, bootstrap.projectId, {
        environment: 'staging',
        entryAgentName: agentName,
        agentVersionManifest: { [agentName]: agentVersion },
        label: 'experiment-v1',
        force: true,
      });
    }, TIMEOUT_MS);

    afterAll(async () => {
      await harness?.close();
    });

    // ── Helpers ────────────────────────────────────────────────────────────

    async function stopAllRunning(): Promise<void> {
      const listRes = await requestJson<{
        success: boolean;
        data?: Record<string, unknown>[];
      }>(harness, `/api/projects/${bootstrap.projectId}/experiments?status=running`, {
        headers: authHeaders(bootstrap.token),
      });
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

    async function createDeploymentModeExperiment(
      overrides: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const res = await requestJson<ExperimentResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments`,
        {
          method: 'POST',
          headers: authHeaders(bootstrap.token),
          body: {
            name: 'Deployment Mode Test',
            assignmentMode: 'deployment',
            controlDeploymentId: controlDeployment.id,
            experimentDeploymentId: experimentDeployment.id,
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
    // DEPL-1: Two deployments created via API
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-1: Two deployments created via API', () => {
      test('control and experiment deployments have distinct IDs and correct environments', () => {
        expect(controlDeployment.id).toBeTruthy();
        expect(experimentDeployment.id).toBeTruthy();
        expect(controlDeployment.id).not.toBe(experimentDeployment.id);
        expect(controlDeployment.environment).toBe('production');
        expect(experimentDeployment.environment).toBe('staging');
        expect(controlDeployment.entryAgentName).toBe(agentName);
        expect(experimentDeployment.entryAgentName).toBe(agentName);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-2: Deployment-mode experiment creation
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-2: Deployment-mode experiment creation', () => {
      test('create deployment-mode experiment → persists assignmentMode and deployment IDs', async () => {
        const exp = await createDeploymentModeExperiment({
          name: 'DEPL-2 Create Test',
        });

        expect(exp.assignmentMode).toBe('deployment');
        expect(exp.controlDeploymentId).toBe(controlDeployment.id);
        expect(exp.experimentDeploymentId).toBe(experimentDeployment.id);
        expect(exp.controlVersion).toBeUndefined();
        expect(exp.experimentVersion).toBeUndefined();
        expect(exp.status).toBe('draft');
        expect(exp.trafficSplit).toBe(0.5);
      });

      test('GET experiment → deployment IDs round-trip correctly', async () => {
        const exp = await createDeploymentModeExperiment({
          name: 'DEPL-2 Round-trip Test',
        });

        const getRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getRes.status).toBe(200);
        const fetched = getRes.body.data!;
        expect(fetched.assignmentMode).toBe('deployment');
        expect(fetched.controlDeploymentId).toBe(controlDeployment.id);
        expect(fetched.experimentDeploymentId).toBe(experimentDeployment.id);
      });

      test('deployment-mode without experimentDeploymentId → 400 VALIDATION_ERROR', async () => {
        const res = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments`,
          {
            method: 'POST',
            headers: authHeaders(bootstrap.token),
            body: {
              name: 'Bad Deployment Mode',
              assignmentMode: 'deployment',
              controlDeploymentId: controlDeployment.id,
              trafficSplit: 0.5,
              successMetrics: ['satisfaction_score'],
              channels: [],
            },
          },
        );
        expect(res.status).toBe(400);
        expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      });

      test('version-mode without version strings → 400 VALIDATION_ERROR', async () => {
        const res = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments`,
          {
            method: 'POST',
            headers: authHeaders(bootstrap.token),
            body: {
              name: 'Bad Version Mode',
              assignmentMode: 'version',
              trafficSplit: 0.5,
              successMetrics: ['satisfaction_score'],
              channels: [],
            },
          },
        );
        expect(res.status).toBe(400);
        expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-3: Start validates deployment IDs exist
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-3: Start validates deployment IDs exist', () => {
      test('nonexistent controlDeploymentId → 400 DEPLOYMENT_NOT_FOUND', async () => {
        const exp = await createDeploymentModeExperiment({
          name: 'Bad Control Deployment (DEPL-3)',
          controlDeploymentId: 'nonexistent-deployment-id-ctrl',
        });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(400);
        expect(startRes.body.error?.code).toBe('DEPLOYMENT_NOT_FOUND');
        expect(startRes.body.error?.message).toContain('nonexistent-deployment-id-ctrl');
      });

      test('nonexistent experimentDeploymentId → 400 DEPLOYMENT_NOT_FOUND', async () => {
        const exp = await createDeploymentModeExperiment({
          name: 'Bad Experiment Deployment (DEPL-3)',
          experimentDeploymentId: 'nonexistent-deployment-id-exp',
        });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(400);
        expect(startRes.body.error?.code).toBe('DEPLOYMENT_NOT_FOUND');
        expect(startRes.body.error?.message).toContain('nonexistent-deployment-id-exp');
      });

      test('valid deployment IDs → 200 running with deployment IDs preserved', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({ name: 'Valid Start (DEPL-3)' });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
        expect(startRes.body.data?.status).toBe('running');
        expect(startRes.body.data?.startedAt).toBeTruthy();
        expect(startRes.body.data?.assignmentMode).toBe('deployment');
        expect(startRes.body.data?.controlDeploymentId).toBe(controlDeployment.id);
        expect(startRes.body.data?.experimentDeploymentId).toBe(experimentDeployment.id);

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-4: Full lifecycle — start → running → stop
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-4: Full lifecycle transitions', () => {
      test('draft → running → stopped with deployment IDs preserved throughout', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({ name: 'Full Lifecycle (DEPL-4)' });

        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
        expect(startRes.body.data?.status).toBe('running');

        const getRunning = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getRunning.body.data?.status).toBe('running');
        expect(getRunning.body.data?.assignmentMode).toBe('deployment');

        const stopRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(stopRes.status).toBe(200);
        expect(stopRes.body.data?.status).toBe('stopped');
        expect(stopRes.body.data?.stoppedReason).toBe('manual');

        const getStopped = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getStopped.body.data?.status).toBe('stopped');
        expect(getStopped.body.data?.controlDeploymentId).toBe(controlDeployment.id);
        expect(getStopped.body.data?.experimentDeploymentId).toBe(experimentDeployment.id);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-5: Assignment at pure function level with deployment-mode
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-5: Assignment with deployment-mode CachedExperiment', () => {
      test('200 sessions → ~50/50 split within ±10%', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({
          name: 'Distribution Test (DEPL-5)',
          trafficSplit: 0.5,
        });
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);

        const experimentId = String(exp._id);
        const cachedExp: CachedExperiment = {
          experimentId,
          assignmentMode: 'deployment',
          controlDeploymentId: controlDeployment.id,
          experimentDeploymentId: experimentDeployment.id,
          trafficSplit: 0.5,
          channels: [],
        };

        let controlCount = 0;
        let experimentCount = 0;
        const TOTAL = 200;

        for (let i = 0; i < TOTAL; i++) {
          const key = getAssignmentKey({ contactId: null, _id: `session-depl-${i}` });
          const group = assignExperimentGroup(experimentId, key, cachedExp.trafficSplit);
          if (group === 'control') controlCount++;
          else experimentCount++;
        }

        const experimentRatio = experimentCount / TOTAL;
        expect(experimentRatio).toBeGreaterThan(0.4);
        expect(experimentRatio).toBeLessThan(0.6);
        expect(controlCount).toBeGreaterThan(0);
        expect(experimentCount).toBeGreaterThan(0);

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });

      test('same contactId → same group across 20 sessions', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({ name: 'Stickiness Test (DEPL-5)' });
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(200);

        const experimentId = String(exp._id);
        const contactId = 'sticky-contact-depl-mode-test';
        const groups = new Set<string>();

        for (let i = 0; i < 20; i++) {
          const key = getAssignmentKey({ contactId, _id: `session-sticky-depl-${i}` });
          const group = assignExperimentGroup(experimentId, key, 0.5);
          groups.add(group);
        }

        expect(groups.size).toBe(1);

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });

      test('studio session excluded from deployment-mode experiment', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({ name: 'Studio Exclusion (DEPL-5)' });
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(200);

        const cachedExp: CachedExperiment = {
          experimentId: String(exp._id),
          assignmentMode: 'deployment',
          controlDeploymentId: controlDeployment.id,
          experimentDeploymentId: experimentDeployment.id,
          trafficSplit: 0.5,
          channels: [],
        };

        const result = checkSessionEligibility(
          { source: { type: 'studio' }, parentId: null, channel: 'web' },
          cachedExp,
        );

        expect(result.eligible).toBe(false);
        if (!result.eligible) {
          expect(result.reason).toBe('studio_session');
        }

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });

      test('channel scoping excludes voice sessions from web-only deployment experiment', async () => {
        await stopAllRunning();
        const exp = await createDeploymentModeExperiment({
          name: 'Channel Scoping (DEPL-5)',
          channels: ['web'],
        });
        const startRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startRes.status).toBe(200);

        const cachedExp: CachedExperiment = {
          experimentId: String(exp._id),
          assignmentMode: 'deployment',
          controlDeploymentId: controlDeployment.id,
          experimentDeploymentId: experimentDeployment.id,
          trafficSplit: 0.5,
          channels: ['web'],
        };

        const voiceResult = checkSessionEligibility(
          { source: { type: 'public' }, parentId: null, channel: 'voice' },
          cachedExp,
        );
        expect(voiceResult.eligible).toBe(false);
        if (!voiceResult.eligible) {
          expect(voiceResult.reason).toBe('channel_excluded');
        }

        const webResult = checkSessionEligibility(
          { source: { type: 'public' }, parentId: null, channel: 'web' },
          cachedExp,
        );
        expect(webResult.eligible).toBe(true);

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-6: One-active constraint with deployment-mode
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-6: One-active constraint', () => {
      test('deployment-mode running → starting another → 409 CONFLICT', async () => {
        await stopAllRunning();

        const expA = await createDeploymentModeExperiment({ name: 'Active A (DEPL-6)' });
        const startA = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expA._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startA.status, JSON.stringify(startA.body)).toBe(200);

        const expB = await createDeploymentModeExperiment({ name: 'Active B (DEPL-6)' });
        const startB = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expB._id}/start`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
        expect(startB.status).toBe(409);
        expect(startB.body.error?.code).toBe('CONFLICT');

        await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${expA._id}/stop`,
          { method: 'POST', headers: authHeaders(bootstrap.token) },
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DEPL-7: List includes deployment-mode fields
    // ═══════════════════════════════════════════════════════════════════════

    describe('DEPL-7: List includes deployment-mode fields', () => {
      test('list experiments → deployment-mode experiment has assignmentMode and deployment IDs', async () => {
        const created = await createDeploymentModeExperiment({ name: 'List Test (DEPL-7)' });

        const listRes = await requestJson<{
          success: boolean;
          data?: Record<string, unknown>[];
        }>(harness, `/api/projects/${bootstrap.projectId}/experiments`, {
          headers: authHeaders(bootstrap.token),
        });
        expect(listRes.status).toBe(200);
        expect(Array.isArray(listRes.body.data)).toBe(true);

        const found = listRes.body.data?.find(
          (e: Record<string, unknown>) => String(e._id) === String(created._id),
        );
        expect(found).toBeTruthy();
        expect(found?.assignmentMode).toBe('deployment');
        expect(found?.controlDeploymentId).toBe(controlDeployment.id);
        expect(found?.experimentDeploymentId).toBe(experimentDeployment.id);
      });
    });
  },
  TIMEOUT_MS,
);
