import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type {
  AnyPlatformEvent,
  EventBus,
  PlatformEvent,
  SessionEndedPayload,
} from '../services/event-bus/types.js';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import sessionsRouter from '../routes/sessions.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../services/event-bus/runtime-bus-accessor.js';
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

describe('Session Terminalization Integration', () => {
  let harness: RuntimeApiHarness;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
      },
      {
        SESSION_TERMINALIZATION_ENABLED: 'true',
      },
    );
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
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
    await harness.close();
  }, 30_000);

  test('POST /:id/close updates the stored session and emits one canonical event', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('terminalize-int-close'),
      uniqueSlug('terminalize-int-tenant-close'),
      uniqueSlug('terminalize-int-project-close'),
    );

    const { Session } = await import('@agent-platform/database/models');
    await Session.create({
      _id: 'session-close-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      currentAgent: 'Booking_Agent',
      channel: 'web_chat',
      environment: 'dev',
      status: 'active',
      messageCount: 3,
      startedAt: new Date('2026-03-30T09:00:00.000Z'),
      lastActivityAt: new Date('2026-03-30T09:10:00.000Z'),
    });

    const response = await requestJson<{
      success: boolean;
      message: string;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/session-close-1/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'completed' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

    const updated = await Session.findOne({
      _id: 'session-close-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
    }).lean();
    expect(updated?.status).toBe('completed');
    expect(updated?.disposition).toBe('completed');
    expect(updated?.endedAt).toBeInstanceOf(Date);

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(1);
    expect(sessionEndedEvents[0]).toMatchObject({
      type: 'session.ended',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: 'session-close-1',
      agentName: 'Booking_Agent',
      channel: 'web_chat',
      payload: {
        reason: 'completed',
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'close_api',
        turnCount: 3,
        agentsUsed: ['Booking_Agent'],
      },
    });
  });

  test('POST /:id/close is idempotent for already terminal stored sessions', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('terminalize-int-close-idempotent'),
      uniqueSlug('terminalize-int-tenant-close-idempotent'),
      uniqueSlug('terminalize-int-project-close-idempotent'),
    );

    const { Session } = await import('@agent-platform/database/models');
    await Session.create({
      _id: 'session-close-idempotent-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      currentAgent: 'Booking_Agent',
      channel: 'web_chat',
      environment: 'dev',
      status: 'active',
      messageCount: 3,
      startedAt: new Date('2026-03-30T09:00:00.000Z'),
      lastActivityAt: new Date('2026-03-30T09:10:00.000Z'),
    });

    const firstResponse = await requestJson<{
      success: boolean;
      message: string;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/session-close-idempotent-1/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'completed' },
    });

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

    const firstStored = await Session.findOne({
      _id: 'session-close-idempotent-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
    }).lean();
    expect(firstStored?.endedAt).toBeInstanceOf(Date);

    const secondResponse = await requestJson<{
      success: boolean;
      message: string;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/session-close-idempotent-1/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'timeout' },
    });

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

    const updated = await Session.findOne({
      _id: 'session-close-idempotent-1',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
    }).lean();
    expect(updated?.status).toBe('completed');
    expect(updated?.disposition).toBe('completed');
    expect(updated?.endedAt?.toISOString()).toBe(firstStored?.endedAt?.toISOString());

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(1);
    expect(sessionEndedEvents[0]).toMatchObject({
      type: 'session.ended',
      sessionId: 'session-close-idempotent-1',
      payload: {
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'close_api',
      },
    });
  });

  test('POST /bulk-close updates only matching project sessions and emits one event per closed session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('terminalize-int-bulk'),
      uniqueSlug('terminalize-int-tenant-bulk'),
      uniqueSlug('terminalize-int-project-bulk'),
    );

    const { Session } = await import('@agent-platform/database/models');
    await Session.create([
      {
        _id: 'bulk-session-1',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        currentAgent: 'Booking_Agent',
        channel: 'web_chat',
        environment: 'dev',
        status: 'active',
        messageCount: 2,
        startedAt: new Date('2026-03-30T09:00:00.000Z'),
        lastActivityAt: new Date('2026-03-30T09:05:00.000Z'),
      },
      {
        _id: 'bulk-session-2',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        currentAgent: 'Booking_Agent',
        channel: 'web_chat',
        environment: 'dev',
        status: 'active',
        messageCount: 1,
        startedAt: new Date('2026-03-30T09:15:00.000Z'),
        lastActivityAt: new Date('2026-03-30T09:18:00.000Z'),
      },
      {
        _id: 'bulk-session-3',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        currentAgent: 'Other_Agent',
        channel: 'web_chat',
        environment: 'dev',
        status: 'active',
        messageCount: 5,
        startedAt: new Date('2026-03-30T09:20:00.000Z'),
        lastActivityAt: new Date('2026-03-30T09:25:00.000Z'),
      },
    ]);

    const response = await requestJson<{
      success: boolean;
      closedRuntime: number;
      closedDb: number;
    }>(harness, `/api/projects/${admin.projectId}/sessions/bulk-close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { agentName: 'Booking', disposition: 'timeout' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      closedRuntime: 0,
      closedDb: 2,
    });

    const [session1, session2, session3] = await Promise.all([
      Session.findOne({
        _id: 'bulk-session-1',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
      }).lean(),
      Session.findOne({
        _id: 'bulk-session-2',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
      }).lean(),
      Session.findOne({
        _id: 'bulk-session-3',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
      }).lean(),
    ]);

    expect(session1?.status).toBe('abandoned');
    expect(session1?.disposition).toBe('timeout');
    expect(session2?.status).toBe('abandoned');
    expect(session2?.disposition).toBe('timeout');
    expect(session3?.status).toBe('active');
    expect(session3?.disposition).toBeNull();

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(2);
    expect(sessionEndedEvents.map((event) => event.sessionId).sort()).toEqual([
      'bulk-session-1',
      'bulk-session-2',
    ]);
    expect(sessionEndedEvents.every((event) => event.payload.terminalSource === 'bulk_close')).toBe(
      true,
    );
  });
});
