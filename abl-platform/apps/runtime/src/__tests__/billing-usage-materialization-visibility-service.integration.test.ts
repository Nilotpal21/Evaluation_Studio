import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingMaterializationApplication,
  BillingMaterializationBatch,
  BillingUsagePublishedSession,
  Tenant,
} from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsageMaterializationVisibilityService } from '../services/billing/billing-usage-materialization-visibility-service.js';

const TENANT_ID = 'tenant-billing-visibility';
const SUBSCRIPTION_ID = 'sub-billing-visibility';
const PROJECT_A = 'project-alpha';
const PROJECT_B = 'project-beta';

async function seedTenant(params: { tenantId: string; name: string }) {
  await Tenant.create({
    _id: params.tenantId,
    name: params.name,
    slug: `${params.tenantId}-slug`,
    organizationId: null,
    ownerId: 'owner-1',
    status: 'active',
  });
}

function buildPolicySnapshot() {
  return {
    intervalMinutes: 15,
    excludedChannels: ['web_debug'],
    excludedSessionTypes: [],
    excludeProactiveWithoutUserInteraction: true,
    interactionThreshold: {
      minUserMessages: 1,
      minInteractiveTurns: 1,
      minEngagedSeconds: 0,
    },
    addons: {
      llm: { mode: 'per_call' as const, bucketSize: null },
      tool: { mode: 'per_call' as const, bucketSize: null },
    },
    materialization: {
      basis: 'time_window' as const,
      timeWindowMinutes: 60,
      completedSessionsCount: null,
    },
  };
}

function buildScope(params: { windowStart: string; windowEnd: string }) {
  return {
    basis: 'time_window' as const,
    windowStart: new Date(params.windowStart),
    windowEnd: new Date(params.windowEnd),
    endedBefore: null,
    completedSessionsCount: null,
    periodLabel: `${params.windowStart}/${params.windowEnd}`,
  };
}

function buildSummary(projectId: string, totalUnits: number) {
  return {
    examinedSessionCount: 2,
    includedSessionCount: 1,
    excludedSessionCount: 1,
    baseUnits: totalUnits,
    llmAddonUnits: 0,
    toolAddonUnits: 0,
    totalUnits,
    exclusionCounts: { excluded_channel: 1 },
    metricsSourceCounts: { message_fallback: 2 },
    projectBreakdown: [
      {
        projectId,
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: totalUnits,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits,
      },
    ],
    channelBreakdown: [
      {
        channel: 'api',
        examinedSessionCount: 1,
        includedSessionCount: 1,
        excludedSessionCount: 0,
        baseUnits: totalUnits,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits,
      },
      {
        channel: 'web_debug',
        examinedSessionCount: 1,
        includedSessionCount: 0,
        excludedSessionCount: 1,
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
      },
    ],
  };
}

async function seedBatch(params: {
  batchId: string;
  tenantId?: string;
  subscriptionId?: string;
  projectId: string;
  status: 'running' | 'completed' | 'failed';
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  completedAt?: string | null;
  failureReason?: string | null;
  totalUnits?: number;
  resultCount?: number;
}) {
  const scope = buildScope({
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
  });
  const summary =
    params.status === 'completed' ? buildSummary(params.projectId, params.totalUnits ?? 2) : null;

  await BillingMaterializationBatch.create({
    _id: params.batchId,
    tenantId: params.tenantId ?? TENANT_ID,
    projectId: params.projectId,
    subscriptionId: params.subscriptionId ?? SUBSCRIPTION_ID,
    status: params.status,
    triggerSource: 'scheduled',
    triggeredBy: 'billing-materializer-scheduler',
    request: {
      projectId: params.projectId,
      windowStart: new Date(params.windowStart),
      windowEnd: new Date(params.windowEnd),
      endedBefore: null,
    },
    planTier: 'TEAM',
    policySnapshot: buildPolicySnapshot(),
    scope,
    summary,
    warnings: [],
    resultCount: params.resultCount ?? (summary ? 2 : 0),
    eventId: `evt-${params.batchId}`,
    eventDispatchAttempted: true,
    failureReason: params.failureReason ?? null,
    startedAt: new Date(params.startedAt),
    completedAt: params.completedAt ? new Date(params.completedAt) : null,
  });
}

async function seedApplication(params: {
  applicationId: string;
  batchId: string;
  tenantId?: string;
  subscriptionId?: string;
  projectId: string;
  status: 'recorded' | 'projected';
  usageReportStatus: 'deferred' | 'applied';
  usageReportReason: string | null;
  usageReportAppliedAt: string | null;
  appliedAt: string;
}) {
  const batch = await BillingMaterializationBatch.findOne({
    tenantId: params.tenantId ?? TENANT_ID,
    _id: params.batchId,
  })
    .lean()
    .exec();

  if (!batch || !batch.summary) {
    throw new Error(`Missing completed batch ${params.batchId} for visibility test setup`);
  }

  await BillingMaterializationApplication.create({
    _id: params.applicationId,
    tenantId: params.tenantId ?? TENANT_ID,
    batchId: params.batchId,
    projectId: params.projectId,
    subscriptionId: params.subscriptionId ?? SUBSCRIPTION_ID,
    status: params.status,
    triggerSource: 'scheduled',
    triggeredBy: 'billing-usage-publication-scheduler',
    appliedBy: 'billing-usage-publication-scheduler',
    materializationBasis: 'time_window',
    materializationScope: batch.scope,
    summarySnapshot: batch.summary,
    warnings: [],
    dealResolution: {
      organizationId: 'org-billing-visibility',
      dealId: `deal-${params.projectId}`,
      dealScope: 'project',
      matchType: 'project_exact',
    },
    accountingPeriod: {
      billingCycle: 'monthly',
      billingStartDate: new Date('2026-04-01T00:00:00.000Z'),
      referenceAt: new Date(params.appliedAt),
      periodStart: new Date('2026-04-01T00:00:00.000Z'),
      periodEnd: new Date('2026-04-30T23:59:59.999Z'),
      periodLabel: '2026-04',
    },
    projection: {
      usageReports: {
        status: params.usageReportStatus,
        reason: params.usageReportReason,
        targetId: params.usageReportStatus === 'applied' ? params.batchId : null,
        targetIds: params.usageReportStatus === 'applied' ? [params.batchId] : [],
        appliedAt: params.usageReportAppliedAt ? new Date(params.usageReportAppliedAt) : null,
      },
      creditLedger: {
        status: 'deferred',
        reason: 'billing_unit_credit_mapping_not_configured',
        targetId: null,
        targetIds: [],
        appliedAt: null,
      },
      billingLineItems: {
        status: 'deferred',
        reason: 'billing_unit_price_mapping_not_configured',
        targetId: null,
        targetIds: [],
        appliedAt: null,
      },
    },
    appliedAt: new Date(params.appliedAt),
  });
}

async function seedPublishedBatchRows(params: {
  tenantId?: string;
  subscriptionId?: string;
  projectId: string;
  batchId: string;
  applicationId: string;
  publishedAt: string;
  sessionIds?: string[];
}) {
  const batch = await BillingMaterializationBatch.findOne({
    tenantId: params.tenantId ?? TENANT_ID,
    _id: params.batchId,
  })
    .lean()
    .exec();

  if (!batch) {
    throw new Error(`Missing batch ${params.batchId} for published-row test setup`);
  }

  const sessionIds = params.sessionIds ?? [`${params.batchId}-session-1`];

  await BillingUsagePublishedSession.insertMany(
    sessionIds.map((sessionId) => ({
      tenantId: params.tenantId ?? TENANT_ID,
      projectId: params.projectId,
      subscriptionId: params.subscriptionId ?? SUBSCRIPTION_ID,
      sessionId,
      batchId: params.batchId,
      applicationId: params.applicationId,
      batchCreatedAt: batch.createdAt,
      triggerSource: batch.triggerSource,
      materializationBasis: batch.scope.basis,
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-04-02T10:00:00.000Z'),
      endedAt: new Date('2026-04-02T10:20:00.000Z'),
      publishedAt: new Date(params.publishedAt),
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 5,
      engagedSeconds: 900,
      llmCallCount: 3,
      toolCallCount: 1,
      metricsSource: 'message_fallback',
      included: true,
      exclusionReasons: [],
      baseUnits: 2,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
      totalUnits: 2,
    })),
  );
}

describe('BillingUsageMaterializationVisibilityService', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST = 'true';
    await setupTestMongo();
  }, 60_000);

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    await teardownTestMongo();
  }, 60_000);

  it('summarizes completed, pending, published, running, and failed billing batches', async () => {
    await seedTenant({ tenantId: TENANT_ID, name: 'Tenant Billing Visibility' });

    await seedBatch({
      batchId: 'batch-running',
      projectId: PROJECT_A,
      status: 'running',
      windowStart: '2026-04-02T09:00:00.000Z',
      windowEnd: '2026-04-02T10:00:00.000Z',
      startedAt: '2026-04-02T10:05:00.000Z',
    });
    await seedBatch({
      batchId: 'batch-failed',
      projectId: PROJECT_A,
      status: 'failed',
      windowStart: '2026-04-02T10:00:00.000Z',
      windowEnd: '2026-04-02T11:00:00.000Z',
      startedAt: '2026-04-02T11:05:00.000Z',
      completedAt: '2026-04-02T11:06:00.000Z',
      failureReason: 'clickhouse_timeout',
    });
    await seedBatch({
      batchId: 'batch-missing-application',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-02T11:00:00.000Z',
      windowEnd: '2026-04-02T12:00:00.000Z',
      startedAt: '2026-04-02T12:00:00.000Z',
      completedAt: '2026-04-02T12:05:00.000Z',
      totalUnits: 2,
    });
    await seedBatch({
      batchId: 'batch-pending-publication',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-02T12:00:00.000Z',
      windowEnd: '2026-04-02T13:00:00.000Z',
      startedAt: '2026-04-02T13:00:00.000Z',
      completedAt: '2026-04-02T13:05:00.000Z',
      totalUnits: 3,
    });
    await seedApplication({
      applicationId: 'app-pending-publication',
      batchId: 'batch-pending-publication',
      projectId: PROJECT_A,
      status: 'recorded',
      usageReportStatus: 'deferred',
      usageReportReason: 'billing_usage_report_publication_pending',
      usageReportAppliedAt: null,
      appliedAt: '2026-04-02T13:06:00.000Z',
    });
    await seedBatch({
      batchId: 'batch-published',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-02T13:00:00.000Z',
      windowEnd: '2026-04-02T14:00:00.000Z',
      startedAt: '2026-04-02T14:00:00.000Z',
      completedAt: '2026-04-02T14:05:00.000Z',
      totalUnits: 6,
    });
    await seedApplication({
      applicationId: 'app-published',
      batchId: 'batch-published',
      projectId: PROJECT_A,
      status: 'projected',
      usageReportStatus: 'applied',
      usageReportReason: null,
      usageReportAppliedAt: '2026-04-02T14:08:00.000Z',
      appliedAt: '2026-04-02T14:08:00.000Z',
    });
    await seedPublishedBatchRows({
      batchId: 'batch-published',
      projectId: PROJECT_A,
      applicationId: 'app-published',
      publishedAt: '2026-04-02T14:08:00.000Z',
    });

    const service = new BillingUsageMaterializationVisibilityService();
    const visibility = await service.getTenantVisibility({
      tenantId: TENANT_ID,
      limit: 10,
    });

    expect(visibility.tenantId).toBe(TENANT_ID);
    expect(visibility.projectId).toBeNull();
    expect(visibility.summary).toEqual({
      completedBatchCount: 3,
      runningBatchCount: 1,
      failedBatchCount: 1,
      pendingPublicationCount: 2,
      publishedBatchCount: 1,
      supersededBatchCount: 0,
      lastMaterializedAt: '2026-04-02T14:05:00.000Z',
      lastPublishedAt: '2026-04-02T14:08:00.000Z',
    });

    const batchesById = new Map(visibility.batches.map((batch) => [batch.batchId, batch]));
    expect(visibility.batches).toHaveLength(5);
    expect(batchesById.get('batch-running')).toMatchObject({
      materializationStatus: 'running',
      applicationStatus: 'missing',
      publicationStatus: 'not_ready',
      publicationReason: 'billing_materialization_in_progress',
      publishedAt: null,
      applicationId: null,
    });
    expect(batchesById.get('batch-failed')).toMatchObject({
      materializationStatus: 'failed',
      applicationStatus: 'missing',
      publicationStatus: 'not_ready',
      publicationReason: 'clickhouse_timeout',
      publishedAt: null,
      applicationId: null,
    });
    expect(batchesById.get('batch-missing-application')).toMatchObject({
      materializationStatus: 'completed',
      applicationStatus: 'missing',
      publicationStatus: 'pending',
      publicationReason: 'billing_usage_report_application_missing',
      totalUnits: 2,
      publishedAt: null,
      applicationId: null,
    });
    expect(batchesById.get('batch-pending-publication')).toMatchObject({
      materializationStatus: 'completed',
      applicationStatus: 'recorded',
      publicationStatus: 'pending',
      publicationReason: 'billing_usage_report_publication_pending',
      totalUnits: 3,
      publishedAt: null,
      applicationId: 'app-pending-publication',
    });
    expect(batchesById.get('batch-published')).toMatchObject({
      materializationStatus: 'completed',
      applicationStatus: 'projected',
      publicationStatus: 'published',
      publicationReason: null,
      totalUnits: 6,
      publishedAt: '2026-04-02T14:08:00.000Z',
      applicationId: 'app-published',
    });
  });

  it('filters visibility by project scope', async () => {
    await seedTenant({ tenantId: TENANT_ID, name: 'Tenant Billing Visibility' });

    await seedBatch({
      batchId: 'batch-project-a',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-03T10:00:00.000Z',
      windowEnd: '2026-04-03T11:00:00.000Z',
      startedAt: '2026-04-03T11:00:00.000Z',
      completedAt: '2026-04-03T11:05:00.000Z',
      totalUnits: 4,
    });
    await seedApplication({
      applicationId: 'app-project-a',
      batchId: 'batch-project-a',
      projectId: PROJECT_A,
      status: 'projected',
      usageReportStatus: 'applied',
      usageReportReason: null,
      usageReportAppliedAt: '2026-04-03T11:08:00.000Z',
      appliedAt: '2026-04-03T11:08:00.000Z',
    });
    await seedBatch({
      batchId: 'batch-project-b',
      projectId: PROJECT_B,
      status: 'completed',
      windowStart: '2026-04-03T12:00:00.000Z',
      windowEnd: '2026-04-03T13:00:00.000Z',
      startedAt: '2026-04-03T13:00:00.000Z',
      completedAt: '2026-04-03T13:05:00.000Z',
      totalUnits: 5,
    });

    const service = new BillingUsageMaterializationVisibilityService();
    const visibility = await service.getTenantVisibility({
      tenantId: TENANT_ID,
      projectId: PROJECT_B,
      limit: 10,
    });

    expect(visibility).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_B,
      summary: {
        completedBatchCount: 1,
        runningBatchCount: 0,
        failedBatchCount: 0,
        pendingPublicationCount: 1,
        publishedBatchCount: 0,
        supersededBatchCount: 0,
        lastMaterializedAt: '2026-04-03T13:05:00.000Z',
        lastPublishedAt: null,
      },
    });
    expect(visibility.batches).toHaveLength(1);
    expect(visibility.batches[0]).toMatchObject({
      batchId: 'batch-project-b',
      projectId: PROJECT_B,
      publicationStatus: 'pending',
      publicationReason: 'billing_usage_report_application_missing',
    });
  });

  it('marks applied batches as superseded once newer published rows own the same reporting surface', async () => {
    await seedTenant({ tenantId: TENANT_ID, name: 'Tenant Billing Visibility' });

    await seedBatch({
      batchId: 'batch-superseded',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-03T09:00:00.000Z',
      windowEnd: '2026-04-03T10:00:00.000Z',
      startedAt: '2026-04-03T10:00:00.000Z',
      completedAt: '2026-04-03T10:05:00.000Z',
      totalUnits: 2,
    });
    await seedApplication({
      applicationId: 'app-superseded',
      batchId: 'batch-superseded',
      projectId: PROJECT_A,
      status: 'projected',
      usageReportStatus: 'applied',
      usageReportReason: null,
      usageReportAppliedAt: '2026-04-03T10:06:00.000Z',
      appliedAt: '2026-04-03T10:06:00.000Z',
    });
    await seedBatch({
      batchId: 'batch-current',
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-03T10:00:00.000Z',
      windowEnd: '2026-04-03T11:00:00.000Z',
      startedAt: '2026-04-03T11:00:00.000Z',
      completedAt: '2026-04-03T11:05:00.000Z',
      totalUnits: 4,
    });
    await seedApplication({
      applicationId: 'app-current',
      batchId: 'batch-current',
      projectId: PROJECT_A,
      status: 'projected',
      usageReportStatus: 'applied',
      usageReportReason: null,
      usageReportAppliedAt: '2026-04-03T11:06:00.000Z',
      appliedAt: '2026-04-03T11:06:00.000Z',
    });
    await seedPublishedBatchRows({
      batchId: 'batch-current',
      projectId: PROJECT_A,
      applicationId: 'app-current',
      publishedAt: '2026-04-03T11:06:00.000Z',
      sessionIds: ['shared-session'],
    });

    const service = new BillingUsageMaterializationVisibilityService();
    const visibility = await service.getTenantVisibility({
      tenantId: TENANT_ID,
      limit: 10,
    });

    expect(visibility.summary).toEqual({
      completedBatchCount: 2,
      runningBatchCount: 0,
      failedBatchCount: 0,
      pendingPublicationCount: 0,
      publishedBatchCount: 1,
      supersededBatchCount: 1,
      lastMaterializedAt: '2026-04-03T11:05:00.000Z',
      lastPublishedAt: '2026-04-03T11:06:00.000Z',
    });

    const batchesById = new Map(visibility.batches.map((batch) => [batch.batchId, batch]));
    expect(batchesById.get('batch-superseded')).toMatchObject({
      publicationStatus: 'superseded',
      publicationReason: 'billing_usage_report_superseded_by_newer_batch',
      publishedAt: '2026-04-03T10:06:00.000Z',
      applicationId: 'app-superseded',
    });
    expect(batchesById.get('batch-current')).toMatchObject({
      publicationStatus: 'published',
      publicationReason: null,
      publishedAt: '2026-04-03T11:06:00.000Z',
      applicationId: 'app-current',
    });
  });

  it('summarizes platform publication visibility across tenants', async () => {
    await seedTenant({ tenantId: TENANT_ID, name: 'Tenant Billing Visibility' });
    await seedTenant({ tenantId: 'tenant-platform-other', name: 'Tenant Platform Other' });

    await seedBatch({
      batchId: 'platform-batch-published',
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-04T09:00:00.000Z',
      windowEnd: '2026-04-04T10:00:00.000Z',
      startedAt: '2026-04-04T10:00:00.000Z',
      completedAt: '2026-04-04T10:05:00.000Z',
      totalUnits: 6,
    });
    await seedApplication({
      applicationId: 'platform-app-published',
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      batchId: 'platform-batch-published',
      projectId: PROJECT_A,
      status: 'projected',
      usageReportStatus: 'applied',
      usageReportReason: null,
      usageReportAppliedAt: '2026-04-04T10:08:00.000Z',
      appliedAt: '2026-04-04T10:08:00.000Z',
    });
    await seedPublishedBatchRows({
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      batchId: 'platform-batch-published',
      projectId: PROJECT_A,
      applicationId: 'platform-app-published',
      publishedAt: '2026-04-04T10:08:00.000Z',
    });
    await seedBatch({
      batchId: 'platform-batch-pending',
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      projectId: PROJECT_A,
      status: 'completed',
      windowStart: '2026-04-04T10:00:00.000Z',
      windowEnd: '2026-04-04T11:00:00.000Z',
      startedAt: '2026-04-04T11:00:00.000Z',
      completedAt: '2026-04-04T11:05:00.000Z',
      totalUnits: 2,
    });
    await seedBatch({
      batchId: 'platform-batch-other-running',
      tenantId: 'tenant-platform-other',
      subscriptionId: 'sub-platform-other',
      projectId: PROJECT_B,
      status: 'running',
      windowStart: '2026-04-04T11:00:00.000Z',
      windowEnd: '2026-04-04T12:00:00.000Z',
      startedAt: '2026-04-04T12:00:00.000Z',
    });
    await seedBatch({
      batchId: 'platform-batch-other-failed',
      tenantId: 'tenant-platform-other',
      subscriptionId: 'sub-platform-other',
      projectId: PROJECT_B,
      status: 'failed',
      windowStart: '2026-04-04T12:00:00.000Z',
      windowEnd: '2026-04-04T13:00:00.000Z',
      startedAt: '2026-04-04T13:00:00.000Z',
      completedAt: '2026-04-04T13:03:00.000Z',
      failureReason: 'scheduler_timeout',
    });

    const service = new BillingUsageMaterializationVisibilityService();
    const visibility = await service.getPlatformVisibility({ limit: 10 });

    expect(visibility.summary).toEqual({
      completedBatchCount: 2,
      runningBatchCount: 1,
      failedBatchCount: 1,
      pendingPublicationCount: 1,
      publishedBatchCount: 1,
      supersededBatchCount: 0,
      lastMaterializedAt: '2026-04-04T11:05:00.000Z',
      lastPublishedAt: '2026-04-04T10:08:00.000Z',
    });
    expect(visibility.tenants).toEqual([
      {
        tenantId: TENANT_ID,
        tenantName: 'Tenant Billing Visibility',
        completedBatchCount: 2,
        runningBatchCount: 0,
        failedBatchCount: 0,
        pendingPublicationCount: 1,
        publishedBatchCount: 1,
        supersededBatchCount: 0,
        lastMaterializedAt: '2026-04-04T11:05:00.000Z',
        lastPublishedAt: '2026-04-04T10:08:00.000Z',
      },
      {
        tenantId: 'tenant-platform-other',
        tenantName: 'Tenant Platform Other',
        completedBatchCount: 0,
        runningBatchCount: 1,
        failedBatchCount: 1,
        pendingPublicationCount: 0,
        publishedBatchCount: 0,
        supersededBatchCount: 0,
        lastMaterializedAt: null,
        lastPublishedAt: null,
      },
    ]);
  });
});
