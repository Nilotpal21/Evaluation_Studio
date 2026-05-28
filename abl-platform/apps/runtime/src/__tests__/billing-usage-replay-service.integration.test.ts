import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingReplayRun,
  BillingReplaySessionResult,
  Message,
  Session,
  Subscription,
} from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsagePreviewService } from '../services/billing/billing-usage-preview-service.js';
import { BillingUsageReplayService } from '../services/billing/billing-usage-replay-service.js';

const TENANT_ID = 'tenant-billing-replay';
const PROJECT_ID = 'project-billing-replay';

function messageDoc(params: {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  timestamp: string;
}): Record<string, unknown> {
  const timestamp = new Date(params.timestamp);
  return {
    _id: params.id,
    sessionId: params.sessionId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    role: params.role,
    content: `${params.role} message`,
    channel: 'api',
    traceId: null,
    attachmentIds: [],
    hasPII: false,
    scrubbed: false,
    scrubbedAt: null,
    encrypted: false,
    metadata: {},
    timestamp,
    expiresAt: null,
    idempotencyKey: null,
    sourceChannel: null,
    inputMode: params.role === 'tool' ? 'tool' : 'typed',
    participantId: null,
    final: true,
    sequence: null,
    deliveryChannels: [],
    _v: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

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
  channel: string;
  status: string;
  disposition: string | null;
  startedAt: string;
  endedAt: string;
  metadata?: Record<string, unknown>;
  isTest?: boolean;
}): Promise<void> {
  const startedAt = new Date(params.startedAt);
  const endedAt = new Date(params.endedAt);
  await Session.create({
    _id: params.sessionId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    currentAgent: 'BillingReplayAgent',
    environment: 'production',
    channel: params.channel,
    status: params.status,
    disposition: params.disposition,
    metadata: params.metadata ?? {},
    isTest: params.isTest ?? false,
    startedAt,
    lastActivityAt: endedAt,
    endedAt,
  });
}

describe('BillingUsageReplayService', () => {
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

  it('creates a persisted compare-only replay run and stores per-session results', async () => {
    await seedActiveSubscription({
      excludedChannels: ['web_debug'],
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-billable',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:31:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-debug',
      channel: 'web_debug',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:05:00.000Z',
      endedAt: '2026-03-30T10:10:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-b1',
        sessionId: 'sess-billable',
        role: 'user',
        timestamp: '2026-03-30T10:01:00.000Z',
      }),
      messageDoc({
        id: 'msg-b2',
        sessionId: 'sess-billable',
        role: 'assistant',
        timestamp: '2026-03-30T10:02:00.000Z',
      }),
      messageDoc({
        id: 'msg-b3',
        sessionId: 'sess-billable',
        role: 'user',
        timestamp: '2026-03-30T10:20:00.000Z',
      }),
      messageDoc({
        id: 'msg-b4',
        sessionId: 'sess-billable',
        role: 'assistant',
        timestamp: '2026-03-30T10:21:00.000Z',
      }),
      messageDoc({
        id: 'msg-d1',
        sessionId: 'sess-debug',
        role: 'user',
        timestamp: '2026-03-30T10:05:30.000Z',
      }),
      messageDoc({
        id: 'msg-d2',
        sessionId: 'sess-debug',
        role: 'assistant',
        timestamp: '2026-03-30T10:06:00.000Z',
      }),
    ]);

    const previewService = new BillingUsagePreviewService({
      metricsReader: {
        async getSessionAddonUsage() {
          return {
            source: 'clickhouse',
            warnings: [],
            usageBySessionId: new Map([
              ['sess-billable', { llmCallCount: 3, toolCallCount: 2 }],
              ['sess-debug', { llmCallCount: 1, toolCallCount: 0 }],
            ]),
          };
        },
      },
      now: () => new Date('2026-03-30T11:00:00.000Z'),
    });
    const service = new BillingUsageReplayService({
      previewService,
      now: () => new Date('2026-03-30T11:05:00.000Z'),
    });

    const replay = await service.createReplayRun({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
      triggeredBy: 'admin-user-1',
    });

    expect(replay).not.toBeNull();
    expect(replay).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      status: 'completed',
      triggerSource: 'manual',
      triggeredBy: 'admin-user-1',
      resultCount: 2,
      scope: {
        basis: 'time_window',
        windowStart: '2026-03-30T10:00:00.000Z',
        windowEnd: '2026-03-30T11:00:00.000Z',
      },
      summary: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 3,
        llmAddonUnits: 3,
        toolAddonUnits: 2,
        totalUnits: 8,
      },
      page: {
        page: 1,
        limit: 50,
        total: 2,
        hasMore: false,
      },
    });

    const persistedRuns = await BillingReplayRun.find({ tenantId: TENANT_ID }).lean().exec();
    const persistedResults = await BillingReplaySessionResult.find({ tenantId: TENANT_ID })
      .sort({ sequence: 1 })
      .lean()
      .exec();

    expect(persistedRuns).toHaveLength(1);
    expect(persistedRuns[0]?.status).toBe('completed');
    expect(persistedResults).toHaveLength(2);
    const billableResult = persistedResults.find((result) => result.sessionId === 'sess-billable');
    const debugResult = persistedResults.find((result) => result.sessionId === 'sess-debug');

    expect(billableResult).toMatchObject({
      sessionId: 'sess-billable',
      sequence: 1,
      included: true,
      totalUnits: 8,
    });
    expect(debugResult).toMatchObject({
      sessionId: 'sess-debug',
      sequence: 0,
      included: false,
      exclusionReasons: ['excluded_channel:web_debug'],
    });
  });

  it('lists replay runs and paginates persisted session results', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 2,
        timeWindowMinutes: null,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-oldest',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:05:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-second',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:10:00.000Z',
      endedAt: '2026-03-30T10:26:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-newest',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:30:00.000Z',
      endedAt: '2026-03-30T10:35:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-s1',
        sessionId: 'sess-second',
        role: 'user',
        timestamp: '2026-03-30T10:11:00.000Z',
      }),
      messageDoc({
        id: 'msg-s2',
        sessionId: 'sess-second',
        role: 'assistant',
        timestamp: '2026-03-30T10:12:00.000Z',
      }),
      messageDoc({
        id: 'msg-n1',
        sessionId: 'sess-newest',
        role: 'user',
        timestamp: '2026-03-30T10:31:00.000Z',
      }),
      messageDoc({
        id: 'msg-n2',
        sessionId: 'sess-newest',
        role: 'assistant',
        timestamp: '2026-03-30T10:32:00.000Z',
      }),
    ]);

    const previewService = new BillingUsagePreviewService({
      metricsReader: {
        async getSessionAddonUsage() {
          return {
            source: 'unavailable',
            warnings: [
              'ClickHouse usage telemetry unavailable; addon counts fell back to message history.',
            ],
            usageBySessionId: new Map(),
          };
        },
      },
      now: () => new Date('2026-03-30T11:00:00.000Z'),
    });
    const service = new BillingUsageReplayService({
      previewService,
      now: () => new Date('2026-03-30T11:05:00.000Z'),
    });

    const replay = await service.createReplayRun({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      endedBefore: new Date('2026-03-30T10:40:00.000Z'),
      triggeredBy: 'admin-user-2',
    });

    expect(replay).not.toBeNull();
    expect(replay?.sessions.map((session) => session.sessionId)).toEqual([
      'sess-second',
      'sess-newest',
    ]);

    const listed = await service.listReplayRuns({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      limit: 10,
    });

    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({
      runId: replay?.runId,
      triggeredBy: 'admin-user-2',
      resultCount: 2,
      scope: {
        basis: 'completed_sessions',
        endedBefore: '2026-03-30T10:40:00.000Z',
        completedSessionsCount: 2,
      },
    });

    const pageOne = await service.getReplayRun({
      tenantId: TENANT_ID,
      runId: replay!.runId,
      page: 1,
      limit: 1,
    });
    const pageTwo = await service.getReplayRun({
      tenantId: TENANT_ID,
      runId: replay!.runId,
      page: 2,
      limit: 1,
    });

    expect(pageOne?.page).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      hasMore: true,
    });
    expect(pageOne?.sessions).toHaveLength(1);
    expect(pageOne?.sessions[0]?.sessionId).toBe('sess-second');

    expect(pageTwo?.page).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      hasMore: false,
    });
    expect(pageTwo?.sessions).toHaveLength(1);
    expect(pageTwo?.sessions[0]?.sessionId).toBe('sess-newest');
  });
});
