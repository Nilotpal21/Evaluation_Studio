/**
 * Tests for BaseRuntime
 *
 * Tests the abstract base runtime class that all runtimes (Digital, Voice, Workflow) extend.
 * Covers construction, agent registration, execution context building, trace lifecycle,
 * tenant isolation, and rate limiting.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  BaseRuntime,
  TenantAccessError,
  type BaseRuntimeConfig,
  type BuildContextParams,
  type RuntimeRateLimitConfig,
  type LegacyConstructExecutor,
} from '../../platform/runtimes/base-runtime.js';
import {
  createInitialState,
  type RuntimeType,
  type AgentState,
  type LLMClient,
  type ToolExecutor,
} from '../../platform/constructs/index.js';
import type { AgentIR, SupervisorIR } from '../../platform/ir/schema.js';
import type { TraceContextManager } from '../../platform/stores/trace-store.js';

// =============================================================================
// MOCK OBJECTS
// =============================================================================

const mockLLMClient: LLMClient = {
  chat: vi.fn(),
  chatWithTools: vi.fn(),
} as any;

const mockToolExecutor: ToolExecutor = {
  execute: vi.fn(),
} as any;

const mockTraceManager: TraceContextManager = {
  traceId: 'trace-123',
  spanId: 'span-456',
  logLLMCall: vi.fn().mockResolvedValue(undefined),
  logToolCall: vi.fn().mockResolvedValue(undefined),
  logDecision: vi.fn().mockResolvedValue(undefined),
  logConstraintCheck: vi.fn().mockResolvedValue(undefined),
  logHandoff: vi.fn().mockResolvedValue(undefined),
  logEscalation: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  createChildSpan: vi.fn(),
} as any;

function createMockStores() {
  return {
    conversationStore: {
      createSession: vi.fn(),
      getSession: vi.fn(),
      updateSession: vi.fn(),
    } as any,
    messageStore: {
      addMessage: vi.fn(),
      getMessages: vi.fn(),
      getMessageCount: vi.fn(),
      deleteBySession: vi.fn(),
      cleanup: vi.fn(),
    } as any,
    traceStore: {
      startTrace: vi.fn().mockReturnValue(mockTraceManager),
      appendEvent: vi.fn(),
      endTrace: vi.fn(),
      getTrace: vi.fn(),
      queryTraces: vi.fn(),
    } as any,
    auditStore: {
      log: vi.fn(),
      query: vi.fn(),
    } as any,
    factStore: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as any,
  };
}

function createMockExecutor(): LegacyConstructExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      action: { type: 'continue' },
      state: createInitialState(),
      phaseResults: {},
      metadata: {},
    }),
  };
}

function createMockConfig(overrides: Partial<BaseRuntimeConfig> = {}): BaseRuntimeConfig {
  return {
    environment: 'dev',
    toolTimeoutMs: 30000,
    llmTimeoutMs: 60000,
    model: 'gpt-4',
    ...overrides,
  };
}

function createMockAgentIR(name: string = 'test-agent'): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: '2024-01-01T00:00:00Z',
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {} as any,
    identity: {} as any,
    tools: [],
    gather: {} as any,
    memory: {} as any,
    constraints: {} as any,
    coordination: {} as any,
    completion: {} as any,
  } as any;
}

function createMockSupervisorIR(): SupervisorIR {
  return {
    ...createMockAgentIR('supervisor'),
    routing: { rules: [] } as any,
    available_agents: ['agent-a', 'agent-b'],
  } as any;
}

// =============================================================================
// CONCRETE TEST RUNTIME (since BaseRuntime is abstract)
// =============================================================================

class TestRuntime extends BaseRuntime {
  get runtimeType(): RuntimeType {
    return 'digital';
  }

  protected adaptLLMClient(): LLMClient {
    return mockLLMClient;
  }

  protected adaptToolExecutor(): ToolExecutor {
    return mockToolExecutor;
  }

  // Expose protected methods for testing
  public testBuildExecutionContext(params: BuildContextParams) {
    return this.buildExecutionContext(params);
  }

  public testAssertTenantAccess(resourceTenantId: string) {
    return this.assertTenantAccess(resourceTenantId);
  }

  public testScopeToTenant<T extends Record<string, unknown>>(query: T) {
    return this.scopeToTenant(query);
  }

  public testCheckRateLimit(operation: string) {
    return this.checkRateLimit(operation);
  }

  public testCreateInitialAgentState(initialContext?: Record<string, unknown>) {
    return this.createInitialAgentState(initialContext);
  }

  public testStartTrace(sessionId: string, agentName: string, agentVersion: string) {
    return this.startTrace(sessionId, agentName, agentVersion);
  }

  public testWithTraceLifecycle<T>(
    params: { sessionId: string; agentName: string; agentVersion: string },
    fn: (trace: TraceContextManager) => Promise<T>,
    onError?: (trace: TraceContextManager, error: unknown) => Promise<T>,
  ) {
    return this.withTraceLifecycle(params, fn, onError);
  }

  // Expose protected fields for assertions
  public getConfig() {
    return this.config;
  }
  public getConversationStore() {
    return this.conversationStore;
  }
  public getMessageStore() {
    return this.messageStore;
  }
  public getTraceStore() {
    return this.traceStore;
  }
  public getAuditStore() {
    return this.auditStore;
  }
  public getFactStore() {
    return this.factStore;
  }
  public getConstructExecutor() {
    return this.constructExecutor;
  }
  public getTenantContext() {
    return this.tenantContext;
  }
  public getAgentIRs() {
    return this.agentIRs;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('BaseRuntime', () => {
  let mockStores: ReturnType<typeof createMockStores>;
  let config: BaseRuntimeConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStores = createMockStores();
    config = createMockConfig();
  });

  // ===========================================================================
  // 1. Construction
  // ===========================================================================

  describe('Construction', () => {
    test('should store all provided stores', () => {
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime.getConfig()).toBe(config);
      expect(runtime.getConversationStore()).toBe(mockStores.conversationStore);
      expect(runtime.getMessageStore()).toBe(mockStores.messageStore);
      expect(runtime.getTraceStore()).toBe(mockStores.traceStore);
      expect(runtime.getAuditStore()).toBe(mockStores.auditStore);
      expect(runtime.getFactStore()).toBe(mockStores.factStore);
    });

    test('should throw if constructExecutor is not provided', () => {
      expect(
        () =>
          new TestRuntime(
            config,
            mockStores.conversationStore,
            mockStores.messageStore,
            mockStores.traceStore,
            mockStores.auditStore,
            mockStores.factStore,
          ),
      ).toThrow('constructExecutor is required');
    });

    test('should use provided constructExecutor', () => {
      const customExecutor = createMockExecutor();
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: customExecutor },
      );

      expect(runtime.getConstructExecutor()).toBe(customExecutor);
    });

    test('should set tenantContext when config.tenantId is provided', () => {
      const tenantConfig = createMockConfig({ tenantId: 'tenant-abc' });
      const runtime = new TestRuntime(
        tenantConfig,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime.getTenantContext()).toEqual({ tenantId: 'tenant-abc' });
    });

    test('should not set tenantContext when config.tenantId is not provided', () => {
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime.getTenantContext()).toBeUndefined();
    });

    test('should extend EventEmitter', () => {
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime).toBeInstanceOf(EventEmitter);
    });

    test('should initialize with empty agentIRs map', () => {
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime.getAgentIRs().size).toBe(0);
    });
  });

  // ===========================================================================
  // 2. Agent Registration
  // ===========================================================================

  describe('Agent Registration', () => {
    let runtime: TestRuntime;

    beforeEach(() => {
      runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );
    });

    test('registerAgent should store agent IR by name', () => {
      const agentIR = createMockAgentIR('booking-agent');
      runtime.registerAgent(agentIR);

      expect(runtime.getAgentIR('booking-agent')).toBe(agentIR);
    });

    test('registerAgent should overwrite existing agent with same name', () => {
      const agentIR1 = createMockAgentIR('my-agent');
      const agentIR2 = createMockAgentIR('my-agent');
      runtime.registerAgent(agentIR1);
      runtime.registerAgent(agentIR2);

      expect(runtime.getAgentIR('my-agent')).toBe(agentIR2);
      expect(runtime.getAgentIRs().size).toBe(1);
    });

    test('getAgentIR should return undefined for unregistered agent', () => {
      expect(runtime.getAgentIR('nonexistent')).toBeUndefined();
    });

    test('registerAgents should register multiple agents by name', () => {
      const agentA = createMockAgentIR('agent-a');
      const agentB = createMockAgentIR('agent-b');

      runtime.registerAgents({ 'agent-a': agentA, 'agent-b': agentB });

      expect(runtime.getAgentIR('agent-a')).toBe(agentA);
      expect(runtime.getAgentIR('agent-b')).toBe(agentB);
      expect(runtime.getAgentIRs().size).toBe(2);
    });

    test('registerAgents should register supervisors in the unified agents map', () => {
      const supervisor = createMockSupervisorIR();
      const agents = {
        'agent-a': createMockAgentIR('agent-a'),
        supervisor: supervisor,
      };

      runtime.registerAgents(agents);

      expect(runtime.getAgentIR('supervisor')).toBe(supervisor);
      expect(runtime.getAgentIR('agent-a')).toBeDefined();
      expect(runtime.getAgentIRs().size).toBe(2);
    });

    test('supervisor registered via registerAgents should retain routing and available_agents', () => {
      const supervisor = createMockSupervisorIR();
      const agents = {
        'agent-a': createMockAgentIR('agent-a'),
        supervisor: supervisor,
      };

      runtime.registerAgents(agents);

      const retrieved = runtime.getAgentIR('supervisor') as SupervisorIR;
      expect(retrieved.routing).toEqual({ rules: [] });
      expect(retrieved.available_agents).toEqual(['agent-a', 'agent-b']);
    });

    test('registerAgents with empty record should not add agents', () => {
      runtime.registerAgents({});
      expect(runtime.getAgentIRs().size).toBe(0);
    });
  });

  // ===========================================================================
  // 3. Execution Context
  // ===========================================================================

  describe('Execution Context', () => {
    let runtime: TestRuntime;

    beforeEach(() => {
      runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );
    });

    test('buildExecutionContext should produce correct shape', () => {
      const agentIR = createMockAgentIR('test-agent');
      const state = createInitialState();
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR,
        state,
        runtimeType: 'digital',
        trace: mockTraceManager,
        userInput: 'Hello',
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.sessionId).toBe('session-1');
      expect(ctx.agentIR).toBe(agentIR);
      expect(ctx.state).toBe(state);
      expect(ctx.runtime).toBe('digital');
      expect(ctx.trace).toBe(mockTraceManager);
      expect(ctx.userInput).toBe('Hello');
      expect(ctx.llmClient).toBe(mockLLMClient);
      expect(ctx.toolExecutor).toBe(mockToolExecutor);
    });

    test('buildExecutionContext should include store context with all stores', () => {
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.stores.conversation).toBe(mockStores.conversationStore);
      expect(ctx.stores.message).toBe(mockStores.messageStore);
      expect(ctx.stores.fact).toBe(mockStores.factStore);
      expect(ctx.stores.trace).toBe(mockStores.traceStore);
      expect(ctx.stores.audit).toBe(mockStores.auditStore);
    });

    test('buildExecutionContext should include config from runtime config', () => {
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.config.environment).toBe('dev');
      expect(ctx.config.toolTimeoutMs).toBe(30000);
      expect(ctx.config.llmTimeoutMs).toBe(60000);
      expect(ctx.config.model).toBe('gpt-4');
    });

    test('buildExecutionContext should merge extraConfig into config', () => {
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
        extraConfig: { model: 'claude-3', maxParallelTools: 5 },
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.config.model).toBe('claude-3');
      expect(ctx.config.maxParallelTools).toBe(5);
      // Other config values should remain from runtime config
      expect(ctx.config.toolTimeoutMs).toBe(30000);
    });

    test('buildExecutionContext should provide working agentRegistry', () => {
      const agentA = createMockAgentIR('agent-a');
      const agentB = createMockAgentIR('agent-b');
      runtime.registerAgent(agentA);
      runtime.registerAgent(agentB);

      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      // getAgentIR returns registered agent or null
      expect(ctx.agentRegistry.getAgentIR('agent-a')).toBe(agentA);
      expect(ctx.agentRegistry.getAgentIR('nonexistent')).toBeNull();

      // listAgents returns all registered agent names
      expect(ctx.agentRegistry.listAgents()).toContain('agent-a');
      expect(ctx.agentRegistry.listAgents()).toContain('agent-b');

      // hasAgent checks existence
      expect(ctx.agentRegistry.hasAgent('agent-a')).toBe(true);
      expect(ctx.agentRegistry.hasAgent('nonexistent')).toBe(false);
    });

    test('buildExecutionContext should pass nluEngine and messageHistory when provided', () => {
      const mockNLU = { classify: vi.fn() } as any;
      const messageHistory = [
        { role: 'user' as const, content: 'Hi' },
        { role: 'assistant' as const, content: 'Hello!' },
      ];

      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
        nluEngine: mockNLU,
        messageHistory,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.nluEngine).toBe(mockNLU);
      expect(ctx.messageHistory).toBe(messageHistory);
    });

    test('buildExecutionContext should have undefined nluEngine and messageHistory when not provided', () => {
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state: createInitialState(),
        runtimeType: 'digital',
        trace: mockTraceManager,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.nluEngine).toBeUndefined();
      expect(ctx.messageHistory).toBeUndefined();
    });

    test('buildExecutionContext should merge handoffContext into state.context', () => {
      const state = createInitialState({ existingKey: 'existingValue' });
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state,
        runtimeType: 'digital',
        trace: mockTraceManager,
        handoffContext: { destination: 'Paris', travelers: 12 },
      };

      const ctx = runtime.testBuildExecutionContext(params);

      // Handoff context should be merged into state.context
      expect(ctx.state.context).toEqual({
        existingKey: 'existingValue',
        destination: 'Paris',
        travelers: 12,
      });
      // Original state should not be mutated
      expect(state.context).toEqual({ existingKey: 'existingValue' });
    });

    test('buildExecutionContext should not modify state when handoffContext is empty', () => {
      const state = createInitialState({ key: 'value' });
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state,
        runtimeType: 'digital',
        trace: mockTraceManager,
        handoffContext: {},
      };

      const ctx = runtime.testBuildExecutionContext(params);

      // Should be the same object reference (no unnecessary copy)
      expect(ctx.state).toBe(state);
    });

    test('buildExecutionContext should not modify state when handoffContext is undefined', () => {
      const state = createInitialState({ key: 'value' });
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state,
        runtimeType: 'digital',
        trace: mockTraceManager,
      };

      const ctx = runtime.testBuildExecutionContext(params);

      expect(ctx.state).toBe(state);
    });

    test('buildExecutionContext handoffContext should override existing context keys', () => {
      const state = createInitialState({ destination: 'London', budget: 500 });
      const params: BuildContextParams = {
        sessionId: 'session-1',
        agentIR: createMockAgentIR(),
        state,
        runtimeType: 'digital',
        trace: mockTraceManager,
        handoffContext: { destination: 'Paris' },
      };

      const ctx = runtime.testBuildExecutionContext(params);

      // Handoff context wins for overlapping keys
      expect(ctx.state.context).toEqual({
        destination: 'Paris',
        budget: 500,
      });
    });
  });

  // ===========================================================================
  // 4. Initial State
  // ===========================================================================

  describe('Initial State', () => {
    let runtime: TestRuntime;

    beforeEach(() => {
      runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );
    });

    test('createInitialAgentState should return a valid initial state', () => {
      const state = runtime.testCreateInitialAgentState();

      expect(state.context).toEqual({});
      expect(state.conversationPhase).toBe('start');
      expect(state.gatherProgress).toEqual({});
      expect(state.constraintResults).toEqual({});
      expect(state.lastToolResults).toEqual({});
      expect(state.memory).toEqual({
        session: {},
        persistentCache: {},
        pendingRemembers: [],
      });
    });

    test('createInitialAgentState should include initial context when provided', () => {
      const initialContext = { customerId: 'cust-123', locale: 'en-US' };
      const state = runtime.testCreateInitialAgentState(initialContext);

      expect(state.context).toEqual({ customerId: 'cust-123', locale: 'en-US' });
      // Other state fields should still be defaults
      expect(state.conversationPhase).toBe('start');
      expect(state.gatherProgress).toEqual({});
    });

    test('createInitialAgentState without context should match createInitialState()', () => {
      const stateFromRuntime = runtime.testCreateInitialAgentState();
      const stateFromFactory = createInitialState();

      expect(stateFromRuntime).toEqual(stateFromFactory);
    });
  });

  // ===========================================================================
  // 5. Trace Lifecycle
  // ===========================================================================

  describe('Trace Lifecycle', () => {
    let runtime: TestRuntime;

    beforeEach(() => {
      runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );
    });

    test('startTrace should delegate to traceStore.startTrace', () => {
      const trace = runtime.testStartTrace('session-1', 'my-agent', '1.0.0');

      expect(mockStores.traceStore.startTrace).toHaveBeenCalledWith({
        sessionId: 'session-1',
        agentName: 'my-agent',
        agentVersion: '1.0.0',
        environment: 'dev',
      });
      expect(trace).toBe(mockTraceManager);
    });

    test('withTraceLifecycle should call fn with trace and return result on success', async () => {
      const fn = vi.fn().mockResolvedValue('result-value');

      const result = await runtime.testWithTraceLifecycle(
        { sessionId: 'session-1', agentName: 'my-agent', agentVersion: '1.0.0' },
        fn,
      );

      expect(result).toBe('result-value');
      expect(fn).toHaveBeenCalledWith(mockTraceManager);
    });

    test('withTraceLifecycle should call trace.end() on success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');

      await runtime.testWithTraceLifecycle(
        { sessionId: 's1', agentName: 'a1', agentVersion: '1.0' },
        fn,
      );

      expect(mockTraceManager.end).toHaveBeenCalled();
    });

    test('withTraceLifecycle should log error and rethrow when fn fails without onError', async () => {
      const error = new Error('Processing failed');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        runtime.testWithTraceLifecycle(
          { sessionId: 's1', agentName: 'a1', agentVersion: '1.0' },
          fn,
        ),
      ).rejects.toThrow('Processing failed');

      expect(mockTraceManager.logError).toHaveBeenCalledWith(
        'processing_error',
        'Processing failed',
        error.stack,
      );
    });

    test('withTraceLifecycle should call trace.end() even on error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      await expect(
        runtime.testWithTraceLifecycle(
          { sessionId: 's1', agentName: 'a1', agentVersion: '1.0' },
          fn,
        ),
      ).rejects.toThrow();

      expect(mockTraceManager.end).toHaveBeenCalled();
    });

    test('withTraceLifecycle should call onError handler and return its result when provided', async () => {
      const error = new Error('Recoverable error');
      const fn = vi.fn().mockRejectedValue(error);
      const onError = vi.fn().mockResolvedValue('fallback-result');

      const result = await runtime.testWithTraceLifecycle(
        { sessionId: 's1', agentName: 'a1', agentVersion: '1.0' },
        fn,
        onError,
      );

      expect(result).toBe('fallback-result');
      expect(onError).toHaveBeenCalledWith(mockTraceManager, error);
      expect(mockTraceManager.logError).toHaveBeenCalled();
      expect(mockTraceManager.end).toHaveBeenCalled();
    });

    test('withTraceLifecycle should log "Unknown error" for non-Error exceptions', async () => {
      const fn = vi.fn().mockRejectedValue('string-error');

      await expect(
        runtime.testWithTraceLifecycle(
          { sessionId: 's1', agentName: 'a1', agentVersion: '1.0' },
          fn,
        ),
      ).rejects.toBe('string-error');

      expect(mockTraceManager.logError).toHaveBeenCalledWith(
        'processing_error',
        'Unknown error',
        undefined,
      );
    });
  });

  // ===========================================================================
  // 6. Tenant Isolation
  // ===========================================================================

  describe('Tenant Isolation', () => {
    test('assertTenantAccess should allow access when tenant matches', () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-A' }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      // Should not throw
      expect(() => runtime.testAssertTenantAccess('tenant-A')).not.toThrow();
    });

    test('assertTenantAccess should throw TenantAccessError when tenant does not match', () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-A' }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(() => runtime.testAssertTenantAccess('tenant-B')).toThrow(TenantAccessError);
      expect(() => runtime.testAssertTenantAccess('tenant-B')).toThrow(
        /Tenant tenant-A cannot access resource tenant-B/,
      );
    });

    test('assertTenantAccess should be a no-op when tenantContext is not configured', () => {
      const runtime = new TestRuntime(
        createMockConfig(), // no tenantId
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      // Should not throw for any tenant ID
      expect(() => runtime.testAssertTenantAccess('any-tenant')).not.toThrow();
    });
  });

  // ===========================================================================
  // 7. Scope to Tenant
  // ===========================================================================

  describe('Scope to Tenant', () => {
    test('scopeToTenant should add tenantId to query when tenant is configured', () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-X' }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const result = runtime.testScopeToTenant({ projectId: 'proj-1', status: 'active' });

      expect(result).toEqual({
        projectId: 'proj-1',
        status: 'active',
        tenantId: 'tenant-X',
      });
    });

    test('scopeToTenant should return original query when tenant is not configured', () => {
      const runtime = new TestRuntime(
        createMockConfig(), // no tenantId
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const query = { projectId: 'proj-1' };
      const result = runtime.testScopeToTenant(query);

      expect(result).toEqual({ projectId: 'proj-1' });
    });

    test('scopeToTenant should override existing tenantId in query', () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-X' }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const result = runtime.testScopeToTenant({ tenantId: 'tenant-old', name: 'test' });

      expect(result.tenantId).toBe('tenant-X');
    });

    test('scopeToTenant should not mutate the original query', () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-X' }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const original = { key: 'value' };
      runtime.testScopeToTenant(original);

      expect(original).toEqual({ key: 'value' });
      expect((original as any).tenantId).toBeUndefined();
    });
  });

  // ===========================================================================
  // 8. Rate Limiting
  // ===========================================================================

  describe('Rate Limiting', () => {
    test('checkRateLimit should emit event when rate limiting and tenant are configured', async () => {
      const rateLimiting: RuntimeRateLimitConfig = {
        requestsPerMinute: 100,
        tokensPerMinute: 50000,
        concurrentSessions: 10,
        toolCallsPerMinute: 200,
      };

      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-A', rateLimiting }),
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const emitSpy = vi.fn();
      runtime.on('rateLimit:check', emitSpy);

      await runtime.testCheckRateLimit('chat_message');

      expect(emitSpy).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        operation: 'chat_message',
        config: rateLimiting,
      });
    });

    test('checkRateLimit should be a no-op when rate limiting is not configured', async () => {
      const runtime = new TestRuntime(
        createMockConfig({ tenantId: 'tenant-A' }), // no rateLimiting
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const emitSpy = vi.fn();
      runtime.on('rateLimit:check', emitSpy);

      await runtime.testCheckRateLimit('chat_message');

      expect(emitSpy).not.toHaveBeenCalled();
    });

    test('checkRateLimit should be a no-op when tenant is not configured', async () => {
      const rateLimiting: RuntimeRateLimitConfig = {
        requestsPerMinute: 100,
        tokensPerMinute: 50000,
        concurrentSessions: 10,
        toolCallsPerMinute: 200,
      };

      const runtime = new TestRuntime(
        createMockConfig({ rateLimiting }), // no tenantId
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const emitSpy = vi.fn();
      runtime.on('rateLimit:check', emitSpy);

      await runtime.testCheckRateLimit('chat_message');

      expect(emitSpy).not.toHaveBeenCalled();
    });

    test('checkRateLimit should be a no-op when neither tenant nor rate limiting are configured', async () => {
      const runtime = new TestRuntime(
        createMockConfig(), // no tenantId, no rateLimiting
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      const emitSpy = vi.fn();
      runtime.on('rateLimit:check', emitSpy);

      await runtime.testCheckRateLimit('chat_message');

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 9. TenantAccessError
  // ===========================================================================

  describe('TenantAccessError', () => {
    test('should have name "TenantAccessError"', () => {
      const error = new TenantAccessError('load', 'tenant-A', 'resource-1');
      expect(error.name).toBe('TenantAccessError');
    });

    test('should have correct message', () => {
      const error = new TenantAccessError('load', 'tenant-A', 'resource-1');
      expect(error.message).toBe(
        'Tenant tenant-A cannot load resource resource-1: cross-tenant access denied',
      );
    });

    test('should be an instance of Error', () => {
      const error = new TenantAccessError('delete', 'tenant-A', 'resource-1');
      expect(error).toBeInstanceOf(Error);
    });

    test('should have a stack trace', () => {
      const error = new TenantAccessError('access', 'tenant-A', 'resource-1');
      expect(error.stack).toBeDefined();
    });

    test('should expose typed fields', () => {
      const error = new TenantAccessError('load', 'tenant-A', 'resource-1');
      expect(error.operation).toBe('load');
      expect(error.tenantId).toBe('tenant-A');
      expect(error.resourceId).toBe('resource-1');
      expect(error.code).toBe('TENANT_ACCESS_DENIED');
      expect(error.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // Additional: runtimeType
  // ===========================================================================

  describe('runtimeType', () => {
    test('should return the runtime type from the concrete implementation', () => {
      const runtime = new TestRuntime(
        config,
        mockStores.conversationStore,
        mockStores.messageStore,
        mockStores.traceStore,
        mockStores.auditStore,
        mockStores.factStore,
        { constructExecutor: createMockExecutor() },
      );

      expect(runtime.runtimeType).toBe('digital');
    });
  });
});
