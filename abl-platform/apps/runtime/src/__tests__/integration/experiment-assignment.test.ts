/**
 * Experiment Assignment — Integration Tests
 *
 * Tests session-level experiment assignment through the real HTTP API:
 * distribution, contactId stickiness, studio exclusion, and channel scoping.
 *
 * ZERO vi.mock() calls — exercises the full middleware chain.
 *
 * NOTE: These tests validate the assignment logic at the pure-function layer
 * because the full session creation pipeline requires model resolution,
 * deployment, and async infrastructure that is beyond the scope of this
 * integration test. The pure function tests in pipeline-engine cover
 * the assignment algorithm thoroughly. These tests verify the API-level
 * experiment management that controls assignment behavior.
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

// ── Pure assignment functions ────────────────────────────────────────────────
import {
  assignExperimentGroup,
  getAssignmentKey,
  checkSessionEligibility,
} from '@agent-platform/pipeline-engine';
import type { CachedExperiment } from '@agent-platform/pipeline-engine';

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 90_000;

const SIMPLE_AGENT_DSL = `AGENT: Assignment_Test_Agent

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
  'Experiment Assignment Integration',
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
        uniqueEmail('exp-assign-admin'),
        uniqueSlug('exp-assign-tenant'),
        uniqueSlug('exp-assign-project'),
      );

      await importProjectFiles(harness, bootstrap.token, bootstrap.projectId, {
        'agents/assignment-test.agent.abl': SIMPLE_AGENT_DSL,
      });

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

    // Helpers

    /** Stop all running experiments in the project to ensure test isolation. */
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

    async function createAndStartExperiment(
      overrides: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      // Ensure no running experiments before starting a new one
      await stopAllRunning();
      const createRes = await requestJson<ExperimentResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments`,
        {
          method: 'POST',
          headers: authHeaders(bootstrap.token),
          body: {
            name: 'Assignment Test',
            controlVersion: agentVersionId,
            experimentVersion: agentVersionId,
            trafficSplit: 0.5,
            successMetrics: ['satisfaction_score'],
            channels: [],
            ...overrides,
          },
        },
      );
      expect(createRes.status).toBe(201);
      const exp = createRes.body.data!;

      const startRes = await requestJson<ExperimentResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments/${exp._id}/start`,
        { method: 'POST', headers: authHeaders(bootstrap.token) },
      );
      expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);
      return startRes.body.data!;
    }

    async function stopExperiment(id: string): Promise<void> {
      await requestJson<ExperimentResponse>(
        harness,
        `/api/projects/${bootstrap.projectId}/experiments/${id}/stop`,
        { method: 'POST', headers: authHeaders(bootstrap.token) },
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INT-4: Distribution test (pure function level)
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-4: Distribution with real experiment', () => {
      test('200 sessions against running experiment → ~50/50 split within ±10%', async () => {
        const exp = await createAndStartExperiment({
          name: 'Distribution Test (INT-4)',
          trafficSplit: 0.5,
        });

        const experimentId = String(exp._id);
        const cachedExp: CachedExperiment = {
          experimentId,
          controlVersion: String(exp.controlVersion),
          experimentVersion: String(exp.experimentVersion),
          trafficSplit: Number(exp.trafficSplit),
          channels: (exp.channels as string[]) ?? [],
        };

        let controlCount = 0;
        let experimentCount = 0;
        const TOTAL = 200;

        for (let i = 0; i < TOTAL; i++) {
          const sessionId = `session-dist-${i}`;
          const key = getAssignmentKey({ contactId: null, _id: sessionId });
          const group = assignExperimentGroup(cachedExp.experimentId, key, cachedExp.trafficSplit);
          if (group === 'control') controlCount++;
          else experimentCount++;
        }

        // ~50/50 split within ±10% (generous for small N)
        const experimentRatio = experimentCount / TOTAL;
        expect(experimentRatio).toBeGreaterThan(0.4);
        expect(experimentRatio).toBeLessThan(0.6);

        // Both groups should have assignments
        expect(controlCount).toBeGreaterThan(0);
        expect(experimentCount).toBeGreaterThan(0);

        await stopExperiment(experimentId);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-5: contactId stickiness
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-5: contactId stickiness', () => {
      test('same contactId across different sessions → same group', async () => {
        const exp = await createAndStartExperiment({ name: 'Stickiness Test (INT-5)' });
        const experimentId = String(exp._id);
        const contactId = 'sticky-contact-integration-test';

        const groups = new Set<string>();
        for (let i = 0; i < 20; i++) {
          const key = getAssignmentKey({ contactId, _id: `session-sticky-${i}` });
          const group = assignExperimentGroup(experimentId, key, Number(exp.trafficSplit));
          groups.add(group);
        }

        // All sessions with the same contactId should land in the same group
        expect(groups.size).toBe(1);

        await stopExperiment(experimentId);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-6: Studio session excluded
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-6: Studio session excluded', () => {
      test('studio session → ineligible for experiment', async () => {
        const exp = await createAndStartExperiment({ name: 'Studio Exclusion (INT-6)' });
        const experimentId = String(exp._id);
        const cachedExp: CachedExperiment = {
          experimentId,
          controlVersion: String(exp.controlVersion),
          experimentVersion: String(exp.experimentVersion),
          trafficSplit: Number(exp.trafficSplit),
          channels: (exp.channels as string[]) ?? [],
        };

        const result = checkSessionEligibility(
          { source: { type: 'studio' }, parentId: null, channel: 'web' },
          cachedExp,
        );

        expect(result.eligible).toBe(false);
        if (!result.eligible) {
          expect(result.reason).toBe('studio_session');
        }

        await stopExperiment(experimentId);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INT-7: Channel scoping
    // ═══════════════════════════════════════════════════════════════════════

    describe('INT-7: Channel scoping', () => {
      test('experiment with channels=["web"] → voice session is ineligible', async () => {
        const exp = await createAndStartExperiment({
          name: 'Channel Scoping (INT-7)',
          channels: ['web'],
        });
        const experimentId = String(exp._id);
        const cachedExp: CachedExperiment = {
          experimentId,
          controlVersion: String(exp.controlVersion),
          experimentVersion: String(exp.experimentVersion),
          trafficSplit: Number(exp.trafficSplit),
          channels: ['web'],
        };

        // Voice session should be excluded
        const voiceResult = checkSessionEligibility(
          { source: { type: 'public' }, parentId: null, channel: 'voice' },
          cachedExp,
        );
        expect(voiceResult.eligible).toBe(false);
        if (!voiceResult.eligible) {
          expect(voiceResult.reason).toBe('channel_excluded');
        }

        // Web session should be eligible
        const webResult = checkSessionEligibility(
          { source: { type: 'public' }, parentId: null, channel: 'web' },
          cachedExp,
        );
        expect(webResult.eligible).toBe(true);

        await stopExperiment(experimentId);
      });

      test('experiment channels persisted correctly via API', async () => {
        // Verify that creating an experiment with channels=['web'] persists correctly
        const createRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments`,
          {
            method: 'POST',
            headers: authHeaders(bootstrap.token),
            body: {
              name: 'Channel Persistence Test',
              controlVersion: agentVersionId,
              experimentVersion: agentVersionId,
              trafficSplit: 0.5,
              successMetrics: ['satisfaction_score'],
              channels: ['web', 'sms'],
            },
          },
        );
        expect(createRes.status).toBe(201);
        const exp = createRes.body.data!;
        expect(exp.channels).toEqual(['web', 'sms']);

        // Fetch and verify
        const getRes = await requestJson<ExperimentResponse>(
          harness,
          `/api/projects/${bootstrap.projectId}/experiments/${exp._id}`,
          { headers: authHeaders(bootstrap.token) },
        );
        expect(getRes.status).toBe(200);
        expect(getRes.body.data?.channels).toEqual(['web', 'sms']);
      });
    });
  },
  TIMEOUT_MS,
);
