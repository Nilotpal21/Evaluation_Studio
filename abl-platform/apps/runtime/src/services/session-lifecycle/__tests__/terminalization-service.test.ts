import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyPlatformEvent, EventBus } from '../../event-bus/types.js';
import {
  SessionTerminalizationService,
  type StoredSessionTerminalizationRecord,
} from '../terminalization-service.js';

const FIXED_NOW = new Date('2026-03-30T10:00:00.000Z');

function makeStoredSession(
  overrides: Partial<StoredSessionTerminalizationRecord> = {},
): StoredSessionTerminalizationRecord {
  return {
    id: 'db-session-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    currentAgent: 'Booking_Agent',
    channel: 'web_chat',
    status: 'active',
    disposition: null,
    startedAt: new Date('2026-03-30T09:45:00.000Z'),
    lastActivityAt: new Date('2026-03-30T09:59:00.000Z'),
    endedAt: null,
    messageCount: 4,
    runtimeSessionId: 'runtime-session-1',
    ...overrides,
  };
}

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

describe('SessionTerminalizationService', () => {
  const getSession = vi.fn();
  const endSession = vi.fn();
  const finalizeSession = vi.fn();
  const removeSession = vi.fn();
  const findSessionById = vi.fn();
  const findSessionByRuntimeId = vi.fn();
  const updateSession = vi.fn();
  const releaseSessionSlot = vi.fn().mockResolvedValue(undefined);
  const resolveEndHook = vi.fn();
  const runEndHook = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockReturnValue(undefined);
    findSessionById.mockResolvedValue(null);
    findSessionByRuntimeId.mockResolvedValue(null);
    updateSession.mockResolvedValue(null);
    resolveEndHook.mockResolvedValue({});
    runEndHook.mockResolvedValue({
      attempted: true,
      mode: 'ignore',
      outcome: 'ignored',
    });
  });

  it('updates the stored session and emits a canonical session.ended event', async () => {
    const events: AnyPlatformEvent[] = [];
    const storedSession = makeStoredSession();
    findSessionById.mockResolvedValue(storedSession);
    updateSession.mockResolvedValue({
      ...storedSession,
      status: 'completed',
      disposition: 'completed',
      endedAt: FIXED_NOW,
      lastActivityAt: FIXED_NOW,
    });

    const service = new SessionTerminalizationService({
      getRuntimeExecutor: () => ({
        getSession,
        endSession,
      }),
      getTraceStore: () => ({
        finalizeSession,
        removeSession,
      }),
      findSessionById,
      findSessionByRuntimeId,
      updateSession,
      getEventBus: () => makeCollectorBus(events),
      releaseSessionSlot,
      resolveEndHook,
      runEndHook,
      createEventId: () => 'evt-1',
      now: () => FIXED_NOW,
    });

    const result = await service.terminateConversationSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-session-1',
      disposition: 'completed',
      source: 'close_api',
    });

    expect(result).toEqual({
      sessionId: 'db-session-1',
      disposition: 'completed',
      status: 'completed',
      endedAt: FIXED_NOW.toISOString(),
      eventEmitted: true,
      eventId: 'evt-1',
      hook: {
        attempted: true,
        mode: 'ignore',
        outcome: 'ignored',
      },
      runtimeEnded: false,
      dbUpdated: true,
      artifactSessionIds: ['runtime-session-1'],
    });
    expect(updateSession).toHaveBeenCalledWith(
      'db-session-1',
      {
        status: 'completed',
        disposition: 'completed',
        endedAt: FIXED_NOW,
        lastActivityAt: FIXED_NOW,
      },
      'tenant-1',
    );
    expect(releaseSessionSlot).toHaveBeenCalledWith('tenant-1', 'db-session-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt-1',
      type: 'session.ended',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-session-1',
      agentName: 'Booking_Agent',
      channel: 'web_chat',
      payload: {
        reason: 'completed',
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'close_api',
        durationMs: 900000,
        turnCount: 4,
        agentsUsed: ['Booking_Agent'],
      },
    });
    expect(resolveEndHook).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channel: 'web_chat',
    });
    expect(runEndHook).toHaveBeenCalledWith({
      config: { mode: 'ignore' },
      sessionId: 'db-session-1',
      channel: 'web_chat',
      disposition: 'completed',
      source: 'close_api',
      sendResponse: undefined,
    });
  });

  it('persists transfer end metadata on the durable session record during transfer terminalization', async () => {
    const events: AnyPlatformEvent[] = [];
    const storedSession = makeStoredSession();
    findSessionById.mockResolvedValue(storedSession);
    updateSession.mockResolvedValue({
      ...storedSession,
      status: 'completed',
      disposition: 'completed',
      dispositionCode: 'resolved',
      metadata: {
        transferEnd: {
          source: 'transfer_end',
          disposition: 'completed',
          endedAt: FIXED_NOW.toISOString(),
          reason: 'agent_completed',
          dispositionCode: 'resolved',
          wrapUpNotes: 'Customer issue fixed',
          details: {
            surveyCompleted: true,
          },
        },
      },
      endedAt: FIXED_NOW,
      lastActivityAt: FIXED_NOW,
    });

    const service = new SessionTerminalizationService({
      getRuntimeExecutor: () => ({
        getSession,
        endSession,
      }),
      getTraceStore: () => ({
        finalizeSession,
        removeSession,
      }),
      findSessionById,
      findSessionByRuntimeId,
      updateSession,
      getEventBus: () => makeCollectorBus(events),
      releaseSessionSlot,
      resolveEndHook,
      runEndHook,
      createEventId: () => 'evt-transfer-1',
      now: () => FIXED_NOW,
    });

    const result = await service.terminateConversationSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-session-1',
      disposition: 'completed',
      source: 'transfer_end',
      transferMetadata: {
        reason: 'agent_completed',
        metadata: {
          surveyCompleted: true,
        },
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer issue fixed',
      },
    });

    expect(result).toMatchObject({
      sessionId: 'db-session-1',
      disposition: 'completed',
      status: 'completed',
      eventEmitted: true,
      dbUpdated: true,
    });
    expect(updateSession).toHaveBeenCalledWith(
      'db-session-1',
      {
        status: 'completed',
        disposition: 'completed',
        endedAt: FIXED_NOW,
        lastActivityAt: FIXED_NOW,
        dispositionCode: 'resolved',
        'metadata.transferEnd': {
          source: 'transfer_end',
          disposition: 'completed',
          endedAt: FIXED_NOW.toISOString(),
          reason: 'agent_completed',
          dispositionCode: 'resolved',
          wrapUpNotes: 'Customer issue fixed',
          details: {
            surveyCompleted: true,
          },
        },
      },
      'tenant-1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.ended',
      sessionId: 'db-session-1',
      payload: {
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'transfer_end',
      },
    });
  });

  it('ends runtime-only sessions and emits a canonical event without DB writes', async () => {
    const events: AnyPlatformEvent[] = [];
    getSession.mockReturnValue({
      id: 'runtime-session-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'Runtime_Only_Agent',
      channelType: 'api',
      turnCount: 2,
      createdAt: new Date('2026-03-30T09:58:00.000Z'),
      threads: [{ agentName: 'Runtime_Only_Agent' }],
    });

    const service = new SessionTerminalizationService({
      getRuntimeExecutor: () => ({
        getSession,
        endSession,
      }),
      getTraceStore: () => ({
        finalizeSession,
        removeSession,
      }),
      findSessionById,
      findSessionByRuntimeId,
      updateSession,
      getEventBus: () => makeCollectorBus(events),
      releaseSessionSlot,
      resolveEndHook,
      runEndHook,
      createEventId: () => 'evt-2',
      now: () => FIXED_NOW,
    });

    const result = await service.terminateConversationSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'runtime-session-1',
      disposition: 'timeout',
      source: 'bulk_close',
    });

    expect(result).toEqual({
      sessionId: 'runtime-session-1',
      disposition: 'timeout',
      status: 'abandoned',
      endedAt: FIXED_NOW.toISOString(),
      eventEmitted: true,
      eventId: 'evt-2',
      hook: {
        attempted: true,
        mode: 'ignore',
        outcome: 'ignored',
      },
      runtimeEnded: true,
      dbUpdated: false,
      artifactSessionIds: ['runtime-session-1'],
    });
    expect(endSession).toHaveBeenCalledWith('runtime-session-1');
    expect(finalizeSession).toHaveBeenCalledWith('runtime-session-1');
    expect(removeSession).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(releaseSessionSlot).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      sessionId: 'runtime-session-1',
      payload: {
        disposition: 'timeout',
        status: 'abandoned',
        terminalSource: 'bulk_close',
        turnCount: 2,
      },
    });
  });

  it('suppresses duplicate session.ended emission for already terminal stored sessions', async () => {
    const events: AnyPlatformEvent[] = [];
    const existingEndedAt = new Date('2026-03-30T09:30:00.000Z');
    const storedSession = makeStoredSession({
      status: 'abandoned',
      disposition: 'timeout',
      endedAt: existingEndedAt,
    });
    findSessionById.mockResolvedValue(storedSession);

    const service = new SessionTerminalizationService({
      getRuntimeExecutor: () => ({
        getSession,
        endSession,
      }),
      getTraceStore: () => ({
        finalizeSession,
        removeSession,
      }),
      findSessionById,
      findSessionByRuntimeId,
      updateSession,
      getEventBus: () => makeCollectorBus(events),
      releaseSessionSlot,
      resolveEndHook,
      runEndHook,
      now: () => FIXED_NOW,
    });

    const result = await service.terminateConversationSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-session-1',
      disposition: 'completed',
      source: 'close_api',
    });

    expect(result).toEqual({
      sessionId: 'db-session-1',
      disposition: 'timeout',
      status: 'abandoned',
      endedAt: existingEndedAt.toISOString(),
      eventEmitted: false,
      hook: {
        attempted: false,
      },
      runtimeEnded: false,
      dbUpdated: false,
      artifactSessionIds: ['runtime-session-1'],
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(resolveEndHook).not.toHaveBeenCalled();
    expect(runEndHook).not.toHaveBeenCalled();
  });

  it('emits session.ended before running the end hook', async () => {
    const callOrder: string[] = [];
    const storedSession = makeStoredSession();
    findSessionById.mockResolvedValue(storedSession);
    updateSession.mockResolvedValue({
      ...storedSession,
      status: 'completed',
      disposition: 'completed',
      endedAt: FIXED_NOW,
      lastActivityAt: FIXED_NOW,
    });
    resolveEndHook.mockResolvedValue({
      config: { mode: 'respond', message: 'Chat closed.' },
      source: 'project.channel.web_chat',
    });
    runEndHook.mockImplementation(async () => {
      callOrder.push('hook');
      return {
        attempted: true,
        mode: 'respond',
        outcome: 'skipped',
      };
    });

    const service = new SessionTerminalizationService({
      getRuntimeExecutor: () => ({
        getSession,
        endSession,
      }),
      getTraceStore: () => ({
        finalizeSession,
        removeSession,
      }),
      findSessionById,
      findSessionByRuntimeId,
      updateSession,
      getEventBus: () => ({
        emit(event) {
          callOrder.push(event.type);
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
      }),
      releaseSessionSlot,
      resolveEndHook,
      runEndHook,
      now: () => FIXED_NOW,
    });

    const result = await service.terminateConversationSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-session-1',
      disposition: 'completed',
      source: 'close_api',
    });

    expect(result?.hook).toEqual({
      attempted: true,
      mode: 'respond',
      outcome: 'skipped',
    });
    expect(callOrder).toEqual(['session.ended', 'hook']);
  });
});
