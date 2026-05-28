import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingMaterializationBatch,
  BillingMaterializationCheckpoint,
  Session,
  Subscription,
} from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsageMaterializationPlannerService } from '../services/billing/billing-usage-materialization-planner-service.js';

const TENANT_ID = 'tenant-billing-materialization-planner';
const PROJECT_ID = 'project-billing-materialization-planner';

async function seedActiveSubscription(overrides: Record<string, unknown>): Promise<void> {
  await Subscription.create({
    tenantId: TENANT_ID,
    organizationId: null,
    planTier: 'TEAM',
    billingCycle: 'monthly',
    billingStartDate: new Date('2026-03-01T00:00:00.000Z'),
    billingEndDate: null,
    status: 'active',
    trialEndsAt: null,
    canceledAt: null,
    externalBillingId: null,
    externalCustomerId: null,
    orgLimits: null,
    entitlements: [],
    tenantQuotas: [],
    billingUnitPolicyOverrides: overrides,
  });
}

async function seedEndedSession(params: {
  sessionId: string;
  endedAt: string;
  startedAt?: string;
  projectId?: string;
}): Promise<void> {
  const endedAt = new Date(params.endedAt);
  const startedAt = new Date(
    params.startedAt ?? new Date(endedAt.getTime() - 10 * 60 * 1000).toISOString(),
  );

  await Session.create({
    _id: params.sessionId,
    tenantId: TENANT_ID,
    projectId: params.projectId ?? PROJECT_ID,
    currentAgent: 'BillingPlannerAgent',
    environment: 'production',
    channel: 'api',
    status: 'completed',
    disposition: 'completed',
    metadata: {},
    isTest: false,
    startedAt,
    lastActivityAt: endedAt,
    endedAt,
  });
}

describe('BillingUsageMaterializationPlannerService', () => {
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

  it('plans the earliest closed time window with ended sessions when no checkpoint exists', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-10-20',
      endedAt: '2026-03-30T10:20:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-11-10',
      endedAt: '2026-03-30T11:10:00.000Z',
    });

    const service = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T12:35:00.000Z'),
    });

    const plan = await service.planNextMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(plan).not.toBeNull();
    expect(plan?.due).toBe(true);
    expect(plan?.basis).toBe('time_window');
    expect(plan?.reason).toBe('due');
    expect(plan?.scope).toMatchObject({
      basis: 'time_window',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
    });
    expect(plan?.stats.candidateSessionCount).toBe(1);
    expect(plan?.checkpoint).toBeNull();
  });

  it('uses the scheduler checkpoint instead of manual materialization history when planning time-window batches', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-11-20',
      endedAt: '2026-03-30T11:20:00.000Z',
    });

    await BillingMaterializationBatch.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      subscriptionId: 'sub-manual-1',
      status: 'completed',
      triggerSource: 'manual',
      triggeredBy: 'admin-user-1',
      request: {
        projectId: PROJECT_ID,
        windowStart: new Date('2026-03-30T10:00:00.000Z'),
        windowEnd: new Date('2026-03-30T11:00:00.000Z'),
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
        windowStart: new Date('2026-03-30T10:00:00.000Z'),
        windowEnd: new Date('2026-03-30T11:00:00.000Z'),
        endedBefore: null,
        completedSessionsCount: null,
        periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
      },
      summary: null,
      warnings: [],
      resultCount: 0,
      eventId: null,
      eventDispatchAttempted: false,
      failureReason: null,
      startedAt: new Date('2026-03-30T11:02:00.000Z'),
      completedAt: new Date('2026-03-30T11:02:01.000Z'),
    });

    await BillingMaterializationCheckpoint.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      basis: 'time_window',
      cursor: {
        lastWindowEnd: new Date('2026-03-30T11:00:00.000Z'),
        lastEndedAt: null,
        lastSessionId: null,
      },
      lastBatchId: 'scheduled-batch-1',
      lastMaterializedAt: new Date('2026-03-30T11:05:00.000Z'),
    });

    const service = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T12:35:00.000Z'),
    });

    const plan = await service.planNextMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(plan?.due).toBe(true);
    expect(plan?.scope).toMatchObject({
      basis: 'time_window',
      windowStart: '2026-03-30T11:00:00.000Z',
      windowEnd: '2026-03-30T12:00:00.000Z',
    });
    expect(plan?.checkpoint?.lastWindowEnd).toBe('2026-03-30T11:00:00.000Z');
    expect(plan?.checkpoint?.lastBatchId).toBe('scheduled-batch-1');
  });

  it('plans the next completed-session batch after the checkpoint cursor using endedAt plus sessionId ordering', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        timeWindowMinutes: null,
        completedSessionsCount: 2,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-1',
      endedAt: '2026-03-30T10:00:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-2',
      endedAt: '2026-03-30T10:00:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-3',
      endedAt: '2026-03-30T10:05:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-4',
      endedAt: '2026-03-30T10:10:00.000Z',
    });

    await BillingMaterializationCheckpoint.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      basis: 'completed_sessions',
      cursor: {
        lastWindowEnd: null,
        lastEndedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSessionId: 'sess-2',
      },
      lastBatchId: 'scheduled-batch-2',
      lastMaterializedAt: new Date('2026-03-30T10:01:00.000Z'),
    });

    const service = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T12:35:00.000Z'),
    });

    const plan = await service.planNextMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(plan?.due).toBe(true);
    expect(plan?.reason).toBe('due');
    expect(plan?.scope).toMatchObject({
      basis: 'completed_sessions',
      completedSessionsCount: 2,
      endedBefore: '2026-03-30T10:10:00.000Z',
      cursorStartAfterEndedAt: '2026-03-30T10:00:00.000Z',
      cursorStartAfterSessionId: 'sess-2',
      cursorEndEndedAt: '2026-03-30T10:10:00.000Z',
      cursorEndSessionId: 'sess-4',
    });
    expect(plan?.stats).toMatchObject({
      candidateSessionCount: 2,
      requiredCompletedSessionsCount: 2,
      remainingCompletedSessionsCount: 0,
    });
  });

  it('reports insufficient completed sessions when the next checkpointed batch is not full yet', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        timeWindowMinutes: null,
        completedSessionsCount: 2,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-1',
      endedAt: '2026-03-30T10:00:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-2',
      endedAt: '2026-03-30T10:00:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-3',
      endedAt: '2026-03-30T10:05:00.000Z',
    });

    await BillingMaterializationCheckpoint.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      basis: 'completed_sessions',
      cursor: {
        lastWindowEnd: null,
        lastEndedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSessionId: 'sess-2',
      },
      lastBatchId: 'scheduled-batch-2',
      lastMaterializedAt: new Date('2026-03-30T10:01:00.000Z'),
    });

    const service = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T12:35:00.000Z'),
    });

    const plan = await service.planNextMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(plan?.due).toBe(false);
    expect(plan?.reason).toBe('insufficient_completed_sessions');
    expect(plan?.stats).toMatchObject({
      candidateSessionCount: 1,
      requiredCompletedSessionsCount: 2,
      remainingCompletedSessionsCount: 1,
    });
    expect(plan?.scope?.cursorEndSessionId).toBe('sess-3');
  });
});
