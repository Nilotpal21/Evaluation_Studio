/**
 * RuntimeLLMAdapter Tests
 *
 * Tests the LiveKit LLM adapter that bridges to RuntimeExecutor.
 * Covers: initialization, tenant-guarded DSL fetch, DSL cache, chat timeout, dispose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import type { CallerContext } from '@agent-platform/shared-auth';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted above imports)
const {
  mockFindFirst,
  mockProject,
  mockSession,
  mockExecutor,
  mockResolve,
  mockCreateSessionFromResolved,
  mockConvStore,
  mockSessionUpdate,
  mockResolveSessionTimeouts,
  mockFindProjectSettings,
  mockGetTenantConfigAsync,
  mockEvaluateAuthPreflightFromIR,
  mockCreateTokenLookups,
  mockRecordSyntheticTraceEvent,
  mockResolveRequiredContactProductionScope,
  mockHandleDisconnect,
  mockLoadConfigVariablesMap,
} = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockProject = {
    id: 'project-1',
    tenantId: 'tenant-1',
    agents: [
      {
        name: 'greeting-agent',
        dslContent: 'AGENT greeting-agent\nROLE: "A friendly greeter"',
        createdAt: new Date(),
      },
    ],
  };

  const mockSession = {
    id: 'test-session-123',
    agentName: 'test-agent',
    agentIR: {},
    compilationOutput: {},
    conversationHistory: [],
    state: { gatherProgress: {}, context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  const mockExecutor = {
    isConfigured: vi.fn(),
    createSessionFromResolved: vi.fn(),
    executeMessage: vi.fn(),
    getSession: vi.fn(),
    rehydrateSession: vi.fn(),
    endSession: vi.fn(),
  };

  const mockResolve = vi.fn();
  const mockCreateSessionFromResolved = mockExecutor.createSessionFromResolved;

  const mockSessionUpdate = vi.fn().mockResolvedValue({});
  const mockFindProjectSettings = vi.fn().mockResolvedValue(null);
  const mockGetTenantConfigAsync = vi.fn().mockResolvedValue({
    security: {
      sessionIdleSeconds: 300,
      sessionMaxAgeSeconds: 1_200,
    },
  });
  const mockConvStore = {
    createSession: vi.fn().mockResolvedValue({ id: 'db-session-1' }),
  };
  const mockResolveSessionTimeouts = vi.fn().mockResolvedValue({});
  const mockEvaluateAuthPreflightFromIR = vi.fn();
  const mockCreateTokenLookups = vi.fn(() => ({}));
  const mockRecordSyntheticTraceEvent = vi.fn();
  const mockResolveRequiredContactProductionScope = vi.fn();
  const mockHandleDisconnect = vi.fn();
  const mockLoadConfigVariablesMap = vi.fn().mockResolvedValue({});

  return {
    mockFindFirst,
    mockProject,
    mockSession,
    mockExecutor,
    mockResolve,
    mockCreateSessionFromResolved,
    mockConvStore,
    mockSessionUpdate,
    mockResolveSessionTimeouts,
    mockFindProjectSettings,
    mockGetTenantConfigAsync,
    mockEvaluateAuthPreflightFromIR,
    mockCreateTokenLookups,
    mockRecordSyntheticTraceEvent,
    mockResolveRequiredContactProductionScope,
    mockHandleDisconnect,
    mockLoadConfigVariablesMap,
  };
});

vi.mock('../../services/runtime-executor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/runtime-executor.js')>();
  return {
    ...orig,
    getRuntimeExecutor: vi.fn().mockReturnValue(mockExecutor),
  };
});

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectWithAgents: mockFindFirst,
  loadConfigVariablesMap: mockLoadConfigVariablesMap,
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = mockResolve;
  },
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({})),
}));

vi.mock('../../services/session/production-contact-scope.js', () => ({
  resolveRequiredContactProductionScope: (...args: unknown[]) =>
    mockResolveRequiredContactProductionScope(...args),
}));

vi.mock('../../channels/pipeline/session-factory.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../channels/pipeline/session-factory.js')>();
  return {
    ...actual,
    resolveSessionTimeouts: mockResolveSessionTimeouts,
  };
});

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: mockEvaluateAuthPreflightFromIR,
  createTokenLookups: mockCreateTokenLookups,
}));

vi.mock('../../services/channel-trace-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/channel-trace-utils.js')>();
  return {
    ...actual,
    recordSyntheticTraceEvent: mockRecordSyntheticTraceEvent,
  };
});

vi.mock('../../channels/pipeline/lifecycle-manager.js', () => ({
  handleDisconnect: mockHandleDisconnect,
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: mockConvStore,
    message: { addMessage: vi.fn() },
    metrics: { record: vi.fn() },
    contact: {},
    fact: {},
    workflowDefinition: {},
    createAgentRegistry: vi.fn(() => ({})),
  })),
}));

vi.mock('../../repos/session-repo.js', () => ({
  updateSession: mockSessionUpdate,
}));

vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: mockFindProjectSettings,
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: vi.fn(() => ({
    getConfigAsync: mockGetTenantConfigAsync,
  })),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Import modules under test
import {
  RuntimeLLMAdapter,
  _clearDSLCacheForTesting,
} from '../../services/voice/livekit/runtime-llm-adapter.js';

describe('RuntimeLLMAdapter', () => {
  let adapter: RuntimeLLMAdapter;
  const sdkCallerContext: CallerContext = {
    tenantId: 'tenant-1',
    channel: 'voice_livekit',
    channelId: 'channel-voice-1',
    customerId: 'verified-user-1',
    sessionPrincipalId: 'sdk-session-voice-1',
    channelArtifact: 'artifact-hash-voice-1',
    identityTier: 2,
    verificationMethod: 'hmac',
    authScope: 'user',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _clearDSLCacheForTesting();

    // Re-set mock return values after clearAllMocks
    mockFindFirst.mockResolvedValue(mockProject);
    mockFindProjectSettings.mockResolvedValue(null);
    mockGetTenantConfigAsync.mockResolvedValue({
      security: {
        sessionIdleSeconds: 300,
        sessionMaxAgeSeconds: 1_200,
      },
    });
    mockResolveRequiredContactProductionScope.mockImplementation(
      async ({
        tenantId,
        projectId,
        sessionId,
        channelId,
        environment,
        source,
        authType,
        callerContext,
      }: {
        tenantId?: string;
        projectId?: string;
        sessionId?: string;
        channelId?: string;
        environment?: string;
        source: string;
        authType: string;
        callerContext?: CallerContext;
      }) => {
        const resolvedCallerContext: CallerContext = {
          ...(callerContext || {}),
          tenantId: tenantId ?? callerContext?.tenantId ?? 'tenant-1',
          channel: callerContext?.channel ?? 'voice_livekit',
          channelId: channelId ?? callerContext?.channelId ?? 'voice_livekit',
          anonymousId: callerContext?.anonymousId ?? `livekit:${sessionId ?? 'test-session'}`,
          identityTier: callerContext?.identityTier ?? 0,
          verificationMethod: callerContext?.verificationMethod ?? 'none',
          contactId: callerContext?.contactId ?? 'contact-livekit-1',
        };

        return {
          callerContext: resolvedCallerContext,
          scope: {
            kind: 'production' as const,
            tenantId: tenantId ?? 'tenant-1',
            projectId: projectId ?? 'project-1',
            sessionId: sessionId ?? 'test-session',
            channelId: channelId ?? resolvedCallerContext.channelId ?? 'voice_livekit',
            environment: environment ?? 'dev',
            source,
            authType,
            traceId: 'trace-livekit',
            actor: {
              kind: 'contact' as const,
              contactId: resolvedCallerContext.contactId ?? 'contact-livekit-1',
            },
            subject: {
              kind: 'contact' as const,
              contactId: resolvedCallerContext.contactId ?? 'contact-livekit-1',
            },
            identityEvidence: {
              identityTier: resolvedCallerContext.identityTier ?? 0,
              verificationMethod: resolvedCallerContext.verificationMethod ?? 'none',
              artifacts: [],
            },
            callerContext: resolvedCallerContext,
          },
        };
      },
    );
    mockExecutor.isConfigured.mockReturnValue(true);
    mockExecutor.createSessionFromResolved.mockImplementation(
      (
        _resolved: unknown,
        options: { sessionId?: string; scope?: { sessionId?: string } } = {},
      ) => ({
        ...mockSession,
        id: options.scope?.sessionId ?? options.sessionId ?? mockSession.id,
      }),
    );
    mockExecutor.getSession.mockReturnValue(mockSession);
    mockExecutor.rehydrateSession.mockResolvedValue(mockSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Hello! How can I help you?',
      action: { type: 'continue' },
    });
    mockResolveSessionTimeouts.mockResolvedValue({});
    mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
    mockHandleDisconnect.mockResolvedValue(undefined);
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockSession.data = { values: {}, gatheredKeys: new Set() };

    adapter = new RuntimeLLMAdapter({
      sessionId: 'test-session',
      projectId: 'project-1',
      agentName: 'greeting-agent',
      tenantId: 'tenant-1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    it('should create a runtime session from project DSLs', async () => {
      await adapter.initialize();

      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          entryAgent: 'greeting-agent',
          sourceHash: 'working-copy',
        }),
        expect.objectContaining({
          channelType: 'voice_livekit',
          scope: expect.objectContaining({
            kind: 'production',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            sessionId: 'test-session',
            source: 'livekit_voice',
          }),
        }),
      );
    });

    it('stores the localization catalog on legacy-initialized runtime sessions even when data is missing', async () => {
      mockLoadConfigVariablesMap.mockResolvedValueOnce({
        'locale:fr/_shared.json': JSON.stringify({
          empty_input: 'Je vous ecoute.',
        }),
      });
      mockSession.data = undefined as unknown as typeof mockSession.data;

      await adapter.initialize();
      const createdSession = mockCreateSessionFromResolved.mock.results.at(-1)?.value as {
        data: {
          values: {
            session: {
              _localizedMessageCatalog?: {
                locales?: Record<string, { shared?: { empty_input?: string } }>;
              };
            };
          };
        };
      };

      const catalog = (
        createdSession.data.values.session as {
          _localizedMessageCatalog?: {
            locales?: Record<string, { shared?: { empty_input?: string } }>;
          };
        }
      )._localizedMessageCatalog;

      expect(catalog?.locales?.fr?.shared?.empty_input).toBe('Je vous ecoute.');
    });

    it('should use tenant-guarded query (findProjectWithAgents with tenantId)', async () => {
      await adapter.initialize();

      expect(mockFindFirst).toHaveBeenCalledWith('project-1', 'tenant-1');
    });

    it('should throw when tenantId is not provided', async () => {
      const noTenantAdapter = new RuntimeLLMAdapter({
        sessionId: 'test-session',
        projectId: 'project-1',
        agentName: 'greeting-agent',
      });

      await expect(noTenantAdapter.initialize()).rejects.toThrow(/Tenant context required/);

      // Should not have called findProjectWithAgents since the error is thrown before
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('should set the runtime session ID after initialization', async () => {
      expect(adapter.getSessionId()).toBeNull();
      await adapter.initialize();
      expect(adapter.getSessionId()).toBe('test-session');
    });

    it('should be idempotent (no-op on second call)', async () => {
      await adapter.initialize();
      await adapter.initialize();

      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledTimes(1);
    });

    it('should throw when project not found', async () => {
      mockFindFirst.mockResolvedValue(null);

      await expect(adapter.initialize()).rejects.toThrow(/Project not found or access denied/);
    });

    it('should throw when no DSLs in project', async () => {
      mockFindFirst.mockResolvedValue({ ...mockProject, agents: [] });

      await expect(adapter.initialize()).rejects.toThrow(/No agent DSLs found/);
    });

    it('should throw when RuntimeExecutor not configured', async () => {
      mockExecutor.isConfigured.mockReturnValue(false);

      await expect(adapter.initialize()).rejects.toThrow(/RuntimeExecutor not configured/);
    });

    it('should use DSL cache on second adapter for same project', async () => {
      // First adapter initializes and populates cache
      await adapter.initialize();
      expect(mockFindFirst).toHaveBeenCalledTimes(1);

      // Second adapter for same project should use cache
      const adapter2 = new RuntimeLLMAdapter({
        sessionId: 'test-session-2',
        projectId: 'project-1',
        tenantId: 'tenant-1',
      });
      await adapter2.initialize();

      // findFirst should NOT have been called again
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it('passes scoped caller identity into runtime session creation', async () => {
      const identityAwareAdapter = new RuntimeLLMAdapter({
        sessionId: 'voice-session',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        callerContext: sdkCallerContext,
      });

      await identityAwareAdapter.initialize();

      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          channelType: 'voice_livekit',
          scope: expect.objectContaining({
            sessionId: 'voice-session',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            callerContext: expect.objectContaining({
              customerId: 'verified-user-1',
              sessionPrincipalId: 'sdk-session-voice-1',
              channelId: 'channel-voice-1',
            }),
            subject: expect.objectContaining({
              contactId: 'contact-livekit-1',
            }),
          }),
        }),
      );
    });

    it('persists the runtime-selected DSL agent name when the requested voice agent name is stale', async () => {
      mockFindFirst.mockResolvedValue({
        ...mockProject,
        agents: [
          {
            name: 'Eugene',
            dslContent: 'AGENT: BankingVirtualAssistant\nGOAL: "Help callers"',
            createdAt: new Date(),
          },
        ],
      });
      mockExecutor.createSessionFromResolved.mockImplementation(
        (
          _resolved: unknown,
          options: { sessionId?: string; scope?: { sessionId?: string } } = {},
        ) => ({
          ...mockSession,
          id: options.scope?.sessionId ?? options.sessionId ?? mockSession.id,
          agentName: 'Eugene',
          agentIR: {
            metadata: { name: 'BankingVirtualAssistant' },
          },
        }),
      );

      const mismatchAdapter = new RuntimeLLMAdapter({
        sessionId: 'voice-session-mismatch',
        projectId: 'project-1',
        agentName: 'Eugene',
        tenantId: 'tenant-1',
      });

      await mismatchAdapter.initialize();
      await mismatchAdapter.chat('Hello');

      expect(mockConvStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'BankingVirtualAssistant',
        }),
      );
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        'db-session-1',
        expect.objectContaining({
          entryAgentName: 'BankingVirtualAssistant',
        }),
        'tenant-1',
      );
    });

    it('applies tenant-configured session timeouts on the non-deployment path', async () => {
      mockResolveSessionTimeouts.mockResolvedValue({
        sessionMaxAgeSeconds: 600,
        sessionIdleSeconds: 120,
      });

      await adapter.initialize();

      expect(mockResolveSessionTimeouts).toHaveBeenCalledWith('tenant-1', 'project-1', undefined);
      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionMaxAgeSeconds: 600,
          sessionIdleSeconds: 120,
          scope: expect.objectContaining({
            sessionId: 'test-session',
          }),
        }),
      );
    });

    it('persists the runtime-selected DSL agent name on the deployment-resolved path when the requested voice agent name is stale', async () => {
      mockResolve.mockResolvedValue({
        entryAgent: 'Eugene',
        compilationOutput: {
          entry_agent: 'BankingVirtualAssistant',
        },
        agents: {
          BankingVirtualAssistant: {
            metadata: { name: 'BankingVirtualAssistant' },
          },
        },
        versionInfo: {
          versions: { BankingVirtualAssistant: 7 },
          environment: 'production',
        },
      });
      mockExecutor.createSessionFromResolved.mockImplementation(
        (
          _resolved: unknown,
          options: { sessionId?: string; scope?: { sessionId?: string } } = {},
        ) => ({
          ...mockSession,
          id: options.scope?.sessionId ?? options.sessionId ?? mockSession.id,
          agentName: 'Eugene',
          agentIR: {
            metadata: { name: 'BankingVirtualAssistant' },
          },
        }),
      );

      const mismatchAdapter = new RuntimeLLMAdapter({
        sessionId: 'voice-session-deployment-mismatch',
        projectId: 'project-1',
        agentName: 'Eugene',
        tenantId: 'tenant-1',
        deploymentId: 'deployment-1',
      });

      await mismatchAdapter.initialize();
      await mismatchAdapter.chat('Hello');

      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'Eugene',
          deploymentId: 'deployment-1',
        }),
      );
      expect(mockConvStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'BankingVirtualAssistant',
          environment: 'production',
        }),
      );
    });

    it('falls back to the compiled deployment agent when the runtime session agent name is orphaned', async () => {
      mockResolve.mockResolvedValue({
        entryAgent: 'Eugene',
        compilationOutput: {
          entry_agent: 'BankingVirtualAssistant',
        },
        agents: {
          BankingVirtualAssistant: {
            metadata: { name: 'BankingVirtualAssistant' },
          },
        },
        versionInfo: {
          versions: { BankingVirtualAssistant: 7 },
          environment: 'production',
        },
      });
      mockExecutor.createSessionFromResolved.mockImplementation(
        (
          _resolved: unknown,
          options: { sessionId?: string; scope?: { sessionId?: string } } = {},
        ) => ({
          ...mockSession,
          id: options.scope?.sessionId ?? options.sessionId ?? mockSession.id,
          agentName: 'Eugene',
          agentIR: {
            metadata: { name: 'PhantomRuntimeAgent' },
          },
        }),
      );

      const mismatchAdapter = new RuntimeLLMAdapter({
        sessionId: 'voice-session-deployment-orphan',
        projectId: 'project-1',
        agentName: 'Eugene',
        tenantId: 'tenant-1',
        deploymentId: 'deployment-1',
      });

      await mismatchAdapter.initialize();
      await mismatchAdapter.chat('Hello');

      expect(mockConvStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'BankingVirtualAssistant',
        }),
      );
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        'db-session-1',
        expect.objectContaining({
          entryAgentName: 'BankingVirtualAssistant',
        }),
        'tenant-1',
      );
    });
  });

  describe('chat', () => {
    it('resolves localized voice system messages from the runtime session catalog', async () => {
      mockLoadConfigVariablesMap.mockResolvedValueOnce({
        'locale:fr/_shared.json': JSON.stringify({
          voice_error: 'Une erreur vocale est survenue.',
        }),
      });
      mockSession.data = {
        values: {
          _locale: 'fr-CA',
        },
        gatheredKeys: new Set(),
      };

      await adapter.initialize();

      await expect(
        adapter.resolveSystemMessage('voice_error', DEFAULT_MESSAGES.voice_error),
      ).resolves.toBe('Une erreur vocale est survenue.');
    });

    it('should forward user text to RuntimeExecutor.executeMessage', async () => {
      await adapter.initialize();
      const result = await adapter.chat('Hello there');

      expect(mockExecutor.executeMessage).toHaveBeenCalledWith(
        'test-session',
        'Hello there',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(result.text).toBe('Hello! How can I help you?');
      expect(result.sessionId).toBe('test-session');
    });

    it('prefers plain-text voiceConfig for final spoken output', async () => {
      mockExecutor.executeMessage.mockResolvedValueOnce({
        response: 'Hello **bold**',
        voiceConfig: {
          plain_text: 'Hello bold',
        },
        action: { type: 'continue' },
      });

      await adapter.initialize();
      const result = await adapter.chat('Hello there');

      expect(result.text).toBe('Hello bold');
      expect(result.voiceConfig).toMatchObject({
        plain_text: 'Hello bold',
      });
    });

    it('returns canonical responseMetadata for downstream voice persistence', async () => {
      const responseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };
      mockExecutor.executeMessage.mockResolvedValueOnce({
        response: 'Hello there',
        action: { type: 'continue' },
        responseMetadata,
      });

      await adapter.initialize();
      const result = await adapter.chat('Hello there');

      expect(result.responseMetadata).toEqual(responseMetadata);
    });

    it('should auto-initialize if not already initialized', async () => {
      const result = await adapter.chat('Hi');
      expect(result.text).toBe('Hello! How can I help you?');
      expect(adapter.getSessionId()).toBe('test-session');
    });

    it('should pass onChunk callback to executeMessage', async () => {
      await adapter.initialize();
      const onChunk = vi.fn();
      await adapter.chat('Hello', onChunk);

      expect(mockExecutor.executeMessage).toHaveBeenCalledWith(
        'test-session',
        'Hello',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      const forwardedOnChunk = mockExecutor.executeMessage.mock.calls[0][2] as (
        chunk: string,
      ) => void;
      forwardedOnChunk('partial');
      expect(onChunk).toHaveBeenCalledWith('partial');
    });

    it('should timeout if executeMessage takes too long', async () => {
      await adapter.initialize();
      vi.useFakeTimers();

      mockExecutor.executeMessage.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );

      const chatPromise = adapter.chat('Hello');
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await chatPromise;
      vi.useRealTimers();

      expect(result.text).toBe(
        "I'm sorry, I'm taking too long to respond. Please try again in a moment.",
      );
      expect(mockRecordSyntheticTraceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          event: expect.objectContaining({
            data: expect.objectContaining({
              code: 'EXECUTION_TIMEOUT',
            }),
          }),
        }),
      );
    }, 35_000);

    it('streams the auth-required fallback and records a synthetic trace when preflight blocks', async () => {
      await adapter.initialize();
      const onChunk = vi.fn();
      mockEvaluateAuthPreflightFromIR.mockResolvedValue({
        pending: [
          {
            connector: 'google',
            authProfileRef: 'google-creds',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      });

      const result = await adapter.chat('Hello', onChunk);

      expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
      expect(onChunk).toHaveBeenCalledWith(
        "I can't continue until the required authorization has been completed.",
      );
      expect(result.text).toBe(
        "I can't continue until the required authorization has been completed.",
      );
      expect(mockRecordSyntheticTraceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
        }),
      );
    });
  });

  describe('dispose', () => {
    it('should route teardown through shared voice lifecycle cleanup', async () => {
      await adapter.initialize();
      await adapter.dispose();

      expect(mockHandleDisconnect).toHaveBeenCalledWith({
        channel: 'voice',
        sessionId: 'test-session',
        dbSessionId: undefined,
        tenantId: 'tenant-1',
      });
      expect(adapter.getSessionId()).toBeNull();
    });

    it('should handle dispose without initialization gracefully', async () => {
      await expect(adapter.dispose()).resolves.not.toThrow();
    });

    it('should include dbSessionId in shared teardown once a DB session exists', async () => {
      await adapter.initialize();
      await adapter.chat('Hello');
      await adapter.dispose();

      expect(mockHandleDisconnect).toHaveBeenCalledWith({
        channel: 'voice',
        sessionId: 'test-session',
        dbSessionId: 'db-session-1',
        tenantId: 'tenant-1',
      });
    });
  });

  describe('getters', () => {
    it('should track session duration', async () => {
      const duration = adapter.getSessionDurationMs();
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(1000);
    });
  });

  // ===========================================================================
  // DEPLOYMENT-AWARE PATH
  // ===========================================================================

  describe('deployment-aware initialization', () => {
    let deployAdapter: RuntimeLLMAdapter;
    const resolvedResult = {
      entryAgent: 'booking_agent',
      agents: { booking_agent: { name: 'booking_agent' } },
      compilationOutput: {},
      versionInfo: {
        environment: 'production',
        versions: { booking_agent: '1.2.0' },
      },
    };

    const deploymentSession = {
      ...mockSession,
      id: 'deploy-session-1',
      agentName: 'booking_agent',
    };

    beforeEach(() => {
      mockResolve.mockResolvedValue(resolvedResult);
      deploymentSession.data = { values: {}, gatheredKeys: new Set() };
      mockCreateSessionFromResolved.mockImplementation(
        (
          _resolved: unknown,
          options: { sessionId?: string; scope?: { sessionId?: string } } = {},
        ) => ({
          ...deploymentSession,
          id: options.scope?.sessionId ?? options.sessionId ?? deploymentSession.id,
        }),
      );
      mockConvStore.createSession.mockResolvedValue({ id: 'db-session-deploy' });
      mockSessionUpdate.mockResolvedValue({});

      deployAdapter = new RuntimeLLMAdapter({
        sessionId: 'lk-session-deploy',
        projectId: 'project-1',
        agentName: 'booking_agent',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });
    });

    it('should use DeploymentResolver when deploymentId is provided', async () => {
      await deployAdapter.initialize();

      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        agentName: 'booking_agent',
      });
      expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
        resolvedResult,
        expect.objectContaining({
          channelType: 'voice_livekit',
          deploymentId: 'deploy-1',
          scope: expect.objectContaining({
            kind: 'production',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            sessionId: 'lk-session-deploy',
            environment: 'production',
          }),
        }),
      );
    });

    it('stores the localization catalog on deployment-resolved runtime sessions even when data is missing', async () => {
      mockLoadConfigVariablesMap.mockResolvedValueOnce({
        'locale:fr/_shared.json': JSON.stringify({
          conversation_complete: 'Conversation terminee.',
        }),
      });
      deploymentSession.data = undefined as unknown as typeof deploymentSession.data;

      await deployAdapter.initialize();
      const createdSession = mockCreateSessionFromResolved.mock.results.at(-1)?.value as {
        data: {
          values: {
            session: {
              _localizedMessageCatalog?: {
                locales?: Record<string, { shared?: { conversation_complete?: string } }>;
              };
            };
          };
        };
      };

      const catalog = (
        createdSession.data.values.session as {
          _localizedMessageCatalog?: {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          };
        }
      )._localizedMessageCatalog;

      expect(catalog?.locales?.fr?.shared?.conversation_complete).toBe('Conversation terminee.');
    });

    it('should set runtime session ID from deployment-resolved session', async () => {
      await deployAdapter.initialize();
      expect(deployAdapter.getSessionId()).toBe('lk-session-deploy');
    });

    it('should NOT call project.findFirst (legacy path) when deployment resolves', async () => {
      await deployAdapter.initialize();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('should defer DB session creation until first chat (prevents ghost sessions)', async () => {
      await deployAdapter.initialize();

      // DB session creation is deferred until first chat() call
      expect(mockConvStore.createSession).not.toHaveBeenCalled();

      // Trigger ensureDbSession via chat()
      await deployAdapter.chat('Hello');

      expect(mockConvStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'voice',
          agentName: 'booking_agent',
          projectId: 'project-1',
          tenantId: 'tenant-1',
          metadata: { voiceMetadata: { provider: 'livekit' } },
        }),
      );
    });

    it('should set dbSessionId after first chat triggers DB session creation', async () => {
      await deployAdapter.initialize();

      // Before chat, no DB session exists
      expect(deployAdapter.getDbSessionId()).toBeNull();

      // Trigger ensureDbSession via chat()
      await deployAdapter.chat('Hello');

      // After chat, DB session should have been created
      expect(deployAdapter.getDbSessionId()).toBe('db-session-deploy');
    });

    it('should fall back to legacy path when DeploymentResolver fails (non-410)', async () => {
      mockResolve.mockRejectedValue(new Error('Resolver internal error'));

      await deployAdapter.initialize();

      // Should have fallen through to legacy DSL path
      expect(mockFindFirst).toHaveBeenCalled();
      expect(mockExecutor.createSessionFromResolved).toHaveBeenCalled();
    });

    it('should NOT fall back on 410 (retired deployment)', async () => {
      const retiredError = new Error('Deployment retired');
      (retiredError as any).statusCode = 410;
      mockResolve.mockRejectedValue(retiredError);

      await expect(deployAdapter.initialize()).rejects.toThrow('Deployment retired');

      // Should NOT have fallen through
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
    });

    it('passes scoped caller identity through deployment-resolved initialization', async () => {
      const deploymentIdentityAdapter = new RuntimeLLMAdapter({
        sessionId: 'lk-session-deploy',
        projectId: 'project-1',
        agentName: 'booking_agent',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        callerContext: sdkCallerContext,
      });

      await deploymentIdentityAdapter.initialize();

      expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
        resolvedResult,
        expect.objectContaining({
          channelType: 'voice_livekit',
          deploymentId: 'deploy-1',
          scope: expect.objectContaining({
            sessionId: 'lk-session-deploy',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            callerContext: expect.objectContaining({
              customerId: 'verified-user-1',
              sessionPrincipalId: 'sdk-session-voice-1',
              channelId: 'channel-voice-1',
            }),
            subject: expect.objectContaining({
              contactId: 'contact-livekit-1',
            }),
          }),
        }),
      );
    });

    it('persists caller identity fields when creating the DB session', async () => {
      const deploymentIdentityAdapter = new RuntimeLLMAdapter({
        sessionId: 'lk-session-deploy',
        projectId: 'project-1',
        agentName: 'booking_agent',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        callerContext: sdkCallerContext,
      });

      await deploymentIdentityAdapter.initialize();
      await deploymentIdentityAdapter.chat('Hello');

      expect(mockConvStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'lk-session-deploy',
          channel: 'voice',
          projectId: 'project-1',
          tenantId: 'tenant-1',
          customerId: 'verified-user-1',
          anonymousId: 'sdk-session-voice-1',
          channelArtifact: 'artifact-hash-voice-1',
          identityTier: 2,
          verificationMethod: 'hmac',
          channelId: 'channel-voice-1',
          metadata: {
            voiceMetadata: { provider: 'livekit' },
            authScope: 'user',
          },
        }),
      );
    });

    it('should skip deployment path when deploymentId is missing', async () => {
      const legacyAdapter = new RuntimeLLMAdapter({
        sessionId: 'lk-session-legacy',
        projectId: 'project-1',
        agentName: 'greeting-agent',
        tenantId: 'tenant-1',
        // NO deploymentId
      });

      await legacyAdapter.initialize();

      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockFindFirst).toHaveBeenCalled();
    });
  });
});
