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

const SIMPLE_AGENT_DSL = `AGENT: Billing_Preview_Agent

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
    baseUnits: number;
    llmAddonUnits: number;
    toolAddonUnits: number;
    totalUnits: number;
    metricsSourceCounts: {
      clickhouse: number;
      message_fallback: number;
    };
  };
  sessions: Array<{
    sessionId: string;
    included: boolean;
    userMessageCount: number;
    assistantMessageCount: number;
    interactiveTurnCount: number;
    llmCallCount: number;
    toolCallCount: number;
    metricsSource: 'clickhouse' | 'message_fallback';
    exclusionReasons: string[];
    baseUnits: number;
    llmAddonUnits: number;
    toolAddonUnits: number;
    totalUnits: number;
  }>;
  warnings: string[];
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
): Promise<BillingPreviewResponse> {
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
      return response.body;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Timed out waiting for billing preview to reflect persisted session history');
}

describe('Platform Admin Billing Preview E2E', () => {
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
    mockLlm.register('', { content: 'Default billing preview reply.' });
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
      uniqueEmail(`billing-preview-${prefix}`),
      uniqueSlug(`billing-preview-tenant-${prefix}`),
      uniqueSlug(`billing-preview-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-preview.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Preview Model ${prefix}`,
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
        credentialName: `mock-billing-preview-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'preview route derives included and excluded billing units through the real chat + close flow',
    async () => {
      const admin = await setupProject('preview');

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

      mockLlm.register('billable turn one', { content: 'Reply one.' });
      mockLlm.register('billable turn two', { content: 'Reply two.' });
      mockLlm.register('single turn only', { content: 'Single turn reply.' });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'billable turn one',
        },
      });

      expect(firstTurn.status).toBe(200);
      const includedSessionId = firstTurn.body.sessionId;
      expect(includedSessionId).toBeTruthy();

      const secondTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: includedSessionId,
          message: 'billable turn two',
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
          message: 'single turn only',
        },
      });

      expect(singleTurn.status).toBe(200);
      const excludedSessionId = singleTurn.body.sessionId;
      expect(excludedSessionId).toBeTruthy();

      await closeSession(harness, admin.token, admin.projectId, excludedSessionId);

      const preview = await waitForBillingPreview(
        harness,
        admin.token,
        admin.tenantId,
        admin.projectId,
        includedSessionId,
        excludedSessionId,
      );

      expect(preview.summary).toMatchObject({
        includedSessionCount: 2,
        excludedSessionCount: 0,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 0,
        totalUnits: 5,
        metricsSourceCounts: {
          clickhouse: 0,
          message_fallback: 2,
        },
      });
      expect(preview.warnings).toContain(
        'ClickHouse usage telemetry unavailable; addon counts fell back to message history.',
      );

      const includedSession = preview.sessions.find(
        (session) => session.sessionId === includedSessionId,
      );
      expect(includedSession).toMatchObject({
        included: true,
        userMessageCount: 2,
        assistantMessageCount: 2,
        interactiveTurnCount: 2,
        llmCallCount: 2,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        baseUnits: 1,
        llmAddonUnits: 2,
        toolAddonUnits: 0,
        totalUnits: 3,
      });

      const excludedSession = preview.sessions.find(
        (session) => session.sessionId === excludedSessionId,
      );
      expect(excludedSession).toMatchObject({
        included: true,
        userMessageCount: 1,
        assistantMessageCount: 1,
        interactiveTurnCount: 1,
        llmCallCount: 1,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        baseUnits: 1,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 2,
        exclusionReasons: [],
      });
    },
    TIMEOUT_MS,
  );
});
