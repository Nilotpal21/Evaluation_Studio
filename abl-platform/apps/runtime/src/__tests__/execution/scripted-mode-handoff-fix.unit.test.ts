/**
 * Scripted Mode Handoff Fix — Unit Tests
 *
 * Task 3.1: Add test: scripted child via handoff executes flow
 *
 * Verifies that when a supervisor hands off to a scripted child agent:
 *   - session.currentFlowStep is defined after handoff
 *   - wireLLMClient is NOT called (flow path, not reasoning)
 *
 * Requirements: 1.1, 1.4, 5.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS — hoisted before any module evaluation
// =============================================================================

vi.mock('@abl/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler')>();
  return {
    ...actual,
    GuardrailPipelineImpl: class MockGuardrailPipeline {
      async execute() {
        return { passed: true };
      }
    },
  };
});

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
      setCorrelationId: vi.fn(),
    }),
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue({ allowLocalhost: false }),
  SsrfEndpointValidator: class MockSsrfValidator {
    validate = vi.fn();
  },
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import {
  createInitialThread,
  type RuntimeSession,
  type ExecutorContext,
  type AgentRegistry,
} from '../../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

function createMockLLMWiring() {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    wireToolExecutor: vi.fn(),
    ensureSessionLLMClient: vi.fn(),
    loadEnvironmentVariables: vi.fn().mockResolvedValue({}),
    clearCooldown: vi.fn(),
  };
}

function createMockContext(agentRegistry: AgentRegistry): ExecutorContext {
  return {
    executeMessage: vi.fn().mockResolvedValue({ response: 'ok', action: { type: 'complete' } }),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: (template: string) => template,
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry,
    sessions: new Map<string, RuntimeSession>(),
    config: { maxConcurrentFanOutCalls: 10 },
  };
}

// BACKWARD COMPAT: Tests that old IR blobs with execution.mode still work.
// Mode is deprecated — new IR derives from flow presence.
function buildScriptedAgentIR(agentName: string, entryStep: string): AgentIR {
  return {
    metadata: { name: agentName, type: 'agent', version: '1.0' },
    identity: { goal: 'Handle scripted flow' },
    execution: { mode: 'scripted' }, // BACKWARD COMPAT: testing old IR format
    flow: {
      entry_point: entryStep,
      steps: [entryStep],
    },
    messages: {},
  } as unknown as AgentIR;
}

// BACKWARD COMPAT: Tests that old IR blobs with execution.mode still work.
// Mode is deprecated — new IR derives from flow presence.
function buildReasoningAgentIR(agentName: string): AgentIR {
  return {
    metadata: { name: agentName, type: 'agent', version: '1.0' },
    identity: { goal: 'Handle reasoning tasks' },
    execution: { mode: 'reasoning' }, // BACKWARD COMPAT: testing old IR format
    messages: {},
  } as unknown as AgentIR;
}

function buildDefaultModeAgentIR(agentName: string): AgentIR {
  return {
    metadata: { name: agentName, type: 'agent', version: '1.0' },
    identity: { goal: 'Handle tasks' },
    // No execution.mode field — defaults to reasoning behavior per Req 4.3
    messages: {},
  } as unknown as AgentIR;
}

function buildMultiStepScriptedAgentIR(agentName: string): AgentIR {
  return {
    metadata: { name: agentName, type: 'agent', version: '1.0' },
    identity: { goal: 'Handle multi-step scripted flow with collect blocks' },
    execution: { mode: 'scripted' },
    flow: {
      entry_point: 'greet',
      steps: ['greet', 'collect_info', 'complete'],
      definitions: {
        greet: { name: 'greet', respond: 'Hello!', then: 'collect_info' },
        collect_info: {
          name: 'collect_info',
          gather: {
            fields: [
              { name: 'user_name', prompt: 'What is your name?' },
              { name: 'user_email', prompt: 'What is your email?' },
            ],
          },
          then: 'complete',
        },
        complete: { name: 'complete', respond: 'Done!', then: 'COMPLETE' },
      },
    },
    messages: {},
  } as unknown as AgentIR;
}

function buildHybridAgentIR(agentName: string): AgentIR {
  return {
    metadata: { name: agentName, type: 'agent', version: '1.0' },
    identity: { goal: 'Handle hybrid flow with reasoning zone steps' },
    flow: {
      entry_point: 'greet',
      steps: ['greet', 'reason', 'complete'],
      definitions: {
        greet: { name: 'greet', respond: 'Hello!', then: 'reason' },
        reason: {
          name: 'reason',
          reasoning_zone: { goal: 'Analyze the request', max_turns: 3 },
          then: 'complete',
        },
        complete: { name: 'complete', respond: 'Done!', then: 'COMPLETE' },
      },
    },
    messages: {},
  } as unknown as AgentIR;
}

function buildSupervisorAgentIR(supervisorName: string, targetAgentName: string): AgentIR {
  return {
    metadata: { name: supervisorName, type: 'supervisor', version: '1.0' },
    identity: { goal: 'Route to child agents' },
    execution: { mode: 'reasoning' },
    routing: {
      rules: [{ to: targetAgentName, when: 'true', description: 'Route to child' }],
    },
    messages: {},
  } as unknown as AgentIR;
}

function createSupervisorSession(
  supervisorName: string,
  supervisorIR: AgentIR,
  targetAgentName: string,
): RuntimeSession {
  const session: RuntimeSession = {
    id: `session-${Math.random().toString(36).slice(2)}`,
    agentName: supervisorName,
    agentIR: supervisorIR,
    compilationOutput: null,
    conversationHistory: [{ role: 'user', content: 'please route me' }],
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
    handoffStack: [supervisorName],
    handoffReturnInfo: { [targetAgentName]: false },
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    // Pre-set llmClient so the end-of-handoff re-wiring fallback doesn't fire
    llmClient: {} as any,
  };

  createInitialThread(session);
  return session;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Scripted Mode Handoff Fix — Unit Tests', () => {
  /**
   * Task 3.1: Scripted child via handoff executes flow
   *
   * Requirements: 1.1, 1.4, 5.1
   */
  describe('3.1 Scripted child via handoff executes flow', () => {
    it('sets session.currentFlowStep after handoff to scripted child', async () => {
      const childIR = buildScriptedAgentIR('BookingAgent', 'collect_details');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'BookingAgent');

      const agentRegistry: AgentRegistry = {
        BookingAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'BookingAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'BookingAgent' });

      expect(result.success).toBe(true);
      // Req 2.2: handleHandoff syncs session.currentFlowStep from newThread.currentFlowStep
      expect(session.currentFlowStep).toBeDefined();
      // Req 1.2: currentFlowStep equals the child's flow.entry_point
      expect(session.currentFlowStep).toBe('collect_details');
    });

    it('does NOT call wireLLMClient for scripted child (flow path, not reasoning)', async () => {
      const childIR = buildScriptedAgentIR('SupportAgent', 'greet');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'SupportAgent');

      const agentRegistry: AgentRegistry = {
        SupportAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'SupportAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'SupportAgent' });

      expect(result.success).toBe(true);
      // Req 1.3, 3.1, 3.2: wireLLMClient SHALL NOT be called for scripted child
      expect(llmWiring.wireLLMClient).not.toHaveBeenCalled();
    });

    it('sets active agent mode to scripted after handoff', async () => {
      const childIR = buildScriptedAgentIR('FlowAgent', 'start');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'FlowAgent');

      const agentRegistry: AgentRegistry = {
        FlowAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'FlowAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'FlowAgent' });

      expect(result.success).toBe(true);
      // Req 1.1: Runtime executes scripted child using Flow_Executor
      expect(session.state.activeAgent?.mode).toBe('scripted');
    });

    it('routes to flow executor (not reasoning) — currentFlowStep defined means flow path', async () => {
      // Req 2.3: executeMessage routes to executeFlowStep when currentFlowStep is defined
      // We verify this indirectly: currentFlowStep is set, wireLLMClient is not called
      const childIR = buildScriptedAgentIR('OrderAgent', 'take_order');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'OrderAgent');

      const agentRegistry: AgentRegistry = {
        OrderAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'OrderAgent');
      llmWiring.wireLLMClient.mockClear();

      await routing.handleHandoff(session, { target: 'OrderAgent' });

      // Both conditions must hold for flow path to be taken in executeMessage:
      // 1. currentFlowStep is defined (routes to executeFlowStep)
      // 2. wireLLMClient not called (no reasoning prompt built)
      expect(session.currentFlowStep).toBeDefined();
      expect(llmWiring.wireLLMClient).not.toHaveBeenCalled();
    });
  });

  /**
   * Task 3.2: Reasoning child via handoff still works
   *
   * Requirements: 4.1, 4.2
   */
  describe('3.2 Reasoning child via handoff still works', () => {
    it('calls wireLLMClient for reasoning child (backward compatibility)', async () => {
      // Req 4.1: Runtime SHALL continue to execute reasoning child via Reasoning_Executor
      // Req 4.2: Runtime SHALL build reasoning-style System_Prompt as before
      const childIR = buildReasoningAgentIR('AnalyticsAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'AnalyticsAgent');

      const agentRegistry: AgentRegistry = {
        AnalyticsAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'AnalyticsAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'AnalyticsAgent' });

      expect(result.success).toBe(true);
      // Req 4.2: wireLLMClient SHALL be called for reasoning child
      expect(llmWiring.wireLLMClient).toHaveBeenCalled();
    });

    it('does NOT set session.currentFlowStep for reasoning child', async () => {
      // Req 4.1: reasoning child uses Reasoning_Executor, not Flow_Executor
      // currentFlowStep undefined means executeMessage routes to reasoning.execute
      const childIR = buildReasoningAgentIR('SalesAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'SalesAgent');

      const agentRegistry: AgentRegistry = {
        SalesAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'SalesAgent');

      const result = await routing.handleHandoff(session, { target: 'SalesAgent' });

      expect(result.success).toBe(true);
      // Req 2.3 (inverse): currentFlowStep undefined → reasoning path in executeMessage
      expect(session.currentFlowStep).toBeUndefined();
    });

    it('sets active agent mode to reasoning after handoff', async () => {
      // Req 4.1: Runtime SHALL continue to execute reasoning child via Reasoning_Executor
      const childIR = buildReasoningAgentIR('SupportAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'SupportAgent');

      const agentRegistry: AgentRegistry = {
        SupportAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'SupportAgent');

      const result = await routing.handleHandoff(session, { target: 'SupportAgent' });

      expect(result.success).toBe(true);
      expect(session.state.activeAgent?.mode).toBe('reasoning');
    });

    it('wireLLMClient called AND currentFlowStep undefined — confirms reasoning execution path', async () => {
      // Both conditions must hold for reasoning path to be taken in executeMessage:
      // 1. wireLLMClient called (reasoning prompt built — Req 4.2)
      // 2. currentFlowStep undefined (routes to reasoning.execute — Req 4.1)
      const childIR = buildReasoningAgentIR('ResearchAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'ResearchAgent');

      const agentRegistry: AgentRegistry = {
        ResearchAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'ResearchAgent');
      llmWiring.wireLLMClient.mockClear();

      await routing.handleHandoff(session, { target: 'ResearchAgent' });

      expect(llmWiring.wireLLMClient).toHaveBeenCalled();
      expect(session.currentFlowStep).toBeUndefined();
    });
  });

  /**
   * Task 5.1: Multi-step scripted child via handoff
   *
   * Requirements: 1.4, 5.1, 5.2, 5.3
   */
  describe('5.1 Multi-step scripted child via handoff', () => {
    it('sets session.currentFlowStep to entry step after handoff', async () => {
      // Req 5.1: Runtime SHALL execute steps sequentially according to flow transitions
      // Req 1.4: Flow_Executor SHALL process Flow_Steps as defined in the agent's IR
      const childIR = buildMultiStepScriptedAgentIR('BookingAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'BookingAgent');

      const agentRegistry: AgentRegistry = {
        BookingAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'BookingAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'BookingAgent' });

      expect(result.success).toBe(true);
      // Req 2.2: session.currentFlowStep synced from newThread.currentFlowStep
      // Req 1.2: currentFlowStep equals the child's flow.entry_point
      expect(session.currentFlowStep).toBe('greet');
    });

    it('does NOT call wireLLMClient for multi-step scripted child', async () => {
      // Req 1.3, 3.2: wireLLMClient SHALL NOT be called for scripted child
      // Flow executor builds its own prompts per step
      const childIR = buildMultiStepScriptedAgentIR('BookingAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'BookingAgent');

      const agentRegistry: AgentRegistry = {
        BookingAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'BookingAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'BookingAgent' });

      expect(result.success).toBe(true);
      expect(llmWiring.wireLLMClient).not.toHaveBeenCalled();
    });

    it('flow structure has multiple steps defined (entry → collect → complete)', async () => {
      // Req 5.1: multi-step flow is preserved in the IR after handoff
      // Req 5.2: COLLECT blocks are defined in the flow structure
      const childIR = buildMultiStepScriptedAgentIR('BookingAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'BookingAgent');

      const agentRegistry: AgentRegistry = {
        BookingAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'BookingAgent');

      const result = await routing.handleHandoff(session, { target: 'BookingAgent' });

      expect(result.success).toBe(true);

      // Verify the active thread's agentIR has the full multi-step flow structure
      const activeThread = session.threads[session.activeThreadIndex];
      expect(activeThread).toBeDefined();
      expect(activeThread.agentIR?.flow?.steps).toHaveLength(3);
      expect(activeThread.agentIR?.flow?.steps).toEqual(['greet', 'collect_info', 'complete']);

      // Req 5.2: COLLECT block is defined for the collect_info step (inside flow.definitions)
      expect(
        (activeThread.agentIR as any)?.flow?.definitions?.collect_info?.gather?.fields,
      ).toHaveLength(2);
    });

    it('session is initialized for flow execution (currentFlowStep set, wireLLMClient not called)', async () => {
      // Combined assertion: both conditions must hold for flow path to be taken
      // Req 5.1: sequential step execution starts from entry_point
      // Req 5.2: COLLECT blocks will be processed by flow executor
      const childIR = buildMultiStepScriptedAgentIR('SupportAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'SupportAgent');

      const agentRegistry: AgentRegistry = {
        SupportAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'SupportAgent');
      llmWiring.wireLLMClient.mockClear();

      await routing.handleHandoff(session, { target: 'SupportAgent' });

      // currentFlowStep defined → executeMessage routes to executeFlowStep (Req 2.3)
      expect(session.currentFlowStep).toBe('greet');
      // wireLLMClient not called → no reasoning prompt built (Req 1.3, 3.2)
      expect(llmWiring.wireLLMClient).not.toHaveBeenCalled();
    });
  });

  /**
   * Task 3.3: Default mode child treated as reasoning
   *
   * Requirements: 4.3
   */
  describe('3.3 Default mode child treated as reasoning', () => {
    it('calls wireLLMClient when child has no explicit execution.mode', async () => {
      // Req 4.3: When no explicit mode is specified, Runtime SHALL default to reasoning behavior
      const childIR = buildDefaultModeAgentIR('DefaultAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'DefaultAgent');

      const agentRegistry: AgentRegistry = {
        DefaultAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'DefaultAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'DefaultAgent' });

      expect(result.success).toBe(true);
      // Req 4.3: default mode → reasoning path → wireLLMClient SHALL be called
      expect(llmWiring.wireLLMClient).toHaveBeenCalled();
    });

    it('does NOT set session.currentFlowStep when child has no explicit execution.mode', async () => {
      // Req 4.3: default mode → reasoning path → currentFlowStep stays undefined
      const childIR = buildDefaultModeAgentIR('DefaultAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'DefaultAgent');

      const agentRegistry: AgentRegistry = {
        DefaultAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'DefaultAgent');

      const result = await routing.handleHandoff(session, { target: 'DefaultAgent' });

      expect(result.success).toBe(true);
      // Req 4.3: no mode → not scripted → currentFlowStep undefined (reasoning path)
      expect(session.currentFlowStep).toBeUndefined();
    });

    it('wireLLMClient called AND currentFlowStep undefined — confirms default mode takes reasoning path', async () => {
      // Req 4.3: Both conditions confirm reasoning execution path for default-mode child
      const childIR = buildDefaultModeAgentIR('UnspecifiedAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'UnspecifiedAgent');

      const agentRegistry: AgentRegistry = {
        UnspecifiedAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'UnspecifiedAgent');
      llmWiring.wireLLMClient.mockClear();

      await routing.handleHandoff(session, { target: 'UnspecifiedAgent' });

      // Req 4.3: default (undefined) mode is treated as reasoning
      expect(llmWiring.wireLLMClient).toHaveBeenCalled();
      expect(session.currentFlowStep).toBeUndefined();
    });
  });

  /**
   * Hybrid agent: flow with reasoning_zone steps
   *
   * A hybrid agent has a flow (so it's flow-driven) but some steps have reasoning_zone.
   * The flow executor needs an LLM client to execute those steps.
   */
  describe('Hybrid agent (flow + reasoning_zone steps)', () => {
    it('calls wireLLMClient for hybrid agent (has flow with reasoning_zone steps)', async () => {
      const childIR = buildHybridAgentIR('HybridAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'HybridAgent');

      const agentRegistry: AgentRegistry = {
        HybridAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'HybridAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'HybridAgent' });

      expect(result.success).toBe(true);
      // Hybrid agent has reasoning_zone steps → wireLLMClient MUST be called
      expect(llmWiring.wireLLMClient).toHaveBeenCalled();
    });

    it('sets session.currentFlowStep for hybrid agent (still flow-driven)', async () => {
      const childIR = buildHybridAgentIR('HybridAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'HybridAgent');

      const agentRegistry: AgentRegistry = {
        HybridAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'HybridAgent');

      const result = await routing.handleHandoff(session, { target: 'HybridAgent' });

      expect(result.success).toBe(true);
      // Hybrid agent is still flow-driven → currentFlowStep is set
      expect(session.currentFlowStep).toBe('greet');
    });

    it('sets active agent mode to scripted for hybrid agent (flow-driven)', async () => {
      const childIR = buildHybridAgentIR('HybridAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'HybridAgent');

      const agentRegistry: AgentRegistry = {
        HybridAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'HybridAgent');

      const result = await routing.handleHandoff(session, { target: 'HybridAgent' });

      expect(result.success).toBe(true);
      // Hybrid agent is flow-driven → mode is 'scripted'
      expect(session.state.activeAgent?.mode).toBe('scripted');
    });

    it('pure scripted (no reasoning_zone steps) does NOT call wireLLMClient', async () => {
      // Regression: ensure pure scripted agents are unaffected by the hybrid check
      const childIR = buildMultiStepScriptedAgentIR('PureScriptedAgent');
      const supervisorIR = buildSupervisorAgentIR('Supervisor', 'PureScriptedAgent');

      const agentRegistry: AgentRegistry = {
        PureScriptedAgent: { dsl: '', ir: childIR, location: 'local' },
      };

      const llmWiring = createMockLLMWiring();
      const ctx = createMockContext(agentRegistry);
      const routing = new RoutingExecutor(ctx, llmWiring as any);

      const session = createSupervisorSession('Supervisor', supervisorIR, 'PureScriptedAgent');
      llmWiring.wireLLMClient.mockClear();

      const result = await routing.handleHandoff(session, { target: 'PureScriptedAgent' });

      expect(result.success).toBe(true);
      // Pure scripted → no reasoning_zone steps → wireLLMClient NOT called
      expect(llmWiring.wireLLMClient).not.toHaveBeenCalled();
    });
  });
});
