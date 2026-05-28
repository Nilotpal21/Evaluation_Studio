import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { BillingMaterializationApplication } from '../models/billing-materialization-application.model.js';
import { BillingMaterializationBatch } from '../models/billing-materialization-batch.model.js';
import { BillingMaterializationCheckpoint } from '../models/billing-materialization-checkpoint.model.js';
import { BillingMaterializationSessionResult } from '../models/billing-materialization-session-result.model.js';
import { BillingUsagePublishedSession } from '../models/billing-usage-published-session.model.js';
import { BillingReplayRun } from '../models/billing-replay-run.model.js';
import { BillingReplaySessionResult } from '../models/billing-replay-session-result.model.js';
import { Subscription } from '../models/subscription.model.js';
import { LLMUsageMetric } from '../models/llm-usage-metric.model.js';
import { LLMCredential } from '../models/llm-credential.model.js';
import { TenantLLMPolicy } from '../models/tenant-llm-policy.model.js';
import { TenantModel } from '../models/tenant-model.model.js';
import { TenantServiceInstance } from '../models/tenant-service-instance.model.js';
beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('ab'.repeat(32));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Subscription Model ─────────────────────────────────────────────────────

describe('Subscription', () => {
  const validSub = () => ({
    tenantId: 'tenant-1',
    planTier: 'pro',
    billingCycle: 'monthly',
    billingStartDate: new Date(),
    status: 'active',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validSub();
    delete (data as any).tenantId;
    const err = new Subscription(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires planTier', () => {
    const data = validSub();
    delete (data as any).planTier;
    const err = new Subscription(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.planTier).toBeDefined();
  });

  it('requires billingCycle', () => {
    const data = validSub();
    delete (data as any).billingCycle;
    const err = new Subscription(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.billingCycle).toBeDefined();
  });

  it('requires billingStartDate', () => {
    const data = validSub();
    delete (data as any).billingStartDate;
    const err = new Subscription(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.billingStartDate).toBeDefined();
  });

  it('requires status', () => {
    const data = validSub();
    delete (data as any).status;
    const err = new Subscription(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid subscription', () => {
    const sub = new Subscription(validSub());
    expect(sub._id).toBeDefined();
    expect(sub.tenantId).toBe('tenant-1');
    expect(sub.organizationId).toBeNull();
    expect(sub.planTier).toBe('pro');
    expect(sub.billingCycle).toBe('monthly');
    expect(sub.billingStartDate).toBeInstanceOf(Date);
    expect(sub.billingEndDate).toBeNull();
    expect(sub.status).toBe('active');
    expect(sub.trialEndsAt).toBeNull();
    expect(sub.canceledAt).toBeNull();
    expect(sub.externalBillingId).toBeNull();
    expect(sub.externalCustomerId).toBeNull();
    expect(sub.orgLimits).toBeNull();
    expect(sub.entitlements).toEqual([]);
    expect(sub.tenantQuotas).toEqual([]);
    expect(sub.billingUnitPolicyOverrides).toBeNull();
    expect(sub._v).toBe(1);
  });

  it('stores tenant quotas with nested project quotas', () => {
    const now = new Date();
    const sub = new Subscription({
      ...validSub(),
      tenantQuotas: [
        {
          id: 'tq-1',
          tenantId: 'tenant-1',
          allocatedLimits: { sessions: 1000 },
          burstAllowed: true,
          projectQuotas: [
            {
              id: 'pq-1',
              projectId: 'proj-1',
              allocatedLimits: { sessions: 500 },
              overageBehavior: 'block',
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    expect(sub.tenantQuotas).toHaveLength(1);
    expect(sub.tenantQuotas[0].burstAllowed).toBe(true);
    expect(sub.tenantQuotas[0].projectQuotas).toHaveLength(1);
  });

  it('stores billing unit policy overrides additively', () => {
    const sub = new Subscription({
      ...validSub(),
      billingUnitPolicyOverrides: {
        intervalMinutes: 15,
        excludedChannels: ['web_debug'],
        excludeProactiveWithoutUserInteraction: true,
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
        },
        materialization: {
          basis: 'time_window',
          timeWindowMinutes: 60,
          completedSessionsCount: null,
        },
      },
    });

    expect(sub.billingUnitPolicyOverrides).toEqual({
      intervalMinutes: 15,
      excludedChannels: ['web_debug'],
      excludeProactiveWithoutUserInteraction: true,
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
      },
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    });
  });

  // --- DB-dependent tests ---

  it('persists and retrieves a subscription', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const sub = await Subscription.create(validSub());
    expect(sub._id).toBeDefined();
    expect(sub.createdAt).toBeInstanceOf(Date);
    expect(sub.updatedAt).toBeInstanceOf(Date);
  });

  it('persists billing unit policy overrides', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await Subscription.create({
      ...validSub(),
      billingUnitPolicyOverrides: {
        excludedChannels: ['web_debug'],
        materialization: {
          basis: 'completed_sessions',
          completedSessionsCount: 25,
          timeWindowMinutes: null,
        },
      },
    });

    const stored = await Subscription.findOne({ tenantId: 'tenant-1' }).lean().exec();

    expect(stored?.billingUnitPolicyOverrides).toEqual({
      excludedChannels: ['web_debug'],
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 25,
        timeWindowMinutes: null,
      },
    });
  });
});

// ─── Billing Replay Models ─────────────────────────────────────────────────

describe('BillingReplayRun', () => {
  it('stores compare-only replay run metadata', () => {
    const run = new BillingReplayRun({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      triggeredBy: 'user-1',
      request: {
        projectId: 'project-1',
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
      summary: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 2,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 3,
        exclusionCounts: { excluded_channel: 1 },
        metricsSourceCounts: { clickhouse: 1, message_fallback: 1 },
        projectBreakdown: [
          {
            projectId: 'project-1',
            examinedSessionCount: 2,
            includedSessionCount: 1,
            excludedSessionCount: 1,
            baseUnits: 2,
            llmAddonUnits: 1,
            toolAddonUnits: 0,
            totalUnits: 3,
          },
        ],
        channelBreakdown: [
          {
            channel: 'api',
            examinedSessionCount: 2,
            includedSessionCount: 1,
            excludedSessionCount: 1,
            baseUnits: 2,
            llmAddonUnits: 1,
            toolAddonUnits: 0,
            totalUnits: 3,
          },
        ],
      },
      warnings: [],
      resultCount: 2,
      startedAt: new Date('2026-03-30T11:01:00.000Z'),
      completedAt: new Date('2026-03-30T11:01:01.000Z'),
      status: 'completed',
    });

    expect(run.mode).toBe('compare_only');
    expect(run.triggerSource).toBe('manual');
    expect(run.status).toBe('completed');
    expect(run.scope.basis).toBe('time_window');
    expect(run.summary?.totalUnits).toBe(3);
    expect(run.summary?.projectBreakdown[0]?.projectId).toBe('project-1');
    expect(run.summary?.channelBreakdown[0]?.channel).toBe('api');
  });

  it('persists replay runs', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const created = await BillingReplayRun.create({
      tenantId: 'tenant-1',
      projectId: null,
      triggeredBy: 'user-1',
      request: {},
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
          basis: 'completed_sessions',
          completedSessionsCount: 25,
          timeWindowMinutes: null,
        },
      },
      scope: {
        basis: 'completed_sessions',
        windowStart: null,
        windowEnd: null,
        endedBefore: new Date('2026-03-30T11:00:00.000Z'),
        completedSessionsCount: 25,
        periodLabel: 'latest-25-sessions-until-2026-03-30T11:00:00.000Z',
      },
      summary: null,
      warnings: [],
      resultCount: 0,
      startedAt: new Date('2026-03-30T11:01:00.000Z'),
      completedAt: null,
      status: 'running',
    });

    expect(created._id).toBeDefined();
    expect(created.status).toBe('running');
  });
});

describe('BillingReplaySessionResult', () => {
  it('stores per-session compare-only artifacts', () => {
    const result = new BillingReplaySessionResult({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 0,
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-03-30T10:00:00.000Z'),
      endedAt: new Date('2026-03-30T10:20:00.000Z'),
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 2,
      engagedSeconds: 900,
      llmCallCount: 3,
      toolCallCount: 1,
      metricsSource: 'clickhouse',
      included: true,
      exclusionReasons: [],
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
    });

    expect(result.runId).toBe('run-1');
    expect(result.sequence).toBe(0);
    expect(result.metricsSource).toBe('clickhouse');
    expect(result.totalUnits).toBe(6);
  });

  it('persists per-session replay results', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const created = await BillingReplaySessionResult.create({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 0,
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-03-30T10:00:00.000Z'),
      endedAt: new Date('2026-03-30T10:20:00.000Z'),
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 2,
      engagedSeconds: 900,
      llmCallCount: 3,
      toolCallCount: 1,
      metricsSource: 'message_fallback',
      included: false,
      exclusionReasons: ['excluded_channel:web_debug'],
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
      totalUnits: 0,
    });

    expect(created._id).toBeDefined();
    expect(created.included).toBe(false);
    expect(created.exclusionReasons).toEqual(['excluded_channel:web_debug']);
  });
});

describe('BillingMaterializationSessionResult', () => {
  it('stores per-session materialization artifacts', () => {
    const result = new BillingMaterializationSessionResult({
      tenantId: 'tenant-1',
      subscriptionId: 'sub-1',
      projectId: 'project-1',
      batchId: 'batch-1',
      sequence: 0,
      sessionId: 'session-1',
      triggerSource: 'scheduled',
      materializationBasis: 'time_window',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-03-30T10:00:00.000Z'),
      endedAt: new Date('2026-03-30T10:20:00.000Z'),
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 2,
      engagedSeconds: 900,
      llmCallCount: 3,
      toolCallCount: 1,
      metricsSource: 'clickhouse',
      included: true,
      exclusionReasons: [],
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
    });

    expect(result.batchId).toBe('batch-1');
    expect(result.subscriptionId).toBe('sub-1');
    expect(result.sequence).toBe(0);
    expect(result.triggerSource).toBe('scheduled');
    expect(result.materializationBasis).toBe('time_window');
    expect(result.totalUnits).toBe(6);
  });

  it('persists per-session materialization results', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const created = await BillingMaterializationSessionResult.create({
      tenantId: 'tenant-1',
      subscriptionId: 'sub-1',
      projectId: 'project-1',
      batchId: 'batch-1',
      sequence: 0,
      sessionId: 'session-1',
      triggerSource: 'manual',
      materializationBasis: 'completed_sessions',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-03-30T10:00:00.000Z'),
      endedAt: new Date('2026-03-30T10:20:00.000Z'),
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 2,
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
    });

    expect(created._id).toBeDefined();
    expect(created.batchId).toBe('batch-1');
    expect(created.sessionId).toBe('session-1');
  });
});

describe('BillingMaterializationBatch', () => {
  it('stores truthful aggregate materialization metadata', () => {
    const batch = new BillingMaterializationBatch({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      triggeredBy: 'admin-1',
      request: {
        projectId: 'project-1',
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
      summary: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
        exclusionCounts: { 'excluded_channel:web_debug': 1 },
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
      },
      warnings: [],
      resultCount: 2,
      eventId: 'evt-billing-1',
      eventDispatchAttempted: true,
      startedAt: new Date('2026-03-30T11:01:00.000Z'),
      completedAt: new Date('2026-03-30T11:01:01.000Z'),
      status: 'completed',
    });

    expect(batch.triggerSource).toBe('manual');
    expect(batch.status).toBe('completed');
    expect(batch.scope.basis).toBe('time_window');
    expect(batch.summary?.totalUnits).toBe(6);
    expect(batch.summary?.projectBreakdown[0]?.projectId).toBe('project-1');
    expect(batch.summary?.channelBreakdown[0]?.channel).toBe('api');
    expect(batch.eventDispatchAttempted).toBe(true);
  });

  it('persists materialization batches', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const created = await BillingMaterializationBatch.create({
      tenantId: 'tenant-1',
      projectId: null,
      subscriptionId: 'sub-1',
      triggeredBy: 'admin-1',
      request: {
        endedBefore: new Date('2026-03-30T11:00:00.000Z'),
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
          basis: 'completed_sessions',
          completedSessionsCount: 25,
          timeWindowMinutes: null,
        },
      },
      scope: {
        basis: 'completed_sessions',
        windowStart: null,
        windowEnd: null,
        endedBefore: new Date('2026-03-30T11:00:00.000Z'),
        completedSessionsCount: 25,
        periodLabel: 'latest-25-sessions-until-2026-03-30T11:00:00.000Z',
      },
      summary: {
        examinedSessionCount: 25,
        includedSessionCount: 20,
        excludedSessionCount: 5,
        baseUnits: 10,
        llmAddonUnits: 4,
        toolAddonUnits: 2,
        totalUnits: 16,
        exclusionCounts: { proactive_below_interaction_threshold: 5 },
        metricsSourceCounts: { clickhouse: 20, message_fallback: 5 },
        projectBreakdown: [
          {
            projectId: 'project-1',
            examinedSessionCount: 25,
            includedSessionCount: 20,
            excludedSessionCount: 5,
            baseUnits: 10,
            llmAddonUnits: 4,
            toolAddonUnits: 2,
            totalUnits: 16,
          },
        ],
        channelBreakdown: [
          {
            channel: 'api',
            examinedSessionCount: 25,
            includedSessionCount: 20,
            excludedSessionCount: 5,
            baseUnits: 10,
            llmAddonUnits: 4,
            toolAddonUnits: 2,
            totalUnits: 16,
          },
        ],
      },
      warnings: [],
      resultCount: 25,
      eventId: null,
      eventDispatchAttempted: false,
      startedAt: new Date('2026-03-30T11:01:00.000Z'),
      completedAt: null,
      status: 'running',
    });

    expect(created._id).toBeDefined();
    expect(created.subscriptionId).toBe('sub-1');
    expect(created.status).toBe('running');
  });
});

describe('BillingMaterializationApplication', () => {
  it('stores deferred projection metadata for an applied materialization batch', () => {
    const application = new BillingMaterializationApplication({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      status: 'recorded',
      triggerSource: 'manual',
      triggeredBy: 'materializer-1',
      appliedBy: 'admin-1',
      materializationBasis: 'time_window',
      materializationScope: {
        basis: 'time_window',
        windowStart: new Date('2026-03-30T10:00:00.000Z'),
        windowEnd: new Date('2026-03-30T11:00:00.000Z'),
        endedBefore: null,
        completedSessionsCount: null,
        periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
      },
      summarySnapshot: {
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
      },
      warnings: ['materialized with fallback metrics for one session'],
      dealResolution: {
        organizationId: 'org-1',
        dealId: 'deal-1',
        dealScope: 'project',
        matchType: 'project_exact',
      },
      accountingPeriod: {
        billingCycle: 'monthly',
        billingStartDate: new Date('2026-03-15T00:00:00.000Z'),
        referenceAt: new Date('2026-04-02T12:00:00.000Z'),
        periodStart: new Date('2026-03-15T00:00:00.000Z'),
        periodEnd: new Date('2026-04-14T23:59:59.999Z'),
        periodLabel: '2026-03',
      },
      projection: {
        usageReports: {
          status: 'applied',
          reason: null,
          targetId: 'batch-1',
          targetIds: [],
          appliedAt: new Date('2026-04-02T12:05:00.000Z'),
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
      appliedAt: new Date('2026-04-02T12:05:00.000Z'),
    });

    expect(application.status).toBe('recorded');
    expect(application.dealResolution.dealId).toBe('deal-1');
    expect(application.accountingPeriod.periodLabel).toBe('2026-03');
    expect(application.projection.usageReports.status).toBe('applied');
    expect(application.projection.creditLedger.status).toBe('deferred');
    expect(application.projection.billingLineItems.reason).toBe(
      'billing_unit_price_mapping_not_configured',
    );
  });

  it('persists at most one application row per tenant and batch', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await BillingMaterializationApplication.create({
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      projectId: null,
      subscriptionId: 'sub-1',
      status: 'recorded',
      triggerSource: 'scheduled',
      triggeredBy: 'billing-materializer-scheduler',
      appliedBy: 'admin-1',
      materializationBasis: 'completed_sessions',
      materializationScope: {
        basis: 'completed_sessions',
        windowStart: null,
        windowEnd: null,
        endedBefore: new Date('2026-03-30T11:00:00.000Z'),
        completedSessionsCount: 25,
        periodLabel: 'latest-25-sessions-until-2026-03-30T11:00:00.000Z',
      },
      summarySnapshot: {
        examinedSessionCount: 25,
        includedSessionCount: 20,
        excludedSessionCount: 5,
        baseUnits: 10,
        llmAddonUnits: 4,
        toolAddonUnits: 2,
        totalUnits: 16,
        exclusionCounts: { proactive_below_interaction_threshold: 5 },
        metricsSourceCounts: { clickhouse: 20, message_fallback: 5 },
        projectBreakdown: [],
        channelBreakdown: [],
      },
      warnings: [],
      dealResolution: {
        organizationId: 'tenant-1',
        dealId: 'deal-1',
        dealScope: 'organization',
        matchType: 'organization_scope',
      },
      accountingPeriod: {
        billingCycle: 'monthly',
        billingStartDate: new Date('2026-03-01T00:00:00.000Z'),
        referenceAt: new Date('2026-03-30T11:00:00.000Z'),
        periodStart: new Date('2026-03-01T00:00:00.000Z'),
        periodEnd: new Date('2026-03-31T23:59:59.999Z'),
        periodLabel: '2026-03',
      },
      projection: {
        usageReports: {
          status: 'applied',
          reason: null,
          targetId: 'batch-1',
          targetIds: [],
          appliedAt: new Date('2026-03-30T11:05:00.000Z'),
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
      appliedAt: new Date('2026-03-30T11:05:00.000Z'),
    });

    await expect(
      BillingMaterializationApplication.create({
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projectId: null,
        subscriptionId: 'sub-1',
        status: 'recorded',
        triggerSource: 'scheduled',
        triggeredBy: 'billing-materializer-scheduler',
        appliedBy: 'admin-2',
        materializationBasis: 'completed_sessions',
        materializationScope: {
          basis: 'completed_sessions',
          windowStart: null,
          windowEnd: null,
          endedBefore: new Date('2026-03-30T11:00:00.000Z'),
          completedSessionsCount: 25,
          periodLabel: 'latest-25-sessions-until-2026-03-30T11:00:00.000Z',
        },
        summarySnapshot: {
          examinedSessionCount: 25,
          includedSessionCount: 20,
          excludedSessionCount: 5,
          baseUnits: 10,
          llmAddonUnits: 4,
          toolAddonUnits: 2,
          totalUnits: 16,
          exclusionCounts: { proactive_below_interaction_threshold: 5 },
          metricsSourceCounts: { clickhouse: 20, message_fallback: 5 },
          projectBreakdown: [],
          channelBreakdown: [],
        },
        warnings: [],
        dealResolution: {
          organizationId: 'tenant-1',
          dealId: 'deal-2',
          dealScope: 'organization',
          matchType: 'organization_scope',
        },
        accountingPeriod: {
          billingCycle: 'monthly',
          billingStartDate: new Date('2026-03-01T00:00:00.000Z'),
          referenceAt: new Date('2026-03-30T11:00:00.000Z'),
          periodStart: new Date('2026-03-01T00:00:00.000Z'),
          periodEnd: new Date('2026-03-31T23:59:59.999Z'),
          periodLabel: '2026-03',
        },
        projection: {
          usageReports: {
            status: 'applied',
            reason: null,
            targetId: 'batch-1',
            targetIds: [],
            appliedAt: new Date('2026-03-30T11:06:00.000Z'),
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
        appliedAt: new Date('2026-03-30T11:06:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe('BillingUsagePublishedSession', () => {
  it('stores the applied reporting projection for a session', () => {
    const published = new BillingUsagePublishedSession({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      sessionId: 'sess-1',
      batchId: 'batch-1',
      applicationId: 'app-1',
      batchCreatedAt: new Date('2026-04-03T11:55:00.000Z'),
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-04-03T10:00:00.000Z'),
      endedAt: new Date('2026-04-03T10:20:00.000Z'),
      publishedAt: new Date('2026-04-03T12:00:00.000Z'),
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
    });

    expect(published.tenantId).toBe('tenant-1');
    expect(published.sessionId).toBe('sess-1');
    expect(published.applicationId).toBe('app-1');
    expect(published.totalUnits).toBe(6);
  });

  it('declares a global endedAt index for platform-wide reporting windows', () => {
    const indexes = BillingUsagePublishedSession.schema.indexes();
    const endedAtIndex = indexes.find(
      ([fields]) => JSON.stringify(fields) === JSON.stringify({ endedAt: -1 }),
    );

    expect(endedAtIndex).toBeDefined();
  });

  it('persists at most one published row per tenant and session', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await BillingUsagePublishedSession.create({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      subscriptionId: 'sub-1',
      sessionId: 'sess-1',
      batchId: 'batch-1',
      applicationId: 'app-1',
      batchCreatedAt: new Date('2026-04-03T11:55:00.000Z'),
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      sessionType: null,
      startedAt: new Date('2026-04-03T10:00:00.000Z'),
      endedAt: new Date('2026-04-03T10:20:00.000Z'),
      publishedAt: new Date('2026-04-03T12:00:00.000Z'),
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
    });

    await expect(
      BillingUsagePublishedSession.create({
        tenantId: 'tenant-1',
        projectId: 'project-2',
        subscriptionId: 'sub-1',
        sessionId: 'sess-1',
        batchId: 'batch-2',
        applicationId: 'app-2',
        batchCreatedAt: new Date('2026-04-03T12:00:00.000Z'),
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'voice',
        status: 'completed',
        disposition: 'completed',
        sessionType: null,
        startedAt: new Date('2026-04-03T10:10:00.000Z'),
        endedAt: new Date('2026-04-03T10:25:00.000Z'),
        publishedAt: new Date('2026-04-03T12:05:00.000Z'),
        durationSeconds: 900,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 2,
        engagedSeconds: 300,
        llmCallCount: 1,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: true,
        exclusionReasons: [],
        baseUnits: 1,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 2,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('BillingMaterializationCheckpoint', () => {
  it('tracks scheduler-owned cursor state separately from manual batches', () => {
    const checkpoint = new BillingMaterializationCheckpoint({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      basis: 'completed_sessions',
      cursor: {
        lastWindowEnd: null,
        lastEndedAt: new Date('2026-03-30T11:00:00.000Z'),
        lastSessionId: 'sess-25',
      },
      lastBatchId: 'batch-1',
      lastMaterializedAt: new Date('2026-03-30T11:05:00.000Z'),
    });

    expect(checkpoint.basis).toBe('completed_sessions');
    expect(checkpoint.projectId).toBe('project-1');
    expect(checkpoint.cursor.lastEndedAt?.toISOString()).toBe('2026-03-30T11:00:00.000Z');
    expect(checkpoint.cursor.lastSessionId).toBe('sess-25');
    expect(checkpoint.lastBatchId).toBe('batch-1');
  });

  it('persists checkpoint rows per tenant/project/basis scope', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const created = await BillingMaterializationCheckpoint.create({
      tenantId: 'tenant-1',
      projectId: null,
      basis: 'time_window',
      cursor: {
        lastWindowEnd: new Date('2026-03-30T11:00:00.000Z'),
        lastEndedAt: null,
        lastSessionId: null,
      },
      lastBatchId: 'batch-1',
      lastMaterializedAt: new Date('2026-03-30T11:05:00.000Z'),
    });

    expect(created._id).toBeDefined();
    expect(created.projectId).toBeNull();
    expect(created.basis).toBe('time_window');
    expect(created.cursor.lastWindowEnd?.toISOString()).toBe('2026-03-30T11:00:00.000Z');
  });
});

// ─── LLMUsageMetric Model ───────────────────────────────────────────────────

describe('LLMUsageMetric', () => {
  const validMetric = () => ({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    agentName: 'booking_agent',
    provider: 'openai',
    model: 'gpt-4',
    operation: 'completion',
    inputTokens: 500,
    outputTokens: 200,
    totalTokens: 700,
    latencyMs: 1200,
    estimatedCost: 0.021,
    status: 'success',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validMetric();
    delete (data as any).tenantId;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires sessionId', () => {
    const data = validMetric();
    delete (data as any).sessionId;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sessionId).toBeDefined();
  });

  it('requires agentName', () => {
    const data = validMetric();
    delete (data as any).agentName;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentName).toBeDefined();
  });

  it('requires provider', () => {
    const data = validMetric();
    delete (data as any).provider;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('requires model', () => {
    const data = validMetric();
    delete (data as any).model;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.model).toBeDefined();
  });

  it('requires operation', () => {
    const data = validMetric();
    delete (data as any).operation;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.operation).toBeDefined();
  });

  it('requires inputTokens', () => {
    const data = validMetric();
    delete (data as any).inputTokens;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.inputTokens).toBeDefined();
  });

  it('requires outputTokens', () => {
    const data = validMetric();
    delete (data as any).outputTokens;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.outputTokens).toBeDefined();
  });

  it('requires totalTokens', () => {
    const data = validMetric();
    delete (data as any).totalTokens;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.totalTokens).toBeDefined();
  });

  it('requires latencyMs', () => {
    const data = validMetric();
    delete (data as any).latencyMs;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.latencyMs).toBeDefined();
  });

  it('requires estimatedCost', () => {
    const data = validMetric();
    delete (data as any).estimatedCost;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.estimatedCost).toBeDefined();
  });

  it('requires status', () => {
    const data = validMetric();
    delete (data as any).status;
    const err = new LLMUsageMetric(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid LLM usage metric', () => {
    const metric = new LLMUsageMetric(validMetric());
    expect(metric._id).toBeDefined();
    expect(metric.tenantId).toBe('tenant-1');
    expect(metric.sessionId).toBe('session-1');
    expect(metric.agentName).toBe('booking_agent');
    expect(metric.provider).toBe('openai');
    expect(metric.model).toBe('gpt-4');
    expect(metric.operation).toBe('completion');
    expect(metric.inputTokens).toBe(500);
    expect(metric.outputTokens).toBe(200);
    expect(metric.totalTokens).toBe(700);
    expect(metric.latencyMs).toBe(1200);
    expect(metric.estimatedCost).toBe(0.021);
    expect(metric.status).toBe('success');
    expect(metric.errorMessage).toBeNull();
    expect(metric.metadata).toBeNull();
    expect(metric._v).toBe(1);
  });
});

// ─── LLMCredential Model ───────────────────────────────────────────────────

describe('LLMCredential', () => {
  const validCred = () => ({
    tenantId: 'tenant-1',
    credentialScope: 'user' as const,
    ownerId: 'user-1',
    provider: 'openai',
    name: 'My OpenAI Key',
    encryptedApiKey: 'enc-key-123',
    authType: 'api_key',
  });

  // --- Validation tests (no DB needed) ---

  it('requires credentialScope and ownerId', () => {
    const data = validCred();
    delete (data as any).credentialScope;
    delete (data as any).ownerId;
    const err = new LLMCredential(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.credentialScope).toBeDefined();
    expect(err!.errors.ownerId).toBeDefined();
  });

  it('requires provider', () => {
    const data = validCred();
    delete (data as any).provider;
    const err = new LLMCredential(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('requires name', () => {
    const data = validCred();
    delete (data as any).name;
    const err = new LLMCredential(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires encryptedApiKey', () => {
    const data = validCred();
    delete (data as any).encryptedApiKey;
    const err = new LLMCredential(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.encryptedApiKey).toBeDefined();
  });

  it('requires authType', () => {
    const data = validCred();
    delete (data as any).authType;
    const err = new LLMCredential(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authType).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid LLM credential', () => {
    const cred = new LLMCredential(validCred());
    expect(cred._id).toBeDefined();
    expect(cred.tenantId).toBe('tenant-1');
    expect(cred.credentialScope).toBe('user');
    expect(cred.ownerId).toBe('user-1');
    expect(cred.provider).toBe('openai');
    expect(cred.name).toBe('My OpenAI Key');
    expect(cred.encryptedApiKey).toBe('enc-key-123');
    expect(cred.encryptedEndpoint).toBeNull();
    expect(cred.customHeaders).toBeNull();
    expect(cred.authType).toBe('api_key');
    expect(cred.isActive).toBe(true);
    expect(cred.isDefault).toBe(false);
    expect(cred.lastUsedAt).toBeNull();
    expect(cred.lastValidatedAt).toBeNull();
    expect(cred._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId+credentialScope+ownerId+provider+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await LLMCredential.create(validCred());
    await expect(LLMCredential.create(validCred())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── TenantLLMPolicy Model ─────────────────────────────────────────────────

describe('TenantLLMPolicy', () => {
  const validPolicy = () => ({
    tenantId: 'tenant-1',
    credentialPolicy: 'bring_your_own',
    monthlyTokenBudget: 1000000,
    dailyTokenBudget: 50000,
    maxRequestsPerMinute: 100,
    allowProjectCredentials: true,
    platformDemoEnabled: false,
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validPolicy();
    delete (data as any).tenantId;
    const err = new TenantLLMPolicy(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires credentialPolicy', () => {
    const data = validPolicy();
    delete (data as any).credentialPolicy;
    const err = new TenantLLMPolicy(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.credentialPolicy).toBeDefined();
  });

  it('requires monthlyTokenBudget', () => {
    const data = validPolicy();
    delete (data as any).monthlyTokenBudget;
    const err = new TenantLLMPolicy(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.monthlyTokenBudget).toBeDefined();
  });

  it('requires dailyTokenBudget', () => {
    const data = validPolicy();
    delete (data as any).dailyTokenBudget;
    const err = new TenantLLMPolicy(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.dailyTokenBudget).toBeDefined();
  });

  it('requires maxRequestsPerMinute', () => {
    const data = validPolicy();
    delete (data as any).maxRequestsPerMinute;
    const err = new TenantLLMPolicy(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.maxRequestsPerMinute).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid tenant LLM policy', () => {
    const policy = new TenantLLMPolicy(validPolicy());
    expect(policy._id).toBeDefined();
    expect(policy.tenantId).toBe('tenant-1');
    expect(policy.allowedProviders).toEqual([]);
    expect(policy.credentialPolicy).toBe('bring_your_own');
    expect(policy.monthlyTokenBudget).toBe(1000000);
    expect(policy.dailyTokenBudget).toBe(50000);
    expect(policy.defaultModel).toBeNull();
    expect(policy.defaultFastModel).toBeNull();
    expect(policy.defaultVoiceModel).toBeNull();
    expect(policy.maxRequestsPerMinute).toBe(100);
    expect(policy.allowProjectCredentials).toBe(true);
    expect(policy.platformDemoEnabled).toBe(false);
    expect(policy._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await TenantLLMPolicy.create(validPolicy());
    await expect(TenantLLMPolicy.create(validPolicy())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── TenantModel Model ─────────────────────────────────────────────────────

describe('TenantModel', () => {
  const validTenantModel = () => ({
    tenantId: 'tenant-1',
    displayName: 'GPT-4o',
    integrationType: 'easy',
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsStructured: true,
    tier: 'premium',
    createdBy: 'user-1',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validTenantModel();
    delete (data as any).tenantId;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires displayName', () => {
    const data = validTenantModel();
    delete (data as any).displayName;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('requires integrationType', () => {
    const data = validTenantModel();
    delete (data as any).integrationType;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.integrationType).toBeDefined();
  });

  it('requires temperature', () => {
    const data = validTenantModel();
    delete (data as any).temperature;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.temperature).toBeDefined();
  });

  it('requires maxTokens', () => {
    const data = validTenantModel();
    delete (data as any).maxTokens;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.maxTokens).toBeDefined();
  });

  it('requires tier', () => {
    const data = validTenantModel();
    delete (data as any).tier;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tier).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validTenantModel();
    delete (data as any).createdBy;
    const err = new TenantModel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid tenant model', () => {
    const tm = new TenantModel(validTenantModel());
    expect(tm._id).toBeDefined();
    expect(tm.tenantId).toBe('tenant-1');
    expect(tm.displayName).toBe('GPT-4o');
    expect(tm.integrationType).toBe('easy');
    expect(tm.modelId).toBeNull();
    expect(tm.provider).toBeNull();
    expect(tm.temperature).toBe(0.7);
    expect(tm.maxTokens).toBe(4096);
    expect(tm.supportsTools).toBe(true);
    expect(tm.supportsStreaming).toBe(true);
    expect(tm.supportsVision).toBe(true);
    expect(tm.supportsStructured).toBe(true);
    expect(tm.capabilities).toEqual(['text']);
    expect(tm.tier).toBe('premium');
    expect(tm.isDefault).toBe(false);
    expect(tm.isActive).toBe(true);
    expect(tm.inferenceEnabled).toBe(true);
    expect(tm.createdBy).toBe('user-1');
    expect(tm.connections).toEqual([]);
    expect(tm._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId+displayName', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await TenantModel.create(validTenantModel());
    await expect(TenantModel.create(validTenantModel())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── TenantServiceInstance Model ────────────────────────────────────────────

describe('TenantServiceInstance', () => {
  const validInstance = () => ({
    tenantId: 'tenant-1',
    displayName: 'Deepgram STT',
    serviceType: 'stt',
    encryptedApiKey: 'enc-key-456',
    createdBy: 'user-1',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validInstance();
    delete (data as any).tenantId;
    const err = new TenantServiceInstance(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires displayName', () => {
    const data = validInstance();
    delete (data as any).displayName;
    const err = new TenantServiceInstance(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('requires serviceType', () => {
    const data = validInstance();
    delete (data as any).serviceType;
    const err = new TenantServiceInstance(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.serviceType).toBeDefined();
  });

  it('requires encryptedApiKey', () => {
    const data = validInstance();
    delete (data as any).encryptedApiKey;
    const err = new TenantServiceInstance(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.encryptedApiKey).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validInstance();
    delete (data as any).createdBy;
    const err = new TenantServiceInstance(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid tenant service instance', () => {
    const inst = new TenantServiceInstance(validInstance());
    expect(inst._id).toBeDefined();
    expect(inst.tenantId).toBe('tenant-1');
    expect(inst.displayName).toBe('Deepgram STT');
    expect(inst.serviceType).toBe('stt');
    expect(inst.encryptedApiKey).toBe('enc-key-456');
    expect(inst.isDefault).toBe(false);
    expect(inst.isActive).toBe(true);
    expect(inst.createdBy).toBe('user-1');
    expect(inst._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId+serviceType+displayName', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await TenantServiceInstance.create(validInstance());
    await expect(TenantServiceInstance.create(validInstance())).rejects.toThrow(/duplicate key/i);
  });
});
