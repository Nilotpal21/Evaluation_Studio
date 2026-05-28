import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BillingMaterializationBatch,
  BillingMaterializationCheckpoint,
  BillingMaterializationSessionResult,
  Message,
  Session,
  Subscription,
} from '@agent-platform/database/models';
import type { EventBus } from '../services/event-bus/types.js';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import { BillingUsageMaterializationPlannerService } from '../services/billing/billing-usage-materialization-planner-service.js';
import { BillingUsageMaterializationSchedulerService } from '../services/billing/billing-usage-materialization-scheduler-service.js';
import { BillingUsageMaterializationService } from '../services/billing/billing-usage-materialization-service.js';
import { BillingUsagePreviewService } from '../services/billing/billing-usage-preview-service.js';

const TENANT_ID = 'tenant-billing-materialization-scheduler';
const PROJECT_ALPHA = 'project-billing-alpha';
const PROJECT_BETA = 'project-billing-beta';

function messageDoc(params: {
  id: string;
  sessionId: string;
  projectId: string;
  role: 'user' | 'assistant' | 'tool';
  timestamp: string;
  channel?: string;
}): Record<string, unknown> {
  const timestamp = new Date(params.timestamp);
  return {
    _id: params.id,
    sessionId: params.sessionId,
    tenantId: TENANT_ID,
    projectId: params.projectId,
    role: params.role,
    content: `${params.role} message`,
    channel: params.channel ?? 'api',
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
  projectId: string;
  channel: string;
  status?: string;
  disposition?: string | null;
  startedAt: string;
  endedAt: string;
}): Promise<void> {
  const startedAt = new Date(params.startedAt);
  const endedAt = new Date(params.endedAt);
  await Session.create({
    _id: params.sessionId,
    tenantId: TENANT_ID,
    projectId: params.projectId,
    currentAgent: 'BillingSchedulerAgent',
    environment: 'production',
    channel: params.channel,
    status: params.status ?? 'completed',
    disposition: params.disposition ?? 'completed',
    metadata: {},
    isTest: false,
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

describe('BillingUsageMaterializationSchedulerService', () => {
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

  it('materializes due tenant batches, emits scheduled aggregate events, and advances the checkpoint only after success', async () => {
    await seedActiveSubscription({
      excludedChannels: ['web_debug'],
      materialization: {
        basis: 'completed_sessions',
        timeWindowMinutes: null,
        completedSessionsCount: 2,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-api',
      projectId: PROJECT_ALPHA,
      channel: 'api',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:31:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-debug',
      projectId: PROJECT_BETA,
      channel: 'web_debug',
      startedAt: '2026-03-30T10:35:00.000Z',
      endedAt: '2026-03-30T10:40:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-a1',
        sessionId: 'sess-api',
        projectId: PROJECT_ALPHA,
        role: 'user',
        timestamp: '2026-03-30T10:01:00.000Z',
      }),
      messageDoc({
        id: 'msg-a2',
        sessionId: 'sess-api',
        projectId: PROJECT_ALPHA,
        role: 'assistant',
        timestamp: '2026-03-30T10:02:00.000Z',
      }),
      messageDoc({
        id: 'msg-a3',
        sessionId: 'sess-api',
        projectId: PROJECT_ALPHA,
        role: 'user',
        timestamp: '2026-03-30T10:20:00.000Z',
      }),
      messageDoc({
        id: 'msg-a4',
        sessionId: 'sess-api',
        projectId: PROJECT_ALPHA,
        role: 'assistant',
        timestamp: '2026-03-30T10:21:00.000Z',
      }),
      messageDoc({
        id: 'msg-d1',
        sessionId: 'sess-debug',
        projectId: PROJECT_BETA,
        role: 'user',
        timestamp: '2026-03-30T10:35:30.000Z',
        channel: 'web_debug',
      }),
      messageDoc({
        id: 'msg-d2',
        sessionId: 'sess-debug',
        projectId: PROJECT_BETA,
        role: 'assistant',
        timestamp: '2026-03-30T10:36:00.000Z',
        channel: 'web_debug',
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
              ['sess-api', { llmCallCount: 3, toolCallCount: 1 }],
              ['sess-debug', { llmCallCount: 1, toolCallCount: 0 }],
            ]),
          };
        },
      },
      now: () => new Date('2026-03-30T11:00:00.000Z'),
    });
    const materializationService = new BillingUsageMaterializationService({
      previewService,
      eventBus: createMockEventBus(emit),
      now: () => new Date('2026-03-30T11:05:00.000Z'),
      eventIdFactory: () => 'evt-billing-materialized-scheduled-1',
    });
    const plannerService = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T11:05:00.000Z'),
    });
    const schedulerService = new BillingUsageMaterializationSchedulerService({
      plannerService,
      materializationService,
      now: () => new Date('2026-03-30T11:06:00.000Z'),
      tenantBatchSize: 10,
    });

    const result = await schedulerService.runDueMaterializations();

    expect(result).toMatchObject({
      scannedTenantCount: 1,
      skippedTenantCount: 0,
      dueTenantCount: 1,
      materializedBatchCount: 1,
      failedTenantCount: 0,
      batches: [
        {
          tenantId: TENANT_ID,
          projectId: null,
          basis: 'completed_sessions',
        },
      ],
    });

    const batch = await BillingMaterializationBatch.findOne({
      tenantId: TENANT_ID,
      triggerSource: 'scheduled',
    })
      .lean()
      .exec();

    expect(batch).toMatchObject({
      tenantId: TENANT_ID,
      projectId: null,
      triggerSource: 'scheduled',
      status: 'completed',
      summary: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 3,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 7,
        projectBreakdown: [
          {
            projectId: PROJECT_ALPHA,
            includedSessionCount: 1,
            totalUnits: 7,
          },
          {
            projectId: PROJECT_BETA,
            excludedSessionCount: 1,
            totalUnits: 0,
          },
        ],
        channelBreakdown: [
          {
            channel: 'api',
            includedSessionCount: 1,
            totalUnits: 7,
          },
          {
            channel: 'web_debug',
            excludedSessionCount: 1,
            totalUnits: 0,
          },
        ],
      },
    });

    const checkpoint = await BillingMaterializationCheckpoint.findOne({
      tenantId: TENANT_ID,
      projectId: null,
      basis: 'completed_sessions',
    })
      .lean()
      .exec();

    expect(checkpoint).toMatchObject({
      tenantId: TENANT_ID,
      projectId: null,
      basis: 'completed_sessions',
      lastBatchId: batch?._id,
    });
    expect(checkpoint?.cursor.lastEndedAt?.toISOString()).toBe('2026-03-30T10:40:00.000Z');
    expect(checkpoint?.cursor.lastSessionId).toBe('sess-debug');

    const persistedResults = await BillingMaterializationSessionResult.find({
      tenantId: TENANT_ID,
      batchId: batch?._id,
    })
      .sort({ sequence: 1 })
      .lean()
      .exec();

    expect(persistedResults).toHaveLength(2);
    expect(persistedResults[0]).toMatchObject({
      triggerSource: 'scheduled',
      materializationBasis: 'completed_sessions',
      sessionId: 'sess-api',
      included: true,
      totalUnits: 7,
    });
    expect(persistedResults[1]).toMatchObject({
      triggerSource: 'scheduled',
      materializationBasis: 'completed_sessions',
      sessionId: 'sess-debug',
      included: false,
      totalUnits: 0,
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'billing.usage.updated',
        tenantId: TENANT_ID,
        payload: expect.objectContaining({
          triggerSource: 'scheduled',
          projectScope: 'tenant',
          materializationBasis: 'completed_sessions',
          projectBreakdown: [
            expect.objectContaining({
              projectId: PROJECT_ALPHA,
              totalUnits: 7,
            }),
            expect.objectContaining({
              projectId: PROJECT_BETA,
              totalUnits: 0,
            }),
          ],
          channelBreakdown: [
            expect.objectContaining({
              channel: 'api',
              totalUnits: 7,
            }),
            expect.objectContaining({
              channel: 'web_debug',
              totalUnits: 0,
            }),
          ],
        }),
      }),
    );
  });

  it('does not advance the scheduler checkpoint when materialization fails', async () => {
    await seedActiveSubscription({
      materialization: {
        basis: 'completed_sessions',
        timeWindowMinutes: null,
        completedSessionsCount: 2,
      },
    });

    await seedEndedSession({
      sessionId: 'sess-1',
      projectId: PROJECT_ALPHA,
      channel: 'api',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:05:00.000Z',
    });
    await seedEndedSession({
      sessionId: 'sess-2',
      projectId: PROJECT_ALPHA,
      channel: 'api',
      startedAt: '2026-03-30T10:06:00.000Z',
      endedAt: '2026-03-30T10:10:00.000Z',
    });

    const plannerService = new BillingUsageMaterializationPlannerService({
      now: () => new Date('2026-03-30T11:00:00.000Z'),
    });
    const materializationService = {
      createMaterialization: vi.fn(async () => {
        throw new Error('materialization exploded');
      }),
    };
    const schedulerService = new BillingUsageMaterializationSchedulerService({
      plannerService,
      materializationService,
      now: () => new Date('2026-03-30T11:06:00.000Z'),
      tenantBatchSize: 10,
    });

    const result = await schedulerService.runDueMaterializations();

    expect(result).toMatchObject({
      scannedTenantCount: 1,
      dueTenantCount: 1,
      materializedBatchCount: 0,
      failedTenantCount: 1,
    });
    expect(result.failures[0]).toMatchObject({
      tenantId: TENANT_ID,
      projectId: null,
      error: 'materialization exploded',
    });

    const checkpoint = await BillingMaterializationCheckpoint.findOne({
      tenantId: TENANT_ID,
      projectId: null,
      basis: 'completed_sessions',
    })
      .lean()
      .exec();

    expect(checkpoint).toBeNull();
    expect(materializationService.createMaterialization).toHaveBeenCalledOnce();
  });
});
