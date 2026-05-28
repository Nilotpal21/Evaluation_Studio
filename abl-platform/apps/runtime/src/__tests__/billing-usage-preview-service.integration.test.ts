import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Subscription, Session, Message } from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsagePreviewService } from '../services/billing/billing-usage-preview-service.js';

const TENANT_ID = 'tenant-billing-preview';
const PROJECT_ID = 'project-billing-preview';

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
    currentAgent: 'BillingPreviewAgent',
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

describe('BillingUsagePreviewService', () => {
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

  it('derives compare-only billing units with shared reactive-session rules, exclusions, interval splitting, and mixed addon modes', async () => {
    await seedActiveSubscription({
      excludedChannels: ['web_debug'],
      interactionThreshold: {
        minUserMessages: 2,
        minInteractiveTurns: 2,
        minEngagedSeconds: 60,
      },
      addons: {
        llm: {
          mode: 'per_call',
          bucketSize: null,
        },
        tool: {
          mode: 'bucketed',
          bucketSize: 2,
        },
      },
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
    await seedEndedSession({
      sessionId: 'sess-low-interaction',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:12:00.000Z',
      endedAt: '2026-03-30T10:16:00.000Z',
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
        id: 'msg-b5',
        sessionId: 'sess-billable',
        role: 'tool',
        timestamp: '2026-03-30T10:22:00.000Z',
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
      messageDoc({
        id: 'msg-l1',
        sessionId: 'sess-low-interaction',
        role: 'user',
        timestamp: '2026-03-30T10:12:30.000Z',
      }),
      messageDoc({
        id: 'msg-l2',
        sessionId: 'sess-low-interaction',
        role: 'assistant',
        timestamp: '2026-03-30T10:13:00.000Z',
      }),
    ]);

    const service = new BillingUsagePreviewService({
      metricsReader: {
        async getSessionAddonUsage() {
          return {
            source: 'clickhouse',
            warnings: [],
            usageBySessionId: new Map([
              ['sess-billable', { llmCallCount: 3, toolCallCount: 3 }],
              ['sess-debug', { llmCallCount: 2, toolCallCount: 1 }],
              ['sess-low-interaction', { llmCallCount: 1, toolCallCount: 0 }],
            ]),
          };
        },
      },
      now: () => new Date('2026-03-30T11:00:00.000Z'),
    });

    const preview = await service.previewTenantUsage({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
    });

    expect(preview).not.toBeNull();
    expect(preview?.summary).toMatchObject({
      examinedSessionCount: 3,
      includedSessionCount: 2,
      excludedSessionCount: 1,
      baseUnits: 4,
      llmAddonUnits: 4,
      toolAddonUnits: 2,
      totalUnits: 10,
      exclusionCounts: {
        'excluded_channel:web_debug': 1,
      },
      metricsSourceCounts: {
        clickhouse: 3,
        message_fallback: 0,
      },
      projectBreakdown: [
        {
          projectId: PROJECT_ID,
          examinedSessionCount: 3,
          includedSessionCount: 2,
          excludedSessionCount: 1,
          baseUnits: 4,
          llmAddonUnits: 4,
          toolAddonUnits: 2,
          totalUnits: 10,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          examinedSessionCount: 2,
          includedSessionCount: 2,
          excludedSessionCount: 0,
          baseUnits: 4,
          llmAddonUnits: 4,
          toolAddonUnits: 2,
          totalUnits: 10,
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
    });

    const billableSession = preview?.sessions.find(
      (session) => session.sessionId === 'sess-billable',
    );
    expect(billableSession).toMatchObject({
      included: true,
      durationSeconds: 1860,
      userMessageCount: 2,
      assistantMessageCount: 2,
      interactiveTurnCount: 2,
      engagedSeconds: 1260,
      llmCallCount: 3,
      toolCallCount: 3,
      metricsSource: 'clickhouse',
      baseUnits: 3,
      llmAddonUnits: 3,
      toolAddonUnits: 2,
      totalUnits: 8,
    });

    const debugSession = preview?.sessions.find((session) => session.sessionId === 'sess-debug');
    expect(debugSession?.included).toBe(false);
    expect(debugSession?.exclusionReasons).toContain('excluded_channel:web_debug');

    const lowInteractionSession = preview?.sessions.find(
      (session) => session.sessionId === 'sess-low-interaction',
    );
    expect(lowInteractionSession).toMatchObject({
      included: true,
      userMessageCount: 1,
      assistantMessageCount: 1,
      interactiveTurnCount: 1,
      engagedSeconds: 30,
      llmCallCount: 1,
      toolCallCount: 0,
      metricsSource: 'clickhouse',
      baseUnits: 1,
      llmAddonUnits: 1,
      toolAddonUnits: 0,
      totalUnits: 2,
    });
  });

  it('reuses canonical derivation rules for proactive exclusions and zero-duration sessions', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-proactive-idle',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T12:00:00.000Z',
      endedAt: '2026-03-30T12:04:00.000Z',
      metadata: {
        interactionType: 'proactive',
      },
    });
    await seedEndedSession({
      sessionId: 'sess-zero-duration',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T12:10:00.000Z',
      endedAt: '2026-03-30T12:10:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-p1',
        sessionId: 'sess-proactive-idle',
        role: 'assistant',
        timestamp: '2026-03-30T12:00:30.000Z',
      }),
      messageDoc({
        id: 'msg-z1',
        sessionId: 'sess-zero-duration',
        role: 'user',
        timestamp: '2026-03-30T12:10:00.000Z',
      }),
      messageDoc({
        id: 'msg-z2',
        sessionId: 'sess-zero-duration',
        role: 'assistant',
        timestamp: '2026-03-30T12:10:00.000Z',
      }),
    ]);

    const service = new BillingUsagePreviewService({
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
      now: () => new Date('2026-03-30T13:00:00.000Z'),
    });

    const preview = await service.previewTenantUsage({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      windowStart: new Date('2026-03-30T12:00:00.000Z'),
      windowEnd: new Date('2026-03-30T13:00:00.000Z'),
    });

    expect(preview).not.toBeNull();
    expect(preview?.summary).toMatchObject({
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      baseUnits: 0,
      llmAddonUnits: 1,
      toolAddonUnits: 0,
      totalUnits: 1,
      exclusionCounts: {
        proactive_below_interaction_threshold: 1,
      },
      metricsSourceCounts: {
        clickhouse: 0,
        message_fallback: 2,
      },
    });

    const proactiveSession = preview?.sessions.find(
      (session) => session.sessionId === 'sess-proactive-idle',
    );
    expect(proactiveSession).toMatchObject({
      included: false,
      userMessageCount: 0,
      assistantMessageCount: 1,
      interactiveTurnCount: 0,
      engagedSeconds: 0,
      llmCallCount: 1,
      toolCallCount: 0,
      metricsSource: 'message_fallback',
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
      totalUnits: 0,
      exclusionReasons: ['proactive_below_interaction_threshold'],
    });

    const zeroDurationSession = preview?.sessions.find(
      (session) => session.sessionId === 'sess-zero-duration',
    );
    expect(zeroDurationSession).toMatchObject({
      included: true,
      durationSeconds: 0,
      userMessageCount: 1,
      assistantMessageCount: 1,
      interactiveTurnCount: 1,
      engagedSeconds: 0,
      llmCallCount: 1,
      toolCallCount: 0,
      metricsSource: 'message_fallback',
      baseUnits: 0,
      llmAddonUnits: 1,
      toolAddonUnits: 0,
      totalUnits: 1,
      exclusionReasons: [],
    });
  });

  it('supports completed-session batching and message-history addon fallback when ClickHouse is unavailable', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 2,
        timeWindowMinutes: null,
      },
      addons: {
        llm: {
          mode: 'bucketed',
          bucketSize: 2,
        },
        tool: {
          mode: 'per_call',
          bucketSize: null,
        },
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
        id: 'msg-o1',
        sessionId: 'sess-oldest',
        role: 'user',
        timestamp: '2026-03-30T10:01:00.000Z',
      }),
      messageDoc({
        id: 'msg-o2',
        sessionId: 'sess-oldest',
        role: 'assistant',
        timestamp: '2026-03-30T10:02:00.000Z',
      }),
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
        id: 'msg-s3',
        sessionId: 'sess-second',
        role: 'user',
        timestamp: '2026-03-30T10:20:00.000Z',
      }),
      messageDoc({
        id: 'msg-s4',
        sessionId: 'sess-second',
        role: 'assistant',
        timestamp: '2026-03-30T10:21:00.000Z',
      }),
      messageDoc({
        id: 'msg-s5',
        sessionId: 'sess-second',
        role: 'tool',
        timestamp: '2026-03-30T10:22:00.000Z',
      }),
      messageDoc({
        id: 'msg-s6',
        sessionId: 'sess-second',
        role: 'tool',
        timestamp: '2026-03-30T10:23:00.000Z',
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

    const service = new BillingUsagePreviewService({
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

    const preview = await service.previewTenantUsage({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      endedBefore: new Date('2026-03-30T10:40:00.000Z'),
    });

    expect(preview).not.toBeNull();
    expect(preview?.scope).toMatchObject({
      basis: 'completed_sessions',
      completedSessionsCount: 2,
      endedBefore: '2026-03-30T10:40:00.000Z',
    });
    expect(preview?.warnings).toContain(
      'ClickHouse usage telemetry unavailable; addon counts fell back to message history.',
    );
    expect(preview?.sessions.map((session) => session.sessionId)).toEqual([
      'sess-second',
      'sess-newest',
    ]);
    expect(preview?.summary).toMatchObject({
      examinedSessionCount: 2,
      includedSessionCount: 2,
      excludedSessionCount: 0,
      baseUnits: 3,
      llmAddonUnits: 2,
      toolAddonUnits: 2,
      totalUnits: 7,
      metricsSourceCounts: {
        clickhouse: 0,
        message_fallback: 2,
      },
      projectBreakdown: [
        {
          projectId: PROJECT_ID,
          examinedSessionCount: 2,
          includedSessionCount: 2,
          excludedSessionCount: 0,
          baseUnits: 3,
          llmAddonUnits: 2,
          toolAddonUnits: 2,
          totalUnits: 7,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          examinedSessionCount: 2,
          includedSessionCount: 2,
          excludedSessionCount: 0,
          baseUnits: 3,
          llmAddonUnits: 2,
          toolAddonUnits: 2,
          totalUnits: 7,
        },
      ],
    });

    const secondSession = preview?.sessions.find((session) => session.sessionId === 'sess-second');
    expect(secondSession).toMatchObject({
      llmCallCount: 2,
      toolCallCount: 2,
      metricsSource: 'message_fallback',
      baseUnits: 2,
      llmAddonUnits: 1,
      toolAddonUnits: 2,
      totalUnits: 5,
    });

    const newestSession = preview?.sessions.find((session) => session.sessionId === 'sess-newest');
    expect(newestSession).toMatchObject({
      llmCallCount: 1,
      toolCallCount: 0,
      metricsSource: 'message_fallback',
      baseUnits: 1,
      llmAddonUnits: 1,
      toolAddonUnits: 0,
      totalUnits: 2,
    });
  });
});
