/**
 * Routing Executor & Types — Comprehensive Helper Function Tests
 *
 * Tests standalone helper functions from:
 * - routing-executor.ts: parseTimeout, mapDelegateInput, mapDelegateReturns,
 *   handleDelegateFailure, deduplicateFanOutTasks, formatFanOutToolResult,
 *   findHandoffConfig, resolveHistoryStrategy, executeComplete
 * - types.ts: getGatherProgress, setGatheredValues, deleteSessionValue,
 *   buildStateUpdates, getActiveThread, createThread, tryThreadReturn
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseTimeout,
  mapDelegateInput,
  mapDelegateReturns,
  handleDelegateFailure,
  deduplicateFanOutTasks,
  formatFanOutToolResult,
  findHandoffConfig,
  resolveHistoryStrategy,
  executeComplete,
} from '../../services/execution/routing-executor.js';

import {
  getGatherProgress,
  setGatheredValues,
  deleteSessionValue,
  buildStateUpdates,
  getActiveThread,
  createThread,
  tryThreadReturn,
} from '../../services/execution/types.js';
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
  AgentThread,
} from '../../services/execution/types.js';

import {
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  type HandoffConfig,
  type HistoryStrategy,
} from '@abl/compiler';

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

  it('parses single second ("1s")', () => {
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

  it('parses "5m" to 300000ms', () => {
    expect(parseTimeout('5m')).toBe(300000);
  });

  it('parses bare number as milliseconds ("2000")', () => {
    expect(parseTimeout('2000')).toBe(2000);
  });

  it('parses zero as 0ms', () => {
    expect(parseTimeout('0')).toBe(0);
  });

  it('parses "0s" as 0', () => {
    expect(parseTimeout('0s')).toBe(0);
  });

  it('parses "0m" as 0', () => {
    expect(parseTimeout('0m')).toBe(0);
  });

  it('parses "0ms" as 0', () => {
    expect(parseTimeout('0ms')).toBe(0);
  });

  it('returns undefined for invalid format ("abc")', () => {
    expect(parseTimeout('abc')).toBeUndefined();
  });

  it('returns undefined for negative numbers ("-10s")', () => {
    expect(parseTimeout('-10s')).toBeUndefined();
  });

  it('returns undefined for floating point ("1.5s")', () => {
    expect(parseTimeout('1.5s')).toBeUndefined();
  });

  it('returns undefined for unsupported unit ("2h")', () => {
    expect(parseTimeout('2h')).toBeUndefined();
  });

  it('returns undefined for unit-only input ("ms")', () => {
    expect(parseTimeout('ms')).toBeUndefined();
  });

  it('returns undefined for spaces ("30 s")', () => {
    expect(parseTimeout('30 s')).toBeUndefined();
  });

  it('handles large millisecond values ("999999ms")', () => {
    expect(parseTimeout('999999ms')).toBe(999999);
  });

  it('handles large second values ("3600s")', () => {
    expect(parseTimeout('3600s')).toBe(3600000);
  });

  it('handles "10m" as 600000ms', () => {
    expect(parseTimeout('10m')).toBe(600000);
  });
});

// =============================================================================
// mapDelegateInput
// =============================================================================

describe('mapDelegateInput', () => {
  it('maps simple key-value pairs from context', () => {
    const mapping = { destination: 'city', nights: 'num_nights' };
    const context = { city: 'Paris', num_nights: 3 };
    expect(mapDelegateInput(mapping, context)).toEqual({ destination: 'Paris', nights: 3 });
  });

  it('skips keys where source value is undefined', () => {
    const mapping = { destination: 'city', budget: 'max_budget' };
    const context = { city: 'London' };
    const result = mapDelegateInput(mapping, context);
    expect(result).toEqual({ destination: 'London' });
    expect(result).not.toHaveProperty('budget');
  });

  it('returns empty object for empty mapping', () => {
    expect(mapDelegateInput({}, { foo: 'bar' })).toEqual({});
  });

  it('returns empty object when no context values match', () => {
    expect(mapDelegateInput({ a: 'x', b: 'y' }, { foo: 'bar' })).toEqual({});
  });

  it('maps nested property paths', () => {
    const mapping = { name: 'user.name' };
    const context = { user: { name: 'Alice', age: 30 } };
    expect(mapDelegateInput(mapping, context)).toEqual({ name: 'Alice' });
  });

  it('maps deeply nested paths', () => {
    const mapping = { zip: 'address.location.zipcode' };
    const context = { address: { location: { zipcode: '10001' } } };
    expect(mapDelegateInput(mapping, context)).toEqual({ zip: '10001' });
  });

  it('maps null values (not undefined)', () => {
    const mapping = { val: 'field' };
    const context: Record<string, unknown> = { field: null };
    expect(mapDelegateInput(mapping, context)).toEqual({ val: null });
  });

  it('maps boolean false as a valid value', () => {
    expect(mapDelegateInput({ flag: 'isActive' }, { isActive: false })).toEqual({ flag: false });
  });

  it('maps array values', () => {
    expect(mapDelegateInput({ items: 'cart' }, { cart: ['a', 'b'] })).toEqual({
      items: ['a', 'b'],
    });
  });

  it('maps numeric zero as valid value', () => {
    expect(mapDelegateInput({ count: 'total' }, { total: 0 })).toEqual({ count: 0 });
  });

  it('maps empty string as valid value', () => {
    expect(mapDelegateInput({ note: 'comment' }, { comment: '' })).toEqual({ note: '' });
  });

  it('maps array.length paths', () => {
    expect(mapDelegateInput({ count: 'items.length' }, { items: ['a', 'b', 'c'] })).toEqual({
      count: 3,
    });
  });

  it('handles multiple mappings with partial matches', () => {
    expect(mapDelegateInput({ a: 'x', b: 'y', c: 'z' }, { x: 1, z: 3 })).toEqual({ a: 1, c: 3 });
  });

  it('maps object values from context', () => {
    const context = { config: { timeout: 5000, retries: 3 } };
    expect(mapDelegateInput({ settings: 'config' }, context)).toEqual({
      settings: { timeout: 5000, retries: 3 },
    });
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
      response: JSON.stringify({ summary: 'Confirmed', id: 'BK123' }),
      action: { type: 'complete' },
    };
    mapDelegateReturns(mapping, result, session);
    expect(session.data.values.booking_summary).toBe('Confirmed');
    expect(session.data.values.booking_id).toBe('BK123');
  });

  it('adds mapped keys to gatheredKeys set', () => {
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
    expect(session.data.gatheredKeys.has('target')).toBe(false);
  });

  it('handles empty mapping', () => {
    const session = createMockSession();
    mapDelegateReturns(
      {},
      { response: JSON.stringify({ foo: 'bar' }), action: { type: 'complete' } },
      session,
    );
    expect(Object.keys(session.data.values).length).toBe(0);
  });

  it('handles object response (non-string)', () => {
    const session = createMockSession();
    const result = {
      response: { key: 'objectValue' } as unknown as string,
      action: { type: 'complete' },
    };
    mapDelegateReturns({ key: 'val' }, result, session);
    expect(session.data.values.val).toBe('objectValue');
  });

  it('handles null values in JSON response', () => {
    const session = createMockSession();
    const result: ExecutionResult = {
      response: JSON.stringify({ val: null }),
      action: { type: 'complete' },
    };
    mapDelegateReturns({ val: 'target' }, result, session);
    expect(session.data.values.target).toBeNull();
    expect(session.data.gatheredKeys.has('target')).toBe(true);
  });

  it('handles numeric values in JSON response', () => {
    const session = createMockSession();
    const result: ExecutionResult = {
      response: JSON.stringify({ total: 42 }),
      action: { type: 'complete' },
    };
    mapDelegateReturns({ total: 'final_total' }, result, session);
    expect(session.data.values.final_total).toBe(42);
  });

  it('handles nested JSON response with flat mapping', () => {
    const session = createMockSession();
    const result: ExecutionResult = {
      response: JSON.stringify({ nested: { deep: 'value' } }),
      action: { type: 'complete' },
    };
    mapDelegateReturns({ nested: 'result_nested' }, result, session);
    expect(session.data.values.result_nested).toEqual({ deep: 'value' });
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
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('delegate_complete');
    expect(events[0].data.success).toBe(false);
    expect(events[0].data.to).toBe('BookingAgent');
    expect(events[0].data.error).toBe('timeout');
  });

  it('does not throw when onTraceEvent is not provided', () => {
    const session = createMockSession();
    const result = handleDelegateFailure(session, undefined, 'error');
    expect(result.success).toBe(false);
  });

  it('does not call onChunk when on_failure is "continue"', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    const config: DelegateConfigIR = {
      agent: 'Agent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'continue',
    };
    handleDelegateFailure(session, config, 'error', (c) => chunks.push(c));
    expect(chunks).toHaveLength(0);
  });

  it('does not call onChunk when on_failure is "escalate"', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    const config: DelegateConfigIR = {
      agent: 'Agent',
      when: 'true',
      purpose: 'test',
      input: {},
      returns: {},
      use_result: 'result',
      on_failure: 'escalate',
    };
    handleDelegateFailure(session, config, 'error', (c) => chunks.push(c));
    expect(chunks).toHaveLength(0);
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
    expect(deduplicateFanOutTasks(tasks)).toEqual([{ target: 'AgentA', intent: 'do something' }]);
  });

  it('passes through tasks with different targets', () => {
    const tasks = [
      { target: 'AgentA', intent: 'task A' },
      { target: 'AgentB', intent: 'task B' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(2);
  });

  it('merges intents for duplicate target agents', () => {
    const tasks = [
      { target: 'AgentA', intent: 'find flights' },
      { target: 'AgentA', intent: 'check availability' },
    ];
    const result = deduplicateFanOutTasks(tasks);
    expect(result).toHaveLength(1);
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

  it('only second task has context -- merges onto undefined', () => {
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
    expect(task1.intent).toBe('task1');
    expect(task1.context).toEqual({ a: 1 });
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
  });

  it('formats empty results', () => {
    const formatted = formatFanOutToolResult({ success: false, results: [], failedCount: 0 });
    expect(formatted.summary).toContain('0/0 tasks succeeded');
  });

  it('returns the original results array reference', () => {
    const results: SubTaskResult[] = [{ target: 'A', status: 'completed', response: 'ok' }];
    const formatted = formatFanOutToolResult({ success: true, results, failedCount: 0 });
    expect(formatted.results).toBe(results);
  });

  it('includes failure instructions when tasks fail', () => {
    const formatted = formatFanOutToolResult({
      success: true,
      results: [{ target: 'A', status: 'error', error: 'err' }],
      failedCount: 1,
    });
    expect(formatted.summary).toContain('failed tasks');
    expect(formatted.summary).toContain("wasn't able to");
  });

  it('includes synthesis instructions without failure guidance when all succeed', () => {
    const formatted = formatFanOutToolResult({
      success: true,
      results: [{ target: 'A', status: 'completed', response: 'ok' }],
      failedCount: 0,
    });
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
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'BookingAgent', when: 'true', context: { pass: [], summary: '' }, return: true },
          ],
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
    expect(findHandoffConfig(session, 'AgentB')).toBeUndefined();
  });

  it('returns undefined when handoffs array is empty', () => {
    const session = createMockSession({
      agentIR: { coordination: { handoffs: [] } } as any,
    });
    expect(findHandoffConfig(session, 'AnyAgent')).toBeUndefined();
  });

  it('returns undefined when coordination is undefined', () => {
    const session = createMockSession({ agentIR: {} as any });
    expect(findHandoffConfig(session, 'AnyAgent')).toBeUndefined();
  });

  it('returns undefined when agentIR is null', () => {
    const session = createMockSession({ agentIR: null });
    expect(findHandoffConfig(session, 'AnyAgent')).toBeUndefined();
  });

  it('finds the correct config among multiple handoffs', () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'AgentA',
              when: 'cond_a',
              context: { pass: ['f1'], summary: 'A' },
              return: false,
            },
            { to: 'AgentB', when: 'cond_b', context: { pass: ['f2'], summary: 'B' }, return: true },
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
    session.threads[0].agentIR = {
      coordination: {
        handoffs: [
          { to: 'ThreadAgent', when: 'true', context: { pass: [], summary: '' }, return: false },
        ],
      },
    } as any;
    session.agentIR = {} as any;
    expect(findHandoffConfig(session, 'ThreadAgent')!.to).toBe('ThreadAgent');
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
    expect(findHandoffConfig(session, 'SessionAgent')!.to).toBe('SessionAgent');
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

  it('returns handoff-level "full" strategy', () => {
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
    expect(resolveHistoryStrategy(config)).toEqual({ last_n: 5 });
  });

  it('falls back to project-level defaultHistoryStrategy', () => {
    const session = createMockSession({
      compilationOutput: { coordination_defaults: { defaultHistoryStrategy: 'full' } } as any,
    });
    expect(resolveHistoryStrategy(undefined, session)).toBe('full');
  });

  it('handoff-level overrides project-level strategy', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '', history: 'summary_only' as HistoryStrategy },
      return: false,
    } as HandoffConfig;
    const session = createMockSession({
      compilationOutput: { coordination_defaults: { defaultHistoryStrategy: 'full' } } as any,
    });
    expect(resolveHistoryStrategy(config, session)).toBe('summary_only');
  });

  it('resolves the platform default when handoff has no history and no project defaults', () => {
    const config = {
      to: 'Agent',
      when: 'true',
      context: { pass: [], summary: '' },
      return: false,
    } as HandoffConfig;
    expect(resolveHistoryStrategy(config, createMockSession())).toEqual({
      last_n: DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
    });
  });

  it('resolves the platform default when session has compilationOutput but no coordination_defaults', () => {
    const session = createMockSession({ compilationOutput: {} as any });
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
    const result = executeComplete(session, 'Thank you!');
    expect(result.response).toBe('Thank you!');
  });

  it('interpolates template variables in message', () => {
    const session = createMockSession();
    session.data.values.name = 'Alice';
    const result = executeComplete(session, 'Goodbye, {{name}}!');
    expect(result.response).toBe('Goodbye, Alice!');
  });

  it('falls back to agent IR message when no message provided', () => {
    const session = createMockSession({
      agentIR: { messages: { conversation_complete: 'Custom complete' } } as any,
    });
    expect(executeComplete(session).response).toBe('Custom complete');
  });

  it('prefers localized catalog messages over IR fallbacks', () => {
    const session = createMockSession({
      agentIR: { messages: { conversation_complete: 'Custom complete' } } as any,
    });
    session.data.values._locale = 'fr-FR';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr-FR/testagent.json': JSON.stringify({
          conversation_complete: 'Conversation terminee.',
        }),
      }),
    );

    expect(executeComplete(session).response).toBe('Conversation terminee.');
  });

  it('falls back to DEFAULT_MESSAGES when no IR message', () => {
    const session = createMockSession();
    expect(executeComplete(session).response).toBe('This conversation has been completed.');
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

  it('handles null message by falling back to default', () => {
    const session = createMockSession();
    const result = executeComplete(session, null as unknown as string);
    expect(result.response).toBe('This conversation has been completed.');
  });
});

// =============================================================================
// getGatherProgress
// =============================================================================

describe('getGatherProgress', () => {
  it('returns empty object when no gathered keys', () => {
    const session = createMockSession();
    expect(getGatherProgress(session)).toEqual({});
  });

  it('returns only values for gathered keys', () => {
    const session = createMockSession();
    session.data.values = { city: 'Paris', hotel: 'Grand', _internal: 'hidden' };
    session.data.gatheredKeys = new Set(['city', 'hotel']);
    const progress = getGatherProgress(session);
    expect(progress).toEqual({ city: 'Paris', hotel: 'Grand' });
    expect(progress).not.toHaveProperty('_internal');
  });

  it('excludes gathered keys whose values have been deleted', () => {
    const session = createMockSession();
    session.data.gatheredKeys = new Set(['city', 'deleted_key']);
    session.data.values = { city: 'London' };
    const progress = getGatherProgress(session);
    expect(progress).toEqual({ city: 'London' });
    expect(progress).not.toHaveProperty('deleted_key');
  });

  it('returns all gathered keys when they exist in values', () => {
    const session = createMockSession();
    session.data.values = { a: 1, b: 2, c: 3, d: 4 };
    session.data.gatheredKeys = new Set(['a', 'b', 'c', 'd']);
    const progress = getGatherProgress(session);
    expect(Object.keys(progress)).toHaveLength(4);
    expect(progress).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  it('handles null and false values correctly', () => {
    const session = createMockSession();
    session.data.values = { nullable: null, flag: false, zero: 0 };
    session.data.gatheredKeys = new Set(['nullable', 'flag', 'zero']);
    const progress = getGatherProgress(session);
    expect(progress.nullable).toBeNull();
    expect(progress.flag).toBe(false);
    expect(progress.zero).toBe(0);
  });
});

// =============================================================================
// setGatheredValues
// =============================================================================

describe('setGatheredValues', () => {
  it('writes values to session data', () => {
    const session = createMockSession();
    setGatheredValues(session, { city: 'Paris', nights: 3 });
    expect(session.data.values.city).toBe('Paris');
    expect(session.data.values.nights).toBe(3);
  });

  it('marks keys as gathered', () => {
    const session = createMockSession();
    setGatheredValues(session, { city: 'Paris', nights: 3 });
    expect(session.data.gatheredKeys.has('city')).toBe(true);
    expect(session.data.gatheredKeys.has('nights')).toBe(true);
  });

  it('overwrites existing values', () => {
    const session = createMockSession();
    session.data.values.city = 'London';
    setGatheredValues(session, { city: 'Paris' });
    expect(session.data.values.city).toBe('Paris');
  });

  it('preserves existing values not in the new set', () => {
    const session = createMockSession();
    session.data.values.existing = 'keep';
    setGatheredValues(session, { city: 'Paris' });
    expect(session.data.values.existing).toBe('keep');
    expect(session.data.values.city).toBe('Paris');
  });

  it('adds to existing gatheredKeys without removing', () => {
    const session = createMockSession();
    session.data.gatheredKeys.add('existing_key');
    setGatheredValues(session, { new_key: 'value' });
    expect(session.data.gatheredKeys.has('existing_key')).toBe(true);
    expect(session.data.gatheredKeys.has('new_key')).toBe(true);
  });

  it('handles empty values object', () => {
    const session = createMockSession();
    session.data.values.keep = 'this';
    setGatheredValues(session, {});
    expect(session.data.values.keep).toBe('this');
    expect(session.data.gatheredKeys.size).toBe(0);
  });

  it('handles writing null values', () => {
    const session = createMockSession();
    setGatheredValues(session, { field: null });
    expect(session.data.values.field).toBeNull();
    expect(session.data.gatheredKeys.has('field')).toBe(true);
  });

  it('handles writing undefined values', () => {
    const session = createMockSession();
    setGatheredValues(session, { field: undefined });
    // Object.assign sets the key with value undefined
    expect('field' in session.data.values).toBe(true);
    expect(session.data.gatheredKeys.has('field')).toBe(true);
  });
});

// =============================================================================
// deleteSessionValue
// =============================================================================

describe('deleteSessionValue', () => {
  it('removes value from session data', () => {
    const session = createMockSession();
    session.data.values.city = 'Paris';
    deleteSessionValue(session, 'city');
    expect(session.data.values).not.toHaveProperty('city');
  });

  it('removes key from gatheredKeys', () => {
    const session = createMockSession();
    session.data.values.city = 'Paris';
    session.data.gatheredKeys.add('city');
    deleteSessionValue(session, 'city');
    expect(session.data.gatheredKeys.has('city')).toBe(false);
  });

  it('does not throw when key does not exist', () => {
    const session = createMockSession();
    expect(() => deleteSessionValue(session, 'nonexistent')).not.toThrow();
  });

  it('does not affect other values', () => {
    const session = createMockSession();
    session.data.values = { a: 1, b: 2, c: 3 };
    session.data.gatheredKeys = new Set(['a', 'b', 'c']);
    deleteSessionValue(session, 'b');
    expect(session.data.values).toEqual({ a: 1, c: 3 });
    expect(session.data.gatheredKeys.has('a')).toBe(true);
    expect(session.data.gatheredKeys.has('b')).toBe(false);
    expect(session.data.gatheredKeys.has('c')).toBe(true);
  });

  it('removes gathered key even if value was already absent', () => {
    const session = createMockSession();
    session.data.gatheredKeys.add('phantom');
    deleteSessionValue(session, 'phantom');
    expect(session.data.gatheredKeys.has('phantom')).toBe(false);
  });
});

// =============================================================================
// buildStateUpdates
// =============================================================================

describe('buildStateUpdates', () => {
  it('returns gatherProgress, context, conversationPhase, and activeAgent', () => {
    const session = createMockSession();
    session.data.values = { city: 'Paris', nights: 3 };
    session.data.gatheredKeys = new Set(['city']);
    session.state.conversationPhase = 'gathering';
    session.state.activeAgent = { name: 'TestAgent', mode: 'reasoning' };

    const updates = buildStateUpdates(session);
    expect(updates.gatherProgress).toEqual({ city: 'Paris' });
    expect(updates.context).toEqual({ city: 'Paris', nights: 3 });
    expect(updates.conversationPhase).toBe('gathering');
    expect(updates.activeAgent).toEqual({ name: 'TestAgent', mode: 'reasoning' });
  });

  it('returns empty gatherProgress when no gathered keys', () => {
    const session = createMockSession();
    session.data.values = { tool_result: 'data' };
    const updates = buildStateUpdates(session);
    expect(updates.gatherProgress).toEqual({});
  });

  it('returns full context with all values', () => {
    const session = createMockSession();
    session.data.values = { a: 1, b: 2, c: 3 };
    const updates = buildStateUpdates(session);
    expect(updates.context).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('returns a copy of context, not a reference', () => {
    const session = createMockSession();
    session.data.values = { key: 'value' };
    const updates = buildStateUpdates(session);
    updates.context!.key = 'modified';
    expect(session.data.values.key).toBe('value');
  });

  it('returns undefined activeAgent when not set', () => {
    const session = createMockSession();
    const updates = buildStateUpdates(session);
    expect(updates.activeAgent).toBeUndefined();
  });

  it('reflects conversationPhase accurately', () => {
    const session = createMockSession();
    session.state.conversationPhase = 'complete';
    expect(buildStateUpdates(session).conversationPhase).toBe('complete');
  });
});

// =============================================================================
// getActiveThread
// =============================================================================

describe('getActiveThread', () => {
  it('returns the thread at activeThreadIndex', () => {
    const session = createMockSession();
    const thread = getActiveThread(session);
    expect(thread).toBeDefined();
    expect(thread.agentName).toBe('TestAgent');
  });

  it('returns the correct thread when multiple threads exist', () => {
    const session = createMockSession();
    const secondThread: AgentThread = {
      agentName: 'SecondAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
    };
    session.threads.push(secondThread);
    session.activeThreadIndex = 1;
    expect(getActiveThread(session).agentName).toBe('SecondAgent');
  });

  it('returns undefined when activeThreadIndex is out of bounds', () => {
    const session = createMockSession();
    session.activeThreadIndex = 99;
    expect(getActiveThread(session)).toBeUndefined();
  });

  it('returns the first thread when index is 0', () => {
    const session = createMockSession();
    session.activeThreadIndex = 0;
    expect(getActiveThread(session)).toBe(session.threads[0]);
  });
});

// =============================================================================
// createThread
// =============================================================================

describe('createThread', () => {
  it('creates a new thread and pushes it to session.threads', () => {
    const session = createMockSession();
    const initialCount = session.threads.length;
    const thread = createThread(session, 'NewAgent', null);
    expect(session.threads.length).toBe(initialCount + 1);
    expect(session.threads[session.threads.length - 1]).toBe(thread);
  });

  it('sets agentName and agentIR on the new thread', () => {
    const session = createMockSession();
    const mockIR = { execution: { mode: 'reasoning' } } as any;
    const thread = createThread(session, 'MyAgent', mockIR);
    expect(thread.agentName).toBe('MyAgent');
    expect(thread.agentIR).toBe(mockIR);
  });

  it('initializes empty state and data by default', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    expect(thread.state).toEqual({ gatherProgress: {}, conversationPhase: 'start', context: {} });
    expect(thread.data.values).toMatchObject({ session_id: session.id });
    expect(thread.data.gatheredKeys.size).toBe(0);
  });

  it('initializes with empty conversation history by default', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    expect(thread.conversationHistory).toEqual([]);
  });

  it('sets returnExpected to false by default', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    expect(thread.returnExpected).toBe(false);
  });

  it('sets status to "active"', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    expect(thread.status).toBe('active');
  });

  it('sets startedAt to a recent timestamp', () => {
    const before = Date.now();
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    const after = Date.now();
    expect(thread.startedAt).toBeGreaterThanOrEqual(before);
    expect(thread.startedAt).toBeLessThanOrEqual(after);
  });

  it('respects handoffFrom option', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null, { handoffFrom: 'ParentAgent' });
    expect(thread.handoffFrom).toBe('ParentAgent');
  });

  it('respects handoffContext option', () => {
    const session = createMockSession();
    const ctx = { city: 'Paris', priority: 'high' };
    const thread = createThread(session, 'Agent', null, { handoffContext: ctx });
    expect(thread.handoffContext).toEqual(ctx);
  });

  it('respects returnExpected option', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null, { returnExpected: true });
    expect(thread.returnExpected).toBe(true);
  });

  it('respects initialData option', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null, {
      initialData: { city: 'Paris', nights: 3 },
    });
    expect(thread.data.values).toMatchObject({ city: 'Paris', nights: 3 });
  });

  it('respects initialHistory option', () => {
    const session = createMockSession();
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const thread = createThread(session, 'Agent', null, { initialHistory: history });
    expect(thread.conversationHistory).toEqual(history);
    // Should be a copy, not a reference
    expect(thread.conversationHistory).not.toBe(history);
  });

  it('sets currentFlowStep for scripted agents with flow', () => {
    const session = createMockSession();
    const ir = {
      execution: { mode: 'scripted' },
      flow: { entry_point: 'welcome', steps: ['welcome', 'gather', 'confirm'] },
    } as any;
    const thread = createThread(session, 'FlowAgent', ir);
    expect(thread.currentFlowStep).toBe('welcome');
  });

  it('uses first step when no entry_point is specified', () => {
    const session = createMockSession();
    const ir = {
      execution: { mode: 'scripted' },
      flow: { steps: ['step1', 'step2'] },
    } as any;
    const thread = createThread(session, 'FlowAgent', ir);
    expect(thread.currentFlowStep).toBe('step1');
  });

  it('does not set currentFlowStep for reasoning agents', () => {
    const session = createMockSession();
    const ir = {
      execution: { mode: 'reasoning' },
    } as any;
    const thread = createThread(session, 'ReasoningAgent', ir);
    expect(thread.currentFlowStep).toBeUndefined();
  });

  it('does not set currentFlowStep when agentIR is null', () => {
    const session = createMockSession();
    const thread = createThread(session, 'Agent', null);
    expect(thread.currentFlowStep).toBeUndefined();
  });

  it('makes a copy of initialData, not a reference', () => {
    const session = createMockSession();
    const initialData = { city: 'Paris' };
    const thread = createThread(session, 'Agent', null, { initialData });
    thread.data.values.city = 'London';
    expect(initialData.city).toBe('Paris');
  });
});

// =============================================================================
// tryThreadReturn
// =============================================================================

describe('tryThreadReturn', () => {
  it('returns false when thread is not returnExpected', () => {
    const session = createMockSession();
    session.threads[0].returnExpected = false;
    expect(tryThreadReturn(session, 'done')).toBe(false);
  });

  it('returns false when threadStack is empty', () => {
    const session = createMockSession();
    session.threads[0].returnExpected = true;
    session.threadStack = [];
    expect(tryThreadReturn(session, 'done')).toBe(false);
  });

  it('marks active thread as completed', () => {
    const session = createMockSession();
    session.threads[0].returnExpected = true;
    session.threadStack = [];
    tryThreadReturn(session, 'done');
    expect(session.threads[0].status).toBe('completed');
    expect(session.threads[0].endedAt).toBeDefined();
  });

  it('performs thread return when returnExpected and parent exists', () => {
    const session = createMockSession();
    // Parent thread at index 0
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    // Child thread at index 1
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: { result: 'success' }, gatheredKeys: new Set(['result']) },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0]; // parent index

    const returned = tryThreadReturn(session, 'Child completed');
    expect(returned).toBe(true);
    expect(childThread.status).toBe('completed');
    expect(parentThread.status).toBe('active');
    expect(session.activeThreadIndex).toBe(0);
  });

  it('removes the active child from handoffStack on return while preserving ancestors', () => {
    const session = createMockSession({
      handoffStack: ['GrandSupervisor', 'ChildAgent'],
    });
    const parentThread: AgentThread = {
      agentName: 'GrandSupervisor',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: { result: 'success' }, gatheredKeys: new Set(['result']) },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    const returned = tryThreadReturn(session, 'Child completed');

    expect(returned).toBe(true);
    expect(session.handoffStack).toEqual(['GrandSupervisor']);
  });

  it('removes the active child from handoffStack when a timeout escalates on return', () => {
    const startedAt = Date.now() - 50;
    const session = createMockSession({
      handoffStack: ['GrandSupervisor', 'ChildAgent'],
    });
    const parentThread: AgentThread = {
      agentName: 'GrandSupervisor',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
      handoffStartedAt: startedAt,
      handoffTimeoutMs: 1,
      handoffTimeoutAction: 'escalate',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    const returned = tryThreadReturn(session, 'Child timed out');

    expect(returned).toBe(true);
    expect(session.escalationReason).toContain('Handoff to ChildAgent timed out');
    expect(session.handoffStack).toEqual(['GrandSupervisor']);
  });

  it('merges child gathered data to parent by default', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: { existing: 'keep' }, gatheredKeys: new Set(['existing']) },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: { childResult: 'booked' }, gatheredKeys: new Set(['childResult']) },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'done');
    expect(parentThread.data.values.childResult).toBe('booked');
    expect(parentThread.data.gatheredKeys.has('childResult')).toBe(true);
    expect(parentThread.data.values.existing).toBe('keep');
  });

  it('uses ON_RETURN.MAP for structured return mapping', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'ChildAgent',
              when: 'true',
              context: { pass: [], summary: '' },
              return: true,
              on_return: { map: { childKey: 'parentKey' } },
            },
          ],
        },
      } as any,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: {
        values: { childKey: 'mapped_value', otherKey: 'ignored' },
        gatheredKeys: new Set(['childKey', 'otherKey']),
      },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'done');
    expect(parentThread.data.values.parentKey).toBe('mapped_value');
    expect(parentThread.data.values).not.toHaveProperty('otherKey');
    expect(parentThread.data.gatheredKeys.has('parentKey')).toBe(true);
  });

  it('propagates cleared readwrite execution_tree grants back to the parent workflow state', () => {
    const session = createMockSession({
      executionTreeValues: { 'workflow.auth_token': 'seed-token' },
    });
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: {
        memory: {
          persistent: [
            { path: 'workflow.auth_token', scope: 'execution_tree', access: 'readwrite' },
          ],
        },
      } as any,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: {
        values: {
          'workflow.auth_token': 'seed-token',
          execution_tree: { workflow: { auth_token: 'seed-token' } },
        },
        gatheredKeys: new Set(['workflow.auth_token']),
      },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: {
        values: {
          _granted_memory_meta: {
            'workflow.auth_token': {
              access: 'readwrite',
              path: 'workflow.auth_token',
              sourcePath: 'workflow.auth_token',
              sourceScope: 'execution_tree',
            },
          },
        },
        gatheredKeys: new Set(),
      },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    const returned = tryThreadReturn(session, 'done');

    expect(returned).toBe(true);
    expect(session.executionTreeValues).toEqual({});
    expect(parentThread.data.values).not.toHaveProperty('workflow.auth_token');
    expect(parentThread.data.values.execution_tree).toBeUndefined();
    expect(parentThread.data.gatheredKeys.has('workflow.auth_token')).toBe(false);
  });

  it('appends child response to parent conversation history', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'Booking confirmed!');
    const lastMsg = parentThread.conversationHistory[parentThread.conversationHistory.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('[ChildAgent]: Booking confirmed!');
  });

  it('preserves structured child response envelope in parent conversation history', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, {
      response: 'Booking confirmed!',
      richContent: { markdown: '**Booking confirmed!**' },
      actions: { elements: [{ type: 'button', id: 'view_booking', label: 'View booking' }] },
      voiceConfig: { plain_text: 'Booking confirmed.' },
    } as any);

    const lastMsg = parentThread.conversationHistory[parentThread.conversationHistory.length - 1];
    expect(lastMsg).toMatchObject({
      role: 'assistant',
      content: '[ChildAgent]: Booking confirmed!',
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        text: '[ChildAgent]: Booking confirmed!',
        richContent: { markdown: '**Booking confirmed!**' },
        actions: { elements: [{ type: 'button', id: 'view_booking', label: 'View booking' }] },
        voiceConfig: { plain_text: 'Booking confirmed.' },
      },
    });
  });

  it('does not append to history when response is empty', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, '');
    expect(parentThread.conversationHistory).toHaveLength(0);
  });

  it('invalidates llmClient after return', () => {
    const session = createMockSession();
    session.llmClient = { someClient: true } as any;
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'done');
    expect(session.llmClient).toBeUndefined();
  });

  it('emits thread_return trace event', () => {
    const session = createMockSession();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'result', (e) => events.push(e));
    const traceEvent = events.find((e) => e.type === 'thread_return');
    expect(traceEvent).toBeDefined();
    expect(traceEvent!.data.from).toBe('ChildAgent');
    expect(traceEvent!.data.to).toBe('ParentAgent');
    expect(traceEvent!.data.silent).toBe(false);
  });

  it('emits silent: true trace event when response is empty', () => {
    const session = createMockSession();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, '', (e) => events.push(e));
    const traceEvent = events.find((e) => e.type === 'thread_return');
    expect(traceEvent!.data.silent).toBe(true);
  });

  it('syncs parent thread state back to session', () => {
    const session = createMockSession();
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: { execution: { mode: 'reasoning' } } as any,
      conversationHistory: [{ role: 'user', content: 'Hi' }],
      state: { gatherProgress: {}, conversationPhase: 'gathering', context: {} },
      data: { values: { parentVal: 1 }, gatheredKeys: new Set(['parentVal']) },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
      currentFlowStep: 'step2',
    };
    const childThread: AgentThread = {
      agentName: 'ChildAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    tryThreadReturn(session, 'result');
    // Session fields should be synced from parent
    expect(session.agentName).toBe('ParentAgent');
    expect(session.currentFlowStep).toBe('step2');
  });
});
