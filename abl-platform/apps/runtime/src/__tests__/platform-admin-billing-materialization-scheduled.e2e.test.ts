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

const SIMPLE_AGENT_DSL = `AGENT: Billing_Scheduled_Materialization_Agent

GOAL: "Reply to the user"

PERSONA: "Helpful assistant"
`;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface BillingMaterializationListResponse {
  success: boolean;
  materializations: Array<{
    batchId: string;
    projectId: string | null;
    triggerSource: 'manual' | 'scheduled';
    resultCount: number;
    eventDispatchAttempted: boolean;
    scope: {
      basis: 'time_window' | 'completed_sessions';
      completedSessionsCount: number | null;
    };
    summary: {
      includedSessionCount: number;
      excludedSessionCount: number;
      projectBreakdown: Array<{
        projectId: string;
        totalUnits: number;
      }>;
      channelBreakdown: Array<{
        channel: string;
        totalUnits: number;
      }>;
    } | null;
  }>;
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

async function waitForScheduledMaterialization(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  timeoutMs = 30_000,
): Promise<BillingMaterializationListResponse['materializations'][number]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson<BillingMaterializationListResponse>(
      harness,
      `/api/platform/admin/billing-policy/${tenantId}/materializations`,
      {
        method: 'GET',
        headers: authHeaders(token),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const scheduledBatch = response.body.materializations.find(
      (materialization) => materialization.triggerSource === 'scheduled',
    );

    if (
      scheduledBatch &&
      scheduledBatch.scope.basis === 'completed_sessions' &&
      scheduledBatch.scope.completedSessionsCount === 2 &&
      scheduledBatch.resultCount === 2
    ) {
      return scheduledBatch;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for scheduled billing materialization batch');
}

describe('Platform Admin Scheduled Billing Materialization E2E', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let previousClickHouseUrl: string | undefined;

  beforeAll(async () => {
    previousClickHouseUrl = process.env.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_URL = 'http://127.0.0.1:1';
    await closeClickHouseClient();
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness(
      {
        SESSION_TERMINALIZATION_ENABLED: 'true',
        BILLING_MATERIALIZATION_ENABLED: 'true',
        BILLING_MATERIALIZATION_INTERVAL_MS: '200',
        BILLING_MATERIALIZATION_TENANT_BATCH_SIZE: '10',
      },
      { bootstrapServer: true },
    );
  }, TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    mockLlm.reset();
    mockLlm.register('', { content: 'Default scheduled billing materialization reply.' });
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
      uniqueEmail(`billing-materialization-scheduled-${prefix}`),
      uniqueSlug(`billing-materialization-scheduled-tenant-${prefix}`),
      uniqueSlug(`billing-materialization-scheduled-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-materialization-scheduled.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Scheduled Materialization Model ${prefix}`,
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
        credentialName: `mock-billing-materialization-scheduled-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'scheduled materialization batches run automatically for completed-session policy and expose tenant aggregate breakdowns',
    async () => {
      const admin = await setupProject('scheduled');

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

      mockLlm.register('scheduled turn one', { content: 'Scheduled reply one.' });
      mockLlm.register('scheduled turn two', { content: 'Scheduled reply two.' });

      const firstSession = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'scheduled turn one',
        },
      });

      expect(firstSession.status).toBe(200);
      await closeSession(harness, admin.token, admin.projectId, firstSession.body.sessionId);

      const secondSession = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'scheduled turn two',
        },
      });

      expect(secondSession.status).toBe(200);
      await closeSession(harness, admin.token, admin.projectId, secondSession.body.sessionId);

      const scheduledBatch = await waitForScheduledMaterialization(
        harness,
        admin.token,
        admin.tenantId,
      );

      expect(scheduledBatch).toMatchObject({
        projectId: null,
        triggerSource: 'scheduled',
        resultCount: 2,
        eventDispatchAttempted: false,
        scope: {
          basis: 'completed_sessions',
          completedSessionsCount: 2,
        },
        summary: {
          includedSessionCount: 2,
          excludedSessionCount: 0,
          projectBreakdown: [
            {
              projectId: admin.projectId,
            },
          ],
          channelBreakdown: [
            {
              channel: 'api',
            },
          ],
        },
      });
      expect(scheduledBatch.summary?.projectBreakdown[0]?.totalUnits).toBeGreaterThan(0);
      expect(scheduledBatch.summary?.channelBreakdown[0]?.totalUnits).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
