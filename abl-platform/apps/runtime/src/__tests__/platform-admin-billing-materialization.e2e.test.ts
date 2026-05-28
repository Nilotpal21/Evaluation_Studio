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

const SIMPLE_AGENT_DSL = `AGENT: Billing_Materialization_Agent

GOAL: "Reply to the user"

PERSONA: "Helpful assistant"
`;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface BillingPreviewResponse {
  success: boolean;
  summary: {
    includedSessionCount: number;
    excludedSessionCount: number;
  };
  sessions: Array<{
    sessionId: string;
    included: boolean;
    assistantMessageCount: number;
    llmCallCount: number;
    metricsSource: 'clickhouse' | 'message_fallback';
  }>;
}

interface BillingMaterializationResponse {
  success: boolean;
  materialization: {
    batchId: string;
    resultCount: number;
    eventId: string | null;
    eventDispatchAttempted: boolean;
    scope: {
      basis: 'time_window' | 'completed_sessions';
    };
    summary: {
      includedSessionCount: number;
      excludedSessionCount: number;
      baseUnits: number;
      llmAddonUnits: number;
      toolAddonUnits: number;
      totalUnits: number;
    };
  };
}

interface BillingMaterializationListResponse {
  success: boolean;
  materializations: Array<{
    batchId: string;
    resultCount: number;
    triggeredBy: string;
  }>;
}

interface BillingMaterializationResultsResponse {
  success: boolean;
  results: {
    batchId: string;
    page: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
    sessions: Array<{
      sessionId: string;
      triggerSource: 'manual' | 'scheduled';
      materializationBasis: 'time_window' | 'completed_sessions';
      included: boolean;
      totalUnits: number;
      metricsSource: 'clickhouse' | 'message_fallback';
    }>;
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

async function waitForBillingPreview(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  projectId: string,
  expectedIncludedSessionId: string,
  expectedSecondSessionId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson<BillingPreviewResponse>(
      harness,
      `/api/platform/admin/billing-policy/${tenantId}/preview?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'GET',
        headers: authHeaders(token),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const includedSession = response.body.sessions.find(
      (session) => session.sessionId === expectedIncludedSessionId,
    );
    const excludedSession = response.body.sessions.find(
      (session) => session.sessionId === expectedSecondSessionId,
    );

    if (
      response.body.summary.includedSessionCount === 2 &&
      response.body.summary.excludedSessionCount === 0 &&
      includedSession?.assistantMessageCount === 2 &&
      includedSession?.llmCallCount === 2 &&
      includedSession?.metricsSource === 'message_fallback' &&
      excludedSession?.included === true &&
      excludedSession?.assistantMessageCount === 1 &&
      excludedSession?.llmCallCount === 1 &&
      excludedSession?.metricsSource === 'message_fallback'
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Timed out waiting for billing preview parity before materialization');
}

describe('Platform Admin Billing Materialization E2E', () => {
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
    mockLlm.register('', { content: 'Default billing materialization reply.' });
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
      uniqueEmail(`billing-materialization-${prefix}`),
      uniqueSlug(`billing-materialization-tenant-${prefix}`),
      uniqueSlug(`billing-materialization-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-materialization.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Materialization Model ${prefix}`,
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
        credentialName: `mock-billing-materialization-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'materialization routes persist truthful aggregate billing batches through the real lifecycle flow',
    async () => {
      const admin = await setupProject('materialization');

      const updateResponse = await requestJson<{ success: boolean }>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            interactionThreshold: {
              minUserMessages: 2,
              minInteractiveTurns: 2,
              minEngagedSeconds: 0,
            },
            addons: {
              llm: {
                mode: 'per_call',
                bucketSize: null,
              },
              tool: {
                mode: 'per_call',
                bucketSize: null,
              },
            },
            materialization: {
              basis: 'time_window',
              timeWindowMinutes: 60,
              completedSessionsCount: null,
            },
          },
        },
      );

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.success).toBe(true);

      mockLlm.register('materialization turn one', { content: 'Reply one.' });
      mockLlm.register('materialization turn two', { content: 'Reply two.' });
      mockLlm.register('materialization single turn', { content: 'Single turn reply.' });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'materialization turn one',
        },
      });

      expect(firstTurn.status).toBe(200);
      const includedSessionId = firstTurn.body.sessionId;

      const secondTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: includedSessionId,
          message: 'materialization turn two',
        },
      });

      expect(secondTurn.status).toBe(200);
      expect(secondTurn.body.sessionId).toBe(includedSessionId);
      await closeSession(harness, admin.token, admin.projectId, includedSessionId);

      const singleTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'materialization single turn',
        },
      });

      expect(singleTurn.status).toBe(200);
      const singleTurnSessionId = singleTurn.body.sessionId;
      await closeSession(harness, admin.token, admin.projectId, singleTurnSessionId);

      await waitForBillingPreview(
        harness,
        admin.token,
        admin.tenantId,
        admin.projectId,
        includedSessionId,
        singleTurnSessionId,
      );

      const createResponse = await requestJson<BillingMaterializationResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            projectId: admin.projectId,
          },
        },
      );

      expect(createResponse.status).toBe(201);
      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.materialization.resultCount).toBe(2);
      expect(createResponse.body.materialization.eventDispatchAttempted).toBe(false);
      expect(createResponse.body.materialization.eventId).toBeNull();
      expect(createResponse.body.materialization.scope.basis).toBe('time_window');
      expect(createResponse.body.materialization.summary).toMatchObject({
        includedSessionCount: 2,
        excludedSessionCount: 0,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 0,
        totalUnits: 5,
      });

      const batchId = createResponse.body.materialization.batchId;

      const listResponse = await requestJson<BillingMaterializationListResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations?projectId=${encodeURIComponent(admin.projectId)}`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.success).toBe(true);
      expect(listResponse.body.materializations).toEqual([
        expect.objectContaining({
          batchId,
          resultCount: 2,
          triggeredBy: admin.userId,
        }),
      ]);

      const detailResponse = await requestJson<BillingMaterializationResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations/${batchId}`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(detailResponse.status).toBe(200);
      expect(detailResponse.body.success).toBe(true);
      expect(detailResponse.body.materialization.batchId).toBe(batchId);
      expect(detailResponse.body.materialization.eventDispatchAttempted).toBe(false);
      expect(detailResponse.body.materialization.summary.totalUnits).toBe(5);

      const resultsResponse = await requestJson<BillingMaterializationResultsResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations/${batchId}/results?limit=10`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(resultsResponse.status).toBe(200);
      expect(resultsResponse.body.success).toBe(true);
      expect(resultsResponse.body.results.page).toMatchObject({
        page: 1,
        limit: 10,
        total: 2,
        hasMore: false,
      });
      expect(resultsResponse.body.results.sessions).toEqual([
        expect.objectContaining({
          sessionId: includedSessionId,
          triggerSource: 'manual',
          materializationBasis: 'time_window',
          included: true,
          totalUnits: 3,
          metricsSource: 'message_fallback',
        }),
        expect.objectContaining({
          sessionId: singleTurnSessionId,
          triggerSource: 'manual',
          materializationBasis: 'time_window',
          included: true,
          totalUnits: 2,
          metricsSource: 'message_fallback',
        }),
      ]);
    },
    TIMEOUT_MS,
  );
});
