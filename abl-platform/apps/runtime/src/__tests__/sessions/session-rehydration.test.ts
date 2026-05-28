/**
 * Session Rehydration Tests
 *
 * Verifies that sessions can be rehydrated from SessionService when not in
 * the local in-memory map (distributed pod support — Bug 2 fix).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PIIType } from '@abl/compiler/platform/security/index.js';
import {
  PIIVault,
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '@abl/compiler/platform/security/index.js';

const { mockRefreshSessionPIIContext } = vi.hoisted(() => ({
  mockRefreshSessionPIIContext: vi.fn(),
}));

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
const contractIdType: PIIType = 'ContractID';

function createContractRegistry(): PIIRecognizerRegistry {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      [contractIdType],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      contractIdType,
      undefined,
      'custom',
    ),
  );
  return registry;
}

vi.mock('../../services/pii/session-pii-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pii/session-pii-context.js')>();
  return {
    ...actual,
    refreshSessionPIIContext: mockRefreshSessionPIIContext,
  };
});

import { RuntimeExecutor } from '../../services/runtime-executor.js';
import type { SessionData, HydratedSession } from '../../services/session/types.js';
import type { AgentIR, CompilationOutput } from '@abl/compiler';

interface MockCreateSessionParams {
  id: string;
  agentName: string;
  agentIR: AgentIR | null;
  compilationOutput: CompilationOutput | null;
  handoffStack?: string[];
  initialContext?: Record<string, unknown>;
  isFlowMode?: boolean;
  entryPoint?: string;
  tenantId?: string;
  projectId?: string;
  authToken?: string;
  userId?: string;
  deploymentId?: string;
  environment?: string;
  agentVersions?: Record<string, number>;
  callerContext?: SessionData['callerContext'];
  maxAgeSeconds?: number;
  idleSeconds?: number;
}

function createMockAgentIR(name = 'test-agent'): AgentIR {
  return {
    metadata: { name, version: '1.0', description: 'Test agent' },
    execution: { mode: 'reasoning' },
    tools: [],
    messages: {},
  } as AgentIR;
}

function createMockCompilation(agentName = 'test-agent'): CompilationOutput {
  const ir = createMockAgentIR(agentName);
  return {
    agents: { [agentName]: ir },
    entry_agent: agentName,
  } as CompilationOutput;
}

function createMockSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-123',
    agentName: 'test-agent',
    irSourceHash: 'hash-abc',
    compilationHash: 'comp-hash-abc',
    conversationHistory: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    dataValues: { session: { channel: 'digital' } },
    dataGatheredKeys: [],
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['test-agent'],
    delegateStack: [],
    tenantId: 'org-1',
    authToken: 'test-token',
    userId: 'user-1',
    initialized: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  };
}

function createMockHydratedSession(overrides: Partial<HydratedSession> = {}): HydratedSession {
  const sessionData = createMockSessionData();
  return {
    ...sessionData,
    agentIR: createMockAgentIR(),
    compilationOutput: createMockCompilation(),
    ...overrides,
  };
}

function createMockCreatedSession(params: MockCreateSessionParams): HydratedSession {
  return createMockHydratedSession({
    id: params.id,
    agentName: params.agentName,
    agentIR: params.agentIR,
    compilationOutput: params.compilationOutput,
    handoffStack: params.handoffStack || [params.agentName],
    currentFlowStep: params.isFlowMode ? params.entryPoint : undefined,
    dataValues: params.initialContext || { session: { channel: 'digital' } },
    tenantId: params.tenantId,
    projectId: params.projectId,
    authToken: params.authToken,
    userId: params.userId,
    deploymentId: params.deploymentId,
    environment: params.environment,
    agentVersions: params.agentVersions,
    callerContext: params.callerContext,
    maxAgeSeconds: params.maxAgeSeconds,
    idleSeconds: params.idleSeconds,
    version: 0,
    conversationHistory: [],
  });
}

describe('Session Rehydration', () => {
  let executor: RuntimeExecutor;
  let mockSessionService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new RuntimeExecutor();
    mockRefreshSessionPIIContext.mockReset();
    mockRefreshSessionPIIContext.mockImplementation(
      async (session: {
        piiVault?: PIIVault;
        piiRecognizerRegistry?: PIIRecognizerRegistry;
        piiPatternConfigs?: Array<Record<string, unknown>>;
        piiRedactionConfig?: { enabled: boolean; redactInput: boolean; redactOutput: boolean };
      }) => {
        const registry = createContractRegistry();
        session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };
        session.piiRecognizerRegistry = registry;
        session.piiPatternConfigs = [
          {
            patternName: contractIdType,
            defaultRenderMode: 'redacted',
            consumerAccess: [],
          },
        ];
        if (session.piiVault) {
          session.piiVault.setRecognizerRegistry(registry);
        } else {
          session.piiVault = new PIIVault({ recognizerRegistry: registry });
        }
      },
    );

    mockSessionService = {
      loadSession: vi.fn(),
      createSession: vi.fn(async (params: MockCreateSessionParams) =>
        createMockCreatedSession(params),
      ),
      saveSession: vi.fn(),
      store: {
        load: vi.fn(async () => null),
      },
      deleteSession: vi.fn(),
      appendToConversation: vi.fn(),
      cacheAgentIR: vi.fn().mockResolvedValue('hash'),
      resolveAgentIR: vi.fn(),
      cacheCompilationOutput: vi.fn().mockResolvedValue('hash'),
      setAgentRegistry: vi.fn(),
      setAgentRegistryScoped: vi.fn(),
      getAgentRegistry: vi.fn(),
      getAgentRegistryScoped: vi.fn(),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
      getConfig: vi.fn().mockReturnValue({ store: 'memory' }),
      computeIRHash: vi.fn().mockReturnValue('hash'),
      computeCompilationHash: vi.fn().mockReturnValue('hash'),
    };

    executor.setSessionService(mockSessionService);

    const llmWiring = (executor as any).llmWiring;
    llmWiring.wireToolExecutor = vi.fn((session: { toolExecutor?: unknown }) => {
      session.toolExecutor = { execute: vi.fn() };
    });
    llmWiring.wireLLMClient = vi.fn(async (session: { llmClient?: unknown }) => {
      session.llmClient = { complete: vi.fn() };
    });
    llmWiring.loadEnvironmentVariables = vi.fn().mockResolvedValue({});
  });

  it('should rehydrate session from SessionService', async () => {
    const hydrated = createMockHydratedSession();
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    expect(session!.id).toBe('session-123');
    expect(session!.agentName).toBe('test-agent');
    expect(session!.agentIR).toBeDefined();
    expect(session!.compilationOutput).toBeDefined();
  });

  it('should recreate toolExecutor on rehydration', async () => {
    const hydrated = createMockHydratedSession();
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    // toolExecutor should be set (MockToolExecutor since no HTTP tools)
    expect(session!.toolExecutor).toBeDefined();
  });

  it('should preserve org/auth context on rehydration', async () => {
    const hydrated = createMockHydratedSession({
      tenantId: 'org-special',
      authToken: 'special-token',
      userId: 'user-special',
    } as any);
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    expect(session!.tenantId).toBe('org-special');
    expect(session!.authToken).toBe('special-token');
    expect(session!.userId).toBe('user-special');
  });

  it('should restore conversation history on rehydration', async () => {
    const hydrated = createMockHydratedSession();
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    expect(session!.conversationHistory).toHaveLength(2);
    expect(session!.conversationHistory[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('should return null when session not found in SessionService', async () => {
    mockSessionService.loadSession.mockResolvedValue(null);

    const session = await executor.rehydrateSession('nonexistent');
    expect(session).toBeNull();
  });

  it('should return null on rehydration error', async () => {
    mockSessionService.loadSession.mockRejectedValue(new Error('Redis connection failed'));

    const session = await executor.rehydrateSession('session-123');
    expect(session).toBeNull();
  });

  it('should store rehydrated session in local map', async () => {
    const hydrated = createMockHydratedSession();
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    await executor.rehydrateSession('session-123');

    // Session should now be in local map
    const localSession = executor.getSession('session-123');
    expect(localSession).toBeDefined();
    expect(localSession!.id).toBe('session-123');
  });

  it('should keep session when LLM wiring fails during rehydration', async () => {
    const hydrated = createMockHydratedSession();
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const llmWireSpy = (executor as any).llmWiring.wireLLMClient;
    llmWireSpy.mockRejectedValueOnce(new Error('LLM init failed'));

    const session = await executor.rehydrateSession('session-123');

    expect(llmWireSpy).toHaveBeenCalled();
    expect(session).not.toBeNull();
    expect(session!.id).toBe('session-123');
    expect(executor.getSession('session-123')).toBeDefined();
  });

  it('should sync active thread conversationHistory to session after rehydration', async () => {
    const { getActiveThread } = await import('../../services/runtime-executor.js');

    // Hydrated session with persisted thread data
    const hydrated = createMockHydratedSession({
      threads: [
        {
          agentName: 'test-agent',
          conversationHistory: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
          ],
          state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          startedAt: Date.now(),
          returnExpected: false,
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
    } as any);
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    const thread = getActiveThread(session!);
    expect(thread).toBeDefined();
    // After syncThreadToSession, session.conversationHistory should reference
    // the same array as the active thread's conversationHistory
    expect(session!.conversationHistory).toBe(thread.conversationHistory);
  });

  it('should expose rehydrated assistant metadata through session detail', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'mixed' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const hydrated = createMockHydratedSession({
      conversationHistory: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'hi there',
          metadata: responseMetadata,
        } as any,
      ],
      threads: [
        {
          agentName: 'test-agent',
          conversationHistory: [
            { role: 'user', content: 'hello' },
            {
              role: 'assistant',
              content: 'hi there',
              metadata: responseMetadata,
            } as any,
          ],
          state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          startedAt: Date.now(),
          returnExpected: false,
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
    } as any);
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');
    const detail = executor.getSessionDetail('session-123');

    expect(session).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(detail!.messages[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'hi there',
        metadata: responseMetadata,
      }),
    );
  });

  it('should sync session fields from active thread after rehydration with empty threads', async () => {
    const { getActiveThread } = await import('../../services/runtime-executor.js');

    // Hydrated session with no persisted threads (createInitialThread path)
    const hydrated = createMockHydratedSession({
      threads: [],
    } as any);
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    const thread = getActiveThread(session!);
    expect(thread).toBeDefined();
    // createInitialThread aliases session.conversationHistory to thread.conversationHistory,
    // and syncThreadToSession maintains that alias
    expect(session!.conversationHistory).toBe(thread.conversationHistory);
  });

  it('should restore the project recognizer registry onto deserialized PII vaults during rehydration', async () => {
    const hydrated = createMockHydratedSession({
      tenantId: 'org-1',
      projectId: 'project-1',
      piiRedactionConfig: {
        enabled: true,
        redactInput: true,
        redactOutput: true,
      },
      piiVaultData: new PIIVault().serialize(),
    } as unknown as Partial<HydratedSession>);
    mockSessionService.loadSession.mockResolvedValue(hydrated);

    const session = await executor.rehydrateSession('session-123');

    expect(session).not.toBeNull();
    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-123',
        tenantId: 'org-1',
        projectId: 'project-1',
      }),
    );

    const tokenized = session!.piiVault?.tokenize(`Contract ${rawContractId}`);
    expect(tokenized?.tokens).toHaveLength(1);
    expect(tokenized?.text).toContain('{{PII:ContractID:');
  });
});
