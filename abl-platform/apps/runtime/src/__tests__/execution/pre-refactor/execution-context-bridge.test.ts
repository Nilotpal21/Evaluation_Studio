/**
 * Pre-Refactor Test: Execution Context Bridge
 *
 * Validates the mapping between RuntimeSession (runtime layer) and
 * ExecutionContext (compiler/construct layer). This bridge is the
 * foundation for delegating execution to construct executors.
 */

import { describe, test, expect } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import type { ExecutionContext, ConstructResult, AgentState } from '@abl/compiler';
import {
  createBaseSession,
  createBaseState,
  createBaseDataStore,
} from './helpers/test-session-factory.js';
import {
  buildExecutionContext,
  applyExecutionResult,
  type BridgeDeps,
} from '../../../services/execution/execution-context-bridge.js';

// =============================================================================
// FIXTURES
// =============================================================================

function createMinimalAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    name: 'TestAgent',
    goal: 'Test goal',
    execution_mode: 'reasoning',
    tools: [],
    constraints: [],
    ...overrides,
  } as AgentIR;
}

function createMinimalDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    toolExecutor: {
      execute: async () => ({}),
      executeParallel: async () => [],
    },
    llmClient: {
      chat: async () => '',
      chatWithTools: async () => ({ toolCalls: [], stopReason: 'end_turn' as const }),
      extractJson: async () => ({}),
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Execution Context Bridge', () => {
  // ---------------------------------------------------------------------------
  // buildExecutionContext — field mapping
  // ---------------------------------------------------------------------------

  describe('buildExecutionContext', () => {
    test('maps session.id to context.sessionId', () => {
      const session = createBaseSession({
        id: 'sess-abc-123',
        agentIR: createMinimalAgentIR(),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.sessionId).toBe('sess-abc-123');
    });

    test('maps agentIR correctly', () => {
      const ir = createMinimalAgentIR({ name: 'MyAgent', goal: 'Do things' });
      const session = createBaseSession({ agentIR: ir });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.agentIR).toBe(ir);
      expect(ctx.agentIR.name).toBe('MyAgent');
      expect(ctx.agentIR.goal).toBe('Do things');
    });

    test('maps state: gatherProgress, conversationPhase, context', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        state: createBaseState({
          gatherProgress: { name: 'Alice', age: 30 },
          conversationPhase: 'gathering',
          context: { intent: 'book_flight' },
        }),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.state.gatherProgress).toEqual({ name: 'Alice', age: 30 });
      expect(ctx.state.conversationPhase).toBe('gathering');
      expect(ctx.state.context).toEqual(expect.objectContaining({ intent: 'book_flight' }));
    });

    test('maps data store values into state context', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        data: createBaseDataStore({
          values: { city: 'NYC', date: '2026-01-01' },
          gatheredKeys: new Set(['city', 'date']),
        }),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.state.context).toEqual(
        expect.objectContaining({ city: 'NYC', date: '2026-01-01' }),
      );
    });

    test('maps data store gatheredKeys into state gatherProgress', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        data: createBaseDataStore({
          values: { name: 'Bob', email: 'bob@test.com', _computed: 'ignore' },
          gatheredKeys: new Set(['name', 'email']),
        }),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      // gatherProgress should contain only gathered keys with their values
      expect(ctx.state.gatherProgress).toEqual(
        expect.objectContaining({ name: 'Bob', email: 'bob@test.com' }),
      );
      expect(ctx.state.gatherProgress).not.toHaveProperty('_computed');
    });

    test('maps conversationHistory to messageHistory format', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        conversationHistory: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'Book a flight' },
        ],
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.messageHistory).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'Book a flight' },
      ]);
    });

    test('handles null agentIR gracefully by throwing', () => {
      const session = createBaseSession({ agentIR: null });
      expect(() => buildExecutionContext(session, createMinimalDeps())).toThrow(
        /agentIR.*required|no.*agent.*IR/i,
      );
    });

    test('handles empty conversation history', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        conversationHistory: [],
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.messageHistory).toEqual([]);
    });

    test('passes through toolExecutor from deps', () => {
      const mockExecutor = {
        execute: async () => ({ result: 'mock' }),
        executeParallel: async () => [],
      };
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(session, createMinimalDeps({ toolExecutor: mockExecutor }));
      expect(ctx.toolExecutor).toBe(mockExecutor);
    });

    test('passes through llmClient from deps', () => {
      const mockClient = {
        chat: async () => 'response',
        chatWithTools: async () => ({ toolCalls: [], stopReason: 'end_turn' as const }),
        extractJson: async () => ({}),
      };
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(session, createMinimalDeps({ llmClient: mockClient }));
      expect(ctx.llmClient).toBe(mockClient);
    });

    test('maps tenantId and projectId from session', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        tenantId: 'tenant-abc',
        projectId: 'project-xyz',
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.tenantId).toBe('tenant-abc');
      expect(ctx.projectId).toBe('project-xyz');
    });

    test('tenantId and projectId are undefined when not set on session', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.tenantId).toBeUndefined();
      expect(ctx.projectId).toBeUndefined();
    });

    test('sets runtime to digital by default', () => {
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.runtime).toBe('digital');
    });

    test('sets runtime to voice when channelType starts with voice', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        channelType: 'voice_twilio',
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.runtime).toBe('voice');
    });

    test('wires trace from deps when provided', () => {
      const mockTrace = {
        startSpan: () => ({ end: () => {} }),
        getCurrentSpan: () => undefined,
        addEvent: () => {},
        logConstraintCheck: () => {},
        traceId: 'test-trace-id',
      };
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(session, createMinimalDeps({ trace: mockTrace as any }));
      expect(ctx.trace).toBe(mockTrace);
    });

    test('uses stub trace when deps.trace is not provided', () => {
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      // Stub trace should have startSpan that returns an object with end()
      expect(ctx.trace).toBeDefined();
      expect(typeof (ctx.trace as any).startSpan).toBe('function');
    });

    test('wires stores from deps when provided', () => {
      const mockConversationStore = { create: async () => ({}) };
      const session = createBaseSession({ agentIR: createMinimalAgentIR() });
      const ctx = buildExecutionContext(
        session,
        createMinimalDeps({ stores: { conversation: mockConversationStore as any } }),
      );
      expect(ctx.stores.conversation).toBe(mockConversationStore);
    });

    test('wires fact store from session.factStore when deps.stores.fact not provided', () => {
      const mockFactStore = { get: async () => null, set: async () => {} };
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        factStore: mockFactStore as any,
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.stores.fact).toBe(mockFactStore);
    });

    test('resolves model from session.resolvedModelId', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        resolvedModelId: 'gpt-4o',
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.config.model).toBe('gpt-4o');
    });

    test('resolves model from agentIR.model when resolvedModelId not set', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR({
          execution: { model: 'claude-haiku-4-5-20251001', hints: {}, timeouts: {} },
        } as any),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.config.model).toBe('claude-haiku-4-5-20251001');
    });

    test('falls back to default model when no model configured', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      // Should fall back to config default or hardcoded fallback
      expect(ctx.config.model).toBeDefined();
      expect(typeof ctx.config.model).toBe('string');
      expect(ctx.config.model!.length).toBeGreaterThan(0);
    });

    test('merges session state context with data store values (data store wins)', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        state: createBaseState({
          context: { existingKey: 'from-state', shared: 'state-value' },
        }),
        data: createBaseDataStore({
          values: { shared: 'data-value', newKey: 'from-data' },
          gatheredKeys: new Set(['shared', 'newKey']),
        }),
      });
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.state.context).toEqual(
        expect.objectContaining({
          existingKey: 'from-state',
          shared: 'data-value',
          newKey: 'from-data',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // applyExecutionResult — mapping result back to session
  // ---------------------------------------------------------------------------

  describe('applyExecutionResult', () => {
    test('updates session state from ConstructResult stateUpdates', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        state: createBaseState({ conversationPhase: 'start' }),
      });

      const result: ConstructResult = {
        action: { type: 'continue' },
        stateUpdates: {
          conversationPhase: 'gathering',
          gatherProgress: { name: 'Alice' },
          context: { intent: 'booking' },
        },
      };

      applyExecutionResult(session, result);

      expect(session.state.conversationPhase).toBe('gathering');
      expect(session.state.gatherProgress).toEqual({ name: 'Alice' });
      expect(session.state.context).toEqual(expect.objectContaining({ intent: 'booking' }));
    });

    test('updates data store values from stateUpdates context', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
      });

      const result: ConstructResult = {
        action: { type: 'continue' },
        stateUpdates: {
          context: { city: 'London', date: '2026-06-01' },
        },
      };

      applyExecutionResult(session, result);

      expect(session.data.values).toEqual(
        expect.objectContaining({ city: 'London', date: '2026-06-01' }),
      );
    });

    test('updates data store gathered keys from stateUpdates gatherProgress', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
      });

      const result: ConstructResult = {
        action: { type: 'continue' },
        stateUpdates: {
          gatherProgress: { name: 'Charlie', email: 'c@test.com' },
        },
      };

      applyExecutionResult(session, result);

      expect(session.data.gatheredKeys.has('name')).toBe(true);
      expect(session.data.gatheredKeys.has('email')).toBe(true);
      expect(session.data.values['name']).toBe('Charlie');
      expect(session.data.values['email']).toBe('c@test.com');
    });

    test('does nothing when stateUpdates is undefined', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        state: createBaseState({ conversationPhase: 'start' }),
      });

      const result: ConstructResult = {
        action: { type: 'continue' },
      };

      applyExecutionResult(session, result);

      expect(session.state.conversationPhase).toBe('start');
    });

    test('handles complete action by setting isComplete', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        isComplete: false,
      });

      const result: ConstructResult = {
        action: { type: 'complete', message: 'Done' },
      };

      applyExecutionResult(session, result);

      expect(session.isComplete).toBe(true);
    });

    test('handles escalate action by setting isEscalated', () => {
      const session = createBaseSession({
        agentIR: createMinimalAgentIR(),
        isEscalated: false,
      });

      const result: ConstructResult = {
        action: { type: 'escalate', reason: 'User requested', priority: 'high' },
      };

      applyExecutionResult(session, result);

      expect(session.isEscalated).toBe(true);
      expect(session.escalationReason).toBe('User requested');
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip: session -> context -> result -> session
  // ---------------------------------------------------------------------------

  describe('round-trip preservation', () => {
    test('session -> context -> result -> session preserves key state', () => {
      const ir = createMinimalAgentIR({ name: 'RoundTrip' });
      const session = createBaseSession({
        id: 'rt-session',
        agentIR: ir,
        state: createBaseState({
          conversationPhase: 'gathering',
          gatherProgress: { city: 'NYC' },
          context: { intent: 'travel' },
        }),
        data: createBaseDataStore({
          values: { city: 'NYC', intent: 'travel' },
          gatheredKeys: new Set(['city']),
        }),
        conversationHistory: [
          { role: 'user', content: 'I want to travel' },
          { role: 'assistant', content: 'Where to?' },
        ],
      });

      // Step 1: Build context from session
      const ctx = buildExecutionContext(session, createMinimalDeps());
      expect(ctx.sessionId).toBe('rt-session');
      expect(ctx.state.conversationPhase).toBe('gathering');

      // Step 2: Simulate construct execution producing a result
      const result: ConstructResult = {
        action: { type: 'continue' },
        stateUpdates: {
          conversationPhase: 'confirming',
          gatherProgress: { city: 'NYC', date: '2026-03-15' },
          context: { city: 'NYC', date: '2026-03-15', intent: 'travel' },
        },
      };

      // Step 3: Apply result back to session
      applyExecutionResult(session, result);

      // Step 4: Verify round-trip preserved + updated state
      expect(session.state.conversationPhase).toBe('confirming');
      expect(session.data.values['city']).toBe('NYC');
      expect(session.data.values['date']).toBe('2026-03-15');
      expect(session.data.gatheredKeys.has('city')).toBe(true);
      expect(session.data.gatheredKeys.has('date')).toBe(true);
      expect(session.id).toBe('rt-session');
      expect(session.agentIR).toBe(ir);
    });
  });
});
