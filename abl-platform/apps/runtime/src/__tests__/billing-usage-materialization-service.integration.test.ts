import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BillingMaterializationBatch,
  BillingMaterializationSessionResult,
  Message,
  Session,
  Subscription,
} from '@agent-platform/database/models';
import type { EventBus } from '../services/event-bus/types.js';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsageMaterializationService } from '../services/billing/billing-usage-materialization-service.js';
import { BillingUsagePreviewService } from '../services/billing/billing-usage-preview-service.js';

const TENANT_ID = 'tenant-billing-materialization';
const PROJECT_ID = 'project-billing-materialization';

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
    currentAgent: 'BillingMaterializerAgent',
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

function createMockEventBus(emit: ReturnType<typeof vi.fn>): EventBus {
  return {
    emit,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

describe('BillingUsageMaterializationService', () => {
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

  it('creates a billing materialization batch and emits a truthful aggregate event', async () => {
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

    const emit = vi.fn();
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
    const service = new BillingUsageMaterializationService({
      previewService,
      eventBus: createMockEventBus(emit),
      now: () => new Date('2026-03-30T11:05:00.000Z'),
      eventIdFactory: () => 'evt-billing-materialized-1',
    });

    const materialization = await service.createMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
      triggeredBy: 'admin-user-1',
    });

    expect(materialization).not.toBeNull();
    expect(materialization).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      status: 'completed',
      triggerSource: 'manual',
      triggeredBy: 'admin-user-1',
      resultCount: 2,
      eventId: 'evt-billing-materialized-1',
      eventDispatchAttempted: true,
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
        projectBreakdown: [
          {
            projectId: PROJECT_ID,
            examinedSessionCount: 2,
            includedSessionCount: 1,
            excludedSessionCount: 1,
            baseUnits: 3,
            llmAddonUnits: 3,
            toolAddonUnits: 2,
            totalUnits: 8,
          },
        ],
        channelBreakdown: [
          {
            channel: 'api',
            examinedSessionCount: 1,
            includedSessionCount: 1,
            excludedSessionCount: 0,
            baseUnits: 3,
            llmAddonUnits: 3,
            toolAddonUnits: 2,
            totalUnits: 8,
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
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'billing.usage.updated',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: materialization?.batchId,
        agentName: 'billing-materializer',
        channel: 'billing',
        payload: expect.objectContaining({
          batchId: materialization?.batchId,
          triggerSource: 'manual',
          projectId: PROJECT_ID,
          projectScope: 'project',
          materializationBasis: 'time_window',
          examinedSessionCount: 2,
          includedSessionCount: 1,
          excludedSessionCount: 1,
          baseUnits: 3,
          llmAddonUnits: 3,
          toolAddonUnits: 2,
          totalUnits: 8,
          projectBreakdown: [
            {
              projectId: PROJECT_ID,
              examinedSessionCount: 2,
              includedSessionCount: 1,
              excludedSessionCount: 1,
              baseUnits: 3,
              llmAddonUnits: 3,
              toolAddonUnits: 2,
              totalUnits: 8,
            },
          ],
          channelBreakdown: [
            {
              channel: 'api',
              examinedSessionCount: 1,
              includedSessionCount: 1,
              excludedSessionCount: 0,
              baseUnits: 3,
              llmAddonUnits: 3,
              toolAddonUnits: 2,
              totalUnits: 8,
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
        }),
      }),
    );

    const persistedBatches = await BillingMaterializationBatch.find({ tenantId: TENANT_ID })
      .lean()
      .exec();

    expect(persistedBatches).toHaveLength(1);
    expect(persistedBatches[0]).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      status: 'completed',
      eventId: 'evt-billing-materialized-1',
      eventDispatchAttempted: true,
      summary: {
        projectBreakdown: [
          {
            projectId: PROJECT_ID,
            examinedSessionCount: 2,
            includedSessionCount: 1,
            excludedSessionCount: 1,
            totalUnits: 8,
          },
        ],
        channelBreakdown: [
          {
            channel: 'api',
            includedSessionCount: 1,
            totalUnits: 8,
          },
          {
            channel: 'web_debug',
            excludedSessionCount: 1,
            totalUnits: 0,
          },
        ],
      },
    });

    const persistedResults = await BillingMaterializationSessionResult.find({
      tenantId: TENANT_ID,
      batchId: materialization?.batchId,
    })
      .sort({ sequence: 1 })
      .lean()
      .exec();

    expect(persistedResults).toHaveLength(2);
    const billableResult = persistedResults.find((result) => result.sessionId === 'sess-billable');
    const debugResult = persistedResults.find((result) => result.sessionId === 'sess-debug');

    expect(billableResult).toMatchObject({
      subscriptionId: materialization?.subscriptionId,
      sessionId: 'sess-billable',
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      included: true,
      totalUnits: 8,
    });
    expect(debugResult).toMatchObject({
      sessionId: 'sess-debug',
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      included: false,
      exclusionReasons: ['excluded_channel:web_debug'],
      totalUnits: 0,
    });

    const resultsPage = await service.getMaterializationResults({
      tenantId: TENANT_ID,
      batchId: materialization!.batchId,
      page: 1,
      limit: 1,
    });

    expect(resultsPage).toMatchObject({
      batchId: materialization?.batchId,
      page: {
        page: 1,
        limit: 1,
        total: 2,
        hasMore: true,
      },
    });
    expect(resultsPage?.sessions[0]).toMatchObject({
      sessionId: 'sess-debug',
      triggerSource: 'manual',
      materializationBasis: 'time_window',
      exclusionReasons: ['excluded_channel:web_debug'],
      totalUnits: 0,
    });
  });

  it('materializes using the shared derivation rules for proactive exclusions and zero-duration sessions', async () => {
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
      now: () => new Date('2026-03-30T13:00:00.000Z'),
    });
    const emit = vi.fn();
    const service = new BillingUsageMaterializationService({
      previewService,
      eventBus: createMockEventBus(emit),
      now: () => new Date('2026-03-30T13:05:00.000Z'),
      eventIdFactory: () => 'evt-billing-materialized-zero-duration',
    });

    const materialization = await service.createMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      windowStart: new Date('2026-03-30T12:00:00.000Z'),
      windowEnd: new Date('2026-03-30T13:00:00.000Z'),
      triggeredBy: 'admin-user-3',
    });

    expect(materialization).not.toBeNull();
    expect(materialization).toMatchObject({
      summary: {
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
      },
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          baseUnits: 0,
          llmAddonUnits: 1,
          toolAddonUnits: 0,
          totalUnits: 1,
        }),
      }),
    );

    const persistedResults = await BillingMaterializationSessionResult.find({
      tenantId: TENANT_ID,
      batchId: materialization?.batchId,
    })
      .sort({ sequence: 1 })
      .lean()
      .exec();

    expect(persistedResults).toHaveLength(2);
    expect(
      persistedResults.find((result) => result.sessionId === 'sess-proactive-idle'),
    ).toMatchObject({
      included: false,
      exclusionReasons: ['proactive_below_interaction_threshold'],
      baseUnits: 0,
      totalUnits: 0,
    });
    expect(
      persistedResults.find((result) => result.sessionId === 'sess-zero-duration'),
    ).toMatchObject({
      included: true,
      durationSeconds: 0,
      baseUnits: 0,
      llmAddonUnits: 1,
      toolAddonUnits: 0,
      totalUnits: 1,
    });
  });

  it('lists and reads persisted materialization batches', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 2,
        timeWindowMinutes: null,
      },
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
    const service = new BillingUsageMaterializationService({
      previewService,
      eventBus: createMockEventBus(vi.fn()),
      now: () => new Date('2026-03-30T11:05:00.000Z'),
      eventIdFactory: () => 'evt-billing-materialized-2',
    });

    const materialization = await service.createMaterialization({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      endedBefore: new Date('2026-03-30T10:40:00.000Z'),
      triggeredBy: 'admin-user-2',
    });

    expect(materialization).not.toBeNull();

    const listed = await service.listMaterializations({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      limit: 10,
    });

    expect(listed.batches).toHaveLength(1);
    expect(listed.batches[0]).toMatchObject({
      batchId: materialization?.batchId,
      triggeredBy: 'admin-user-2',
      resultCount: 2,
      scope: {
        basis: 'completed_sessions',
        endedBefore: '2026-03-30T10:40:00.000Z',
        completedSessionsCount: 2,
      },
    });

    const fetched = await service.getMaterialization({
      tenantId: TENANT_ID,
      batchId: materialization!.batchId,
    });

    expect(fetched).toMatchObject({
      batchId: materialization?.batchId,
      eventId: 'evt-billing-materialized-2',
      summary: {
        examinedSessionCount: 2,
      },
    });
  });
});
