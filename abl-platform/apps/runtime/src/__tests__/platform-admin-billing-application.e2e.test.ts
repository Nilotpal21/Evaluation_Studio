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

const SIMPLE_AGENT_DSL = `AGENT: Billing_Application_Agent

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
  };
  sessions: Array<{
    sessionId: string;
    included: boolean;
    metricsSource: 'clickhouse' | 'message_fallback';
  }>;
}

interface BillingMaterializationCreateResponse {
  success: boolean;
  materialization: {
    batchId: string;
  };
}

interface TenantDetailResponse {
  success: boolean;
  tenant: {
    _id: string;
    organizationId: string | null;
  };
}

interface DealCreateResponse {
  success: boolean;
  deal: {
    _id: string;
    organizationId: string;
    scope: 'organization' | 'project';
    projectId?: string;
  };
}

interface BillingMaterializationApplicationResponse {
  success: boolean;
  application: {
    applicationId: string;
    batchId: string;
    dealResolution: {
      organizationId: string;
      dealId: string;
      dealScope: 'organization' | 'project';
      matchType: 'project_exact' | 'organization_scope' | 'organization_fallback';
    };
    accountingPeriod: {
      billingCycle: string;
      periodLabel: string;
    };
    projection: {
      usageReports: {
        status: 'deferred' | 'applied';
      };
      creditLedger: {
        status: 'deferred' | 'applied';
      };
      billingLineItems: {
        status: 'deferred' | 'applied';
      };
    };
  };
}

interface BillingUsageReportResponse {
  success: boolean;
  tenantId: string | null;
  projectId: string | null;
  totals: {
    examinedSessionCount: number;
    includedSessionCount: number;
    totalUnits: number;
  };
  tenantBreakdown?: Array<{
    tenantId: string;
    tenantName: string;
    totalUnits: number;
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
  expectedSessionId: string,
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

    const session = response.body.sessions.find((entry) => entry.sessionId === expectedSessionId);
    if (
      response.body.summary.includedSessionCount >= 1 &&
      session?.included === true &&
      session.metricsSource === 'message_fallback'
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Timed out waiting for billing preview before applying materialization batch');
}

describe('Platform Admin Billing Materialization Application E2E', () => {
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
    mockLlm.register('', { content: 'Default billing application reply.' });
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
      uniqueEmail(`billing-application-${prefix}`),
      uniqueSlug(`billing-application-tenant-${prefix}`),
      uniqueSlug(`billing-application-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/billing-application.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Billing Application Model ${prefix}`,
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
        credentialName: `mock-billing-application-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'applies a completed materialization batch exactly once and exposes the recorded application',
    async () => {
      const admin = await setupProject('apply');

      const updateResponse = await requestJson<{ success: boolean }>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            interactionThreshold: {
              minUserMessages: 1,
              minInteractiveTurns: 1,
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

      mockLlm.register('billing application turn one', {
        content: 'Billing application reply one.',
      });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'billing application turn one',
        },
      });

      expect(firstTurn.status).toBe(200);
      const sessionId = firstTurn.body.sessionId;
      await closeSession(harness, admin.token, admin.projectId, sessionId);

      await waitForBillingPreview(harness, admin.token, admin.tenantId, admin.projectId, sessionId);

      const materialization = await requestJson<BillingMaterializationCreateResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: { projectId: admin.projectId },
        },
      );

      expect(materialization.status).toBe(201);
      expect(materialization.body.success).toBe(true);
      const batchId = materialization.body.materialization.batchId;

      const tenantDetail = await requestJson<TenantDetailResponse>(
        harness,
        `/api/platform/admin/tenants/${admin.tenantId}`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(tenantDetail.status).toBe(200);
      expect(tenantDetail.body.success).toBe(true);
      const organizationId = tenantDetail.body.tenant.organizationId ?? admin.tenantId;

      const dealCreate = await requestJson<DealCreateResponse>(
        harness,
        '/api/platform/admin/deals',
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            organizationId,
            name: 'Billing Application Deal',
            status: 'active',
            scope: 'project',
            projectId: admin.projectId,
            aggregationMode: 'dedicated',
            phases: [],
            overagePolicy: 'soft_cap',
            overageAlertThresholds: [],
            creditAllotment: {
              totalCredits: 1000,
              sharedPoolCredits: 1000,
              featureCredits: {},
              rolloverPolicy: 'none',
            },
            features: [],
          },
        },
      );

      expect(dealCreate.status).toBe(201);
      expect(dealCreate.body.success).toBe(true);

      const firstApply = await requestJson<BillingMaterializationApplicationResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations/${batchId}/apply`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
        },
      );

      expect(firstApply.status).toBe(201);
      expect(firstApply.body.success).toBe(true);
      expect(firstApply.body.application).toMatchObject({
        batchId,
        dealResolution: {
          organizationId,
          dealId: dealCreate.body.deal._id,
          dealScope: 'project',
          matchType: 'project_exact',
        },
        accountingPeriod: {
          billingCycle: 'monthly',
        },
        projection: {
          usageReports: {
            status: 'applied',
          },
          creditLedger: {
            status: 'deferred',
          },
          billingLineItems: {
            status: 'deferred',
          },
        },
      });
      expect(firstApply.body.application.accountingPeriod.periodLabel).toMatch(/^\d{4}-\d{2}$/);

      const secondApply = await requestJson<BillingMaterializationApplicationResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations/${batchId}/apply`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
        },
      );

      expect(secondApply.status).toBe(200);
      expect(secondApply.body.success).toBe(true);
      expect(secondApply.body.application.applicationId).toBe(
        firstApply.body.application.applicationId,
      );

      const detail = await requestJson<BillingMaterializationApplicationResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/materializations/${batchId}/application`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(detail.status).toBe(200);
      expect(detail.body.success).toBe(true);
      expect(detail.body.application).toEqual(firstApply.body.application);

      const report = await requestJson<BillingUsageReportResponse>(
        harness,
        `/api/platform/admin/billing-policy/${admin.tenantId}/reports/usage?projectId=${encodeURIComponent(admin.projectId)}&granularity=day`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(report.status).toBe(200);
      expect(report.body.success).toBe(true);
      expect(report.body.projectId).toBe(admin.projectId);
      expect(report.body.totals.examinedSessionCount).toBeGreaterThanOrEqual(1);
      expect(report.body.totals.includedSessionCount).toBeGreaterThanOrEqual(1);
      expect(report.body.totals.totalUnits).toBeGreaterThan(0);

      const platformReport = await requestJson<BillingUsageReportResponse>(
        harness,
        '/api/platform/admin/billing-policy/reports/usage?granularity=day',
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(platformReport.status).toBe(200);
      expect(platformReport.body.success).toBe(true);
      expect(platformReport.body.tenantId).toBeNull();
      expect(platformReport.body.totals.totalUnits).toBeGreaterThan(0);
      expect(platformReport.body.tenantBreakdown?.[0]).toMatchObject({
        tenantId: admin.tenantId,
      });
    },
    TIMEOUT_MS,
  );
});
