import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Message, Session, Subscription } from '@agent-platform/database/models';
import { BillingSessionAssessmentService } from '../services/billing/billing-session-assessment-service.js';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';

const TENANT_ID = 'tenant-billing-update';
const PROJECT_ID = 'project-billing-update';

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

async function seedActiveSubscription(overrides: Record<string, unknown> = {}): Promise<void> {
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
  context?: Record<string, unknown>;
  isTest?: boolean;
}): Promise<void> {
  const startedAt = new Date(params.startedAt);
  const endedAt = new Date(params.endedAt);
  await Session.create({
    _id: params.sessionId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    currentAgent: 'BillingAgent',
    environment: 'production',
    channel: params.channel,
    status: params.status,
    disposition: params.disposition,
    metadata: params.metadata ?? {},
    context: params.context ?? {},
    isTest: params.isTest ?? false,
    startedAt,
    lastActivityAt: endedAt,
    endedAt,
  });
}

describe('BillingSessionAssessmentService', () => {
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

  it('derives a compare-only assessment for a billable ended session', async () => {
    await seedActiveSubscription();
    await seedEndedSession({
      sessionId: 'sess-billable-close',
      channel: 'api',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:16:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-1',
        sessionId: 'sess-billable-close',
        role: 'user',
        timestamp: '2026-03-30T10:01:00.000Z',
      }),
      messageDoc({
        id: 'msg-2',
        sessionId: 'sess-billable-close',
        role: 'assistant',
        timestamp: '2026-03-30T10:02:00.000Z',
      }),
      messageDoc({
        id: 'msg-3',
        sessionId: 'sess-billable-close',
        role: 'user',
        timestamp: '2026-03-30T10:12:00.000Z',
      }),
      messageDoc({
        id: 'msg-4',
        sessionId: 'sess-billable-close',
        role: 'assistant',
        timestamp: '2026-03-30T10:13:00.000Z',
      }),
      messageDoc({
        id: 'msg-5',
        sessionId: 'sess-billable-close',
        role: 'tool',
        timestamp: '2026-03-30T10:14:00.000Z',
      }),
    ]);

    const service = new BillingSessionAssessmentService({
      clickHouseClientFactory: () =>
        ({
          query: async () => ({
            json: async () => [
              {
                sessionId: 'sess-billable-close',
                llmCallCount: '3',
                toolCallCount: '2',
              },
            ],
          }),
        }) as unknown as import('@clickhouse/client').ClickHouseClient,
    });

    const result = await service.assessEndedSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: 'sess-billable-close',
    });

    expect(result.skipped).toBe(false);
    expect(result.assessment).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: 'sess-billable-close',
      agentName: 'BillingAgent',
      channel: 'api',
      policyMaterializationBasis: 'time_window',
      metricsSource: 'clickhouse',
      included: true,
      exclusionReasons: [],
      interactionType: 'unknown',
      durationSeconds: 960,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 2,
      totalUnits: 7,
      interaction: {
        userMessageCount: 2,
        interactiveTurnCount: 2,
        engagedSeconds: 780,
      },
      usage: {
        llmCallCount: 3,
        toolCallCount: 2,
      },
    });
  });

  it('falls back to message history and records exclusion reasons for non-billable sessions', async () => {
    await seedActiveSubscription();
    await seedEndedSession({
      sessionId: 'sess-debug-close',
      channel: 'web_debug',
      status: 'completed',
      disposition: 'completed',
      startedAt: '2026-03-30T11:00:00.000Z',
      endedAt: '2026-03-30T11:05:00.000Z',
    });

    await Message.collection.insertMany([
      messageDoc({
        id: 'msg-debug-1',
        sessionId: 'sess-debug-close',
        role: 'user',
        timestamp: '2026-03-30T11:01:00.000Z',
      }),
      messageDoc({
        id: 'msg-debug-2',
        sessionId: 'sess-debug-close',
        role: 'assistant',
        timestamp: '2026-03-30T11:02:00.000Z',
      }),
      messageDoc({
        id: 'msg-debug-3',
        sessionId: 'sess-debug-close',
        role: 'tool',
        timestamp: '2026-03-30T11:03:00.000Z',
      }),
    ]);

    const service = new BillingSessionAssessmentService({
      clickHouseClientFactory: () =>
        ({
          query: async () => {
            throw new Error('ClickHouse unavailable');
          },
        }) as unknown as import('@clickhouse/client').ClickHouseClient,
    });

    const result = await service.assessEndedSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: 'sess-debug-close',
    });

    expect(result.skipped).toBe(false);
    expect(result.assessment).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: 'sess-debug-close',
      policyMaterializationBasis: 'time_window',
      metricsSource: 'message_fallback',
      included: false,
      exclusionReasons: ['excluded_channel:web_debug'],
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
      totalUnits: 0,
      usage: {
        llmCallCount: 1,
        toolCallCount: 1,
      },
    });
  });
});
