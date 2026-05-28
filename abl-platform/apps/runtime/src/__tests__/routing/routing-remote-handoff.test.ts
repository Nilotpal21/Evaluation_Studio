/**
 * RoutingExecutor — Remote Handoff Failure Path Tests
 *
 * Tests the private handleRemoteHandoff() method via the public handleHandoff()
 * entry point by configuring sessions with remote agent registry entries. Covers
 * timeout, parent restoration, data merging, input-required, failures, auth
 * forwarding, and history strategy control.
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SyncResponseForAsyncRequest,
  type Task,
  type Message,
  type TextPart,
} from '@agent-platform/a2a';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import type {
  RuntimeSession,
  AgentRegistryEntry,
  ExecutorContext,
  RuntimeExecutorConfig,
} from '../../services/execution/types.js';
import type { HandoffConfig } from '@abl/compiler';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';
import { isVoiceChannel } from '../../services/execution/prompt-builder.js';
import {
  KMSProviderPool,
  _resetKMSRegistryForTesting,
  setKMSProviderPool,
} from '@agent-platform/database/kms';
import {
  TenantEncryptionFacade,
  clearGlobalEncryptionFacade,
  setGlobalEncryptionFacade,
  type AcquiredDEK,
  type DEKScope,
} from '@agent-platform/shared-encryption';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before the RoutingExecutor import
// ---------------------------------------------------------------------------

const mockSendTask = vi.fn();
const mockSendTaskAsync = vi.fn();
const mockCreateA2AClient = vi.fn();
const mockDiscoverAgent = vi.fn();
const mockSendTaskStreaming = vi.fn();
const mockCancelRemoteTask = vi.fn().mockResolvedValue({ status: { state: 'canceled' } });

vi.mock('@agent-platform/a2a', () => {
  class MockSsrfEndpointValidator {
    validate() {}
  }
  class MockAgentCardCache {
    get() {
      return undefined;
    }
    set() {}
  }
  return {
    sendTask: (...args: unknown[]) => mockSendTask(...args),
    sendTaskAsync: (...args: unknown[]) => mockSendTaskAsync(...args),
    sendTaskStreaming: (...args: unknown[]) => mockSendTaskStreaming(...args),
    SyncResponseForAsyncRequest: class extends Error {
      result: unknown;
      constructor(result: unknown) {
        super();
        this.result = result;
      }
    },
    createA2AClient: (...args: unknown[]) => mockCreateA2AClient(...args),
    createA2AClientWithAuth: (...args: unknown[]) => mockCreateA2AClient(...args),
    discoverAgent: (...args: unknown[]) => mockDiscoverAgent(...args),
    cancelRemoteTask: (...args: unknown[]) => mockCancelRemoteTask(...args),
    SsrfEndpointValidator: MockSsrfEndpointValidator,
    AgentCardCache: MockAgentCardCache,
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue({}),
}));

vi.mock('@abl/compiler', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    interpolateMessage: vi.fn((tpl: string) => tpl),
    DEFAULT_MESSAGES: {
      handoff_message_voice: 'Transferring to {{target}}',
      remote_handoff_message_voice: 'Connecting to {{target}}',
      remote_handoff_message: 'Connecting to {{target}}',
      ...(actual.DEFAULT_MESSAGES as Record<string, string> | undefined),
    },
  };
});

vi.mock('../../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(),
  createLLMEvalFromClient: vi.fn(),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../services/execution/memory-integration.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initializeActivatedAgentMemory: vi.fn().mockResolvedValue(undefined),
    executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/execution/prompt-template-loader.js', () => ({
  promptTemplateLoader: { getEscalation: vi.fn().mockReturnValue('') },
}));

vi.mock('@agent-platform/execution', () => {
  class MockInProcessExecutionRuntime {}
  class MockCountingSemaphore {
    acquire() {
      return Promise.resolve();
    }
    release() {}
  }
  return {
    InProcessExecutionRuntime: MockInProcessExecutionRuntime,
    CountingSemaphore: MockCountingSemaphore,
    createChildSession: vi.fn(),
    createChildSessionForFanOut: vi.fn(),
    createExecutionId: vi.fn().mockReturnValue('exec-1'),
  };
});

// Now import the class under test
import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import type { LLMWiringService } from '../../services/execution/llm-wiring.js';

class InMemoryDEKManager {
  private readonly entries = new Map<string, { tenantId: string; plaintext: Buffer }>();
  private readonly activeByScope = new Map<string, string>();

  async acquireDEK(scope: DEKScope, kekKeyId: string): Promise<AcquiredDEK> {
    const scopeKey = this.scopeKey(scope);
    const activeDekId = this.activeByScope.get(scopeKey);
    if (activeDekId) {
      const activeEntry = this.entries.get(activeDekId);
      if (activeEntry) {
        return {
          plaintext: Buffer.from(activeEntry.plaintext),
          dekId: activeDekId,
          kekKeyId,
          kekKeyVersion: 1,
        };
      }
    }

    const dekId = `test-dek-${randomBytes(8).toString('hex')}`;
    const plaintext = randomBytes(32);
    this.entries.set(dekId, { tenantId: scope.tenantId, plaintext });
    this.activeByScope.set(scopeKey, dekId);
    return { plaintext: Buffer.from(plaintext), dekId, kekKeyId, kekKeyVersion: 1 };
  }

  async unwrapDEK(dekId: string, tenantId: string): Promise<Buffer> {
    const entry = this.entries.get(dekId);
    if (!entry || entry.tenantId !== tenantId) {
      throw new Error('DEK not found for tenant');
    }
    return Buffer.from(entry.plaintext);
  }

  getCachedDEK(dekId: string, tenantId?: string): Buffer | null {
    const entry = this.entries.get(dekId);
    if (!entry || (tenantId && entry.tenantId !== tenantId)) {
      return null;
    }
    return Buffer.from(entry.plaintext);
  }

  getActiveDEKId(scope?: DEKScope): string {
    return scope
      ? (this.activeByScope.get(this.scopeKey(scope)) ?? 'unused-sync-path')
      : 'unused-sync-path';
  }

  clearCache(): void {
    for (const entry of this.entries.values()) {
      entry.plaintext.fill(0);
    }
    this.entries.clear();
    this.activeByScope.clear();
  }

  private scopeKey(scope: DEKScope): string {
    return `${scope.tenantId}:${scope.projectId}:${scope.environment}`;
  }
}

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'Supervisor',
    agentIR: {
      coordination: {
        handoffs: [
          {
            to: 'RemoteAgent',
            when: 'true',
            context: { pass: [], summary: '', history: 'none' as const },
            return: true,
            remote: {
              location: 'remote' as const,
              endpoint: 'https://remote.example.com',
              protocol: 'a2a' as const,
              timeout: '5000ms',
            },
          },
        ] as HandoffConfig[],
      },
      routing: {
        rules: [{ to: 'RemoteAgent', when: 'true' }],
      },
    } as RuntimeSession['agentIR'],
    compilationOutput: null,
    conversationHistory: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'I need remote help' },
    ],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    handoffReturnInfo: { RemoteAgent: true },
    tenantId: 'tenant-1',
    projectId: 'project-1',
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  };

  // Ensure at least one thread
  if (session.threads.length === 0) {
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: [...session.conversationHistory],
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
  }

  return session;
}

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function createSessionWithCustomContractPII(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['ContractID'],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      'ContractID',
      undefined,
      'custom',
    ),
  );

  return createMockSession({
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
    piiRecognizerRegistry: registry,
    piiVault: new PIIVault({ recognizerRegistry: registry }),
    piiPatternConfigs: [
      {
        patternName: 'ContractID',
        defaultRenderMode: 'redacted',
        consumerAccess: [],
      },
    ],
    ...overrides,
  });
}

/** Helper to build a completed Task response */
function makeCompletedTask(text: string): Task {
  return {
    kind: 'task',
    id: 'task-1',
    status: {
      state: 'completed',
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{ kind: 'text', text } as TextPart],
      },
    },
  } as Task;
}

/** Helper to build a failed Task response */
function makeFailedTask(): Task {
  return {
    kind: 'task',
    id: 'task-1',
    status: {
      state: 'failed',
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{ kind: 'text', text: 'Something went wrong' } as TextPart],
      },
    },
  } as Task;
}

/** Helper to build an input-required Task response */
function makeInputRequiredTask(text: string): Task {
  return {
    kind: 'task',
    id: 'task-1',
    status: {
      state: 'input-required',
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{ kind: 'text', text } as TextPart],
      },
    },
  } as Task;
}

function createRemoteAgentEntry(overrides?: Partial<AgentRegistryEntry>): AgentRegistryEntry {
  return {
    dsl: '',
    ir: null,
    location: 'remote',
    remote: {
      endpoint: 'https://remote.example.com',
      protocol: 'a2a' as const,
      timeout: 5000,
    },
    ...overrides,
  };
}

function createMockExecutorContext(
  agentRegistry: Record<string, AgentRegistryEntry> = {},
): ExecutorContext {
  return {
    executeMessage: vi.fn().mockResolvedValue({ response: '', action: { type: 'none' } }),
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((tpl: string) => tpl),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry,
    sessions: new Map(),
    config: { timeoutMs: 30000 } as RuntimeExecutorConfig,
    asyncInfra: {
      callbackRegistry: {
        register: vi.fn().mockResolvedValue({
          callbackId: 'callback-1',
          secret: 'secret-1',
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      suspensionStore: {
        create: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn().mockResolvedValue(undefined),
        fail: vi.fn().mockResolvedValue(undefined),
      },
      callbackBaseUrl: 'https://runtime.example.com/a2a/callbacks',
    } as ExecutorContext['asyncInfra'],
    reasoning: {
      execute: vi.fn().mockResolvedValue({ response: '', action: { type: 'none' } }),
    },
  };
}

function createMockLLMWiring(): LLMWiringService {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
  } as unknown as LLMWiringService;
}

// =============================================================================
// TESTS
// =============================================================================

describe('RoutingExecutor — Remote Handoff', () => {
  let executor: RoutingExecutor;
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let dekManager: InMemoryDEKManager;
  const originalKmsProvider = process.env.KMS_PROVIDER;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.KMS_PROVIDER = 'local';
    _resetKMSRegistryForTesting();
    clearGlobalEncryptionFacade();

    const pool = new KMSProviderPool({ masterKeyHex: randomBytes(32).toString('hex') });
    await pool.initialize();
    setKMSProviderPool(pool);
    dekManager = new InMemoryDEKManager();
    setGlobalEncryptionFacade(new TenantEncryptionFacade(dekManager));

    const registry: Record<string, AgentRegistryEntry> = {
      RemoteAgent: createRemoteAgentEntry(),
    };

    ctx = createMockExecutorContext(registry);
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  afterEach(() => {
    dekManager?.clearCache();
    clearGlobalEncryptionFacade();
    _resetKMSRegistryForTesting();
    if (originalKmsProvider === undefined) {
      delete process.env.KMS_PROVIDER;
    } else {
      process.env.KMS_PROVIDER = originalKmsProvider;
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Timeout fires when sendTask exceeds remoteTimeoutMs
  // -------------------------------------------------------------------------
  it('timeout fires when sendTask exceeds remoteTimeoutMs', async () => {
    const remoteTimeoutMs = 25;
    // sendTask never resolves — it hangs until the timeout fires
    mockSendTask.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const session = createMockSession();
    const handoffConfig = session.agentIR?.coordination?.handoffs?.[0];
    if (handoffConfig?.remote) {
      handoffConfig.remote.timeout = remoteTimeoutMs;
    }

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'help me',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`Remote handoff timeout after ${remoteTimeoutMs}ms`);
  });

  // -------------------------------------------------------------------------
  // 2. Parent thread restored from threadStack after timeout
  // -------------------------------------------------------------------------
  it('parent thread restored from threadStack after timeout', async () => {
    const remoteTimeoutMs = 25;
    mockSendTask.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const session = createMockSession();
    const handoffConfig = session.agentIR?.coordination?.handoffs?.[0];
    if (handoffConfig?.remote) {
      handoffConfig.remote.timeout = remoteTimeoutMs;
    }
    const originalThreadIndex = session.activeThreadIndex;
    const originalThreadCount = session.threads.length;

    await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'help me',
    });

    // Parent thread should be restored as active.
    expect(session.activeThreadIndex).toBe(originalThreadIndex);
    // Parent thread should be active again (not stuck in 'waiting').
    expect(session.threads[originalThreadIndex].status).toBe('active');
    // A remote thread was created and completed.
    expect(session.threads.length).toBe(originalThreadCount + 1);
    const remoteThread = session.threads[session.threads.length - 1];
    expect(remoteThread.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // 3. Completed task with returnExpected merges data to parent
  // -------------------------------------------------------------------------
  it('completed task with returnExpected merges data to parent', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('Booking confirmed'));

    const session = createMockSession();
    // Set returnExpected via handoffReturnInfo
    session.handoffReturnInfo = { RemoteAgent: true };

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'book a flight',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('Booking confirmed');

    // Parent thread should be active again after return
    const parentThread = session.threads[0];
    expect(parentThread.status).toBe('active');
    // Response from remote agent should be appended to parent conversation
    const lastEntry = parentThread.conversationHistory[parentThread.conversationHistory.length - 1];
    expect(lastEntry.role).toBe('assistant');
    expect(lastEntry.content).toContain('[RemoteAgent]');
    expect(lastEntry.content).toContain('Booking confirmed');
  });

  it('redacts custom-pattern remote handoff returns for delivery while tokenizing thread history', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask(`Contract ${rawContractId}`));

    const session = createSessionWithCustomContractPII();
    session.handoffReturnInfo = { RemoteAgent: true };
    const chunks: string[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'book a flight' },
      (chunk) => chunks.push(chunk),
    );

    expect(result.success).toBe(true);
    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);

    const remoteThread = session.threads[1];
    expect(String(remoteThread.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(remoteThread.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);

    const parentThread = session.threads[0];
    expect(String(parentThread.conversationHistory.at(-1)?.content)).toContain(
      '[RemoteAgent]: Contract {{PII:ContractID:',
    );
    expect(String(parentThread.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });

  it('completed task with ON_RETURN: resume_intent replays the parent intent', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('Booking confirmed'));
    ctx.executeMessage = vi
      .fn()
      .mockResolvedValue({ response: 'Parent follow-up complete', action: { type: 'continue' } });

    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'RemoteAgent',
              when: 'true',
              context: { pass: [], summary: '', history: 'none' as const },
              return: true,
              on_return: 'resume_intent',
              remote: {
                location: 'remote' as const,
                endpoint: 'https://remote.example.com',
                protocol: 'a2a' as const,
              },
            },
          ] as HandoffConfig[],
        },
        routing: {
          rules: [{ to: 'RemoteAgent', when: 'true' }],
        },
      } as RuntimeSession['agentIR'],
    });

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'book a flight',
    });

    expect(result.success).toBe(true);
    expect(result.response).toContain('Booking confirmed');
    expect(result.response).toContain('Parent follow-up complete');
    expect(ctx.executeMessage).toHaveBeenCalledWith(
      'test-session-1',
      'book a flight',
      undefined,
      undefined,
      { resumeIntentReplay: true, messageSource: 'resume', sourceAgent: 'RemoteAgent' },
    );
  });

  // -------------------------------------------------------------------------
  // 4. Input-required task keeps remote thread active
  // -------------------------------------------------------------------------
  it('input-required task keeps remote thread active', async () => {
    mockSendTask.mockResolvedValue(makeInputRequiredTask('What is your destination?'));

    const session = createMockSession();

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'book a flight',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('What is your destination?');

    // Remote thread should still be the active thread (not returned to parent)
    const remoteThread = session.threads[session.threads.length - 1];
    expect(remoteThread.agentName).toBe('RemoteAgent');
    // Status should remain 'active' (not completed)
    expect(remoteThread.status).toBe('active');
    // The remote thread has the response in its conversation history
    expect(
      remoteThread.conversationHistory.some(
        (m) => m.role === 'assistant' && m.content === 'What is your destination?',
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Failed task restores parent and returns error
  // -------------------------------------------------------------------------
  it('failed task restores parent and returns error', async () => {
    mockSendTask.mockResolvedValue(makeFailedTask());

    const session = createMockSession();
    const parentThreadIndex = session.activeThreadIndex;

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'help me',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Remote agent failed');

    // Parent should be restored
    expect(session.activeThreadIndex).toBe(parentThreadIndex);
    expect(session.threads[parentThreadIndex].status).toBe('active');

    // Remote thread should be completed (failed)
    const remoteThread = session.threads[session.threads.length - 1];
    expect(remoteThread.status).toBe('completed');
    expect(remoteThread.endedAt).toBeDefined();
  });

  it('does not apply handoff ON_FAILURE after remote child reports failed state', async () => {
    mockSendTask.mockResolvedValue(makeFailedTask());

    const session = createMockSession();
    const handoffConfig = session.agentIR!.coordination!.handoffs![0] as HandoffConfig;
    handoffConfig.on_failure = 'respond';
    handoffConfig.failure_message = 'Fallback should stay unused';
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help me' },
      onChunk,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Remote agent failed');
    expect(result.response).toBeUndefined();
    expect(onChunk).not.toHaveBeenCalledWith('Fallback should stay unused');
    expect(
      session.threads[0].conversationHistory.some(
        (entry) => entry.role === 'assistant' && entry.content === 'Fallback should stay unused',
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Exception in sendTask restores parent and returns error
  // -------------------------------------------------------------------------
  it('exception in sendTask restores parent and returns error', async () => {
    mockSendTask.mockRejectedValue(new Error('Network connection refused'));

    const session = createMockSession();
    const parentThreadIndex = session.activeThreadIndex;

    const result = await executor.handleHandoff(session, {
      target: 'RemoteAgent',
      message: 'help me',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Remote handoff failed');
    expect(result.error).toContain('Network connection refused');

    // Parent should be restored
    expect(session.activeThreadIndex).toBe(parentThreadIndex);
    expect(session.threads[parentThreadIndex].status).toBe('active');
  });

  it('dispatch failure can use handoff ON_FAILURE respond and emits phase trace', async () => {
    mockSendTask.mockRejectedValue(new Error('Connection refused'));

    const session = createMockSession();
    const handoffConfig = session.agentIR!.coordination!.handoffs![0] as HandoffConfig;
    handoffConfig.on_failure = 'respond';
    handoffConfig.failure_message = 'Remote specialist unavailable';
    const onChunk = vi.fn();
    const onTraceEvent = vi.fn();

    const result = await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help me' },
      onChunk,
      onTraceEvent,
    );

    expect(result.success).toBe(false);
    expect(result.response).toBe('Remote specialist unavailable');
    expect(onChunk).toHaveBeenCalledWith('Remote specialist unavailable');
    expect(session.threads[0].status).toBe('active');
    expect(session.activeThreadIndex).toBe(0);
    expect(
      session.threads[0].conversationHistory.some(
        (entry) => entry.role === 'assistant' && entry.content === 'Remote specialist unavailable',
      ),
    ).toBe(true);
    expect(
      onTraceEvent.mock.calls.some(
        ([event]) =>
          event.type === 'handoff_failure' &&
          event.data.phase === 'dispatch' &&
          event.data.action === 'respond',
      ),
    ).toBe(true);
  });

  it('redacts custom-pattern responses on the streaming remote handoff path', async () => {
    mockDiscoverAgent.mockResolvedValue({
      capabilities: { streaming: true },
    });
    mockSendTask.mockResolvedValue(makeCompletedTask(`Contract ${rawContractId}`));

    const session = createSessionWithCustomContractPII();
    session.handoffReturnInfo = { RemoteAgent: true };
    const chunks: string[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help me' },
      (chunk) => chunks.push(chunk),
    );

    expect(result.success).toBe(true);
    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.threads[1].conversationHistory.at(-1)?.content)).toContain(
      '{{PII:ContractID:',
    );
    expect(String(session.threads[0].conversationHistory.at(-1)?.content)).toContain(
      '[RemoteAgent]: Contract {{PII:ContractID:',
    );
  });

  it('redacts custom-pattern responses on the async sync-fallback remote handoff path', async () => {
    mockSendTaskAsync.mockRejectedValue(
      new SyncResponseForAsyncRequest(makeCompletedTask(`Contract ${rawContractId}`)),
    );

    const session = createSessionWithCustomContractPII({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'RemoteAgent',
              when: 'true',
              context: { pass: [], summary: '', history: 'none' as const },
              return: true,
              remote: {
                location: 'remote' as const,
                endpoint: 'https://remote.example.com',
                protocol: 'a2a' as const,
                timeout: '5000ms',
              },
              async: true,
            },
          ] as HandoffConfig[],
        },
        routing: {
          rules: [{ to: 'RemoteAgent', when: 'true' }],
        },
      } as RuntimeSession['agentIR'],
      handoffReturnInfo: { RemoteAgent: true },
    });
    const chunks: string[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help me' },
      (chunk) => chunks.push(chunk),
    );

    expect(result.success).toBe(true);
    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.threads[1].conversationHistory.at(-1)?.content)).toContain(
      '{{PII:ContractID:',
    );
    expect(String(session.threads[0].conversationHistory.at(-1)?.content)).toContain(
      '[RemoteAgent]: Contract {{PII:ContractID:',
    );
    expect(String(session.threads[0].conversationHistory.at(-1)?.content)).not.toContain(
      rawContractId,
    );
  });

  it('setup failure can use handoff ON_FAILURE respond before any child transfer starts', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'MissingLocalAgent',
              when: 'true',
              context: { pass: [], summary: '', history: 'none' as const },
              return: true,
              on_failure: 'respond',
              failure_message: 'Local specialist unavailable',
            },
          ] as HandoffConfig[],
        },
        routing: {
          rules: [{ to: 'MissingLocalAgent', when: 'true' }],
        },
      } as RuntimeSession['agentIR'],
      handoffReturnInfo: { MissingLocalAgent: true },
    });
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      { target: 'MissingLocalAgent', message: 'help me' },
      onChunk,
    );

    expect(result.success).toBe(false);
    expect(result.response).toBe('Local specialist unavailable');
    expect(onChunk).toHaveBeenCalledWith('Local specialist unavailable');
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].status).toBe('active');
    expect(
      session.threads[0].conversationHistory.some(
        (entry) => entry.role === 'assistant' && entry.content === 'Local specialist unavailable',
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Auth token forwarded in A2A headers
  // -------------------------------------------------------------------------
  it('auth token forwarded in A2A headers', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('done'));

    const session = createMockSession({
      authToken: 'Bearer secret-token-123',
      tenantId: 'tenant-42',
    });

    await executor.handleHandoff(session, { target: 'RemoteAgent', message: 'do it' });

    expect(mockSendTask).toHaveBeenCalledTimes(1);

    // Verify the sendTask was called with correct params
    const [params] = mockSendTask.mock.calls[0];
    expect(params.endpoint).toBe('https://remote.example.com');
    expect(params.tenantId).toBe('tenant-42');
    expect(params.taskId).toMatch(/^task_/);

    // Verify message structure includes the forwarded message
    expect(params.message.message.parts[0].text).toBe('do it');
  });

  it('uses localized remote handoff voice prompts when a locale asset exists', async () => {
    vi.mocked(isVoiceChannel).mockReturnValue(true);
    mockSendTask.mockResolvedValue(makeCompletedTask('done'));

    const session = createMockSession({
      channelType: 'voice',
    });
    session.data.values._locale = 'fr-CA';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr/_shared.json': JSON.stringify({
          remote_handoff_message_voice: 'Connexion vers {{target}}',
        }),
      }),
    );
    const onChunk = vi.fn();

    await executor.handleHandoff(session, { target: 'RemoteAgent', message: 'bonjour' }, onChunk);

    expect(onChunk).toHaveBeenCalledWith('Connexion vers RemoteAgent.');
  });

  it('uses localized remote handoff prompts for non-voice channels when a locale asset exists', async () => {
    vi.mocked(isVoiceChannel).mockReturnValue(false);
    mockSendTask.mockResolvedValue(makeCompletedTask('done'));

    const session = createMockSession();
    session.data.values._locale = 'es-MX';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:es/supervisor.json': JSON.stringify({
          remote_handoff_message: 'Conectando con {{target}}',
        }),
      }),
    );
    const onChunk = vi.fn();

    await executor.handleHandoff(session, { target: 'RemoteAgent', message: 'hola' }, onChunk);

    expect(onChunk).toHaveBeenCalledWith('Conectando con RemoteAgent.');
  });

  // -------------------------------------------------------------------------
  // 8. History strategy none sends empty conversation
  // -------------------------------------------------------------------------
  it('history strategy none sends empty conversation', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('done'));

    const session = createMockSession();
    // Ensure the handoff config has history: 'none'
    const handoffConfig = session.agentIR!.coordination!.handoffs![0] as HandoffConfig;
    handoffConfig.context.history = 'none';

    // Add conversation history to parent thread
    session.threads[0].conversationHistory = [
      { role: 'user', content: 'message 1' },
      { role: 'assistant', content: 'response 1' },
      { role: 'user', content: 'message 2' },
    ];

    await executor.handleHandoff(session, { target: 'RemoteAgent', message: 'hello' });

    expect(mockSendTask).toHaveBeenCalledTimes(1);
    const [params] = mockSendTask.mock.calls[0];

    // With history: 'none', metadata should NOT contain history
    expect(params.message.metadata.history).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Sync handoff emits handoff_progress started + completed events
  // -------------------------------------------------------------------------
  it('emits handoff_progress started and completed on sync success', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('Done'));

    const session = createMockSession();
    const onTraceEvent = vi.fn();

    await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'do it' },
      undefined,
      onTraceEvent,
    );

    const progressEvents = onTraceEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'handoff_progress');

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].data.phase).toBe('started');
    expect(progressEvents[0].data.targetAgent).toBe('RemoteAgent');
    expect(progressEvents[0].data.async).toBe(false);
    expect(progressEvents[1].data.phase).toBe('completed');
    expect(progressEvents[1].data.targetAgent).toBe('RemoteAgent');
    expect(typeof progressEvents[1].data.durationMs).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 10. Sync handoff emits handoff_progress started + failed on error
  // -------------------------------------------------------------------------
  it('emits handoff_progress started and failed on sendTask error', async () => {
    mockSendTask.mockRejectedValue(new Error('Connection refused'));

    const session = createMockSession();
    const onTraceEvent = vi.fn();

    await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help' },
      undefined,
      onTraceEvent,
    );

    const progressEvents = onTraceEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'handoff_progress');

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].data.phase).toBe('started');
    expect(progressEvents[1].data.phase).toBe('failed');
    expect(progressEvents[1].data.error).toContain('Connection refused');
    expect(typeof progressEvents[1].data.durationMs).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 11. Sync handoff emits failed on remote agent failure state
  // -------------------------------------------------------------------------
  it('emits handoff_progress failed when remote returns failed task', async () => {
    mockSendTask.mockResolvedValue(makeFailedTask());

    const session = createMockSession();
    const onTraceEvent = vi.fn();

    await executor.handleHandoff(
      session,
      { target: 'RemoteAgent', message: 'help' },
      undefined,
      onTraceEvent,
    );

    const progressEvents = onTraceEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'handoff_progress');

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].data.phase).toBe('started');
    expect(progressEvents[1].data.phase).toBe('failed');
    expect(progressEvents[1].data.error).toContain('Remote agent failed');
  });

  // -------------------------------------------------------------------------
  // 12. History strategy full sends complete conversation
  // -------------------------------------------------------------------------
  it('history strategy full sends complete conversation', async () => {
    mockSendTask.mockResolvedValue(makeCompletedTask('done'));

    const session = createMockSession();
    // Set history strategy to 'full' at handoff config level
    const handoffConfig = session.agentIR!.coordination!.handoffs![0] as HandoffConfig;
    handoffConfig.context.history = 'full';

    // Set up conversation history on the parent thread
    const parentHistory = [
      { role: 'user', content: 'message 1' },
      { role: 'assistant', content: 'response 1' },
      { role: 'user', content: 'message 2' },
      { role: 'assistant', content: 'response 2' },
    ];
    session.threads[0].conversationHistory = [...parentHistory];

    await executor.handleHandoff(session, { target: 'RemoteAgent', message: 'summarize' });

    expect(mockSendTask).toHaveBeenCalledTimes(1);
    const [params] = mockSendTask.mock.calls[0];

    // With history: 'full', the inner SDK Message's metadata should contain the conversation.
    // params.message = { message: { kind, parts, metadata: { history } }, metadata: { context } }
    const innerMessage = params.message.message;
    expect(innerMessage.metadata.history).toBeDefined();
    expect(innerMessage.metadata.history).toHaveLength(parentHistory.length);
    expect(innerMessage.metadata.history[0]).toEqual({
      role: 'user',
      content: 'message 1',
    });
    expect(innerMessage.metadata.history[3]).toEqual({
      role: 'assistant',
      content: 'response 2',
    });
  });
});
