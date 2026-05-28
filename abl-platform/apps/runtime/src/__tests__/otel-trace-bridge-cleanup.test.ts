/**
 * Tests for OtelTraceStore orphaned span cleanup (M-5).
 *
 * Verifies that activeSpans are properly cleaned up when
 * sessions are evicted from the trace store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @opentelemetry/api before importing OtelTraceStore
const mockSpanEnd = vi.fn();
const mockStartSpan = vi.fn().mockReturnValue({
  end: mockSpanEnd,
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startSpan: mockStartSpan,
    }),
    setSpan: vi.fn().mockReturnValue({}),
  },
  context: {
    active: vi.fn().mockReturnValue({}),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
    }),
  },
  SpanStatusCode: {
    ERROR: 2,
  },
}));

import { OtelTraceStore } from '../observability/otel-trace-bridge.js';

describe('OtelTraceStore cleanup (M-5)', () => {
  let store: OtelTraceStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new OtelTraceStore({
      type: 'memory',
      environment: 'dev',
    });
  });

  it('ends orphaned spans during cleanup', () => {
    // Start a trace (creates an active span)
    const manager = store.startTrace({
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      sessionId: 'session-1',
      environment: 'dev',
    });

    expect(store.activeSpanCount).toBe(1);

    // Don't call endTrace — simulate abnormal termination
    // Trigger cleanup with empty active set (all spans are orphaned)
    store.cleanupOrphanedSpans(new Set());

    expect(store.activeSpanCount).toBe(0);
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  it('removes orphaned spans from activeSpans map', () => {
    store.startTrace({
      agentName: 'agent-a',
      agentVersion: '1.0.0',
      sessionId: 's-1',
      environment: 'dev',
    });
    store.startTrace({
      agentName: 'agent-b',
      agentVersion: '1.0.0',
      sessionId: 's-2',
      environment: 'dev',
    });

    expect(store.activeSpanCount).toBe(2);

    // Cleanup all
    store.cleanupOrphanedSpans();

    expect(store.activeSpanCount).toBe(0);
  });

  it('does not end spans for active sessions', () => {
    const manager1 = store.startTrace({
      agentName: 'agent-a',
      agentVersion: '1.0.0',
      sessionId: 's-1',
      environment: 'dev',
    });
    store.startTrace({
      agentName: 'agent-b',
      agentVersion: '1.0.0',
      sessionId: 's-2',
      environment: 'dev',
    });

    // Only keep first trace active
    const activeSet = new Set([manager1.traceId]);
    vi.clearAllMocks(); // Reset span.end call count

    store.cleanupOrphanedSpans(activeSet);

    // One span should remain (the active one)
    expect(store.activeSpanCount).toBe(1);
    // span.end was called once (for the orphaned span)
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('handles span.end() throwing gracefully', () => {
    store.startTrace({
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      sessionId: 'session-1',
      environment: 'dev',
    });

    // Make span.end() throw
    mockSpanEnd.mockImplementationOnce(() => {
      throw new Error('Span already ended');
    });

    // Should not throw
    expect(() => store.cleanupOrphanedSpans()).not.toThrow();
    expect(store.activeSpanCount).toBe(0);
  });
});
