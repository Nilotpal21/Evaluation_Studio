import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Redis from 'ioredis';
import { AgentTransferConfigSchema } from '@agent-platform/agent-transfer';
import type {
  AnyPlatformEvent,
  EventBus,
  PlatformEvent,
  SessionEndedPayload,
} from '../services/event-bus/types.js';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import agentTransferSessionsRouter from '../routes/agent-transfer-sessions.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../services/event-bus/runtime-bus-accessor.js';
import {
  getTransferSessionStore,
  initializeAgentTransfer,
  shutdownAgentTransfer,
} from '../services/agent-transfer/index.js';
import {
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;

function makeCollectorBus(events: AnyPlatformEvent[]): EventBus {
  return {
    emit(event) {
      events.push(event);
    },
    subscribe() {
      /* no-op */
    },
    unsubscribe() {
      /* no-op */
    },
    async shutdown() {
      /* no-op */
    },
  };
}

describe('Agent Transfer Session Terminalization Integration', () => {
  let harness: RuntimeApiHarness | undefined;
  let redisHarness: RedisServerHarness | undefined;
  let redisClient: Redis | undefined;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    redisHarness = await startRedisServerHarness();
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/v1/agent-transfer/sessions', agentTransferSessionsRouter);
      },
      {
        SESSION_TERMINALIZATION_ENABLED: 'true',
      },
    );

    redisClient = new Redis(redisHarness.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: null,
    });
    await redisClient.connect();
    await initializeAgentTransfer(redisClient, AgentTransferConfigSchema.parse({}));
  }, 90_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await redisHarness.clear();
    await setSuperAdmins([]);
    capturedEvents = [];
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(makeCollectorBus(capturedEvents));

    const { Session } = await import('@agent-platform/database/models');
    await Session.deleteMany({});
  });

  afterEach(() => {
    setRuntimeEventBus(previousBus);
  });

  afterAll(async () => {
    await shutdownAgentTransfer();
    if (redisClient) {
      await redisClient.quit().catch(async () => {
        redisClient?.disconnect();
      });
    }
    await redisHarness?.close();
    await harness?.close();
  }, 60_000);

  test('POST /:id/end terminalizes the parent conversation and persists transfer wrap-up metadata', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('at-terminalize-int'),
      uniqueSlug('at-terminalize-int-tenant'),
      uniqueSlug('at-terminalize-int-project'),
    );

    const { Session } = await import('@agent-platform/database/models');
    await Session.create({
      _id: 'conversation-session-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      currentAgent: 'Support_Agent',
      channel: 'web_chat',
      environment: 'dev',
      status: 'active',
      messageCount: 3,
      startedAt: new Date('2026-03-30T09:45:00.000Z'),
      lastActivityAt: new Date('2026-03-30T09:58:00.000Z'),
    });

    const store = getTransferSessionStore();
    expect(store).not.toBeNull();
    const created = await store!.create({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId: 'contact-1',
      channel: 'chat',
      provider: 'kore',
      providerSessionId: 'provider-session-1',
      ownerPod: 'integration-test',
      metadata: {
        postAgentAction: 'end',
        conversationSessionId: 'conversation-session-1',
      },
    });

    expect(created.success).toBe(true);
    expect(created.sessionKey).toBeTruthy();

    const response = await requestJson<{ success: boolean; data: null }>(
      harness,
      `/api/v1/agent-transfer/sessions/${encodeURIComponent(created.sessionKey!)}/end`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(admin.token),
          'X-Project-Id': admin.projectId,
        },
        body: {
          reason: 'completed',
          dispositionCode: 'resolved',
          wrapUpNotes: 'Customer confirmed the fix.',
          metadata: {
            surveyCompleted: true,
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const updated = await Session.findOne({
      _id: 'conversation-session-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
    }).lean();

    expect(updated?.status).toBe('completed');
    expect(updated?.disposition).toBe('completed');
    expect(updated?.dispositionCode).toBe('resolved');
    expect(updated?.metadata?.transferEnd).toMatchObject({
      source: 'transfer_end',
      disposition: 'completed',
      reason: 'completed',
      dispositionCode: 'resolved',
      wrapUpNotes: 'Customer confirmed the fix.',
      details: {
        surveyCompleted: true,
      },
    });

    const endedTransferSession = await store!.get(created.sessionKey!);
    expect(endedTransferSession).toBeNull();

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(1);
    expect(sessionEndedEvents[0]).toMatchObject({
      type: 'session.ended',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: 'conversation-session-1',
      payload: {
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'transfer_end',
      },
    });
  });
});
