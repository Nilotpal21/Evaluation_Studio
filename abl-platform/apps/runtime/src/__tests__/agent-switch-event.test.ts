/**
 * Agent Switch Event — verifies that the RoutingExecutor emits an `agent_switch`
 * trace event when a handoff switches the active agent. This event allows
 * SSE/WebSocket consumers to surface the active agent identity (e.g.,
 * "Advisor Agent is typing...").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must appear before any imports that pull the mocked modules
// ---------------------------------------------------------------------------

const mockCompilerState = vi.hoisted(() => ({
  handoffValidationResult: {
    allowed: true,
    returnExpected: false,
  },
}));

vi.mock('@abl/compiler', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    evaluateConditionDual: vi.fn(() => false),
    interpolateMessage: (msg: string) => msg,
    DEFAULT_MESSAGES: {
      ...(actual.DEFAULT_MESSAGES as Record<string, string> | undefined),
      conversation_complete: 'This conversation has been completed.',
    },
    ESCALATION_FORMAT: {},
    ESCALATION_REASON_MIN_LENGTH: 10,
    ESCALATION_REASON_MAX_LENGTH: 500,
    CompletionDetector: class {
      detect() {
        return null;
      }
      check() {
        return { shouldComplete: false };
      }
    },
    HandoffExecutor: class {
      validate() {
        return { ...mockCompilerState.handoffValidationResult };
      }
    },
    DelegateExecutor: class {
      validate() {
        return { allowed: true };
      }
      execute() {
        return { delegated: false };
      }
    },
  };
});

vi.mock('@abl/compiler/platform', () => ({
  KNOWLEDGE_CATALOG: {
    version: 'test',
    constructs: [
      {
        name: 'MEMORY',
        fields: [{ name: 'session', type: 'MemoryVariable[]', required: false }],
        examples: ['MEMORY:\n  session: []'],
      },
    ],
    validCombinations: [],
    cel: { perContextAllowlist: {}, functions: [] },
    validationCodes: {},
    runtimeFeasibilityChecks: [],
    crossConstructMandatories: [],
  },
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/a2a', () => ({
  sendTask: vi.fn(),
  SsrfEndpointValidator: vi.fn(),
  createA2AClient: vi.fn(),
  AgentCardCache: vi.fn(),
}));

vi.mock('@agent-platform/shared/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn(() => ({})),
}));

vi.mock('@agent-platform/execution', () => {
  class MockInProcessExecutionRuntime {}
  class MockCountingSemaphore {
    acquire = vi.fn();
    release = vi.fn();
  }
  return {
    InProcessExecutionRuntime: MockInProcessExecutionRuntime,
    CountingSemaphore: MockCountingSemaphore,
    createChildSession: vi.fn(),
    createChildSessionForFanOut: vi.fn(),
    createExecutionId: vi.fn(() => 'exec-id'),
  };
});

vi.mock('../services/execution/llm-wiring.js', () => ({
  LLMWiringService: vi.fn(),
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: vi.fn(() => false),
}));

vi.mock('../services/execution/prompt-template-loader.js', () => ({
  promptTemplateLoader: { load: vi.fn() },
}));

vi.mock('../services/execution/memory-integration.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initializeActivatedAgentMemory: vi.fn().mockResolvedValue(undefined),
    executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../services/execution/multi-intent-strategy.js', () => ({
  resolveStrategy: vi.fn(),
}));

vi.mock('../services/execution/intent-queue.js', () => ({
  enqueueIntents: vi.fn(),
  createIntentQueue: vi.fn(),
}));

vi.mock('../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(),
  createLLMEvalFromClient: vi.fn(),
}));

vi.mock('../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn(() => null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../services/auth-profile/auth-preflight.js', () => ({
  createTokenLookups: vi.fn(() => ({
    hasSessionToken: vi.fn(),
    hasUserToken: vi.fn(),
    hasTenantToken: vi.fn(),
  })),
  evaluateAuthPreflightFromIR: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Real imports — after mocks
// ---------------------------------------------------------------------------

import { RoutingExecutor } from '../services/execution/routing-executor.js';
import type {
  RuntimeSession,
  ExecutorContext,
  RuntimeExecutorConfig,
  AgentRegistryEntry,
} from '../services/execution/types.js';

// =============================================================================
// HELPERS
// =============================================================================

type TraceEvent = { type: string; data: Record<string, unknown> };

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'Supervisor',
    agentIR: null,
    compilationOutput: null,
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
    ...overrides,
  };

  if (session.threads.length === 0) {
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
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

function createMockExecutorContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'child response',
      action: { type: 'continue' },
    }),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn(() => null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    persistSession: vi.fn(),
    agentRegistry: {},
    sessions: new Map(),
    config: {} as RuntimeExecutorConfig,
    reasoning: {
      execute: vi.fn(),
    },
    ...overrides,
  } as unknown as ExecutorContext;
}

// =============================================================================
// TESTS
// =============================================================================

describe('agent_switch trace event on handoff', () => {
  beforeEach(() => {
    mockCompilerState.handoffValidationResult.allowed = true;
    mockCompilerState.handoffValidationResult.returnExpected = false;
  });

  it('emits agent_switch with agentName, previousAgent, and mode when handoff succeeds', async () => {
    const targetIR = {
      ir_version: '1.0',
      metadata: { name: 'AdvisorAgent', version: '1.0', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { role: 'advisor' },
      tools: [],
      coordination: {},
    };

    const agentRegistry: Record<string, AgentRegistryEntry> = {
      AdvisorAgent: {
        dsl: 'AGENT AdvisorAgent',
        ir: targetIR as any,
      },
    };

    const ctx = createMockExecutorContext({ agentRegistry });
    const llmWiring = { wireLLMClient: vi.fn().mockResolvedValue(undefined) } as any;
    const executor = new RoutingExecutor(ctx, llmWiring);

    const session = createMockSession({
      agentName: 'Supervisor',
      agentIR: {
        coordination: {
          handoffs: [{ to: 'AdvisorAgent', when: 'always' }],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;

    const traces: TraceEvent[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'AdvisorAgent', context: {}, message: 'help me' },
      (chunk: string) => {
        /* noop */
      },
      (event: TraceEvent) => traces.push(event),
    );

    expect(result.success).toBe(true);

    // Find the agent_switch event
    const switchEvent = traces.find((t) => t.type === 'agent_switch');
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.data.agentName).toBe('AdvisorAgent');
    expect(switchEvent!.data.previousAgent).toBe('Supervisor');
    expect(switchEvent!.data.mode).toBe('reasoning');
  });

  it('rewires the tool executor for the activated handoff target', async () => {
    const targetIR = {
      ir_version: '1.0',
      metadata: { name: 'AdvisorAgent', version: '1.0', type: 'agent' },
      identity: { role: 'advisor' },
      tools: [{ name: 'lookup_customer', tool_type: 'http' }],
      coordination: {},
    };

    const agentRegistry: Record<string, AgentRegistryEntry> = {
      AdvisorAgent: {
        dsl: 'AGENT AdvisorAgent',
        ir: targetIR as any,
      },
    };

    const ctx = createMockExecutorContext({ agentRegistry });
    const llmWiring = {
      wireLLMClient: vi.fn().mockResolvedValue(undefined),
      wireToolExecutor: vi.fn(),
    } as any;
    const executor = new RoutingExecutor(ctx, llmWiring);

    const session = createMockSession({
      agentName: 'Supervisor',
      compilationOutput: {
        agents: {
          Supervisor: { metadata: { name: 'Supervisor' }, tools: [] },
          AdvisorAgent: targetIR,
        },
      } as any,
      agentIR: {
        coordination: {
          handoffs: [{ to: 'AdvisorAgent', when: 'always' }],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;

    const result = await executor.handleHandoff(
      session,
      { target: 'AdvisorAgent', context: {}, message: 'help me' },
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(llmWiring.wireToolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'AdvisorAgent',
      }),
      session.compilationOutput,
      undefined,
      undefined,
      undefined,
    );
  });

  it('restores the parent activation auth context after a RETURN:true handoff completes', async () => {
    const targetIR = {
      ir_version: '1.0',
      metadata: { name: 'AdvisorAgent', version: '1.0', type: 'agent' },
      identity: { role: 'advisor' },
      tools: [{ name: 'lookup_customer', tool_type: 'http' }],
      coordination: {},
    };

    const agentRegistry: Record<string, AgentRegistryEntry> = {
      AdvisorAgent: {
        dsl: 'AGENT AdvisorAgent',
        ir: targetIR as any,
      },
    };

    const ctx = createMockExecutorContext({
      agentRegistry,
      executeMessage: vi.fn().mockResolvedValue({
        response: 'child resolved it',
        action: { type: 'complete' },
      }),
    });
    const wiredAgentNames: string[] = [];
    const llmWiring = {
      wireLLMClient: vi.fn().mockResolvedValue(undefined),
      wireToolExecutor: vi.fn().mockImplementation((wiredSession: RuntimeSession) => {
        wiredAgentNames.push(wiredSession.agentName);
      }),
    } as any;
    const executor = new RoutingExecutor(ctx, llmWiring);

    const session = createMockSession({
      agentName: 'Supervisor',
      compilationOutput: {
        agents: {
          Supervisor: { metadata: { name: 'Supervisor' }, tools: [] },
          AdvisorAgent: targetIR,
        },
      } as any,
      agentIR: {
        coordination: {
          handoffs: [{ to: 'AdvisorAgent', when: 'always', return: true }],
        },
      } as any,
      _activationAuthContext: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        authToken: 'auth-token-1',
        authScope: 'user',
        delegatedBy: ['root-session'],
        callerContext: {
          authScope: 'user',
          channel: 'chat',
        },
      } as RuntimeSession['_activationAuthContext'],
    });
    session.threads[0].agentIR = session.agentIR;

    const result = await executor.handleHandoff(
      session,
      { target: 'AdvisorAgent', context: {}, message: 'help me' },
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(session.agentName).toBe('Supervisor');
    expect(wiredAgentNames).toEqual(['AdvisorAgent', 'Supervisor']);
    expect(session.threads[0]?.activationAuthContext).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        delegatedBy: ['root-session'],
      }),
    );
    expect(session.threads[1]?.activationAuthContext).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        delegatedBy: ['root-session'],
      }),
    );
    expect(session._activationAuthContext).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        delegatedBy: ['root-session'],
      }),
    );
  });

  it('emits agent_switch with mode "scripted" for flow-based agents', async () => {
    const targetIR = {
      ir_version: '1.0',
      metadata: { name: 'FlowAgent', version: '1.0', type: 'agent' },
      execution: { mode: 'scripted' },
      identity: { role: 'flow' },
      tools: [],
      coordination: {},
      flow: {
        entry_point: 'step1',
        steps: ['step1'],
        definitions: {
          step1: { type: 'respond', message: 'Hello' },
        },
      },
    };

    const agentRegistry: Record<string, AgentRegistryEntry> = {
      FlowAgent: {
        dsl: 'AGENT FlowAgent',
        ir: targetIR as any,
      },
    };

    // For flow agents, executeMessage is called on the child session.
    // It needs to set session.isComplete to true and return a response.
    const mockExecuteMessage = vi.fn().mockImplementation(async (sessionId: string) => {
      // Find the session and mark it complete (simulates flow execution)
      const session = sessionsMap.get(sessionId);
      if (session) {
        session.isComplete = true;
      }
      return {
        response: 'Flow done',
        action: { type: 'complete' },
      };
    });

    const sessionsMap = new Map<string, RuntimeSession>();
    const ctx = createMockExecutorContext({
      agentRegistry,
      executeMessage: mockExecuteMessage,
      sessions: sessionsMap,
    });
    const llmWiring = { wireLLMClient: vi.fn().mockResolvedValue(undefined) } as any;
    const executor = new RoutingExecutor(ctx, llmWiring);

    const session = createMockSession({
      agentName: 'MainAgent',
      agentIR: {
        coordination: {
          handoffs: [{ to: 'FlowAgent' }],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    sessionsMap.set(session.id, session);

    const traces: TraceEvent[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'FlowAgent', context: {} },
      undefined,
      (event: TraceEvent) => traces.push(event),
    );

    expect(result.success).toBe(true);
    const switchEvent = traces.find((t) => t.type === 'agent_switch');
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.data.agentName).toBe('FlowAgent');
    expect(switchEvent!.data.mode).toBe('scripted');
  });

  it('does not emit agent_switch when handoff target is not found', async () => {
    const ctx = createMockExecutorContext({ agentRegistry: {} });
    const llmWiring = { wireLLMClient: vi.fn() } as any;
    const executor = new RoutingExecutor(ctx, llmWiring);

    const session = createMockSession({ agentName: 'Supervisor' });

    const traces: TraceEvent[] = [];

    const result = await executor.handleHandoff(
      session,
      { target: 'NonExistentAgent', context: {} },
      undefined,
      (event: TraceEvent) => traces.push(event),
    );

    expect(result.success).toBe(false);

    // agent_switch should NOT be emitted since the handoff failed
    const switchEvent = traces.find((t) => t.type === 'agent_switch');
    expect(switchEvent).toBeUndefined();
  });
});
