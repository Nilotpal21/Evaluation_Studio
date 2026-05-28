import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeClickHouseClient } from '@agent-platform/database/clickhouse';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

const TIMEOUT_MS = 150_000;

const SIMPLE_AGENT_DSL = `AGENT: Billing_Materialization_Plan_Agent

GOAL: "Reply to the user"

PERSONA: "Helpful assistant"
`;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface BillingMaterializationPlanResponse {
  success: boolean;
  plan: {
    due: boolean;
    reason:
      | 'due'
      | 'misconfigured_policy'
      | 'no_ended_sessions'
      | 'waiting_for_window_close'
      | 'insufficient_completed_sessions';
    basis: 'time_window' | 'completed_sessions';
    projectId: string | null;
    checkpoint: {
      lastBatchId: string | null;
    } | null;
    scope: {
      basis: 'time_window' | 'completed_sessions';
      completedSessionsCount: number | null;
      cursorStartAfterSessionId: string | null;
      cursorEndSessionId: string | null;
    } | null;
    stats: {
      candidateSessionCount: number;
      requiredCompletedSessionsCount: number | null;
      remainingCompletedSessionsCount: number | null;
    };
  };
}

async function closeSession(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const response = await requestJson<{ success: boolean }>(
    harness,
    `/api/projects/${projectId}/sessions/${sessionId}/close`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: { disposition: 'completed' },
    },
  );

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
}

async function waitForDuePlan(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  projectId: string,
  timeoutMs = 30_000,
): Promise<BillingMaterializationPlanResponse['plan']> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson<BillingMaterializationPlanResponse>(
      harness,
      `/api/platform/admin/billing-policy/${tenantId}/materializations/due?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'GET',
        headers: authHeaders(token),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    if (
      response.body.plan.due &&
      response.body.plan.scope?.completedSessionsCount === 2 &&
      response.body.plan.stats.candidateSessionCount === 2
    ) {
      return response.body.plan;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Timed out waiting for billing materialization due plan');
}

describe('Platform Admin Billing Materialization Plan E2E', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let previousClickHouseUrl: string | undefined;

  beforeAll(async () => {
    previousClickHouseUrl = process.env.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_URL = 'http://127.0.0.1:1';
    await closeClickHouseClient();
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({
      SESSION_TERMINALIZATION_ENABLED: 'true',
    });
  }, TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    mockLlm.reset();
    mockLlm.register('', { content: 'Default billing materialization plan reply.' });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
    await closeClickHouseClient();
    if (previousClickHouseUrl === undefined) {
      delete process.env.CLICKHOUSE_URL;
    } else {
      process.env.CLICKHOUSE_URL = previousClickHouseUrl;
    }
  }, TIMEOUT_MS);

  async function setupProject(prefix: string): Promise<BootstrapProjectResult> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail(`billing-materialization-plan-${prefix}`),
      uniqueSlug(`billing-materialization-plan-tenant-${prefix}`),
      uniqueSlug(`billing-materialization-plan-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-materialization-plan.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Materialization Plan Model ${prefix}`,
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: false,
      capabilities: ['text'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: `mock-billing-materialization-plan-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'due-plan route exposes the next completed-session scheduler candidate through the real lifecycle flow',
    async () => {
      const admin = await setupProject('plan');

      const updateResponse = await requestJson<{ success: boolean }>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            materialization: {
              basis: 'completed_sessions',
              timeWindowMinutes: null,
              completedSessionsCount: 2,
            },
          },
        },
      );

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.success).toBe(true);

      mockLlm.register('plan turn one', { content: 'Plan reply one.' });
      mockLlm.register('plan turn two', { content: 'Plan reply two.' });

      const firstSession = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'plan turn one',
        },
      });

      expect(firstSession.status).toBe(200);
      await closeSession(harness, admin.token, admin.projectId, firstSession.body.sessionId);

      const secondSession = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'plan turn two',
        },
      });

      expect(secondSession.status).toBe(200);
      await closeSession(harness, admin.token, admin.projectId, secondSession.body.sessionId);

      const plan = await waitForDuePlan(harness, admin.token, admin.tenantId, admin.projectId);

      expect(plan.due).toBe(true);
      expect(plan.reason).toBe('due');
      expect(plan.basis).toBe('completed_sessions');
      expect(plan.projectId).toBe(admin.projectId);
      expect(plan.checkpoint).toBeNull();
      expect(plan.scope).toMatchObject({
        basis: 'completed_sessions',
        completedSessionsCount: 2,
        cursorStartAfterSessionId: null,
      });
      expect(plan.scope?.cursorEndSessionId).toBeTruthy();
      expect(plan.stats).toMatchObject({
        candidateSessionCount: 2,
        requiredCompletedSessionsCount: 2,
        remainingCompletedSessionsCount: 0,
      });
    },
    TIMEOUT_MS,
  );
});
