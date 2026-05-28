import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type {
  AnyPlatformEvent,
  EventBus,
  PlatformEvent,
  SessionEndedPayload,
} from '../services/event-bus/types.js';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../services/event-bus/runtime-bus-accessor.js';
import { compileToResolvedAgent, getRuntimeExecutor } from '../services/runtime-executor.js';
import {
  runSessionTimeoutSweepPass,
  stopSessionTimeoutSweepJob,
} from '../services/session-timeout-sweep-job.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;

const SIMPLE_AGENT_DSL = `AGENT: CleanupAgent

GOAL: "Handle cleanup tests"

PERSONA: "Reliable assistant"
`;

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

async function runTimeoutSweepOnce(): Promise<void> {
  await runSessionTimeoutSweepPass();
}

describe('Session Cleanup Terminalization Integration', () => {
  let harness: RuntimeApiHarness;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    stopSessionTimeoutSweepJob();
    process.env.SESSION_TERMINALIZATION_ENABLED = 'true';

    capturedEvents = [];
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(makeCollectorBus(capturedEvents));

    const { ProjectSettings, Session } = await import('@agent-platform/database/models');
    await Promise.all([ProjectSettings.deleteMany({}), Session.deleteMany({})]);
  });

  afterEach(() => {
    stopSessionTimeoutSweepJob();
    delete process.env.SESSION_TERMINALIZATION_ENABLED;
    setRuntimeEventBus(previousBus);
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  test('cleanup terminalizes timeout and unengaged sessions through the shared service', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cleanup-int-terminalize'),
      uniqueSlug('cleanup-int-tenant-terminalize'),
      uniqueSlug('cleanup-int-project-terminalize'),
    );

    const executor = getRuntimeExecutor();
    const timeoutSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'CleanupAgent'),
      {
        sessionId: 'cleanup-timeout-session',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelType: 'api',
      },
    );
    const unengagedSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'CleanupAgent'),
      {
        sessionId: 'cleanup-unengaged-session',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelType: 'api',
      },
    );

    expect(timeoutSession.id).toBe('cleanup-timeout-session');
    expect(unengagedSession.id).toBe('cleanup-unengaged-session');

    const { Session } = await import('@agent-platform/database/models');
    const oldStartedAt = new Date('2026-03-30T07:00:00.000Z');
    const oldLastActivityAt = new Date('2026-03-30T08:00:00.000Z');
    timeoutSession.createdAt = oldStartedAt;
    timeoutSession.lastActivityAt = oldLastActivityAt;
    unengagedSession.createdAt = oldStartedAt;
    unengagedSession.lastActivityAt = oldLastActivityAt;

    await Session.create([
      {
        _id: timeoutSession.id,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        currentAgent: 'CleanupAgent',
        channel: 'api',
        environment: 'dev',
        status: 'active',
        messageCount: 3,
        startedAt: oldStartedAt,
        lastActivityAt: oldLastActivityAt,
      },
      {
        _id: unengagedSession.id,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        currentAgent: 'CleanupAgent',
        channel: 'api',
        environment: 'dev',
        status: 'active',
        messageCount: 0,
        startedAt: oldStartedAt,
        lastActivityAt: oldLastActivityAt,
      },
    ]);

    await runTimeoutSweepOnce();

    const [updatedTimeout, updatedUnengaged] = await Promise.all([
      Session.findOne({
        _id: timeoutSession.id,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
      }).lean(),
      Session.findOne({
        _id: unengagedSession.id,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
      }).lean(),
    ]);

    expect(updatedTimeout?.status).toBe('abandoned');
    expect(updatedTimeout?.disposition).toBe('timeout');
    expect(updatedTimeout?.endedAt).toBeInstanceOf(Date);
    expect(updatedUnengaged?.status).toBe('abandoned');
    expect(updatedUnengaged?.disposition).toBe('unengaged');
    expect(updatedUnengaged?.endedAt).toBeInstanceOf(Date);

    expect(getRuntimeExecutor().getSession(timeoutSession.id)).toBeUndefined();
    expect(getRuntimeExecutor().getSession(unengagedSession.id)).toBeUndefined();

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(2);
    expect(sessionEndedEvents.map((event) => event.payload.disposition).sort()).toEqual([
      'timeout',
      'unengaged',
    ]);
    expect(sessionEndedEvents.every((event) => event.payload.terminalSource === 'cleanup')).toBe(
      true,
    );
  });

  test('cleanup honors project runtime overrides when tenant defaults would keep the session active', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cleanup-int-project-override'),
      uniqueSlug('cleanup-int-tenant-project-override'),
      uniqueSlug('cleanup-int-project-project-override'),
    );

    const { ProjectSettings, Session } = await import('@agent-platform/database/models');
    await ProjectSettings.findOneAndUpdate(
      { tenantId: admin.tenantId, projectId: admin.projectId },
      {
        $set: {
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          sessionLifecycle: {
            runtime: {
              idleSeconds: 1,
              maxAgeSeconds: 60,
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();

    const runtimeSession = getRuntimeExecutor().createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'CleanupAgent'),
      {
        sessionId: 'cleanup-project-override-session',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelType: 'api',
      },
    );
    runtimeSession.createdAt = new Date('2026-03-30T09:00:00.000Z');
    runtimeSession.lastActivityAt = new Date(Date.now() - 5_000);

    await Session.create({
      _id: runtimeSession.id,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      currentAgent: 'CleanupAgent',
      channel: 'api',
      environment: 'dev',
      status: 'active',
      messageCount: 2,
      startedAt: new Date('2026-03-30T09:00:00.000Z'),
      lastActivityAt: new Date(Date.now() - 5_000),
    });

    await runTimeoutSweepOnce();

    const updated = await Session.findOne({
      _id: runtimeSession.id,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
    }).lean();

    expect(updated?.status).toBe('abandoned');
    expect(updated?.disposition).toBe('timeout');
    expect(getRuntimeExecutor().getSession(runtimeSession.id)).toBeUndefined();

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(1);
    expect(sessionEndedEvents[0]).toMatchObject({
      type: 'session.ended',
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: runtimeSession.id,
      payload: {
        disposition: 'timeout',
        status: 'abandoned',
        terminalSource: 'cleanup',
      },
    });
  });

  test('cleanup falls back for legacy active sessions that have no projectId', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('cleanup-int-legacy-no-project'),
      uniqueSlug('cleanup-int-tenant-legacy-no-project'),
      uniqueSlug('cleanup-int-project-legacy-no-project'),
    );

    const runtimeSession = getRuntimeExecutor().createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'CleanupAgent'),
      {
        sessionId: 'cleanup-legacy-no-project-session',
        tenantId: admin.tenantId,
        channelType: 'api',
      },
    );

    const oldStartedAt = new Date('2026-03-30T06:00:00.000Z');
    const oldLastActivityAt = new Date('2026-03-30T06:15:00.000Z');
    runtimeSession.createdAt = oldStartedAt;
    runtimeSession.lastActivityAt = oldLastActivityAt;

    const { Session } = await import('@agent-platform/database/models');
    await Session.collection.insertOne({
      _id: runtimeSession.id,
      tenantId: admin.tenantId,
      currentAgent: 'CleanupAgent',
      channel: 'api',
      environment: 'dev',
      status: 'active',
      messageCount: 2,
      startedAt: oldStartedAt,
      lastActivityAt: oldLastActivityAt,
    } as any);

    await runTimeoutSweepOnce();

    const updated = await Session.collection.findOne({ _id: runtimeSession.id });

    expect(updated?.status).toBe('ended');
    expect(updated?.disposition).toBe('timeout');
    expect(updated?.endedAt).toBeInstanceOf(Date);
    expect(getRuntimeExecutor().getSession(runtimeSession.id)).toBeUndefined();
  });
});
