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

const SIMPLE_AGENT_DSL = `AGENT: Billing_Replay_Agent

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

interface BillingReplayRunResponse {
  success: boolean;
  replay: {
    runId: string;
    resultCount: number;
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
    page: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
    sessions: Array<{
      sessionId: string;
      included: boolean;
      llmCallCount: number;
      metricsSource: 'clickhouse' | 'message_fallback';
      exclusionReasons: string[];
      totalUnits: number;
    }>;
  };
}

interface BillingReplayRunListResponse {
  success: boolean;
  runs: Array<{
    runId: string;
    resultCount: number;
    triggeredBy: string;
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

async function waitForBillingPreview(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  projectId: string,
  expectedIncludedSessionId: string,
  expectedExcludedSessionId: string,
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
      (session) => session.sessionId === expectedExcludedSessionId,
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

  throw new Error('Timed out waiting for billing preview parity before replay creation');
}

describe('Platform Admin Billing Replay E2E', () => {
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
    mockLlm.register('', { content: 'Default billing replay reply.' });
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
      uniqueEmail(`billing-replay-${prefix}`),
      uniqueSlug(`billing-replay-tenant-${prefix}`),
      uniqueSlug(`billing-replay-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-replay.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Replay Model ${prefix}`,
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
        credentialName: `mock-billing-replay-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'replay routes persist and expose compare-only billing results through the real lifecycle flow',
    async () => {
      const admin = await setupProject('replay');

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

      mockLlm.register('replay turn one', { content: 'Reply one.' });
      mockLlm.register('replay turn two', { content: 'Reply two.' });
      mockLlm.register('replay single turn', { content: 'Single turn reply.' });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'replay turn one',
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
          message: 'replay turn two',
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
          message: 'replay single turn',
        },
      });

      expect(singleTurn.status).toBe(200);
      const excludedSessionId = singleTurn.body.sessionId;
      await closeSession(harness, admin.token, admin.projectId, excludedSessionId);

      await waitForBillingPreview(
        harness,
        admin.token,
        admin.tenantId,
        admin.projectId,
        includedSessionId,
        excludedSessionId,
      );

      const createReplayResponse = await requestJson<BillingReplayRunResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/replays`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            projectId: admin.projectId,
          },
        },
      );

      expect(createReplayResponse.status).toBe(201);
      expect(createReplayResponse.body.success).toBe(true);
      expect(createReplayResponse.body.replay.resultCount).toBe(2);
      expect(createReplayResponse.body.replay.scope.basis).toBe('time_window');
      expect(createReplayResponse.body.replay.summary).toMatchObject({
        includedSessionCount: 2,
        excludedSessionCount: 0,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 0,
        totalUnits: 5,
      });
      expect(createReplayResponse.body.replay.page).toMatchObject({
        page: 1,
        total: 2,
        hasMore: false,
      });

      const createdRunId = createReplayResponse.body.replay.runId;
      const includedSession = createReplayResponse.body.replay.sessions.find(
        (session) => session.sessionId === includedSessionId,
      );
      const excludedSession = createReplayResponse.body.replay.sessions.find(
        (session) => session.sessionId === excludedSessionId,
      );

      expect(includedSession).toMatchObject({
        included: true,
        llmCallCount: 2,
        metricsSource: 'message_fallback',
        totalUnits: 3,
      });
      expect(excludedSession).toMatchObject({
        included: true,
        llmCallCount: 1,
        metricsSource: 'message_fallback',
        baseUnits: 1,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 2,
        exclusionReasons: [],
      });

      const listResponse = await requestJson<BillingReplayRunListResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/replays?projectId=${encodeURIComponent(admin.projectId)}`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.success).toBe(true);
      expect(listResponse.body.runs).toEqual([
        expect.objectContaining({
          runId: createdRunId,
          resultCount: 2,
          triggeredBy: admin.userId,
        }),
      ]);

      const detailResponse = await requestJson<BillingReplayRunResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/replays/${createdRunId}?page=1&limit=1`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(detailResponse.status).toBe(200);
      expect(detailResponse.body.success).toBe(true);
      expect(detailResponse.body.replay.page).toMatchObject({
        page: 1,
        limit: 1,
        total: 2,
        hasMore: true,
      });
      expect(detailResponse.body.replay.sessions).toHaveLength(1);
      expect(detailResponse.body.replay.sessions[0]?.sessionId).toBe(includedSessionId);
    },
    TIMEOUT_MS,
  );
});
