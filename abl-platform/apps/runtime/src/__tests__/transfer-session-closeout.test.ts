import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../services/agent-transfer/index.js', () => ({
  getAdapterRegistry: vi.fn(),
  getTransferSessionStore: vi.fn(),
  getTransferTraceEmitter: vi.fn(() => null),
}));

const { mockFlushRuntimeSessionTransferTranscript } = vi.hoisted(() => ({
  mockFlushRuntimeSessionTransferTranscript: vi.fn(),
}));

vi.mock('../services/agent-transfer/transcript-persistence.js', () => ({
  getAgentTransferTranscriptPersistenceService: () => ({
    flushRuntimeSessionTransferTranscript: mockFlushRuntimeSessionTransferTranscript,
  }),
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockResolvedValue({ security: { scrubPII: false } }),
  }),
}));

const mockReasoningExecute = vi.fn().mockResolvedValue({
  response: 'test response',
  action: { type: 'continue' },
});

vi.mock('../services/execution/reasoning-executor.js', () => ({
  ReasoningExecutor: class {
    execute = mockReasoningExecute;
  },
}));

vi.mock('../services/session/session-service.js', () => ({
  getSessionService: vi.fn().mockReturnValue({
    store: { load: vi.fn() },
    saveSession: vi.fn(),
    replaceConversation: vi.fn(),
    getVersion: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../services/filler/index.js', () => ({
  FillerMessageService: class {
    destroy = vi.fn();
    isDestroyed = () => true;
    queueFiller = vi.fn();
    cancel = vi.fn();
  },
  getFillerMessage: vi.fn(),
  buildStaticFillerCandidate: vi.fn((options: { operation: string }) => ({
    operation: options.operation,
    text: 'Mock filler',
    source: 'static',
  })),
  normalizeFillerStatusText: vi.fn((text: string) => text),
  generatePipelineFiller: vi.fn(),
  StatusTagParser: class {
    processChunk(chunk: string) {
      return { outputChunk: chunk, statusText: null };
    }
  },
  DEFAULT_FILLER_CONFIG: {},
  resolveFillerConfig: vi.fn().mockReturnValue({ enabled: false }),
  resolveFillerRuntimeConfig: vi.fn().mockReturnValue({ serviceConfig: { enabled: false } }),
}));

vi.mock('../services/execution/memory-integration.js', () => ({
  initializeAllMemory: vi.fn(),
}));

vi.mock('../services/stores/mongodb-fact-store.js', () => ({
  createMongoDBFactStore: vi.fn(),
  createProjectFactStore: vi.fn(),
  PROJECT_SCOPE_USER_ID: '__project__',
}));

import { RuntimeExecutor, type RuntimeSession } from '../services/runtime-executor.js';
import { getAdapterRegistry, getTransferSessionStore } from '../services/agent-transfer/index.js';

class MockLLMClient {
  calls = 0;

  async chatWithToolUse() {
    this.calls += 1;
    return {
      text: 'This should not be used in the closeout path.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'This should not be used in the closeout path.' }],
    };
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  (executor as { llmWiring: Record<string, unknown> }).llmWiring.wireLLMClient = async (session: {
    llmClient?: MockLLMClient;
  }) => {
    session.llmClient = mock;
  };
  (executor as { llmWiring: Record<string, unknown> }).llmWiring.ensureSessionLLMClient =
    async (session: { llmClient?: MockLLMClient }) => {
      if (!session.llmClient) {
        session.llmClient = mock;
      }
    };
  return mock;
}

function sessions(executor: RuntimeExecutor): Map<string, RuntimeSession> {
  return (executor as unknown as Record<string, Map<string, RuntimeSession>>).sessions;
}

function createMockSession(id: string, overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id,
    agentName: 'VisaAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    llmClient: {
      resolveLanguageModel: vi.fn().mockResolvedValue(null),
    } as never,
    ...overrides,
  } as RuntimeSession;
}

describe('RuntimeExecutor post-transfer closeout', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReasoningExecute.mockResolvedValue({
      response: 'test response',
      action: { type: 'continue' },
    });
    mockFlushRuntimeSessionTransferTranscript.mockResolvedValue(undefined);
    executor = new RuntimeExecutor();
    executor.stopStaleReaper();
    mockClient = injectMockClient(executor);
    vi.mocked(getAdapterRegistry).mockReturnValue({
      get: vi.fn(),
    } as never);
  });

  afterEach(() => {
    executor.stopStaleReaper();
  });

  test('completes instead of re-escalating when a stale transfer session is gone and user says thank you', async () => {
    vi.mocked(getTransferSessionStore).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);

    const session = createMockSession('session-closeout-1', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isEscalated: true,
      transferInitiated: true,
      channelType: 'web_debug',
      callerContext: { channel: 'web_debug' } as never,
    });
    sessions(executor).set(session.id, session);

    const result = await executor.executeMessage(session.id, 'Thank you');

    expect(result.action?.type).toBe('complete');
    expect(session.isComplete).toBe(true);
    expect(session.isEscalated).toBe(false);
    expect(session.transferInitiated).toBe(false);
    expect(mockClient.calls).toBe(0);
  });

  test('flushes pending transfer transcript writes during stale-transfer closeout', async () => {
    vi.mocked(getTransferSessionStore).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);

    const session = createMockSession('session-closeout-pending-flush', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isEscalated: true,
      transferInitiated: true,
      channelType: 'web_debug',
      callerContext: { channel: 'web_debug' } as never,
      data: {
        values: { session: { conversationSessionId: 'conversation-closeout-1' } },
        gatheredKeys: new Set<string>(),
      },
    });
    sessions(executor).set(session.id, session);

    const result = await executor.executeMessage(session.id, 'Thank you');

    expect(result.action?.type).toBe('complete');
    expect(mockFlushRuntimeSessionTransferTranscript).toHaveBeenCalledWith({
      runtimeSessionId: session.id,
      tenantId: 'tenant-1',
      channelType: 'web_debug',
      parentConversationSessionId: 'conversation-closeout-1',
      reason: 'runtime_execution_exit',
    });
  });

  test('flushes transfer transcript writes on execution errors without masking the failure', async () => {
    mockReasoningExecute.mockRejectedValueOnce(new Error('reasoner failed'));
    mockFlushRuntimeSessionTransferTranscript.mockRejectedValueOnce(new Error('flush failed'));

    const session = createMockSession('session-closeout-error-flush', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      transferInitiated: true,
      isEscalated: false,
      channelType: 'web_debug',
      callerContext: { channel: 'web_debug' } as never,
    });
    sessions(executor).set(session.id, session);

    await expect(executor.executeMessage(session.id, 'Keep going')).rejects.toThrow(
      'reasoner failed',
    );

    expect(mockFlushRuntimeSessionTransferTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSessionId: session.id,
        tenantId: 'tenant-1',
        parentConversationSessionId: session.id,
        reason: 'runtime_execution_error',
      }),
    );
  });

  test('skips transfer transcript flush for sessions without transfer lifecycle state', async () => {
    const session = createMockSession('session-closeout-no-transfer', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelType: 'web_debug',
      callerContext: { channel: 'web_debug' } as never,
    });
    sessions(executor).set(session.id, session);

    const result = await executor.executeMessage(session.id, 'Hello');

    expect(result.response).toBe('test response');
    expect(mockFlushRuntimeSessionTransferTranscript).not.toHaveBeenCalled();
  });

  test('resets the active escalated thread before resuming the bot after stale transfer cleanup', async () => {
    vi.mocked(getTransferSessionStore).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);

    const session = createMockSession('session-closeout-threads', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isEscalated: true,
      transferInitiated: true,
      channelType: 'web_debug',
      callerContext: { channel: 'web_debug' } as never,
    });
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: null,
        conversationHistory: [],
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'escalated',
        currentFlowStep: undefined,
        waitingForInput: undefined,
        pendingResponse: undefined,
        pendingRichContent: undefined,
      } as never,
    ];
    session.activeThreadIndex = 0;
    sessions(executor).set(session.id, session);

    const result = await executor.executeMessage(session.id, 'Can you verify appointment?');

    expect(result.action?.type).not.toBe('escalated');
    expect(session.isEscalated).toBe(false);
    expect(session.transferInitiated).toBe(false);
    expect(session.threads[0]?.status).toBe('active');
  });

  test('completes trivial closeout after a recent transfer disconnect even when flags were already cleared', async () => {
    vi.mocked(getTransferSessionStore).mockReturnValue(null as never);

    const session = createMockSession('session-closeout-2', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      recentTransferEndedAt: Date.now(),
    });
    sessions(executor).set(session.id, session);

    const result = await executor.executeMessage(session.id, 'Thanks');

    expect(result.action?.type).toBe('complete');
    expect(session.isComplete).toBe(true);
    expect(session.recentTransferEndedAt).toBeUndefined();
    expect(mockClient.calls).toBe(0);
  });
});
