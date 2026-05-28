import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingMaterializationApplication,
  BillingMaterializationBatch,
  BillingMaterializationSessionResult,
  BillingUsagePublishedSession,
  Deal,
  Subscription,
  Tenant,
} from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsagePublicationSchedulerService } from '../services/billing/billing-usage-publication-scheduler-service.js';

async function seedTenant(params: {
  tenantId: string;
  organizationId: string | null;
}): Promise<void> {
  await Tenant.create({
    _id: params.tenantId,
    name: `Tenant ${params.tenantId}`,
    slug: `${params.tenantId}-slug`,
    organizationId: params.organizationId,
    ownerId: 'owner-1',
    status: 'active',
  });
}

async function seedSubscription(params: {
  subscriptionId: string;
  tenantId: string;
  organizationId: string | null;
  billingCycle: string;
  billingStartDate: string;
}): Promise<void> {
  await Subscription.create({
    _id: params.subscriptionId,
    tenantId: params.tenantId,
    organizationId: params.organizationId,
    planTier: 'TEAM',
    billingCycle: params.billingCycle,
    billingStartDate: new Date(params.billingStartDate),
    billingEndDate: null,
    status: 'active',
    trialEndsAt: null,
    canceledAt: null,
    externalBillingId: null,
    externalCustomerId: null,
    orgLimits: null,
    entitlements: [],
    tenantQuotas: [],
    billingUnitPolicyOverrides: null,
  });
}

async function seedDeal(params: {
  dealId: string;
  organizationId: string;
  scope: 'organization' | 'project';
  projectId?: string;
}): Promise<void> {
  await Deal.create({
    _id: params.dealId,
    organizationId: params.organizationId,
    name: `Deal ${params.dealId}`,
    status: 'active',
    scope: params.scope,
    projectId: params.projectId,
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
  });
}

function buildSummary(projectId: string) {
  return {
    examinedSessionCount: 2,
    includedSessionCount: 1,
    excludedSessionCount: 1,
    baseUnits: 2,
    llmAddonUnits: 3,
    toolAddonUnits: 1,
    totalUnits: 6,
    exclusionCounts: { excluded_channel: 1 },
    metricsSourceCounts: { clickhouse: 1, message_fallback: 1 },
    projectBreakdown: [
      {
        projectId,
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
    ],
    channelBreakdown: [
      {
        channel: 'api',
        examinedSessionCount: 1,
        includedSessionCount: 1,
        excludedSessionCount: 0,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
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
  tenantId: string;
  subscriptionId: string;
  projectId: string;
  triggerSource?: 'manual' | 'scheduled';
}): Promise<void> {
  await BillingMaterializationBatch.create({
    _id: params.batchId,
    tenantId: params.tenantId,
    projectId: params.projectId,
    subscriptionId: params.subscriptionId,
    status: 'completed',
    triggerSource: params.triggerSource ?? 'scheduled',
    triggeredBy: 'billing-materializer-scheduler',
    request: {
      projectId: params.projectId,
      windowStart: new Date('2026-04-02T10:00:00.000Z'),
      windowEnd: new Date('2026-04-02T11:00:00.000Z'),
      endedBefore: null,
    },
    planTier: 'TEAM',
    policySnapshot: {
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
        llm: { mode: 'per_call', bucketSize: null },
        tool: { mode: 'per_call', bucketSize: null },
      },
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    },
    scope: {
      basis: 'time_window',
      windowStart: new Date('2026-04-02T10:00:00.000Z'),
      windowEnd: new Date('2026-04-02T11:00:00.000Z'),
      endedBefore: null,
      completedSessionsCount: null,
      periodLabel: '2026-04-02T10:00:00.000Z/2026-04-02T11:00:00.000Z',
    },
    summary: buildSummary(params.projectId),
    warnings: [],
    resultCount: 2,
    eventId: `evt-${params.batchId}`,
    eventDispatchAttempted: true,
    failureReason: null,
    startedAt: new Date('2026-04-02T12:00:00.000Z'),
    completedAt: new Date('2026-04-02T12:00:05.000Z'),
  });
}

async function seedBatchSessionResults(params: {
  tenantId: string;
  subscriptionId: string;
  projectId: string;
  batchId: string;
}): Promise<void> {
  await BillingMaterializationSessionResult.insertMany([
    {
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
      batchId: params.batchId,
      sequence: 0,
      sessionId: `${params.batchId}-sess-1`,
      triggerSource: 'scheduled',
      materializationBasis: 'time_window',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-04-02T10:00:00.000Z'),
      endedAt: new Date('2026-04-02T10:20:00.000Z'),
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
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
    },
    {
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
      batchId: params.batchId,
      sequence: 1,
      sessionId: `${params.batchId}-sess-2`,
      triggerSource: 'scheduled',
      materializationBasis: 'time_window',
      channel: 'web_debug',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-04-02T10:30:00.000Z'),
      endedAt: new Date('2026-04-02T10:35:00.000Z'),
      durationSeconds: 300,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolMessageCount: 0,
      interactiveTurnCount: 2,
      engagedSeconds: 180,
      llmCallCount: 1,
      toolCallCount: 0,
      metricsSource: 'message_fallback',
      included: false,
      exclusionReasons: ['excluded_channel'],
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
      totalUnits: 0,
    },
  ]);
}

describe('BillingUsagePublicationSchedulerService', () => {
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

  it('applies completed unpublished batches and projects them into published usage rows', async () => {
    await seedTenant({ tenantId: 'tenant-publication-1', organizationId: 'org-publication-1' });
    await seedSubscription({
      subscriptionId: 'sub-publication-1',
      tenantId: 'tenant-publication-1',
      organizationId: 'org-publication-1',
      billingCycle: 'monthly',
      billingStartDate: '2026-03-01T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-publication-1',
      organizationId: 'org-publication-1',
      scope: 'organization',
    });
    await seedBatch({
      batchId: 'batch-publication-1',
      tenantId: 'tenant-publication-1',
      subscriptionId: 'sub-publication-1',
      projectId: 'project-publication-1',
    });
    await seedBatchSessionResults({
      tenantId: 'tenant-publication-1',
      subscriptionId: 'sub-publication-1',
      projectId: 'project-publication-1',
      batchId: 'batch-publication-1',
    });

    const service = new BillingUsagePublicationSchedulerService({
      tenantBatchSize: 10,
      batchLimit: 10,
    });

    const result = await service.runDuePublications();

    expect(result).toMatchObject({
      scannedTenantCount: 1,
      skippedTenantCount: 0,
      pendingTenantCount: 1,
      attemptedBatchCount: 1,
      appliedBatchCount: 1,
      failedBatchCount: 0,
      batches: [
        {
          tenantId: 'tenant-publication-1',
          projectId: 'project-publication-1',
          batchId: 'batch-publication-1',
          created: true,
        },
      ],
    });

    const application = await BillingMaterializationApplication.findOne({
      tenantId: 'tenant-publication-1',
      batchId: 'batch-publication-1',
    })
      .lean()
      .exec();
    expect(application).toMatchObject({
      status: 'projected',
      projection: {
        usageReports: {
          status: 'applied',
          targetId: 'batch-publication-1',
        },
      },
    });

    const publishedRows = await BillingUsagePublishedSession.find({
      tenantId: 'tenant-publication-1',
    })
      .sort({ sessionId: 1 })
      .lean()
      .exec();
    expect(publishedRows).toHaveLength(2);
    expect(publishedRows.map((row) => row.sessionId)).toEqual([
      'batch-publication-1-sess-1',
      'batch-publication-1-sess-2',
    ]);
  });

  it('respects the low-frequency batch limit and leaves remaining batches for the next pass', async () => {
    await seedTenant({ tenantId: 'tenant-publication-2', organizationId: 'org-publication-2' });
    await seedSubscription({
      subscriptionId: 'sub-publication-2',
      tenantId: 'tenant-publication-2',
      organizationId: 'org-publication-2',
      billingCycle: 'monthly',
      billingStartDate: '2026-03-01T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-publication-2',
      organizationId: 'org-publication-2',
      scope: 'organization',
    });
    await seedBatch({
      batchId: 'batch-publication-2a',
      tenantId: 'tenant-publication-2',
      subscriptionId: 'sub-publication-2',
      projectId: 'project-publication-2',
    });
    await seedBatch({
      batchId: 'batch-publication-2b',
      tenantId: 'tenant-publication-2',
      subscriptionId: 'sub-publication-2',
      projectId: 'project-publication-2',
    });
    await seedBatchSessionResults({
      tenantId: 'tenant-publication-2',
      subscriptionId: 'sub-publication-2',
      projectId: 'project-publication-2',
      batchId: 'batch-publication-2a',
    });
    await seedBatchSessionResults({
      tenantId: 'tenant-publication-2',
      subscriptionId: 'sub-publication-2',
      projectId: 'project-publication-2',
      batchId: 'batch-publication-2b',
    });

    const service = new BillingUsagePublicationSchedulerService({
      tenantBatchSize: 10,
      batchLimit: 1,
    });

    const result = await service.runDuePublications();

    expect(result).toMatchObject({
      scannedTenantCount: 1,
      pendingTenantCount: 1,
      attemptedBatchCount: 1,
      appliedBatchCount: 1,
      failedBatchCount: 0,
    });

    expect(
      await BillingMaterializationApplication.countDocuments({
        tenantId: 'tenant-publication-2',
      }).exec(),
    ).toBe(1);
    expect(
      await BillingUsagePublishedSession.countDocuments({
        tenantId: 'tenant-publication-2',
      }).exec(),
    ).toBe(2);
  });
});
