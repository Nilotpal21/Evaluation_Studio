/**
 * Delegate Safety Tests
 *
 * Tests for Fix 1 (cycle/depth guard) and Fix 2 (timeout with AbortSignal):
 * - Self-delegation returns failure
 * - Delegate cycle detection (A→B→A)
 * - Delegate depth limit (chain of 10+ delegates)
 * - delegateStack is pushed before execution and popped after success
 * - delegateStack is popped after failure/timeout
 * - Timeout triggers AbortSignal (mock executeMessage checks signal.aborted)
 * - Detached execution after timeout doesn't corrupt parent session state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import type {
  RuntimeSession,
  ExecutorContext,
  AgentRegistry,
  RuntimeExecutorConfig,
} from '../../services/execution/types.js';
import type { LLMWiringService } from '../../services/execution/llm-wiring.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'AgentA',
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
    storeVersion: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
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
  const agentRegistry: AgentRegistry = {
    AgentA: { dsl: '', ir: { name: 'AgentA' } as any },
    AgentB: { dsl: '', ir: { name: 'AgentB' } as any },
    AgentC: { dsl: '', ir: { name: 'AgentC' } as any },
  };

  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'delegate result',
      action: { type: 'respond' },
    }),
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry,
    sessions: new Map(),
    config: { timeoutMs: 30000 } as RuntimeExecutorConfig,
    reasoning: {
      execute: vi.fn(),
    },
    ...overrides,
  } as unknown as ExecutorContext;
}

function createMockLLMWiring(): LLMWiringService {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    wireToolExecutor: vi.fn(),
    clearCooldown: vi.fn(),
  } as unknown as LLMWiringService;
}

// =============================================================================
// SYSTEM AGENT REQUIRED PERMISSIONS
// =============================================================================

describe('Delegate Safety — System Agent Required Permissions', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;
  let runArchAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runArchAgent = vi.fn().mockResolvedValue({
      success: true,
      correlationId: 'corr-1',
      sessionId: 'arch-session-1',
      iterations: 1,
      events: [],
      data: {
        projectId: 'project-1',
        agents: [],
        topology: { agents: [], edges: [], entryPoint: '' },
      },
    });
    ctx = createMockExecutorContext({
      config: {
        timeoutMs: 30000,
        systemAgentHandlerDeps: {
          runArchAgent,
        },
      } as RuntimeExecutorConfig,
    });
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches system/arch when the session principal has project:write', async () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const session = createMockSession({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      permissions: ['project:write'],
    });

    const result = await executor.handleDelegate(
      session,
      {
        target: 'system/arch',
        input: {
          spec: {
            projectName: 'Allowed',
            description: 'Allowed system agent delegate',
          },
        },
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result.success).toBe(true);
    expect(runArchAgent).toHaveBeenCalledTimes(1);
    expect(runArchAgent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'project-1',
      permissions: ['project:write'],
    });
    expect(traceEvents.some((event) => event.data.error === 'permission_denied')).toBe(false);
  });

  it('uses the runtime session project scope even if delegate input includes another projectId', async () => {
    runArchAgent.mockResolvedValueOnce({
      success: true,
      correlationId: 'corr-scoped',
      sessionId: 'arch-session-scoped',
      iterations: 4,
      events: [],
      data: {
        projectId: 'project-1',
        agents: [{ name: 'scoped_agent' }],
        topology: {
          agents: [{ name: 'scoped_agent', role: 'Scoped', executionMode: 'reasoning' }],
          edges: [],
          entryPoint: 'scoped_agent',
        },
      },
    });
    const session = createMockSession({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      permissions: ['project:write'],
    });

    const result = await executor.handleDelegate(session, {
      target: 'system/arch',
      input: {
        projectId: 'other-project',
        spec: {
          projectName: 'Scoped',
          description: 'The delegate input project must not override runtime scope',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      projectId: 'project-1',
      agents: [{ name: 'scoped_agent' }],
    });
    expect(runArchAgent).toHaveBeenCalledTimes(1);
    expect(runArchAgent.mock.calls[0][0]).toMatchObject({ projectId: 'project-1' });
  });

  it('denies system/arch before dispatch when project:write is missing', async () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const session = createMockSession({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-2',
      permissions: ['project:read'],
    });

    const result = await executor.handleDelegate(
      session,
      {
        target: 'system/arch',
        input: {
          spec: {
            projectName: 'Denied',
            description: 'Denied system agent delegate',
          },
        },
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result).toEqual({
      success: false,
      error: "Permission denied: missing required permission 'project:write' for system/arch",
    });
    expect(runArchAgent).not.toHaveBeenCalled();
    expect(ctx.executeMessage).not.toHaveBeenCalled();
    expect(traceEvents).toEqual([
      {
        type: 'delegate_complete',
        data: expect.objectContaining({
          to: 'system/arch',
          success: false,
          systemAgent: true,
          error: 'permission_denied',
          principalId: 'user-2',
          missingPermission: 'project:write',
        }),
      },
    ]);
  });
});

// =============================================================================
// DELEGATE CYCLE/DEPTH GUARD (Fix 1)
// =============================================================================

describe('Delegate Safety — Cycle/Depth Guard', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  it('rejects self-delegation (AgentA delegates to AgentA)', async () => {
    const session = createMockSession({ agentName: 'AgentA' });

    const result = await executor.handleDelegate(session, {
      target: 'AgentA',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot delegate to yourself');
    // executeMessage should not have been called
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });

  it('rejects delegate cycle (A→B→A)', async () => {
    const session = createMockSession({
      agentName: 'AgentB',
      delegateStack: ['AgentA', 'AgentB'],
    });
    // Thread should show AgentB as active
    session.threads[0].agentName = 'AgentB';

    const result = await executor.handleDelegate(session, {
      target: 'AgentA',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegate cycle detected');
    expect(result.error).toContain('AgentA');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });

  it('rejects delegate depth exceeding MAX_DELEGATE_DEPTH (10)', async () => {
    const deepStack = Array.from({ length: 10 }, (_, i) => `Agent${i}`);
    const session = createMockSession({
      agentName: 'Agent10',
      delegateStack: deepStack,
    });
    session.threads[0].agentName = 'Agent10';

    const result = await executor.handleDelegate(session, {
      target: 'AgentNew',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegate depth limit reached');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });

  it('pushes to delegateStack before execution and pops after success', async () => {
    const session = createMockSession({ agentName: 'AgentA' });
    expect(session.delegateStack).toEqual([]);

    // Mock executeMessage to check delegateStack mid-execution
    let stackDuringExecution: string[] = [];
    (ctx.executeMessage as any).mockImplementation(async () => {
      stackDuringExecution = [...session.delegateStack];
      return { response: 'ok', action: { type: 'respond' } };
    });

    const result = await executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'do something',
    });

    expect(result.success).toBe(true);
    expect(stackDuringExecution).toContain('AgentB');
    // After success, stack should be popped
    expect(session.delegateStack).toEqual([]);
  });

  it('rewires tool execution for both the delegate child and the restored parent', async () => {
    const session = createMockSession({
      agentName: 'AgentA',
      compilationOutput: {
        agents: {
          AgentA: { metadata: { name: 'AgentA' }, tools: [{ name: 'shared_tool' }] },
          AgentB: { metadata: { name: 'AgentB' }, tools: [{ name: 'shared_tool' }] },
        },
      } as any,
    });
    const wiredAgentNames: string[] = [];
    const wireToolExecutor = llmWiring.wireToolExecutor as ReturnType<typeof vi.fn>;
    wireToolExecutor.mockImplementation((wiredSession: RuntimeSession) => {
      wiredAgentNames.push(wiredSession.agentName);
    });

    const result = await executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'do something',
    });

    expect(result.success).toBe(true);
    expect(wireToolExecutor).toHaveBeenCalledTimes(2);
    expect(wiredAgentNames).toEqual(['AgentB', 'AgentA']);
  });

  it('restores the parent activation auth context after delegate return', async () => {
    const session = createMockSession({
      agentName: 'AgentA',
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

    const result = await executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'do something',
    });

    expect(result.success).toBe(true);
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
        delegatedBy: ['root-session', 'test-session-1'],
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

  it('pops delegateStack after execution failure', async () => {
    const session = createMockSession({ agentName: 'AgentA' });

    (ctx.executeMessage as any).mockRejectedValue(new Error('LLM call failed'));

    const result = await executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'do something',
    });

    expect(result.success).toBe(false);
    // Stack should be cleaned up even on failure
    expect(session.delegateStack).toEqual([]);
  });
});

// =============================================================================
// DELEGATE TIMEOUT WITH ABORT SIGNAL (Fix 2)
// =============================================================================

describe('Delegate Safety — Timeout with AbortSignal', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes AbortSignal to executeMessage options', async () => {
    const session = createMockSession({ agentName: 'AgentA' });

    let receivedSignal: AbortSignal | undefined;
    (ctx.executeMessage as any).mockImplementation(
      async (
        _id: string,
        _msg: string,
        _chunk: any,
        _trace: any,
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal;
        return { response: 'ok', action: { type: 'respond' } };
      },
    );

    const resultPromise = executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'test',
    });

    // Advance timers so the Promise.race resolves
    await vi.advanceTimersByTimeAsync(0);
    await resultPromise;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('aborts executeMessage on timeout', async () => {
    const session = createMockSession({
      agentName: 'AgentA',
      agentIR: {
        name: 'AgentA',
        coordination: {
          delegates: [
            {
              agent: 'AgentB',
              when: '',
              purpose: 'test',
              input: {},
              returns: {},
              use_result: 'result',
              timeout: '100ms',
              on_failure: 'continue' as const,
            },
          ],
        },
      } as any,
    });

    let signalAborted = false;
    (ctx.executeMessage as any).mockImplementation(
      async (
        _id: string,
        _msg: string,
        _chunk: any,
        _trace: any,
        opts?: { signal?: AbortSignal },
      ) => {
        // Simulate long-running execution
        return new Promise((resolve) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              signalAborted = true;
            });
          }
          // Never resolve — will be aborted by timeout
        });
      },
    );

    const resultPromise = executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'test',
    });

    // Advance past the 100ms timeout
    await vi.advanceTimersByTimeAsync(150);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(signalAborted).toBe(true);
    // delegateStack should be cleaned up
    expect(session.delegateStack).toEqual([]);
  });

  it('severs shared references on timeout to prevent state corruption', async () => {
    const session = createMockSession({
      agentName: 'AgentA',
      agentIR: {
        name: 'AgentA',
        coordination: {
          delegates: [
            {
              agent: 'AgentB',
              when: '',
              purpose: 'test',
              input: {},
              returns: {},
              use_result: 'result',
              timeout: '50ms',
              on_failure: 'continue' as const,
            },
          ],
        },
      } as any,
    });

    (ctx.executeMessage as any).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    const resultPromise = executor.handleDelegate(session, {
      target: 'AgentB',
      input: {},
      message: 'test',
    });

    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    // The delegate thread (last in the array) should have severed references
    const delegateThread = session.threads[session.threads.length - 1];
    expect(delegateThread.conversationHistory).toEqual([]);
    expect(delegateThread.data.gatheredKeys.size).toBe(0);
    expect(Object.keys(delegateThread.data.values)).toEqual([]);
  });
});
