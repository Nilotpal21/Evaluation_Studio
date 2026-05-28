/**
 * Trace Forwarder Integration Tests
 *
 * Verifies that buildExecutionContext correctly wires the trace forwarder
 * when traceStore is provided, falls back to no-op when neither is provided,
 * and gives precedence to an explicit trace dep.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildExecutionContext,
  type BridgeDeps,
} from '../../services/execution/execution-context-bridge.js';
import { createBaseSession } from '../execution/pre-refactor/helpers/test-session-factory.js';
import type { TraceStoreInterface, TraceEvent } from '../../services/trace-store.js';

function createMockTraceStore(): TraceStoreInterface & {
  capturedEvents: TraceEvent[];
} {
  const capturedEvents: TraceEvent[] = [];
  return {
    capturedEvents,
    addEvent: vi.fn((sessionId: string, event: TraceEvent) => {
      capturedEvents.push(event);
    }),
    readSince: vi.fn((_sessionId: string, afterEventId?: string) => ({
      events: [],
      totalBuffered: 0,
      afterEventId,
      snapshotRequired: false,
    })),
    subscribe: vi.fn(() => ({ success: true, eventCount: 0 })),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    getEvents: vi.fn(() => []),
    getActiveSessions: vi.fn(() => []),
    setSessionAgent: vi.fn(),
    removeSession: vi.fn(),
    stop: vi.fn(),
  };
}

function createSessionWithIR() {
  const session = createBaseSession();
  session.agentIR = { name: 'Test', execution: { mode: 'reasoning' } } as any;
  return session;
}

describe('trace forwarder integration with buildExecutionContext', () => {
  it('creates a forwarding trace when traceStore is provided', async () => {
    const mockStore = createMockTraceStore();
    const session = createSessionWithIR();

    const deps: BridgeDeps = { traceStore: mockStore };
    const ctx = buildExecutionContext(session, deps);

    // The trace should be wired — calling logConstraintCheck should forward
    await ctx.trace.logConstraintCheck('must_be_adult', true, { age: 25 });

    expect(mockStore.addEvent).toHaveBeenCalledOnce();
    const event = mockStore.capturedEvents[0];
    expect(event.type).toBe('constraint_check');
    expect(event.data).toMatchObject({
      constraint: 'must_be_adult',
      passed: true,
      source: 'construct-layer',
    });
  });

  it('uses no-op stub when neither trace nor traceStore is provided', () => {
    const session = createSessionWithIR();

    const deps: BridgeDeps = {};
    const ctx = buildExecutionContext(session, deps);

    // The no-op stub should not throw
    expect(() => ctx.trace.logConstraintCheck('test', true, {})).not.toThrow();
    expect(() => ctx.trace.addEvent('test', {})).not.toThrow();
    const span = ctx.trace.startSpan('test');
    expect(() => span.end()).not.toThrow();
  });

  it('explicit trace dep takes precedence over traceStore', async () => {
    const mockStore = createMockTraceStore();
    const explicitTrace = {
      logConstraintCheck: vi.fn(),
      logHandoff: vi.fn(),
      logLLMCall: vi.fn(),
      logToolCall: vi.fn(),
      startSpan: vi.fn(() => ({ end: vi.fn() })),
      getCurrentSpan: vi.fn(),
      addEvent: vi.fn(),
    };

    const session = createSessionWithIR();

    const deps: BridgeDeps = {
      trace: explicitTrace as any,
      traceStore: mockStore,
    };
    const ctx = buildExecutionContext(session, deps);

    await ctx.trace.logConstraintCheck('test', false, {});

    // The explicit trace should have been called, NOT the traceStore
    expect(explicitTrace.logConstraintCheck).toHaveBeenCalledOnce();
    expect(mockStore.addEvent).not.toHaveBeenCalled();
  });
});
