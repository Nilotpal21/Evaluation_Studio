import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import type {
  CallbackRegistry,
  FanOutBarrierStore,
  ResumeData,
  SuspendedExecution,
} from '@agent-platform/execution';
import { MemorySuspensionStore } from '../../services/execution/memory-suspension-store.js';
import { ResumptionService } from '../../services/execution/resumption-service.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import {
  startSuspensionTimeoutWorker,
  stopSuspensionTimeoutWorker,
} from '../../services/queues/suspension-timeout-worker.js';

const { mockRefreshSessionPIIContext } = vi.hoisted(() => ({
  mockRefreshSessionPIIContext: vi.fn(async (session: RuntimeSession) => session),
}));

vi.mock('../../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  refreshSessionPIIContext: mockRefreshSessionPIIContext,
}));

const mockSendTask = vi.fn();

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
    sendTaskAsync: vi.fn(),
    sendTaskStreaming: vi.fn(),
    SyncResponseForAsyncRequest: class extends Error {
      result: unknown;

      constructor(result: unknown) {
        super();
        this.result = result;
      }
    },
    createA2AClient: vi.fn(),
    createA2AClientWithAuth: vi.fn(),
    discoverAgent: vi.fn(),
    cancelRemoteTask: vi.fn().mockResolvedValue({ status: { state: 'canceled' } }),
    SsrfEndpointValidator: MockSsrfEndpointValidator,
    AgentCardCache: MockAgentCardCache,
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue({}),
}));

function createSession(): RuntimeSession {
  const threadData = {
    values: {},
    gatheredKeys: new Set<string>(),
  };

  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentName: 'SupervisorAgent',
    agentIR: {
      metadata: { name: 'SupervisorAgent', type: 'agent' },
      coordination: {
        handoffs: [
          {
            to: 'RemoteShippingAgent',
            return: true,
            on_return: 'resume_intent',
            context: { pass: [], history: 'summary_only' as const },
            remote: {
              location: 'remote' as const,
              endpoint: 'https://remote.example.com',
              protocol: 'a2a' as const,
            },
          },
        ],
      },
    } as RuntimeSession['agentIR'],
    compilationOutput: null,
    conversationHistory: [{ role: 'user', content: 'Where is my order?' }],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: threadData,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['RemoteShippingAgent'],
    delegateStack: [],
    threads: [
      {
        agentName: 'SupervisorAgent',
        agentIR: {
          metadata: { name: 'SupervisorAgent', type: 'agent' },
          coordination: {
            handoffs: [
              {
                to: 'RemoteShippingAgent',
                return: true,
                on_return: 'resume_intent',
                context: { pass: [], history: 'summary_only' as const },
                remote: {
                  location: 'remote' as const,
                  endpoint: 'https://remote.example.com',
                  protocol: 'a2a' as const,
                },
              },
            ],
          },
        } as RuntimeSession['agentIR'],
        conversationHistory: [{ role: 'user', content: 'Where is my order?' }],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: threadData,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'waiting',
      },
      {
        agentName: 'RemoteShippingAgent',
        agentIR: null,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: {
          values: {},
          gatheredKeys: new Set<string>(),
        },
        startedAt: Date.now(),
        returnExpected: true,
        handoffFrom: 'SupervisorAgent',
        status: 'suspended',
      },
    ],
    activeThreadIndex: 1,
    threadStack: [0],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as RuntimeSession;
}

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function addCustomContractPII(session: RuntimeSession): RuntimeSession {
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

  session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };
  session.piiRecognizerRegistry = registry;
  session.piiVault = new PIIVault({ recognizerRegistry: registry });
  session.piiPatternConfigs = [
    {
      patternName: 'ContractID',
      defaultRenderMode: 'redacted',
      consumerAccess: [],
    },
  ];

  return session;
}

function makeCompletedTask(text: string) {
  return {
    kind: 'task',
    id: 'task-1',
    status: {
      state: 'completed',
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{ kind: 'text', text }],
      },
    },
  };
}

function createRemoteHandoffSuspension(): SuspendedExecution {
  return {
    suspensionId: 'remote-handoff-suspension',
    executionId: 'remote-task-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    reason: {
      type: 'remote_handoff',
      target: 'RemoteShippingAgent',
      remoteTaskId: 'remote-task-1',
      callbackId: 'callback-1',
      timeout: 300,
    },
    continuation: {
      type: 'remote_handoff_result',
      targetAgent: 'RemoteShippingAgent',
      remoteThreadIndex: 1,
      parentThreadIndex: 0,
      returnExpected: true,
      remoteTaskId: 'remote-task-1',
    },
    channelBinding: {
      channelType: 'web_debug',
      tenantId: 'tenant-1',
      wsSessionId: 'session-1',
    },
    callbackId: 'callback-1',
    callbackSecret: 'secret',
    status: 'suspended',
    suspendedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
    resumeAttempts: 0,
  };
}

describe('async remote handoff resumption', () => {
  afterEach(() => {
    mockSendTask.mockReset();
    mockRefreshSessionPIIContext.mockReset();
    mockRefreshSessionPIIContext.mockImplementation(async (session: RuntimeSession) => session);
    vi.useRealTimers();
  });

  it('forwards remote handoff resume metadata through the executor', async () => {
    const suspensionStore = new MemorySuspensionStore();
    await suspensionStore.create(createRemoteHandoffSuspension());

    const session = createSession();
    const executor = {
      executeMessage: vi
        .fn()
        .mockImplementation(async (_sessionId, _text, _onChunk, onTraceEvent) => {
          onTraceEvent?.({
            type: 'llm_call',
            data: {
              tokensIn: 12,
              tokensOut: 34,
              responseContribution: 'customer_visible',
            },
          });
          return {
            response: 'Parent resumed after remote handoff',
            action: { type: 'continue' },
          };
        }),
      rehydrateSession: vi.fn().mockResolvedValue(session),
      saveSessionSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const callbackRegistry = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallbackRegistry;
    const barrierStore = {} as FanOutBarrierStore;
    const channelDispatcher = { deliver: vi.fn().mockResolvedValue(undefined) };
    const lockManager = {
      acquire: vi.fn().mockResolvedValue({ key: 'lock', owner: 'test' }),
      release: vi.fn().mockResolvedValue(undefined),
      extend: vi.fn().mockResolvedValue(true),
    };

    const service = new ResumptionService({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      channelDispatcher,
      executor,
      lockManager,
    });

    const resumeData: ResumeData = {
      type: 'remote_handoff_result',
      callbackId: 'callback-1',
      tenantId: 'tenant-1',
      payload: { status: 'completed', response: 'Remote shipment confirmed.' },
      receivedAt: Date.now(),
    };

    await service.resume('remote-handoff-suspension', resumeData);

    expect(executor.executeMessage).toHaveBeenCalledWith(
      'session-1',
      'Remote shipment confirmed.',
      undefined,
      expect.any(Function),
      {
        remoteHandoffResume: {
          targetAgent: 'RemoteShippingAgent',
          responseText: 'Remote shipment confirmed.',
          taskId: 'remote-task-1',
          status: 'completed',
        },
      },
    );
    expect(channelDispatcher.deliver).toHaveBeenCalledWith(
      createRemoteHandoffSuspension().channelBinding,
      'session-1',
      expect.objectContaining({
        response: 'Parent resumed after remote handoff',
        responseMetadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    );
  });

  it('preserves canonical responseMetadata when resume execution already finalized provenance', async () => {
    const suspensionStore = new MemorySuspensionStore();
    await suspensionStore.create(createRemoteHandoffSuspension());

    const session = createSession();
    const canonicalResponseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
      provenanceTag: 'canonical-resume',
    };

    const executor = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Parent resumed after remote handoff',
        action: { type: 'continue' },
        responseMetadata: canonicalResponseMetadata,
      }),
      rehydrateSession: vi.fn().mockResolvedValue(session),
      saveSessionSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const callbackRegistry = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallbackRegistry;
    const barrierStore = {} as FanOutBarrierStore;
    const channelDispatcher = { deliver: vi.fn().mockResolvedValue(undefined) };
    const lockManager = {
      acquire: vi.fn().mockResolvedValue({ key: 'lock', owner: 'test' }),
      release: vi.fn().mockResolvedValue(undefined),
      extend: vi.fn().mockResolvedValue(true),
    };

    const service = new ResumptionService({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      channelDispatcher,
      executor,
      lockManager,
    });

    const resumeData: ResumeData = {
      type: 'remote_handoff_result',
      callbackId: 'callback-1',
      tenantId: 'tenant-1',
      payload: { status: 'completed', response: 'Remote shipment confirmed.' },
      receivedAt: Date.now(),
    };

    await service.resume('remote-handoff-suspension', resumeData);

    expect(channelDispatcher.deliver).toHaveBeenCalledWith(
      createRemoteHandoffSuspension().channelBinding,
      'session-1',
      expect.objectContaining({
        response: 'Parent resumed after remote handoff',
        responseMetadata: canonicalResponseMetadata,
      }),
    );
  });

  it('preserves structured resume output through channel dispatch', async () => {
    const suspensionStore = new MemorySuspensionStore();
    await suspensionStore.create(createRemoteHandoffSuspension());

    const session = createSession();
    const structuredResumeResult = {
      response: 'Choose a delivery option',
      action: { type: 'continue' },
      richContent: { markdown: '**Delivery options**' },
      actions: {
        elements: [{ type: 'button', id: 'schedule', label: 'Schedule delivery' }],
      },
      voiceConfig: { plain_text: 'Choose a delivery option' },
      localization: {
        domain: 'project' as const,
        locale: 'en-US',
        messageKey: 'delivery.options',
      },
    };

    const executor = {
      executeMessage: vi.fn().mockResolvedValue(structuredResumeResult),
      rehydrateSession: vi.fn().mockResolvedValue(session),
      saveSessionSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const callbackRegistry = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallbackRegistry;
    const barrierStore = {} as FanOutBarrierStore;
    const channelDispatcher = { deliver: vi.fn().mockResolvedValue(undefined) };
    const lockManager = {
      acquire: vi.fn().mockResolvedValue({ key: 'lock', owner: 'test' }),
      release: vi.fn().mockResolvedValue(undefined),
      extend: vi.fn().mockResolvedValue(true),
    };

    const service = new ResumptionService({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      channelDispatcher,
      executor,
      lockManager,
    });

    await service.resume('remote-handoff-suspension', {
      type: 'remote_handoff_result',
      callbackId: 'callback-1',
      tenantId: 'tenant-1',
      payload: { status: 'completed', response: 'Remote shipment confirmed.' },
      receivedAt: Date.now(),
    });

    expect(channelDispatcher.deliver).toHaveBeenCalledWith(
      createRemoteHandoffSuspension().channelBinding,
      'session-1',
      expect.objectContaining({
        response: structuredResumeResult.response,
        richContent: structuredResumeResult.richContent,
        actions: structuredResumeResult.actions,
        voiceConfig: structuredResumeResult.voiceConfig,
        localization: structuredResumeResult.localization,
      }),
    );
  });

  it('queues timed-out remote handoffs for resume processing without expiring them first', async () => {
    vi.useFakeTimers();

    const suspensionStore = new MemorySuspensionStore();
    const suspension = {
      ...createRemoteHandoffSuspension(),
      expiresAt: new Date(Date.now() - 1_000),
    };
    await suspensionStore.create(suspension);

    const callbackRegistry = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallbackRegistry;
    const resumeDispatcher = {
      enqueueResume: vi.fn().mockResolvedValue(undefined),
    };
    const barrierStore = {} as FanOutBarrierStore;

    const timer = startSuspensionTimeoutWorker({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      resumeDispatcher,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    stopSuspensionTimeoutWorker(timer);

    expect(resumeDispatcher.enqueueResume).toHaveBeenCalledWith(
      'remote-handoff-suspension',
      expect.objectContaining({
        type: 'remote_handoff_result',
        payload: expect.objectContaining({ status: 'timeout' }),
      }),
    );
    expect((await suspensionStore.load('remote-handoff-suspension'))?.status).toBe('suspended');
  });

  it('restores the parent thread when runtime consumes a remote handoff resume payload', async () => {
    const { RuntimeExecutor } = await import('../../services/runtime-executor.js');

    const executor = new RuntimeExecutor();
    const mutableExecutor = executor as unknown as {
      sessions: Map<string, RuntimeSession>;
      checkAndRefreshIfStale: (session: RuntimeSession) => Promise<RuntimeSession>;
      saveSessionSnapshot: (session: RuntimeSession) => Promise<void>;
    };
    const session = createSession();
    session.tenantId = undefined;
    session.projectId = undefined;
    session.handoffStack = ['SupervisorAgent', 'RemoteShippingAgent'];
    session.agentIR = {
      metadata: { name: 'SupervisorAgent', type: 'agent' },
      coordination: {
        handoffs: [
          {
            to: 'RemoteShippingAgent',
            return: true,
            on_return: 'continue',
            context: { pass: [], history: 'summary_only' as const },
            remote: {
              location: 'remote' as const,
              endpoint: 'https://remote.example.com',
              protocol: 'a2a' as const,
            },
          },
        ],
      },
    } as RuntimeSession['agentIR'];
    session.threads[0].agentIR = session.agentIR;

    mutableExecutor.sessions.set(session.id, session);
    mutableExecutor.checkAndRefreshIfStale = vi.fn().mockResolvedValue(session);
    mutableExecutor.saveSessionSnapshot = vi.fn().mockResolvedValue(undefined);

    const result = await executor.executeMessage(
      session.id,
      'Remote shipment confirmed.',
      undefined,
      undefined,
      {
        remoteHandoffResume: {
          targetAgent: 'RemoteShippingAgent',
          responseText: 'Remote shipment confirmed.',
          taskId: 'remote-task-1',
          status: 'completed',
        },
      },
    );

    expect(result.response).toBe('Remote shipment confirmed.');
    expect(result.action).toEqual({ type: 'continue' });
    expect(session.activeThreadIndex).toBe(0);
    expect(session.agentName).toBe('SupervisorAgent');
    expect(session.threads[0].status).toBe('active');
    expect(session.threads[1].status).toBe('completed');
    expect(session.handoffStack).toEqual(['SupervisorAgent']);
    expect(session.threads[0].conversationHistory.at(-1)).toEqual({
      role: 'assistant',
      content: '[RemoteShippingAgent]: Remote shipment confirmed.',
      metadata: {
        isLlmGenerated: false,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'scripted',
          disclaimerRequired: false,
          usedLlmInternally: false,
        },
      },
    });
  });

  it('redacts custom-pattern async remote resume delivery while tokenizing thread history', async () => {
    const { RuntimeExecutor } = await import('../../services/runtime-executor.js');

    const executor = new RuntimeExecutor();
    const mutableExecutor = executor as unknown as {
      sessions: Map<string, RuntimeSession>;
      checkAndRefreshIfStale: (session: RuntimeSession) => Promise<RuntimeSession>;
      saveSessionSnapshot: (session: RuntimeSession) => Promise<void>;
    };
    const session = addCustomContractPII(createSession());
    session.handoffStack = ['SupervisorAgent', 'RemoteShippingAgent'];
    session.agentIR = {
      metadata: { name: 'SupervisorAgent', type: 'agent' },
      coordination: {
        handoffs: [
          {
            to: 'RemoteShippingAgent',
            return: true,
            on_return: 'continue',
            context: { pass: [], history: 'summary_only' as const },
            remote: {
              location: 'remote' as const,
              endpoint: 'https://remote.example.com',
              protocol: 'a2a' as const,
            },
          },
        ],
      },
    } as RuntimeSession['agentIR'];
    session.threads[0].agentIR = session.agentIR;

    mutableExecutor.sessions.set(session.id, session);
    mutableExecutor.checkAndRefreshIfStale = vi.fn().mockResolvedValue(session);
    mutableExecutor.saveSessionSnapshot = vi.fn().mockResolvedValue(undefined);
    const chunks: string[] = [];

    const result = await executor.executeMessage(
      session.id,
      `Contract ${rawContractId}`,
      (chunk) => chunks.push(chunk),
      undefined,
      {
        remoteHandoffResume: {
          targetAgent: 'RemoteShippingAgent',
          responseText: `Contract ${rawContractId}`,
          taskId: 'remote-task-1',
          status: 'completed',
        },
      },
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.threads[1].conversationHistory.at(-1)?.content)).toContain(
      '{{PII:ContractID:',
    );
    expect(String(session.threads[0].conversationHistory.at(-1)?.content)).toContain(
      '[RemoteShippingAgent]: Contract {{PII:ContractID:',
    );
  });

  it('redacts custom-pattern fire-and-forget resume delivery when no parent thread is available', async () => {
    const { RuntimeExecutor } = await import('../../services/runtime-executor.js');

    const executor = new RuntimeExecutor();
    const mutableExecutor = executor as unknown as {
      sessions: Map<string, RuntimeSession>;
      checkAndRefreshIfStale: (session: RuntimeSession) => Promise<RuntimeSession>;
      saveSessionSnapshot: (session: RuntimeSession) => Promise<void>;
    };
    const session = addCustomContractPII(createSession());
    session.threadStack = [];
    session.threads[1].returnExpected = false;

    mutableExecutor.sessions.set(session.id, session);
    mutableExecutor.checkAndRefreshIfStale = vi.fn().mockResolvedValue(session);
    mutableExecutor.saveSessionSnapshot = vi.fn().mockResolvedValue(undefined);
    const chunks: string[] = [];

    const result = await executor.executeMessage(
      session.id,
      `Contract ${rawContractId}`,
      (chunk) => chunks.push(chunk),
      undefined,
      {
        remoteHandoffResume: {
          targetAgent: 'RemoteShippingAgent',
          responseText: `Contract ${rawContractId}`,
          taskId: 'remote-task-1',
          status: 'completed',
        },
      },
    );

    expect(result.action).toEqual({ type: 'complete', message: 'Remote handoff completed' });
    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toBe('');
    expect(String(session.threads[1].conversationHistory.at(-1)?.content)).toContain(
      '{{PII:ContractID:',
    );
  });

  it('allows a fresh remote handoff to the same target after async resume returns to the parent', async () => {
    const { RuntimeExecutor } = await import('../../services/runtime-executor.js');

    mockSendTask.mockResolvedValue(makeCompletedTask('Remote shipment reconfirmed.'));

    const executor = new RuntimeExecutor();
    const mutableExecutor = executor as unknown as {
      sessions: Map<string, RuntimeSession>;
      checkAndRefreshIfStale: (session: RuntimeSession) => Promise<RuntimeSession>;
      saveSessionSnapshot: (session: RuntimeSession) => Promise<void>;
      routing: {
        handleHandoff: (
          session: RuntimeSession,
          input: { target: string; message: string },
        ) => Promise<{ success: boolean; response?: string; error?: string }>;
      };
    };
    const session = createSession();
    session.tenantId = undefined;
    session.projectId = undefined;
    session.handoffStack = ['SupervisorAgent', 'RemoteShippingAgent'];
    session.agentIR = {
      metadata: { name: 'SupervisorAgent', type: 'agent' },
      coordination: {
        handoffs: [
          {
            to: 'RemoteShippingAgent',
            return: true,
            on_return: 'continue',
            context: { pass: [], history: 'summary_only' as const },
            remote: {
              location: 'remote' as const,
              endpoint: 'https://remote.example.com',
              protocol: 'a2a' as const,
            },
          },
        ],
      },
    } as RuntimeSession['agentIR'];
    session.threads[0].agentIR = session.agentIR;

    mutableExecutor.sessions.set(session.id, session);
    mutableExecutor.checkAndRefreshIfStale = vi.fn().mockResolvedValue(session);
    mutableExecutor.saveSessionSnapshot = vi.fn().mockResolvedValue(undefined);

    await executor.executeMessage(session.id, 'Remote shipment confirmed.', undefined, undefined, {
      remoteHandoffResume: {
        targetAgent: 'RemoteShippingAgent',
        responseText: 'Remote shipment confirmed.',
        taskId: 'remote-task-1',
        status: 'completed',
      },
    });

    expect(session.handoffStack).toEqual(['SupervisorAgent']);

    const handleHandoff = mutableExecutor.routing.handleHandoff.bind(mutableExecutor.routing);
    const secondHandoff = await handleHandoff(session, {
      target: 'RemoteShippingAgent',
      message: 'Where is my replacement order?',
    });

    expect(secondHandoff.success).toBe(true);
    expect(secondHandoff.error).toBeUndefined();
    expect(secondHandoff.response).toBe('Remote shipment reconfirmed.');
    expect(session.agentName).toBe('SupervisorAgent');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.handoffStack).toEqual(['SupervisorAgent']);
    expect(session.threads).toHaveLength(3);
    expect(session.threads[2].agentName).toBe('RemoteShippingAgent');
    expect(session.threads[2].status).toBe('completed');
  });
});
