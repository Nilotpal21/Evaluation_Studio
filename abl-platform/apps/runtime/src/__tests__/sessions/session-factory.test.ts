/**
 * Session Factory Tests
 *
 * Verifies that SessionFactory correctly delegates to the RuntimeExecutor
 * and SessionService, and that the singleton lifecycle (getSessionFactory /
 * resetSessionFactory) behaves as expected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const { mockExecutor, mockSessionService, mockLoadConfigVariablesMap } = vi.hoisted(() => ({
  mockExecutor: {
    createSessionFromResolved: vi.fn(),
    registerAgent: vi.fn(),
    getSession: vi.fn(),
  },
  mockSessionService: {
    loadSession: vi.fn(),
    loadSessionScoped: vi.fn(),
  },
  mockLoadConfigVariablesMap: vi.fn(async () => ({})),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => mockExecutor),
  compileToResolvedAgent: vi.fn((dsls: string[], entry: string) => ({
    agents: { [entry]: { metadata: { name: entry } } },
    entryAgent: entry,
    compilationOutput: {},
    sourceHash: 'working-copy',
    versionInfo: { versions: {} },
  })),
  resolveProjectTools: vi.fn(async () => new Map()),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => mockSessionService),
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: mockLoadConfigVariablesMap,
}));

// ---------------------------------------------------------------------------
// Import the actual module under test (after mocks are wired)
// ---------------------------------------------------------------------------

import {
  SessionFactory,
  getSessionFactory,
  resetSessionFactory,
} from '../../services/session/session-factory.js';

import { compileToResolvedAgent, resolveProjectTools } from '../../services/runtime-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SINGLE_DSL = 'AGENT greeting_agent\n  PROMPT: "Hello!"';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionFactory', () => {
  let factory: SessionFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionFactory();
    factory = new SessionFactory();
    mockLoadConfigVariablesMap.mockResolvedValue({});

    // Default return values
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'new-session',
      agentName: 'greeting_agent',
      data: {
        values: {},
        gatheredKeys: new Set<string>(),
      },
    });
  });

  // -----------------------------------------------------------------------
  // createFromDSLs
  // -----------------------------------------------------------------------

  describe('createFromDSLs', () => {
    it('forwards the channel option as channelType', async () => {
      await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        channel: 'web-sdk',
      });

      const resolvedArg = (compileToResolvedAgent as ReturnType<typeof vi.fn>).mock.results[0]
        .value;
      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(resolvedArg, {
        channelType: 'web-sdk',
        tenantId: undefined,
        projectId: undefined,
      });
    });

    it('resolves tools and passes them to compileToResolvedAgent when tenantId and projectId are provided', async () => {
      const fakeTools = new Map([['greeting_agent', [{ name: 'my_tool' }]]]);
      (resolveProjectTools as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeTools);

      await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        tenantId: 'tenant-1',
        projectId: 'project-1',
      });

      expect(resolveProjectTools).toHaveBeenCalledWith('tenant-1', 'project-1', [SINGLE_DSL]);
      expect(compileToResolvedAgent).toHaveBeenCalledWith(
        [SINGLE_DSL],
        'greeting_agent',
        undefined,
        fakeTools,
      );
    });

    it('loads project config variables and stores the localization catalog when tenantId and projectId are provided', async () => {
      mockLoadConfigVariablesMap.mockResolvedValueOnce({
        'locale:fr/_shared.json': JSON.stringify({
          conversation_complete: 'Conversation terminee.',
        }),
      });

      const session = await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        tenantId: 'tenant-1',
        projectId: 'project-1',
      });

      expect(mockLoadConfigVariablesMap).toHaveBeenCalledWith('project-1', 'tenant-1');
      expect(compileToResolvedAgent).toHaveBeenCalledWith(
        [SINGLE_DSL],
        'greeting_agent',
        {
          'locale:fr/_shared.json': JSON.stringify({
            conversation_complete: 'Conversation terminee.',
          }),
        },
        expect.any(Map),
      );
      expect(
        (
          (
            session.data.values.session as {
              _localizedMessageCatalog?: { locales?: Record<string, unknown> };
            }
          )?._localizedMessageCatalog as {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          }
        ).locales?.fr?.shared?.conversation_complete,
      ).toBe('Conversation terminee.');
    });

    it('materializes a missing runtime session data store before attaching localization', async () => {
      mockLoadConfigVariablesMap.mockResolvedValueOnce({
        'locale:de/_shared.json': JSON.stringify({
          conversation_complete: 'Unterhaltung abgeschlossen.',
        }),
      });
      mockExecutor.createSessionFromResolved.mockReturnValueOnce({
        id: 'session-without-data',
        agentName: 'greeting_agent',
        data: undefined,
      });

      const session = await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        tenantId: 'tenant-1',
        projectId: 'project-1',
      });

      expect(session.data.gatheredKeys).toBeInstanceOf(Set);
      expect(
        (
          (
            session.data.values.session as {
              _localizedMessageCatalog?: { locales?: Record<string, unknown> };
            }
          )?._localizedMessageCatalog as {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          }
        ).locales?.de?.shared?.conversation_complete,
      ).toBe('Unterhaltung abgeschlossen.');
    });

    it('skips tool resolution when tenantId is missing', async () => {
      (resolveProjectTools as ReturnType<typeof vi.fn>).mockClear();

      await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        projectId: 'project-1',
      });

      expect(resolveProjectTools).not.toHaveBeenCalled();
      expect(compileToResolvedAgent).toHaveBeenCalledWith(
        [SINGLE_DSL],
        'greeting_agent',
        undefined,
        undefined,
      );
    });

    it('skips tool resolution when projectId is missing', async () => {
      (resolveProjectTools as ReturnType<typeof vi.fn>).mockClear();

      await factory.createFromDSLs([SINGLE_DSL], 'greeting_agent', {
        tenantId: 'tenant-1',
      });

      expect(resolveProjectTools).not.toHaveBeenCalled();
      expect(compileToResolvedAgent).toHaveBeenCalledWith(
        [SINGLE_DSL],
        'greeting_agent',
        undefined,
        undefined,
      );
    });
  });

  describe('resumeSession', () => {
    it('uses unscoped session loading when passed a session id', async () => {
      mockSessionService.loadSession.mockResolvedValueOnce({ id: 'resume-session' });

      const result = await factory.resumeSession('resume-session');

      expect(result).toEqual({ id: 'resume-session' });
      expect(mockSessionService.loadSession).toHaveBeenCalledWith('resume-session');
      expect(mockSessionService.loadSessionScoped).not.toHaveBeenCalled();
    });

    it('uses scoped session loading when passed a session locator', async () => {
      const locator = {
        kind: 'production' as const,
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'resume-session',
      };
      mockSessionService.loadSessionScoped.mockResolvedValueOnce({ id: 'resume-session' });

      const result = await factory.resumeSession(locator);

      expect(result).toEqual({ id: 'resume-session' });
      expect(mockSessionService.loadSessionScoped).toHaveBeenCalledWith(locator);
      expect(mockSessionService.loadSession).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

describe('getSessionFactory / resetSessionFactory', () => {
  beforeEach(() => {
    resetSessionFactory();
  });

  it('returns a SessionFactory instance', () => {
    const instance = getSessionFactory();
    expect(instance).toBeInstanceOf(SessionFactory);
  });

  it('returns the same instance on consecutive calls', () => {
    const first = getSessionFactory();
    const second = getSessionFactory();
    expect(first).toBe(second);
  });

  it('returns a new instance after resetSessionFactory', () => {
    const first = getSessionFactory();
    resetSessionFactory();
    const second = getSessionFactory();

    expect(second).toBeInstanceOf(SessionFactory);
    expect(second).not.toBe(first);
  });

  it('resetSessionFactory is idempotent', () => {
    resetSessionFactory();
    resetSessionFactory(); // should not throw
    const instance = getSessionFactory();
    expect(instance).toBeInstanceOf(SessionFactory);
  });
});
