import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  requireTenantAuthMock,
  requireProjectAccessMock,
  acquireTurnLockMock,
  releaseTurnLockMock,
  getRedisClientMock,
  transitionSessionToIdleMock,
  validateArchFileRefsReadyMock,
  sessionServiceMock,
} = vi.hoisted(() => ({
  requireTenantAuthMock: vi.fn(),
  requireProjectAccessMock: vi.fn(),
  acquireTurnLockMock: vi.fn(),
  releaseTurnLockMock: vi.fn(),
  getRedisClientMock: vi.fn(),
  transitionSessionToIdleMock: vi.fn(),
  validateArchFileRefsReadyMock: vi.fn(),
  sessionServiceMock: {
    getById: vi.fn(),
    transitionState: vi.fn(),
    transitionStateAndClearPendingInteraction: vi.fn(),
    resumeFromInteractiveTool: vi.fn(),
    setPendingInteraction: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => requireTenantAuthMock(...args),
  isAuthError: () => false,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  isAccessError: () => false,
}));

vi.mock('@agent-platform/arch-ai/session', () => ({
  acquireTurnLock: (...args: unknown[]) => acquireTurnLockMock(...args),
  releaseTurnLock: (...args: unknown[]) => releaseTurnLockMock(...args),
  startRenewalLoop: () => () => undefined,
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  fileStoreService: {},
  sessionService: sessionServiceMock,
}));

vi.mock('@/lib/arch-ai/helpers/session-helpers', () => ({
  isAbortError: () => false,
  isTimeoutAbort: () => false,
  createAbortSignal: () => ({ signal: new AbortController().signal, timeoutId: null }),
  transitionSessionToIdle: (...args: unknown[]) => transitionSessionToIdleMock(...args),
  closeAndResetIfActive: vi.fn(),
}));

vi.mock('@/lib/arch-ai/processors/process-message', () => ({
  processMessage: vi.fn(),
}));

vi.mock('@/lib/arch-ai/processors/process-in-project', () => ({
  processInProjectMessage: vi.fn(),
}));

vi.mock('@/lib/arch-ai/stream-observer', () => ({
  createObservedArchStream: () => ({
    emit: vi.fn(),
    close: vi.fn(),
    fail: vi.fn(),
  }),
}));

vi.mock('@/lib/arch-ai/sse-stream', () => ({
  createSSEStream: () => ({
    stream: new ReadableStream(),
    emit: vi.fn(),
    emitRaw: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('@/lib/arch-audit-pipeline-writer', () => ({
  getStudioArchAuditPipelineWriter: vi.fn(),
}));

vi.mock('@/lib/arch-ai/attachment-readiness', () => ({
  validateArchFileRefsReady: (...args: unknown[]) => validateArchFileRefsReadyMock(...args),
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:5173/api/arch-ai/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeBuildSession() {
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      projectId: null,
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-build-complete-1',
        payload: { widgetType: 'BuildComplete' },
        createdAt: '2026-05-12T00:00:00.000Z',
      },
    },
  };
}

describe('POST /api/arch-ai/message lock ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireTenantAuthMock.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: [],
    });
    sessionServiceMock.getById.mockResolvedValue(makeBuildSession());
    sessionServiceMock.transitionState.mockResolvedValue(makeBuildSession());
    transitionSessionToIdleMock.mockResolvedValue(undefined);
    validateArchFileRefsReadyMock.mockResolvedValue({ ok: true });
    getRedisClientMock.mockReturnValue({ set: vi.fn(), get: vi.fn(), pttl: vi.fn() });
    acquireTurnLockMock.mockResolvedValue({ acquired: false });
  });

  it('does not clear pendingInteraction when tool_answer loses the turn lock', async () => {
    const { POST } = await import('@/app/api/arch-ai/message/route');

    const response = await POST(
      makeRequest({
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-build-complete-1',
        answer: 'create',
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ code: 'SESSION_BUSY' }],
    });
    expect(sessionServiceMock.transitionState).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1', permissions: [] },
      'session-1',
      'IDLE',
      'ACTIVE',
    );
    expect(transitionSessionToIdleMock).toHaveBeenCalledWith(
      sessionServiceMock,
      { tenantId: 'tenant-1', userId: 'user-1', permissions: [] },
      'session-1',
      'lock_contention',
    );
    expect(sessionServiceMock.resumeFromInteractiveTool).not.toHaveBeenCalled();
    expect(sessionServiceMock.setPendingInteraction).not.toHaveBeenCalled();
  });

  it('recovers an ACTIVE session with no pending widget when its turn lock is gone', async () => {
    const staleActiveSession = {
      ...makeBuildSession(),
      state: 'ACTIVE',
      metadata: {
        ...makeBuildSession().metadata,
        pendingInteraction: null,
      },
    };
    const recoveredIdleSession = {
      ...staleActiveSession,
      state: 'IDLE',
    };
    const redis = { set: vi.fn(), get: vi.fn(), pttl: vi.fn().mockResolvedValue(-2) };
    getRedisClientMock.mockReturnValue(redis);
    sessionServiceMock.getById
      .mockResolvedValueOnce(staleActiveSession)
      .mockResolvedValueOnce(recoveredIdleSession);
    sessionServiceMock.transitionState.mockResolvedValue(recoveredIdleSession);

    const { POST } = await import('@/app/api/arch-ai/message/route');

    const response = await POST(
      makeRequest({
        sessionId: 'session-1',
        type: 'message',
        text: 'continue',
      }),
    );

    expect(redis.pttl).toHaveBeenCalledWith('arch:session:session-1:turn_lock');
    expect(transitionSessionToIdleMock).toHaveBeenCalledWith(
      sessionServiceMock,
      { tenantId: 'tenant-1', userId: 'user-1', permissions: [] },
      'session-1',
      'stale_active_without_turn_lock',
    );
    expect(sessionServiceMock.transitionState).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1', permissions: [] },
      'session-1',
      'IDLE',
      'ACTIVE',
    );
    expect(response.status).toBe(409);
  });
});
