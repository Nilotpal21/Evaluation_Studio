/**
 * Routing Executor — Unit Tests for Standalone Helper Functions
 *
 * Tests the pure/standalone exported functions from routing-executor.ts plus
 * targeted delegate-session isolation coverage:
 * - parseTimeout
 * - mapDelegateInput
 * - mapDelegateReturns
 * - handleDelegateFailure
 * - deduplicateFanOutTasks
 * - formatFanOutToolResult
 * - findHandoffConfig
 * - resolveHistoryStrategy
 * - executeComplete
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import {
  RoutingExecutor,
  parseTimeout,
  mapDelegateInput,
  mapDelegateReturns,
  handleDelegateFailure,
  handleHandoffFailure,
  deduplicateFanOutTasks,
  formatFanOutToolResult,
  findHandoffConfig,
  resolveHistoryStrategy,
  resolveHandoffOnReturnBehavior,
  applyHandoffOnReturnEffects,
  dispatchHandoffOnReturnBehavior,
  combineVisibleResponses,
  executeComplete,
} from '../../services/execution/routing-executor.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';

import type {
  RuntimeSession,
  ExecutionResult,
  FanOutResult,
  SubTaskResult,
  DelegateConfigIR,
  ExecutorContext,
  AgentRegistry,
  RuntimeExecutorConfig,
  AgentThread,
} from '../../services/execution/types.js';

import {
  DEFAULT_MESSAGES,
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  type AgentIR,
  type HandoffConfig,
  type HistoryStrategy,
} from '@abl/compiler';
import type { LLMWiringService } from '../../services/execution/llm-wiring.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/** Create a minimal RuntimeSession stub for testing */
function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'TestAgent',
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
    ...overrides,
  };

  // Ensure at least one thread exists so getActiveThread works
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

function createMockExecutorContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  const agentRegistry: AgentRegistry = {
    TestAgent: { dsl: '', ir: { metadata: { name: 'TestAgent' } } as any },
    ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
  };

  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'delegate result',
      action: { type: 'respond' },
    }),
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((template: string) => template),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    persistSession: vi.fn().mockResolvedValue(undefined),
    agentRegistry,
    sessions: new Map<string, RuntimeSession>(),
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
// parseTimeout
// =============================================================================

describe('parseTimeout', () => {
  it('returns undefined for undefined input', () => {
    expect(parseTimeout(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTimeout('')).toBeUndefined();
  });

  it('parses seconds ("30s") to milliseconds', () => {
    expect(parseTimeout('30s')).toBe(30000);
  });

  it('parses single second ("1s") to milliseconds', () => {
    expect(parseTimeout('1s')).toBe(1000);
  });

  it('parses milliseconds ("1000ms") as-is', () => {
    expect(parseTimeout('1000ms')).toBe(1000);
  });

  it('parses small millisecond value ("500ms")', () => {
    expect(parseTimeout('500ms')).toBe(500);
  });

  it('parses minutes ("1m") to milliseconds', () => {
    expect(parseTimeout('1m')).toBe(60000);
  });

  it('parses minutes ("5m") to milliseconds', () => {
    expect(parseTimeout('5m')).toBe(300000);
  });

  it('parses bare number as milliseconds', () => {
    expect(parseTimeout('2000')).toBe(2000);
  });

  it('parses zero as 0ms', () => {
    expect(parseTimeout('0')).toBe(0);
  });

  it('parses "0s" as 0', () => {
    expect(parseTimeout('0s')).toBe(0);
  });

  it('returns undefined for invalid format ("abc")', () => {
    expect(parseTimeout('abc')).toBeUndefined();
  });

  it('returns undefined for negative numbers', () => {
    expect(parseTimeout('-10s')).toBeUndefined();
  });

  it('returns undefined for floating point ("1.5s")', () => {
    expect(parseTimeout('1.5s')).toBeUndefined();
  });

  it('returns undefined for unsupported unit ("2h")', () => {
    // Only ms, s, m are supported
    expect(parseTimeout('2h')).toBeUndefined();
  });

  it('returns undefined for unit-only input ("ms")', () => {
    expect(parseTimeout('ms')).toBeUndefined();
  });

  it('returns undefined for spaces ("30 s")', () => {
    expect(parseTimeout('30 s')).toBeUndefined();
  });

  it('handles large values ("999999ms")', () => {
    expect(parseTimeout('999999ms')).toBe(999999);
  });

  it('handles large second values ("3600s")', () => {
    expect(parseTimeout('3600s')).toBe(3600000);
  });
});

// =============================================================================
// mapDelegateInput
// =============================================================================

describe('mapDelegateInput', () => {
  it('maps simple key-value pairs from context', () => {
    const mapping = { destination: 'city', nights: 'num_nights' };
    const context = { city: 'Paris', num_nights: 3 };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ destination: 'Paris', nights: 3 });
  });

  it('skips keys where source value is undefined', () => {
    const mapping = { destination: 'city', budget: 'max_budget' };
    const context = { city: 'London' };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ destination: 'London' });
    expect(result).not.toHaveProperty('budget');
  });

  it('returns empty object for empty mapping', () => {
    const result = mapDelegateInput({}, { foo: 'bar' });
    expect(result).toEqual({});
  });

  it('returns empty object when no context values match', () => {
    const mapping = { a: 'x', b: 'y' };
    const context = { foo: 'bar' };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({});
  });

  it('maps nested property paths', () => {
    const mapping = { name: 'user.name' };
    const context = { user: { name: 'Alice', age: 30 } };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('maps deeply nested paths', () => {
    const mapping = { zip: 'address.location.zipcode' };
    const context = { address: { location: { zipcode: '10001' } } };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ zip: '10001' });
  });

  it('handles null values in context', () => {
    const mapping = { val: 'field' };
    const context: Record<string, unknown> = { field: null };
    const result = mapDelegateInput(mapping, context);
    // null is not undefined, so it should be mapped
    expect(result).toEqual({ val: null });
  });

  it('handles boolean values in context', () => {
    const mapping = { flag: 'isActive' };
    const context = { isActive: false };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ flag: false });
  });

  it('handles array values in context', () => {
    const mapping = { items: 'cart' };
    const context = { cart: ['item1', 'item2'] };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ items: ['item1', 'item2'] });
  });

  it('handles numeric zero as a valid value', () => {
    const mapping = { count: 'total' };
    const context = { total: 0 };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ count: 0 });
  });

  it('handles empty string as a valid value', () => {
    const mapping = { note: 'comment' };
    const context = { comment: '' };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ note: '' });
  });

  it('maps array.length paths', () => {
    const mapping = { count: 'items.length' };
    const context = { items: ['a', 'b', 'c'] };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ count: 3 });
  });

  it('handles multiple mappings with partial matches', () => {
    const mapping = { a: 'x', b: 'y', c: 'z' };
    const context = { x: 1, z: 3 };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ a: 1, c: 3 });
  });
});

// =============================================================================
// mapDelegateReturns
// =============================================================================

describe('mapDelegateReturns', () => {
  it('maps JSON response fields to session data', () => {
    const session = createMockSession();
    const mapping = { summary: 'booking_summary', id: 'booking_id' };
    const result: ExecutionResult = {
      response: JSON.stringify({ summary: 'Booking confirmed', id: 'BK123' }),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values.booking_summary).toBe('Booking confirmed');
    expect(session.data.values.booking_id).toBe('BK123');
    expect(session.data.gatheredKeys.has('booking_summary')).toBe(true);
    expect(session.data.gatheredKeys.has('booking_id')).toBe(true);
  });

  it('handles non-JSON string response by wrapping in { response: ... }', () => {
    const session = createMockSession();
    const mapping = { response: 'delegate_result' };
    const result: ExecutionResult = {
      response: 'plain text result',
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values.delegate_result).toBe('plain text result');
  });

  it('skips undefined source keys', () => {
    const session = createMockSession();
    const mapping = { missing_key: 'target' };
    const result: ExecutionResult = {
      response: JSON.stringify({ other_key: 'value' }),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values).not.toHaveProperty('target');
  });

  it('handles empty mapping', () => {
    const session = createMockSession();
    const result: ExecutionResult = {
      response: JSON.stringify({ foo: 'bar' }),
      action: { type: 'complete' },
    };
    mapDelegateReturns({}, result, session);
    expect(Object.keys(session.data.values).length).toBe(0);
  });

  it('handles object response (non-string)', () => {
    const session = createMockSession();
    const mapping = { key: 'val' };
    const result = {
      response: { key: 'objectValue' } as unknown as string,
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values.val).toBe('objectValue');
  });

  it('adds all mapped keys to gatheredKeys set', () => {
    const session = createMockSession();
    const mapping = { a: 'x', b: 'y' };
    const result: ExecutionResult = {
      response: JSON.stringify({ a: 1, b: 2 }),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.gatheredKeys.has('x')).toBe(true);
    expect(session.data.gatheredKeys.has('y')).toBe(true);
  });

  it('does not add keys for undefined source values', () => {
    const session = createMockSession();
    const mapping = { missing: 'target_key' };
    const result: ExecutionResult = {
      response: JSON.stringify({}),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.gatheredKeys.has('target_key')).toBe(false);
  });

  it('handles null values in response', () => {
    const session = createMockSession();
    const mapping = { val: 'target' };
    const result: ExecutionResult = {
      response: JSON.stringify({ val: null }),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values.target).toBeNull();
    expect(session.data.gatheredKeys.has('target')).toBe(true);
  });
});

// =============================================================================
// handleDelegateFailure
// =============================================================================

describe('handleDelegateFailure', () => {
  it('returns error with "continue" on_failure (default)', () => {
    const session = createMockSession();
    const result = handleDelegateFailure(session, undefined, 'timeout occurred');
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout occurred');
  });

  it('uses "continue" as default when delegateConfig is undefined', () => {
    const session = createMockSession();
    const result = handleDelegateFailure(session, undefined, 'some error');
    expect(result.success).toBe(false);
    expect(result.error).toBe('some error');
    expect(session.isEscalated).toBe(false);
  });

  it('escalates on "escalate" on_failure', () => {
    const session = createMockSession();
    const config: DelegateConfigIR = {
      agent: 'TargetAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'escalate',
    };
    const result = handleDelegateFailure(session, config, 'delegate failed');
    expect(result.success).toBe(false);
    expect(result.error).toBe('delegate failed');
    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('Delegate failed: delegate failed');
  });

  it('responds with failure_message on "respond" on_failure', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    const config: DelegateConfigIR = {
      agent: 'TargetAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'respond',
      failure_message: 'Sorry, we could not process your request.',
    };
    const result = handleDelegateFailure(session, config, 'agent not found', (chunk) =>
      chunks.push(chunk),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('agent not found');
    expect(result.result).toBe('Sorry, we could not process your request.');
    expect(chunks).toContain('Sorry, we could not process your request.');
  });

  it('uses default failure message when failure_message is not set', () => {
    const session = createMockSession();
    const config: DelegateConfigIR = {
      agent: 'TargetAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'respond',
    };
    const result = handleDelegateFailure(session, config, 'network error');
    expect(result.result).toBe('Unable to complete request: network error');
  });

  it('pushes response message to conversation history on "respond"', () => {
    const session = createMockSession();
    const config: DelegateConfigIR = {
      agent: 'TargetAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'respond',
      failure_message: 'Custom failure message',
    };
    handleDelegateFailure(session, config, 'error');
    const lastMsg = session.conversationHistory[session.conversationHistory.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('Custom failure message');
  });

  it('emits trace event with delegate failure info', () => {
    const session = createMockSession();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const config: DelegateConfigIR = {
      agent: 'BookingAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'continue',
    };
    handleDelegateFailure(session, config, 'timeout', undefined, (e) => events.push(e));
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('delegate_complete');
    expect(events[0].data.success).toBe(false);
    expect(events[0].data.to).toBe('BookingAgent');
    expect(events[0].data.error).toBe('timeout');
  });

  it('does not emit trace event when onTraceEvent is not provided', () => {
    const session = createMockSession();
    // Should not throw
    const result = handleDelegateFailure(session, undefined, 'error');
    expect(result.success).toBe(false);
  });

  it('handles "continue" explicitly in config', () => {
    const session = createMockSession();
    const config: DelegateConfigIR = {
      agent: 'Agent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'continue',
    };
    const result = handleDelegateFailure(session, config, 'transient error');
    expect(result.success).toBe(false);
    expect(result.error).toBe('transient error');
    expect(session.isEscalated).toBe(false);
  });

  it('redacts custom-pattern delegate failure delivery while tokenizing history', () => {
    const session = createSessionWithCustomContractPII();
    const chunks: string[] = [];
    const config: DelegateConfigIR = {
      agent: 'TargetAgent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'respond',
    };

    const result = handleDelegateFailure(
      session,
      config,
      `upstream contract ${rawContractId} failed`,
      (chunk) => chunks.push(chunk),
    );

    expect(String(result.result)).toContain('[REDACTED_CONTRACT_ID]');
    expect(String(result.result)).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });
});

describe('handleHandoffFailure', () => {
  it('redacts custom-pattern handoff failure delivery while tokenizing active-thread history', () => {
    const session = createSessionWithCustomContractPII();
    const activeThread = session.threads[0];
    activeThread.status = 'active';
    const chunks: string[] = [];

    const result = handleHandoffFailure(
      session,
      {
        to: 'TargetAgent',
        when: 'true',
        context: { pass: [], summary: '', history: 'none' },
        on_failure: 'respond',
      } as any,
      `remote contract ${rawContractId} failed`,
      'dispatch',
      (chunk) => chunks.push(chunk),
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(String(activeThread.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(activeThread.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });
});

// =============================================================================
// RoutingExecutor delegate isolation
// =============================================================================

describe('RoutingExecutor delegate isolation', () => {
  it('executes delegates against an isolated child session id', async () => {
    const ctx = createMockExecutorContext();
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          delegates: [
            {
              agent: 'ChildAgent',
              when: '',
              purpose: 'test',
              input: {},
              returns: {},
              use_result: 'delegate_result',
              on_failure: 'continue',
            },
          ],
        },
      } as any,
    });

    let delegatedSessionId: string | undefined;
    (ctx.executeMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (sessionId: string) => {
        delegatedSessionId = sessionId;
        return { response: 'ok', action: { type: 'respond' } };
      },
    );

    const result = await executor.handleDelegate(session, {
      target: 'ChildAgent',
      input: {},
      message: 'test',
    });

    expect(result.success).toBe(true);
    expect(delegatedSessionId).toBeDefined();
    expect(delegatedSessionId).not.toBe(session.id);
    expect(delegatedSessionId).toContain('__delegate__');
    expect(ctx.cancelPendingPersist).toHaveBeenCalledWith(delegatedSessionId);
    expect(ctx.unmarkExecuting).toHaveBeenCalledWith(delegatedSessionId);
    expect(ctx.sessions.has(delegatedSessionId!)).toBe(false);
  });

  it('prevents timed-out child mutations from corrupting the parent session', async () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockExecutorContext();
      const executor = new RoutingExecutor(ctx, createMockLLMWiring());
      const parentHistory = [{ role: 'user', content: 'keep me' }];
      const session = createMockSession({
        agentName: 'TestAgent',
        conversationHistory: [...parentHistory],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: { parentOnly: 'safe' },
        },
        data: {
          values: { parentOnly: 'safe' },
          gatheredKeys: new Set<string>(['parentOnly']),
        },
        agentIR: {
          metadata: { name: 'TestAgent' },
          coordination: {
            delegates: [
              {
                agent: 'ChildAgent',
                when: '',
                purpose: 'test',
                input: {},
                returns: {},
                use_result: 'delegate_result',
                timeout: '50ms',
                on_failure: 'continue',
              },
            ],
          },
        } as any,
      });

      (ctx.executeMessage as ReturnType<typeof vi.fn>).mockImplementation((sessionId: string) => {
        const childSession = ctx.sessions.get(sessionId)!;
        childSession.conversationHistory.push({ role: 'assistant', content: 'child mutation' });
        (childSession.state as { context: Record<string, unknown> }).context.childOnly = 'mutated';
        (
          childSession.data as { values: Record<string, unknown>; gatheredKeys: Set<string> }
        ).values.childOnly = 'mutated';
        (
          childSession.data as { values: Record<string, unknown>; gatheredKeys: Set<string> }
        ).gatheredKeys.add('childOnly');
        return new Promise(() => {});
      });

      const resultPromise = executor.handleDelegate(session, {
        target: 'ChildAgent',
        input: {},
        message: 'test',
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(session.activeThreadIndex).toBe(0);
      expect(session.conversationHistory).toEqual(parentHistory);
      expect(session.state.context).toEqual({ parentOnly: 'safe' });
      expect(session.data.values).toEqual(
        expect.objectContaining({
          parentOnly: 'safe',
          _memory_initialized_agent: 'TestAgent',
        }),
      );
      expect(session.data.gatheredKeys.has('parentOnly')).toBe(true);
      expect(session.data.gatheredKeys.has('childOnly')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RoutingExecutor Grok realtime handoff', () => {
  it('switches to the target agent without eagerly executing the child agent', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'should not run',
        action: { type: 'respond' },
      }),
      agentRegistry: {
        TestAgent: {
          dsl: '',
          ir: {
            metadata: { name: 'TestAgent' },
            coordination: {
              handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
            },
          } as any,
        },
        ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
      },
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
      } as any,
      channelType: 'voice',
      data: {
        values: {
          session: {
            channel: 'voice',
            s2sProvider: 's2s:grok',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });

    const result = await executor.handleHandoff(session, {
      target: 'ChildAgent',
      message: 'book a hotel',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(ctx.executeMessage).not.toHaveBeenCalled();
    expect(session.agentName).toBe('ChildAgent');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.threads).toHaveLength(2);
    expect(session.threads[0].status).toBe('completed');
    expect(session.threads[1].status).toBe('active');
    expect(session.threads[1].parentThreadIndex).toBe(0);
  });
});

describe('RoutingExecutor realtime voice handoff', () => {
  it('keeps OpenAI realtime handoffs on the live voice transport', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'should not run',
        action: { type: 'respond' },
      }),
      agentRegistry: {
        TestAgent: {
          dsl: '',
          ir: {
            metadata: { name: 'TestAgent' },
            coordination: {
              handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
            },
          } as any,
        },
        ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
      },
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
      } as any,
      channelType: 'voice',
      data: {
        values: {
          session: {
            channel: 'voice',
            s2sProvider: 's2s:openai',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });

    const result = await executor.handleHandoff(session, {
      target: 'ChildAgent',
      message: 'book a hotel',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(ctx.executeMessage).not.toHaveBeenCalled();
    expect(session.agentName).toBe('ChildAgent');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.threads).toHaveLength(2);
    expect(session.threads[0].status).toBe('completed');
    expect(session.threads[1].status).toBe('active');
  });

  it('switches to the target agent without returning transfer speech', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'should not run',
        action: { type: 'respond' },
      }),
      agentRegistry: {
        TestAgent: {
          dsl: '',
          ir: {
            metadata: { name: 'TestAgent' },
            coordination: {
              handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
            },
          } as any,
        },
        ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
      },
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
      } as any,
      channelType: 'voice',
      data: {
        values: {
          session: {
            channel: 'voice',
            s2sProvider: 's2s:google',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });

    const result = await executor.handleHandoff(session, {
      target: 'ChildAgent',
      message: 'book a hotel',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(ctx.executeMessage).not.toHaveBeenCalled();
    expect(session.agentName).toBe('ChildAgent');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.threads).toHaveLength(2);
    expect(session.threads[0].status).toBe('completed');
    expect(session.threads[1].status).toBe('active');
  });

  it('emits project-owned voice handoff copy before deferring child execution', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'should not run',
        action: { type: 'respond' },
      }),
      agentRegistry: {
        TestAgent: {
          dsl: '',
          ir: {
            metadata: { name: 'TestAgent' },
            coordination: {
              handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
            },
            messages: {
              handoff_message_voice: 'Connecting to {{target}}',
            },
          } as any,
        },
        ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
      },
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
        messages: {
          handoff_message_voice: 'Connecting to {{target}}',
        },
      } as any,
      channelType: 'voice',
      data: {
        values: {
          session: {
            channel: 'voice',
            s2sProvider: 's2s:grok',
          },
          _locale: 'fr-CA',
        },
        gatheredKeys: new Set<string>(),
      },
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr/_shared.json': JSON.stringify({
          handoff_message_voice: 'Transfert vers {{target}}',
        }),
      }),
    );
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      {
        target: 'ChildAgent',
        message: 'book a hotel',
      },
      onChunk,
    );

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(onChunk).toHaveBeenCalledWith('Transfert vers ChildAgent.');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });
});

describe('RoutingExecutor handoff memory grants', () => {
  it('hydrates granted memory from execution_tree and fact stores for the child agent', async () => {
    const factStore = new InMemoryFactStore({ type: 'memory' });
    await factStore.set({
      key: 'user.preference',
      value: 'gold',
      source: { type: 'agent' },
    });

    try {
      const ctx = createMockExecutorContext({
        executeMessage: vi.fn().mockResolvedValue({
          response: 'child result',
          action: { type: 'respond' },
        }),
        agentRegistry: {
          TestAgent: {
            dsl: '',
            ir: {
              metadata: { name: 'TestAgent' },
              memory: {
                session: [],
                persistent: [
                  { path: 'workflow.auth_token', scope: 'execution_tree', access: 'readwrite' },
                  { path: 'user.preference', scope: 'user', access: 'readwrite' },
                ],
                remember: [],
                recall: [],
              },
              coordination: {
                handoffs: [
                  {
                    to: 'ChildAgent',
                    context: {
                      pass: [],
                      summary: 'Resume child work',
                      memory_grants: [
                        { path: 'workflow.auth_token', access: 'readwrite' },
                        { path: 'user.preference', access: 'read' },
                      ],
                    },
                    return: false,
                  },
                ],
              },
            } as any,
          },
          ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
        },
      });
      const executor = new RoutingExecutor(ctx, createMockLLMWiring());
      const session = createMockSession({
        agentName: 'TestAgent',
        agentIR: ctx.agentRegistry.TestAgent.ir,
        executionTreeValues: { 'workflow.auth_token': 'shared-token' },
        factStore,
        conversationHistory: [{ role: 'user', content: 'resume specialist work' }],
      });

      const result = await executor.handleHandoff(session, {
        target: 'ChildAgent',
        message: 'resume specialist work',
      });

      expect(result.success).toBe(true);
      expect(session.agentName).toBe('ChildAgent');
      expect(session.data.values.granted_memory).toEqual({
        workflow: { auth_token: 'shared-token' },
        user: { preference: 'gold' },
      });
      expect(session.data.values._granted_memory).toEqual({
        'workflow.auth_token': 'shared-token',
        'user.preference': 'gold',
      });
      expect(session.data.values._granted_memory_meta).toEqual(
        expect.objectContaining({
          'workflow.auth_token': expect.objectContaining({
            access: 'readwrite',
            sourceScope: 'execution_tree',
          }),
          'user.preference': expect.objectContaining({
            access: 'read',
            sourceScope: 'user',
          }),
        }),
      );
    } finally {
      factStore.stop();
    }
  });
});

// =============================================================================
// deduplicateFanOutTasks
// =============================================================================

describe('deduplicateFanOutTasks', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateFanOutTasks([])).toEqual([]);
  });

  it('passes through single task unchanged', () => {
    const tasks = [{ target: 'AgentA', intent: 'do something' }];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toEqual([{ target: 'AgentA', intent: 'do something' }]);
  });

  it('passes through tasks with different targets', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task A' },
      { target: 'AgentB', intent: 'task B' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('AgentA');
    expect(result[1].target).toBe('AgentB');
  });

  it('merges intents for duplicate target agents', () => {
    const tasks = [
      { target: 'AgentA', intent: 'find flights' },
      { target: 'AgentA', intent: 'check availability' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('AgentA');
    expect(result[0].intent).toBe('find flights; check availability');
  });

  it('merges context for duplicate targets', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task1', context: { city: 'Paris' } },
      { target: 'AgentA', intent: 'task2', context: { dates: '2025-01-01' } },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].context).toEqual({ city: 'Paris', dates: '2025-01-01' });
  });

  it('later context values override earlier for same keys', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task1', context: { city: 'Paris' } },
      { target: 'AgentA', intent: 'task2', context: { city: 'London' } },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result[0].context!.city).toBe('London');
  });

  it('handles mix of duplicate and unique targets', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task1' },
      { target: 'AgentB', intent: 'task2' },
      { target: 'AgentA', intent: 'task3' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0].intent).toBe('task1; task3');
    expect(result[1].intent).toBe('task2');
  });

  it('preserves order of first occurrence', () => {
    const tasks = [
      { target: 'AgentC', intent: 'c1' },
      { target: 'AgentA', intent: 'a1' },
      { target: 'AgentB', intent: 'b1' },
      { target: 'AgentA', intent: 'a2' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result.map((t) => t.target)).toEqual(['AgentC', 'AgentA', 'AgentB']);
  });

  it('handles three duplicates for same target', () => {
    const tasks = [
      { target: 'Agent', intent: 'one' },
      { target: 'Agent', intent: 'two' },
      { target: 'Agent', intent: 'three' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe('one; two; three');
  });

  it('handles tasks without context', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task1' },
      { target: 'AgentA', intent: 'task2' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result[0].context).toBeUndefined();
  });

  it('only second task has context — merges onto undefined', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task1' },
      { target: 'AgentA', intent: 'task2', context: { key: 'val' } },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result[0].context).toEqual({ key: 'val' });
  });

  it('does not mutate original task objects', () => {
    const task1 = { target: 'AgentA', intent: 'task1', context: { a: 1 } };
    const task2 = { target: 'AgentA', intent: 'task2', context: { b: 2 } };
    deduplicateFanOutTasks([task1, task2]);
    // Original objects should be untouched
    expect(task1.intent).toBe('task1');
    expect(task1.context).toEqual({ a: 1 });
    expect(task2.intent).toBe('task2');
  });
});

describe('RoutingExecutor voice localization', () => {
  it('emits localized voice handoff copy when the message is project-owned', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'child result',
        action: { type: 'respond' },
      }),
      agentRegistry: {
        TestAgent: {
          dsl: '',
          ir: {
            metadata: { name: 'TestAgent' },
            coordination: {
              handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
            },
            messages: {
              handoff_message_voice: 'Connecting to {{target}}',
            },
          } as any,
        },
        ChildAgent: { dsl: '', ir: { metadata: { name: 'ChildAgent' } } as any },
      },
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
        messages: {
          handoff_message_voice: 'Connecting to {{target}}',
        },
      } as any,
      channelType: 'voice',
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });
    session.data.values._locale = 'fr-CA';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr/_shared.json': JSON.stringify({
          handoff_message_voice: 'Transfert vers {{target}}',
        }),
      }),
    );
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      {
        target: 'ChildAgent',
        message: 'book a hotel',
      },
      onChunk,
    );

    expect(result.success).toBe(true);
    expect(onChunk).toHaveBeenCalledWith('Transfert vers ChildAgent.');
  });

  it('does not prepend the platform default voice handoff copy when the child responds immediately', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'child result',
        action: { type: 'respond' },
      }),
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
      } as any,
      channelType: 'voice',
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      {
        target: 'ChildAgent',
        message: 'book a hotel',
      },
      onChunk,
    );

    expect(result.success).toBe(true);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('falls back to the default voice handoff copy when the child stays silent', async () => {
    const ctx = createMockExecutorContext({
      executeMessage: vi.fn().mockResolvedValue({
        response: '',
        action: { type: 'continue' },
      }),
    });
    const executor = new RoutingExecutor(ctx, createMockLLMWiring());
    const session = createMockSession({
      agentName: 'TestAgent',
      agentIR: {
        metadata: { name: 'TestAgent' },
        coordination: {
          handoffs: [{ to: 'ChildAgent', context: { pass: [] } }],
        },
      } as any,
      channelType: 'voice',
      conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    });
    const onChunk = vi.fn();

    const result = await executor.handleHandoff(
      session,
      {
        target: 'ChildAgent',
        message: 'book a hotel',
      },
      onChunk,
    );

    expect(result.success).toBe(true);
    // The runtime applies completeCustomerContinuityPhrase to streamed text
    // before emitting it, which rewrites bare-gerund openers ("Transferring …")
    // into first-person phrasing ("I'm transferring …") for customer-facing
    // delivery. Match the post-rewrite output.
    expect(onChunk).toHaveBeenCalledWith(
      DEFAULT_MESSAGES.handoff_message_voice
        .replace('{{target}}', 'ChildAgent')
        .replace(/^Transferring\b/, "I'm transferring"),
    );
  });
});

// =============================================================================
// formatFanOutToolResult
// =============================================================================

describe('formatFanOutToolResult', () => {
  it('formats all-success results', () => {
    const fanOutResult: FanOutResult = {
      success: true,
      results: [
        { target: 'FlightAgent', status: 'completed', response: 'Found 3 flights' },
        { target: 'HotelAgent', status: 'completed', response: 'Found 5 hotels' },
      ],
      failedCount: 0,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.success).toBe(true);
    expect(formatted.summary).toContain('2/2 tasks succeeded');
    expect(formatted.summary).toContain('[FlightAgent] SUCCESS: Found 3 flights');
    expect(formatted.summary).toContain('[HotelAgent] SUCCESS: Found 5 hotels');
    expect(formatted.summary).toContain('Synthesis Instructions');
    expect(formatted.summary).toContain('single cohesive response');
    expect(formatted.results).toHaveLength(2);
  });

  it('formats all-failure results', () => {
    const fanOutResult: FanOutResult = {
      success: false,
      results: [
        { target: 'FlightAgent', status: 'error', error: 'Timeout' },
        { target: 'HotelAgent', status: 'error', error: 'Not found' },
      ],
      failedCount: 2,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.success).toBe(false);
    expect(formatted.summary).toContain('0/2 tasks succeeded');
    expect(formatted.summary).toContain('[FlightAgent] FAILED: Timeout');
    expect(formatted.summary).toContain('[HotelAgent] FAILED: Not found');
    expect(formatted.summary).toContain('failed tasks');
  });

  it('formats mixed success/failure results', () => {
    const fanOutResult: FanOutResult = {
      success: true,
      results: [
        { target: 'FlightAgent', status: 'completed', response: 'Found flights' },
        { target: 'HotelAgent', status: 'error', error: 'Service unavailable' },
      ],
      failedCount: 1,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.success).toBe(true);
    expect(formatted.summary).toContain('1/2 tasks succeeded');
    expect(formatted.summary).toContain('[FlightAgent] SUCCESS: Found flights');
    expect(formatted.summary).toContain('[HotelAgent] FAILED: Service unavailable');
    expect(formatted.summary).toContain('failed tasks');
  });

  it('formats single success result', () => {
    const fanOutResult: FanOutResult = {
      success: true,
      results: [{ target: 'Agent', status: 'completed', response: 'Done' }],
      failedCount: 0,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.summary).toContain('1/1 tasks succeeded');
    expect(formatted.summary).toContain('[Agent] SUCCESS: Done');
  });

  it('formats empty results', () => {
    const fanOutResult: FanOutResult = {
      success: false,
      results: [],
      failedCount: 0,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.summary).toContain('0/0 tasks succeeded');
  });

  it('returns the original results array', () => {
    const results: SubTaskResult[] = [{ target: 'A', status: 'completed', response: 'ok' }];
    const fanOutResult: FanOutResult = { success: true, results, failedCount: 0 };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.results).toBe(results);
  });

  it('includes failure instructions when tasks fail', () => {
    const fanOutResult: FanOutResult = {
      success: true,
      results: [{ target: 'A', status: 'error', error: 'err' }],
      failedCount: 1,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.summary).toContain('failed tasks');
    expect(formatted.summary).toContain("wasn't able to");
  });

  it('includes synthesis instructions without failure guidance when all succeed', () => {
    const fanOutResult: FanOutResult = {
      success: true,
      results: [{ target: 'A', status: 'completed', response: 'ok' }],
      failedCount: 0,
    };
    const formatted = formatFanOutToolResult(fanOutResult);
    expect(formatted.summary).toContain('Synthesis Instructions');
    expect(formatted.summary).toContain('single cohesive response');
    expect(formatted.summary).not.toContain('failed tasks');
  });
});

// =============================================================================
// findHandoffConfig
// =============================================================================

describe('findHandoffConfig', () => {
  it('finds handoff config by target agent name', () => {
    const handoffConfig: HandoffConfig = {
      to: 'BookingAgent',
      when: 'true',
      context: { pass: [], summary: '' },
      return: true,
    };
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [handoffConfig],
        },
      } as any,
    });
    const result = findHandoffConfig(session, 'BookingAgent');
    expect(result).toBeDefined();
    expect(result!.to).toBe('BookingAgent');
  });

  it('returns undefined when target is not in handoffs', () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'AgentA', when: 'true', context: { pass: [], summary: '' }, return: false },
          ],
        },
      } as any,
    });
    const result = findHandoffConfig(session, 'AgentB');
    expect(result).toBeUndefined();
  });

  it('returns undefined when handoffs array is empty', () => {
    const session = createMockSession({
      agentIR: {
        coordination: { handoffs: [] },
      } as any,
    });
    const result = findHandoffConfig(session, 'AnyAgent');
    expect(result).toBeUndefined();
  });

  it('returns undefined when coordination is undefined', () => {
    const session = createMockSession({
      agentIR: {} as any,
    });
    const result = findHandoffConfig(session, 'AnyAgent');
    expect(result).toBeUndefined();
  });

  it('returns undefined when agentIR is null', () => {
    const session = createMockSession({ agentIR: null });
    const result = findHandoffConfig(session, 'AnyAgent');
    expect(result).toBeUndefined();
  });

  it('finds the correct config among multiple handoffs', () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'AgentA',
              when: 'cond_a',
              context: { pass: ['f1'], summary: 'summary A' },
              return: false,
            },
            {
              to: 'AgentB',
              when: 'cond_b',
              context: { pass: ['f2'], summary: 'summary B' },
              return: true,
            },
            { to: 'AgentC', when: 'cond_c', context: { pass: [], summary: '' }, return: false },
          ],
        },
      } as any,
    });
    const result = findHandoffConfig(session, 'AgentB');
    expect(result!.to).toBe('AgentB');
    expect(result!.context.pass).toEqual(['f2']);
    expect(result!.return).toBe(true);
  });

  it('uses active thread agentIR when available', () => {
    const session = createMockSession();
    // Set the thread's agentIR to have handoffs
    session.threads[0].agentIR = {
      coordination: {
        handoffs: [
          { to: 'ThreadAgent', when: 'true', context: { pass: [], summary: '' }, return: false },
        ],
      },
    } as any;
    // Session-level has no coordination
    session.agentIR = {} as any;

    const result = findHandoffConfig(session, 'ThreadAgent');
    expect(result).toBeDefined();
    expect(result!.to).toBe('ThreadAgent');
  });

  it('falls back to session.agentIR when thread agentIR is null', () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'SessionAgent', when: 'true', context: { pass: [], summary: '' }, return: false },
          ],
        },
      } as any,
    });
    session.threads[0].agentIR = null;

    const result = findHandoffConfig(session, 'SessionAgent');
    expect(result).toBeDefined();
    expect(result!.to).toBe('SessionAgent');
  });
});

// =============================================================================
// resolveHistoryStrategy
// =============================================================================

describe('resolveHistoryStrategy', () => {
  it('resolves the platform default auto strategy to bounded history when no summary is available', () => {
    expect(resolveHistoryStrategy()).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('resolves the platform default auto strategy when both inputs are undefined', () => {
    expect(resolveHistoryStrategy(undefined, undefined)).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('returns handoff-level history strategy when set', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: 'full' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    expect(resolveHistoryStrategy(config)).toBe('full');
  });

  it('returns handoff-level "summary_only" strategy', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: 'summary_only' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    expect(resolveHistoryStrategy(config)).toBe('summary_only');
  });

  it('resolves handoff-level "auto" to summary_only when summary context is available', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: 'Carry forward context', history: 'auto' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    expect(resolveHistoryStrategy(config)).toBe('summary_only');
  });

  it('resolves handoff-level "auto" to bounded history for non-LLM targets', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: 'Carry forward context', history: 'auto' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    expect(
      resolveHistoryStrategy(config, undefined, {
        targetSupportsSummaryOnly: false,
      }),
    ).toEqual({ last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N });
  });

  it('resolves handoff-level "auto" to bounded history when no summary exists', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: 'auto' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    expect(resolveHistoryStrategy(config)).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('returns handoff-level last_n strategy', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: { last_n: 5 } as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    const result = resolveHistoryStrategy(config);
    expect(result).toEqual({ last_n: 5 });
  });

  it('falls back to project-level defaultHistoryStrategy', () => {
    const session = createMockSession({
      compilationOutput: {
        coordination_defaults: {
          defaultHistoryStrategy: 'full',
        },
      } as any,
    });
    const result = resolveHistoryStrategy(undefined, session);
    expect(result).toBe('full');
  });

  it('handoff-level overrides project-level strategy', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: 'summary_only' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    const session = createMockSession({
      compilationOutput: {
        coordination_defaults: {
          defaultHistoryStrategy: 'full',
        },
      } as any,
    });
    expect(resolveHistoryStrategy(config, session)).toBe('summary_only');
  });

  it('resolves the platform default when handoff has no history and no project defaults', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '' }, // no history key
      return: false,
    } as HandoffConfig;
    const session = createMockSession();
    expect(resolveHistoryStrategy(config, session)).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('returns project-level last_n strategy when handoff has no history', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '' },
      return: false,
    } as HandoffConfig;
    const session = createMockSession({
      compilationOutput: {
        coordination_defaults: {
          defaultHistoryStrategy: { last_n: 10 },
        },
      } as any,
    });
    const result = resolveHistoryStrategy(config, session);
    expect(result).toEqual({ last_n: 10 });
  });

  it('resolves the platform default when session has compilationOutput but no coordination_defaults', () => {
    const session = createMockSession({
      compilationOutput: {} as any,
    });
    expect(resolveHistoryStrategy(undefined, session)).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('resolves the platform default when handoff config context is undefined', () => {
    const config = { to: 'Agent', when: 'true', return: false } as unknown as HandoffConfig;
    expect(resolveHistoryStrategy(config, undefined)).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('uses the project-level auto fallback size override', () => {
    const session = createMockSession({
      compilationOutput: {
        coordination_defaults: {
          defaultHistoryStrategy: 'auto',
          autoHistoryFallbackLastN: 8,
        },
      } as any,
    });
    expect(resolveHistoryStrategy(undefined, session)).toEqual({ last_n: 8 });
  });

  it('still exposes auto as the symbolic platform default constant', () => {
    expect(DEFAULT_HANDOFF_HISTORY_STRATEGY).toBe('auto');
  });
});

// =============================================================================
// handoff on_return helpers
// =============================================================================

describe('handoff on_return helpers', () => {
  it('resolves named handlers from coordination.return_handlers', () => {
    const parentIR = {
      coordination: {
        return_handlers: {
          await_next_request: {
            respond: 'Anything else?',
            continue: true,
          },
        },
      },
    } as AgentIR;
    const handoffConfig = {
      to: 'SpecialistAgent',
      when: 'always',
      context: { pass: [], summary: '' },
      return: true,
      on_return: 'await_next_request',
    } as HandoffConfig;

    expect(resolveHandoffOnReturnBehavior(parentIR, handoffConfig)).toEqual({
      action: 'continue',
      handlerName: 'await_next_request',
      map: undefined,
      respond: 'Anything else?',
      clear: undefined,
    });
  });

  it('applies CLEAR/RESPOND effects without creating duplicate assistant history entries', () => {
    const session = createMockSession({
      data: {
        values: {
          current_intent: 'balance',
          customer_name: 'Priya',
        },
        gatheredKeys: new Set<string>(['current_intent', 'customer_name']),
      },
      conversationHistory: [
        { role: 'user', content: 'check my balance' },
        { role: 'assistant', content: '[Auth_Agent]: Identity verified successfully.' },
      ],
    });

    const parentThread: AgentThread = {
      agentName: 'Supervisor',
      agentIR: session.agentIR,
      conversationHistory: session.conversationHistory,
      state: session.state,
      data: session.data,
      activationAuthContext: undefined,
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
    };

    const chunks: string[] = [];
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const effectResult = applyHandoffOnReturnEffects(
      session,
      parentThread,
      'Auth_Agent',
      {
        action: 'continue',
        handlerName: 'await_next_request',
        respond: 'What else can I help with, {{customer_name}}?',
        clear: ['current_intent'],
      },
      {
        mergeWithLastAssistant: true,
        onChunk: (chunk) => chunks.push(chunk),
        onTraceEvent: (event) => traces.push(event),
        decisionId: 'decision-return-1',
        parentThreadIndex: 0,
        childThreadIndex: 1,
      },
    );

    expect(effectResult.emittedResponse).toBe('What else can I help with, Priya?');
    expect(session.data.values.current_intent).toBeUndefined();
    expect(session.data.gatheredKeys.has('current_intent')).toBe(false);
    expect(session.conversationHistory).toEqual([
      { role: 'user', content: 'check my balance' },
      {
        role: 'assistant',
        content: '[Auth_Agent]: Identity verified successfully.\nWhat else can I help with, Priya?',
      },
    ]);
    expect(chunks).toEqual(['What else can I help with, Priya?']);
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'handoff_return_handler',
          data: expect.objectContaining({
            from: 'Auth_Agent',
            sourceAgent: 'Auth_Agent',
            parentAgent: 'Supervisor',
            targetAgent: 'Supervisor',
            handler: 'await_next_request',
            action: 'continue',
            handoffReturnBehavior: 'continue',
            reasonCode: 'handoff_return_continue',
            decisionId: 'decision-return-1',
            parentThreadIndex: 0,
            childThreadIndex: 1,
            clearedFields: ['current_intent'],
          }),
        }),
      ]),
    );
  });

  it('protects PII in handoff return handler responses before streaming and history writes', () => {
    const session = createSessionWithCustomContractPII({
      data: {
        values: {
          contract_id: rawContractId,
        },
        gatheredKeys: new Set<string>(['contract_id']),
      },
    });

    const parentThread: AgentThread = {
      agentName: 'Supervisor',
      agentIR: session.agentIR,
      conversationHistory: session.conversationHistory,
      state: session.state,
      data: session.data,
      activationAuthContext: undefined,
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
    };

    const chunks: string[] = [];
    const effectResult = applyHandoffOnReturnEffects(
      session,
      parentThread,
      'Auth_Agent',
      {
        action: 'continue',
        handlerName: 'await_next_request',
        respond: 'Contract {{contract_id}} is verified.',
      },
      {
        onChunk: (chunk) => chunks.push(chunk),
      },
    );

    expect(effectResult.emittedResponse).toContain('[REDACTED_CONTRACT_ID]');
    expect(effectResult.emittedResponse).not.toContain(rawContractId);
    expect(chunks).toEqual([expect.stringContaining('[REDACTED_CONTRACT_ID]')]);
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(session.conversationHistory).toEqual([
      {
        role: 'assistant',
        content: expect.stringContaining('Contract {{PII:ContractID:'),
      },
    ]);
    expect(session.conversationHistory[0].content).not.toContain(rawContractId);
  });

  it('combines child and handler responses for non-stream consumers', () => {
    expect(combineVisibleResponses('Child response', 'What else can I help with?')).toBe(
      'Child response\nWhat else can I help with?',
    );
  });

  it('emits causal resume_intent trace data and replays with resume source options', async () => {
    const parentIR = {
      coordination: {
        handoffs: [
          {
            to: 'Auth_Agent',
            return: true,
            on_return: { action: 'resume_intent' },
          },
        ],
      },
    } as AgentIR;
    const session = createMockSession({
      agentName: 'Supervisor',
      agentIR: parentIR,
      conversationHistory: [{ role: 'user', content: 'check my balance' }],
      threads: [
        {
          agentName: 'Supervisor',
          agentIR: parentIR,
          conversationHistory: [{ role: 'user', content: 'check my balance' }],
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
          returnExpected: false,
          status: 'active',
        },
      ],
    });
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const executeMessage = vi.fn().mockResolvedValue({
      response: 'Balance is $42',
      action: { type: 'respond' },
    } satisfies ExecutionResult);

    const result = await dispatchHandoffOnReturnBehavior(session, 'Auth_Agent', {
      originalUserIntent: 'check my balance',
      onTraceEvent: (event) => traces.push(event),
      executeMessage,
      decisionId: 'decision-return-2',
      parentThreadIndex: 0,
      childThreadIndex: 1,
    });

    expect(result.resumed).toBe(true);
    expect(executeMessage).toHaveBeenCalledWith(
      session.id,
      'check my balance',
      undefined,
      expect.any(Function),
      {
        resumeIntentReplay: true,
        messageSource: 'resume',
        sourceAgent: 'Auth_Agent',
      },
    );
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'resume_intent',
          data: expect.objectContaining({
            from: 'Auth_Agent',
            sourceAgent: 'Auth_Agent',
            parentAgent: 'Supervisor',
            targetAgent: 'Supervisor',
            originalMessage: 'check my balance',
            handoffReturnBehavior: 'resume_intent',
            reasonCode: 'handoff_return_resume_intent',
            resumeDepth: 1,
            decisionId: 'decision-return-2',
            parentThreadIndex: 0,
            childThreadIndex: 1,
          }),
        }),
      ]),
    );
  });
});

// =============================================================================
// executeComplete
// =============================================================================

describe('executeComplete', () => {
  it('marks session as complete', () => {
    const session = createMockSession();
    executeComplete(session);
    expect(session.isComplete).toBe(true);
    expect(session.state.conversationPhase).toBe('complete');
  });

  it('uses provided completion message', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Thank you for your booking!');
    expect(result.response).toBe('Thank you for your booking!');
  });

  it('interpolates template variables in message', () => {
    const session = createMockSession();
    session.data.values.name = 'Alice';
    const result = executeComplete(session, 'Goodbye, {{name}}!');
    expect(result.response).toBe('Goodbye, Alice!');
  });

  it('falls back to agent IR message when no message provided', () => {
    const session = createMockSession({
      agentIR: {
        messages: { conversation_complete: 'Custom complete message' },
      } as any,
    });
    const result = executeComplete(session);
    expect(result.response).toBe('Custom complete message');
  });

  it('falls back to DEFAULT_MESSAGES when no IR message', () => {
    const session = createMockSession();
    const result = executeComplete(session);
    expect(result.response).toBe('This conversation has been completed.');
  });

  it('stores data when storeKey is provided', () => {
    const session = createMockSession();
    session.data.values.city = 'Paris';
    executeComplete(session, 'Done', 'booking_data');
    const stored = session.data.values._stored_booking_data as any;
    expect(stored).toBeDefined();
    expect(stored.key).toBe('booking_data');
    expect(stored.value.city).toBe('Paris');
    expect(stored.sessionId).toBe('test-session-1');
    expect(stored.agentName).toBe('TestAgent');
    expect(stored.timestamp).toBeDefined();
  });

  it('does not store data when storeKey is undefined', () => {
    const session = createMockSession();
    executeComplete(session, 'Done');
    const storedKeys = Object.keys(session.data.values).filter((k) => k.startsWith('_stored_'));
    expect(storedKeys).toHaveLength(0);
  });

  it('calls onChunk with completion message', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    executeComplete(session, 'Complete!', undefined, (c) => chunks.push(c));
    expect(chunks).toContain('Complete!');
  });

  it('does not call onChunk when message is empty string', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    executeComplete(session, '', undefined, (c) => chunks.push(c));
    // Empty string is falsy so onChunk should not be called
    expect(chunks).toHaveLength(0);
  });

  it('pushes completion message to conversation history', () => {
    const session = createMockSession();
    executeComplete(session, 'All done.');
    const last = session.conversationHistory[session.conversationHistory.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('All done.');
  });

  it('emits data_stored trace event when storeKey is provided', () => {
    const session = createMockSession();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    executeComplete(session, 'Done', 'my_key', undefined, (e) => events.push(e));
    const storeEvent = events.find((e) => e.type === 'data_stored');
    expect(storeEvent).toBeDefined();
    expect(storeEvent!.data.key).toBe('my_key');
  });

  it('emits decision trace event', () => {
    const session = createMockSession();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    executeComplete(session, 'Finished', undefined, undefined, (e) => events.push(e));
    const decision = events.find((e) => e.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision!.data.type).toBe('complete');
    expect(decision!.data.message).toBe('Finished');
  });

  it('returns action with type "complete"', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Done');
    expect(result.action.type).toBe('complete');
    expect(result.action.message).toBe('Done');
  });

  it('returns action with stored key', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Done', 'booking');
    expect(result.action.stored).toBe('booking');
  });

  it('returns action with undefined stored when no storeKey', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Done');
    expect(result.action.stored).toBeUndefined();
  });

  it('handles null message by falling back to default', () => {
    const session = createMockSession();
    const result = executeComplete(session, null as unknown as string);
    // null is not undefined but the check is !== undefined && !== null
    expect(result.response).toBe('This conversation has been completed.');
  });

  it('interpolates complex templates', () => {
    const session = createMockSession();
    session.data.values.hotel = 'Grand Hotel';
    session.data.values.nights = 3;
    const result = executeComplete(session, 'Booked {{hotel}} for {{nights}} nights.');
    expect(result.response).toBe('Booked Grand Hotel for 3 nights.');
  });

  it('handles voiceConfig parameter', () => {
    const session = createMockSession();
    session.data.values.name = 'Bob';
    const vc = { ssml: '<speak>Hello {{name}}</speak>' } as any;
    const result = executeComplete(session, 'Done', undefined, undefined, undefined, vc);
    expect(result.voiceConfig).toBeDefined();
    expect(result.voiceConfig!.ssml).toBe('<speak>Hello Bob</speak>');
  });

  it('returns undefined voiceConfig when not provided', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Done');
    expect(result.voiceConfig).toBeUndefined();
  });

  it('handles richContent parameter', () => {
    const session = createMockSession();
    session.data.values.item = 'widget';
    const rc = { markdown: '# {{item}} purchased' } as any;
    const result = executeComplete(session, 'Done', undefined, undefined, undefined, undefined, rc);
    expect(result.richContent).toBeDefined();
    expect(result.richContent!.markdown).toBe('# widget purchased');
  });

  it('redacts delivery while tokenizing history for custom-pattern completion output', () => {
    const session = createSessionWithCustomContractPII();
    const chunks: string[] = [];
    const result = executeComplete(
      session,
      `Contract ${rawContractId}`,
      undefined,
      (chunk) => chunks.push(chunk),
      undefined,
      {
        plain_text: `Say ${rawContractId}`,
      },
      {
        markdown: `Review ${rawContractId}`,
      },
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(result.action.message).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.action.message).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks).toEqual([expect.stringContaining('[REDACTED_CONTRACT_ID]')]);
    expect(chunks.join('')).not.toContain(rawContractId);

    const last = session.conversationHistory[session.conversationHistory.length - 1];
    expect(last.role).toBe('assistant');
    expect(String(last.content)).toContain('{{PII:ContractID:');
    expect(String(last.content)).not.toContain(rawContractId);
  });

  it('returns undefined richContent when not provided', () => {
    const session = createMockSession();
    const result = executeComplete(session, 'Done');
    expect(result.richContent).toBeUndefined();
  });
});
