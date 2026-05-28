import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockPeekSessionService = vi.fn();
const mockGetSessionService = vi.fn();

vi.mock('../../services/session/session-service.js', () => ({
  peekSessionService: mockPeekSessionService,
  getSessionService: mockGetSessionService,
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function createHydratedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    agentName: 'EntryAgent',
    irSourceHash: '',
    compilationHash: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['EntryAgent'],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    initialized: true,
    tenantId: 'tenant-A',
    projectId: 'proj-1',
    createdAt: Date.parse('2026-04-22T10:00:00.000Z'),
    lastActivityAt: Date.parse('2026-04-22T10:00:05.000Z'),
    threads: [
      {
        agentName: 'EntryAgent',
        irSourceHash: '',
        conversationHistory: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        startedAt: Date.parse('2026-04-22T10:00:00.000Z'),
        returnExpected: false,
        status: 'active',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    agentIR: null,
    compilationOutput: null,
    ...overrides,
  };
}

describe('session list live overlay helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('countSharedSessionMessages falls back to conversationHistory when threads are absent', async () => {
    const { countSharedSessionMessages } = await import('../session-list-live-overlay.js');
    const session = createHydratedSession({
      conversationHistory: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      threads: [],
    });

    expect(countSharedSessionMessages(session as any)).toBe(3);
  });

  test('buildSharedRuntimeSessionSnapshot returns null when required ownership scope is missing', async () => {
    const { buildSharedRuntimeSessionSnapshot } = await import('../session-list-live-overlay.js');
    const session = createHydratedSession({
      tenantId: undefined,
    });

    expect(buildSharedRuntimeSessionSnapshot(session as any)).toBeNull();
  });

  test('buildSharedRuntimeSessionSnapshot derives entry agent, active agent, timestamps, and thread count', async () => {
    const { buildSharedRuntimeSessionSnapshot } = await import('../session-list-live-overlay.js');
    const session = createHydratedSession({
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
        activeAgent: { name: 'StateActiveAgent', mode: 'chat' },
      },
      threads: [
        {
          agentName: 'EntryAgent',
          irSourceHash: '',
          conversationHistory: [{ role: 'user', content: 'u1' }],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          startedAt: Date.parse('2026-04-22T10:00:00.000Z'),
          returnExpected: false,
          status: 'completed',
        },
        {
          agentName: 'ThreadActiveAgent',
          irSourceHash: '',
          conversationHistory: [
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
          ],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          startedAt: Date.parse('2026-04-22T10:00:03.000Z'),
          returnExpected: false,
          status: 'active',
        },
      ],
      activeThreadIndex: 1,
    });

    expect(buildSharedRuntimeSessionSnapshot(session as any)).toEqual({
      agentName: 'EntryAgent',
      messageCount: 3,
      createdAt: '2026-04-22T10:00:00.000Z',
      createdAtMs: Date.parse('2026-04-22T10:00:00.000Z'),
      lastActivityAt: '2026-04-22T10:00:05.000Z',
      lastActivityAtMs: Date.parse('2026-04-22T10:00:05.000Z'),
      activeAgent: 'ThreadActiveAgent',
      threadCount: 2,
    });
  });

  test('buildSharedRuntimeSessionSnapshot falls back to state active agent and session agent name when thread data is absent', async () => {
    const { buildSharedRuntimeSessionSnapshot } = await import('../session-list-live-overlay.js');

    const stateFallbackSession = createHydratedSession({
      conversationHistory: [{ role: 'user', content: 'hello' }],
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
        activeAgent: { name: 'StateActiveAgent', mode: 'chat' },
      },
      threads: [],
      activeThreadIndex: 3,
    });

    expect(buildSharedRuntimeSessionSnapshot(stateFallbackSession as any)).toMatchObject({
      agentName: 'EntryAgent',
      activeAgent: 'StateActiveAgent',
      messageCount: 1,
      threadCount: 0,
    });

    const sessionFallback = createHydratedSession({
      conversationHistory: [{ role: 'user', content: 'hello' }],
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      },
      threads: [],
      activeThreadIndex: 2,
    });

    expect(buildSharedRuntimeSessionSnapshot(sessionFallback as any)).toMatchObject({
      agentName: 'EntryAgent',
      activeAgent: 'EntryAgent',
      messageCount: 1,
      threadCount: 0,
    });
  });

  test('loadSharedRuntimeSessionMap returns empty when the shared session service is absent or not distributed', async () => {
    const { loadSharedRuntimeSessionMap } = await import('../session-list-live-overlay.js');

    mockPeekSessionService.mockReturnValue(null);
    await expect(
      loadSharedRuntimeSessionMap({
        sessionIds: ['sess-1'],
        tenantId: 'tenant-A',
        projectId: 'proj-1',
      }),
    ).resolves.toEqual(new Map());

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(false),
    });
    await expect(
      loadSharedRuntimeSessionMap({
        sessionIds: ['sess-1'],
        tenantId: 'tenant-A',
        projectId: 'proj-1',
      }),
    ).resolves.toEqual(new Map());

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(true),
      loadSessionMetadataScoped: vi.fn(),
    });
    await expect(
      loadSharedRuntimeSessionMap({
        sessionIds: [],
        tenantId: 'tenant-A',
        projectId: 'proj-1',
      }),
    ).resolves.toEqual(new Map());
  });

  test('loadSharedRuntimeSessionMap filters null snapshots and continues after lookup errors', async () => {
    const { loadSharedRuntimeSessionMap } = await import('../session-list-live-overlay.js');
    const loadSessionMetadataScoped = vi
      .fn()
      .mockResolvedValueOnce(createHydratedSession())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createHydratedSession({ tenantId: undefined }))
      .mockRejectedValueOnce(new Error('redis miss'));

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(true),
      loadSessionMetadataScoped,
    });

    const result = await loadSharedRuntimeSessionMap({
      sessionIds: ['sess-1', 'sess-2', 'sess-3', 'sess-4'],
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });

    expect([...result.entries()]).toEqual([
      [
        'sess-1',
        {
          agentName: 'EntryAgent',
          messageCount: 2,
          createdAt: '2026-04-22T10:00:00.000Z',
          createdAtMs: Date.parse('2026-04-22T10:00:00.000Z'),
          lastActivityAt: '2026-04-22T10:00:05.000Z',
          lastActivityAtMs: Date.parse('2026-04-22T10:00:05.000Z'),
          activeAgent: 'EntryAgent',
          threadCount: 1,
        },
      ],
    ]);
    expect(loadSessionMetadataScoped).toHaveBeenCalledTimes(4);
  });

  test('loadSharedRuntimeSessionMap drops invalid locators before attempting shared-store reads', async () => {
    const { loadSharedRuntimeSessionMap } = await import('../session-list-live-overlay.js');
    const loadSessionMetadataScoped = vi.fn();

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(true),
      loadSessionMetadataScoped,
    });

    const result = await loadSharedRuntimeSessionMap({
      sessionIds: ['sess-1'],
      tenantId: '',
      projectId: 'proj-1',
    });

    expect(result).toEqual(new Map());
    expect(loadSessionMetadataScoped).not.toHaveBeenCalled();
  });

  test('loadSharedRuntimeSessionMap tolerates non-Error rejections from the shared store client', async () => {
    const { loadSharedRuntimeSessionMap } = await import('../session-list-live-overlay.js');
    const loadSessionMetadataScoped = vi.fn().mockRejectedValue('boom');

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(true),
      loadSessionMetadataScoped,
    });

    await expect(
      loadSharedRuntimeSessionMap({
        sessionIds: ['sess-1'],
        tenantId: 'tenant-A',
        projectId: 'proj-1',
      }),
    ).resolves.toEqual(new Map());
  });

  test('loadSharedRuntimeSessionMap scales with the provided page of session ids only', async () => {
    const { loadSharedRuntimeSessionMap } = await import('../session-list-live-overlay.js');
    const sessionIds = Array.from({ length: 200 }, (_, index) => `sess-${index + 1}`);
    const loadSessionMetadataScoped = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      createHydratedSession({ id: sessionId }),
    );

    mockPeekSessionService.mockReturnValue({
      isDistributed: vi.fn().mockReturnValue(true),
      loadSessionMetadataScoped,
    });

    const result = await loadSharedRuntimeSessionMap({
      sessionIds,
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });

    expect(result.size).toBe(200);
    expect(loadSessionMetadataScoped).toHaveBeenCalledTimes(200);
    expect(loadSessionMetadataScoped).toHaveBeenNthCalledWith(1, {
      kind: 'production',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    expect(loadSessionMetadataScoped).toHaveBeenLastCalledWith({
      kind: 'production',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      sessionId: 'sess-200',
    });
  });
});
