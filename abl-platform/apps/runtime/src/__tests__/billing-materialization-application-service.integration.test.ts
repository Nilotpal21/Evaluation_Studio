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
import {
  BillingMaterializationApplicationError,
  BillingMaterializationApplicationService,
} from '../services/billing/billing-materialization-application-service.js';

function buildSummary() {
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
        projectId: 'project-1',
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
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
    ],
  };
}

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
  status?: 'active' | 'paused' | 'expired' | 'canceled';
}): Promise<void> {
  await Deal.create({
    _id: params.dealId,
    organizationId: params.organizationId,
    name: `Deal ${params.dealId}`,
    status: params.status ?? 'active',
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

async function seedBatch(params: {
  batchId: string;
  tenantId: string;
  projectId: string | null;
  subscriptionId: string;
  basis: 'time_window' | 'completed_sessions';
  scope: {
    windowStart?: string | null;
    windowEnd?: string | null;
    endedBefore?: string | null;
    completedSessionsCount?: number | null;
    periodLabel: string | null;
  };
  status?: 'running' | 'completed' | 'failed';
}): Promise<void> {
  await BillingMaterializationBatch.create({
    _id: params.batchId,
    tenantId: params.tenantId,
    projectId: params.projectId,
    subscriptionId: params.subscriptionId,
    status: params.status ?? 'completed',
    triggerSource: 'manual',
    triggeredBy: 'materializer-1',
    request: {
      projectId: params.projectId,
      windowStart: params.scope.windowStart ? new Date(params.scope.windowStart) : null,
      windowEnd: params.scope.windowEnd ? new Date(params.scope.windowEnd) : null,
      endedBefore: params.scope.endedBefore ? new Date(params.scope.endedBefore) : null,
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
        basis: params.basis,
        timeWindowMinutes: params.basis === 'time_window' ? 60 : null,
        completedSessionsCount:
          params.basis === 'completed_sessions'
            ? (params.scope.completedSessionsCount ?? 25)
            : null,
      },
    },
    scope: {
      basis: params.basis,
      windowStart: params.scope.windowStart ? new Date(params.scope.windowStart) : null,
      windowEnd: params.scope.windowEnd ? new Date(params.scope.windowEnd) : null,
      endedBefore: params.scope.endedBefore ? new Date(params.scope.endedBefore) : null,
      completedSessionsCount:
        params.basis === 'completed_sessions' ? (params.scope.completedSessionsCount ?? 25) : null,
      periodLabel: params.scope.periodLabel,
    },
    summary: buildSummary(),
    warnings: [],
    resultCount: 2,
    eventId: 'evt-batch-1',
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
      triggerSource: 'manual',
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
      triggerSource: 'manual',
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

async function seedCustomBatchSessionResults(params: {
  tenantId: string;
  subscriptionId: string;
  projectId: string;
  batchId: string;
  sessions: Array<{
    sessionId: string;
    sequence: number;
    included: boolean;
    totalUnits: number;
    baseUnits: number;
    llmAddonUnits: number;
    toolAddonUnits: number;
    channel?: string;
  }>;
}): Promise<void> {
  await BillingMaterializationSessionResult.insertMany(
    params.sessions.map((session) => ({
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
      batchId: params.batchId,
      sequence: session.sequence,
      sessionId: session.sessionId,
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      channel: session.channel ?? 'api',
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
      included: session.included,
      exclusionReasons: session.included ? [] : ['excluded_channel'],
      baseUnits: session.baseUnits,
      llmAddonUnits: session.llmAddonUnits,
      toolAddonUnits: session.toolAddonUnits,
      totalUnits: session.totalUnits,
    })),
  );
}

describe('BillingMaterializationApplicationService', () => {
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

  it('records a project-scoped application, prefers the project deal, and stays idempotent', async () => {
    await seedTenant({ tenantId: 'tenant-1', organizationId: 'org-1' });
    await seedSubscription({
      subscriptionId: 'sub-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      billingCycle: 'monthly',
      billingStartDate: '2026-03-15T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-org-1',
      organizationId: 'org-1',
      scope: 'organization',
    });
    await seedDeal({
      dealId: 'deal-project-1',
      organizationId: 'org-1',
      scope: 'project',
      projectId: 'project-1',
    });
    await seedBatch({
      batchId: 'batch-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      basis: 'time_window',
      scope: {
        windowStart: '2026-04-02T10:00:00.000Z',
        windowEnd: '2026-04-02T11:00:00.000Z',
        periodLabel: '2026-04-02T10:00:00.000Z/2026-04-02T11:00:00.000Z',
      },
    });
    await seedBatchSessionResults({
      tenantId: 'tenant-1',
      subscriptionId: 'sub-1',
      projectId: 'project-1',
      batchId: 'batch-1',
    });

    const service = new BillingMaterializationApplicationService();

    const firstApply = await service.applyMaterialization({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      appliedBy: 'admin-1',
    });

    expect(firstApply).not.toBeNull();
    expect(firstApply?.created).toBe(true);
    expect(firstApply?.application).toMatchObject({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      status: 'projected',
      triggerSource: 'manual',
      triggeredBy: 'materializer-1',
      appliedBy: 'admin-1',
      materializationBasis: 'time_window',
      dealResolution: {
        organizationId: 'org-1',
        dealId: 'deal-project-1',
        dealScope: 'project',
        matchType: 'project_exact',
      },
      accountingPeriod: {
        billingCycle: 'monthly',
        billingStartDate: '2026-03-15T00:00:00.000Z',
        referenceAt: '2026-04-02T11:00:00.000Z',
        periodStart: '2026-03-15T00:00:00.000Z',
        periodEnd: '2026-04-14T23:59:59.999Z',
        periodLabel: '2026-03',
      },
      projection: {
        usageReports: {
          status: 'applied',
          reason: null,
          targetId: 'batch-1',
          targetIds: [],
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
    });
    expect(firstApply?.application.projection.usageReports.appliedAt).toBeTruthy();

    const secondApply = await service.applyMaterialization({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      appliedBy: 'admin-2',
    });

    expect(secondApply).not.toBeNull();
    expect(secondApply?.created).toBe(false);
    expect(secondApply?.application.applicationId).toBe(firstApply?.application.applicationId);
    expect(secondApply?.application.appliedBy).toBe('admin-1');

    const applicationCount = await BillingMaterializationApplication.countDocuments({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
    }).exec();
    expect(applicationCount).toBe(1);

    const publishedSessions = await BillingUsagePublishedSession.find({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
    })
      .sort({ sessionId: 1 })
      .lean()
      .exec();

    expect(publishedSessions).toHaveLength(2);
    expect(publishedSessions[0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      batchId: 'batch-1',
      applicationId: firstApply?.application.applicationId,
      sessionId: 'batch-1-sess-1',
      included: true,
      totalUnits: 6,
    });
    expect(publishedSessions[1]).toMatchObject({
      sessionId: 'batch-1-sess-2',
      included: false,
      exclusionReasons: ['excluded_channel'],
      totalUnits: 0,
    });
  });

  it('does not let an older completed batch overwrite newer published rows for overlapping sessions', async () => {
    await seedTenant({ tenantId: 'tenant-overlap', organizationId: 'org-overlap' });
    await seedSubscription({
      subscriptionId: 'sub-overlap',
      tenantId: 'tenant-overlap',
      organizationId: 'org-overlap',
      billingCycle: 'monthly',
      billingStartDate: '2026-03-15T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-overlap',
      organizationId: 'org-overlap',
      scope: 'organization',
    });
    await seedBatch({
      batchId: 'batch-older',
      tenantId: 'tenant-overlap',
      projectId: 'project-overlap',
      subscriptionId: 'sub-overlap',
      basis: 'time_window',
      scope: {
        windowStart: '2026-04-02T10:00:00.000Z',
        windowEnd: '2026-04-02T11:00:00.000Z',
        periodLabel: '2026-04-02T10:00:00.000Z/2026-04-02T11:00:00.000Z',
      },
    });
    await seedBatch({
      batchId: 'batch-newer',
      tenantId: 'tenant-overlap',
      projectId: 'project-overlap',
      subscriptionId: 'sub-overlap',
      basis: 'time_window',
      scope: {
        windowStart: '2026-04-02T11:00:00.000Z',
        windowEnd: '2026-04-02T12:00:00.000Z',
        periodLabel: '2026-04-02T11:00:00.000Z/2026-04-02T12:00:00.000Z',
      },
    });
    await BillingMaterializationBatch.updateOne(
      { tenantId: 'tenant-overlap', _id: 'batch-older' },
      {
        $set: {
          createdAt: new Date('2026-04-02T12:00:00.000Z'),
          updatedAt: new Date('2026-04-02T12:00:00.000Z'),
        },
      },
    ).exec();
    await BillingMaterializationBatch.updateOne(
      { tenantId: 'tenant-overlap', _id: 'batch-newer' },
      {
        $set: {
          createdAt: new Date('2026-04-02T12:10:00.000Z'),
          updatedAt: new Date('2026-04-02T12:10:00.000Z'),
        },
      },
    ).exec();
    await seedCustomBatchSessionResults({
      tenantId: 'tenant-overlap',
      subscriptionId: 'sub-overlap',
      projectId: 'project-overlap',
      batchId: 'batch-older',
      sessions: [
        {
          sessionId: 'shared-session',
          sequence: 0,
          included: true,
          baseUnits: 1,
          llmAddonUnits: 0,
          toolAddonUnits: 0,
          totalUnits: 1,
        },
        {
          sessionId: 'older-only-session',
          sequence: 1,
          included: true,
          baseUnits: 2,
          llmAddonUnits: 1,
          toolAddonUnits: 0,
          totalUnits: 3,
        },
      ],
    });
    await seedCustomBatchSessionResults({
      tenantId: 'tenant-overlap',
      subscriptionId: 'sub-overlap',
      projectId: 'project-overlap',
      batchId: 'batch-newer',
      sessions: [
        {
          sessionId: 'shared-session',
          sequence: 0,
          included: true,
          baseUnits: 3,
          llmAddonUnits: 1,
          toolAddonUnits: 0,
          totalUnits: 4,
        },
        {
          sessionId: 'newer-only-session',
          sequence: 1,
          included: true,
          baseUnits: 1,
          llmAddonUnits: 1,
          toolAddonUnits: 1,
          totalUnits: 3,
        },
      ],
    });

    const service = new BillingMaterializationApplicationService();

    await service.applyMaterialization({
      tenantId: 'tenant-overlap',
      batchId: 'batch-newer',
      appliedBy: 'admin-newer',
    });
    await service.applyMaterialization({
      tenantId: 'tenant-overlap',
      batchId: 'batch-older',
      appliedBy: 'admin-older',
    });

    const publishedSessions = await BillingUsagePublishedSession.find({
      tenantId: 'tenant-overlap',
    })
      .sort({ sessionId: 1 })
      .lean()
      .exec();

    expect(publishedSessions).toHaveLength(3);
    expect(publishedSessions.find((row) => row.sessionId === 'shared-session')).toMatchObject({
      batchId: 'batch-newer',
      applicationId: expect.any(String),
      totalUnits: 4,
    });
    expect(publishedSessions.find((row) => row.sessionId === 'older-only-session')).toMatchObject({
      batchId: 'batch-older',
      totalUnits: 3,
    });
    expect(publishedSessions.find((row) => row.sessionId === 'newer-only-session')).toMatchObject({
      batchId: 'batch-newer',
      totalUnits: 3,
    });
  });

  it('falls back to the tenant-scoped organization key when no organizationId is stored', async () => {
    await seedTenant({ tenantId: 'tenant-2', organizationId: null });
    await seedSubscription({
      subscriptionId: 'sub-2',
      tenantId: 'tenant-2',
      organizationId: null,
      billingCycle: 'monthly',
      billingStartDate: '2026-03-01T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-tenant-2',
      organizationId: 'tenant-2',
      scope: 'organization',
    });
    await seedBatch({
      batchId: 'batch-2',
      tenantId: 'tenant-2',
      projectId: null,
      subscriptionId: 'sub-2',
      basis: 'completed_sessions',
      scope: {
        endedBefore: '2026-03-30T11:00:00.000Z',
        completedSessionsCount: 25,
        periodLabel: 'latest-25-sessions-until-2026-03-30T11:00:00.000Z',
      },
    });

    const service = new BillingMaterializationApplicationService();
    const result = await service.applyMaterialization({
      tenantId: 'tenant-2',
      batchId: 'batch-2',
      appliedBy: 'admin-1',
    });

    expect(result?.application.dealResolution).toMatchObject({
      organizationId: 'tenant-2',
      dealId: 'deal-tenant-2',
      dealScope: 'organization',
      matchType: 'organization_scope',
    });
    expect(result?.application.projectId).toBeNull();
    expect(result?.application.materializationBasis).toBe('completed_sessions');
  });

  it('rejects ambiguous active deal matches without recording an application row', async () => {
    await seedTenant({ tenantId: 'tenant-3', organizationId: 'org-3' });
    await seedSubscription({
      subscriptionId: 'sub-3',
      tenantId: 'tenant-3',
      organizationId: 'org-3',
      billingCycle: 'monthly',
      billingStartDate: '2026-03-01T00:00:00.000Z',
    });
    await seedDeal({
      dealId: 'deal-project-a',
      organizationId: 'org-3',
      scope: 'project',
      projectId: 'project-3',
    });
    await seedDeal({
      dealId: 'deal-project-b',
      organizationId: 'org-3',
      scope: 'project',
      projectId: 'project-3',
    });
    await seedBatch({
      batchId: 'batch-3',
      tenantId: 'tenant-3',
      projectId: 'project-3',
      subscriptionId: 'sub-3',
      basis: 'time_window',
      scope: {
        windowStart: '2026-04-02T10:00:00.000Z',
        windowEnd: '2026-04-02T11:00:00.000Z',
        periodLabel: '2026-04-02T10:00:00.000Z/2026-04-02T11:00:00.000Z',
      },
    });

    const service = new BillingMaterializationApplicationService();

    await expect(
      service.applyMaterialization({
        tenantId: 'tenant-3',
        batchId: 'batch-3',
        appliedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_ACTIVE_DEAL',
      details: {
        organizationId: 'org-3',
        projectId: 'project-3',
        candidateDealIds: ['deal-project-a', 'deal-project-b'],
      },
    } satisfies Partial<BillingMaterializationApplicationError>);

    const application = await BillingMaterializationApplication.findOne({
      tenantId: 'tenant-3',
      batchId: 'batch-3',
    })
      .lean()
      .exec();
    expect(application).toBeNull();
  });
});
