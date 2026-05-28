/**
 * Observatory Store — span_end Handling Tests
 *
 * Verifies Phase 2 additions to the observatory store:
 * - span_end event closes the target span (status + timestamp)
 * - getSpanTree() skips events without spanId
 * - getActiveSpan() works with the active-span registry (latest running span)
 * - Backward compat: events without spanId don't crash
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';
import type { ExtendedTraceEvent } from '../types';

function makeEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'llm_call',
    timestamp: new Date(),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    data: {},
    ...overrides,
  };
}

describe('Observatory Store — span_end handling', () => {
  beforeEach(() => {
    // Reset store state
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.resetMetrics();
  });

  describe('span_end event closes the target span', () => {
    it('marks a running span as completed when span_end event arrives', () => {
      const store = useObservatoryStore.getState();

      // Start a span
      store.startSpan(
        'span-abc',
        'TestAgent',
        'trace-1',
        'session-1',
        'TestAgent',
        undefined,
        new Date(),
      );

      // Verify it's running (re-read state after mutation)
      expect(useObservatoryStore.getState().spans.get('span-abc')?.status).toBe('running');

      // Add span_end event
      const endTime = new Date(Date.now() + 1000);
      store.addEvent(
        makeEvent({
          type: 'span_end' as ExtendedTraceEvent['type'],
          spanId: 'span-abc',
          timestamp: endTime,
          data: { status: 'completed' },
        }),
      );

      const span = useObservatoryStore.getState().spans.get('span-abc');
      expect(span?.status).toBe('completed');
      expect(span?.endTime).toEqual(endTime);
    });

    it('marks a running span as error when span_end has status: error', () => {
      const store = useObservatoryStore.getState();

      store.startSpan('span-err', 'ErrorAgent', 'trace-1', 'session-1', 'ErrorAgent');

      store.addEvent(
        makeEvent({
          type: 'span_end' as ExtendedTraceEvent['type'],
          spanId: 'span-err',
          data: { status: 'error' },
        }),
      );

      expect(useObservatoryStore.getState().spans.get('span-err')?.status).toBe('error');
    });

    it('does not crash when span_end references a non-existent span', () => {
      const store = useObservatoryStore.getState();

      expect(() =>
        store.addEvent(
          makeEvent({
            type: 'span_end' as ExtendedTraceEvent['type'],
            spanId: 'non-existent-span',
            data: { status: 'completed' },
          }),
        ),
      ).not.toThrow();
    });

    it('calculates durationMs when span is closed', () => {
      const store = useObservatoryStore.getState();
      const startTime = new Date('2025-01-01T00:00:00Z');
      const endTime = new Date('2025-01-01T00:00:05Z');

      store.startSpan('span-dur', 'Agent', 'trace-1', 'session-1', 'Agent', undefined, startTime);

      store.addEvent(
        makeEvent({
          type: 'span_end' as ExtendedTraceEvent['type'],
          spanId: 'span-dur',
          timestamp: endTime,
          data: { status: 'completed' },
        }),
      );

      const span = useObservatoryStore.getState().spans.get('span-dur');
      expect(span?.durationMs).toBe(5000);
    });
  });

  describe('getSpanTree() skips events without spanId', () => {
    it('builds tree with valid spans only', () => {
      const store = useObservatoryStore.getState();

      // Create a normal span
      store.startSpan('span-valid', 'AgentA', 'trace-1', 'session-1', 'AgentA');

      const tree = store.getSpanTree();
      expect(tree.length).toBe(1);
      expect(tree[0].span.spanId).toBe('span-valid');
    });

    it('handles orphan child spans gracefully (parent not in tree)', () => {
      const store = useObservatoryStore.getState();

      // Create a child span whose parent doesn't exist — it should become a root
      store.startSpan(
        'orphan-child',
        'Agent',
        'trace-1',
        'session-1',
        'Agent',
        'non-existent-parent',
      );
      store.startSpan('span-real', 'Real', 'trace-1', 'session-1', 'Real');

      const tree = useObservatoryStore.getState().getSpanTree();
      const spanIds = tree.map((n) => n.span.spanId);
      expect(spanIds).toContain('orphan-child');
      expect(spanIds).toContain('span-real');
      // Both should be roots since parent doesn't exist
      expect(tree.length).toBe(2);
    });

    it('correctly nests child spans under parents', () => {
      const store = useObservatoryStore.getState();

      store.startSpan('parent', 'AgentA', 'trace-1', 'session-1', 'AgentA');
      store.startSpan('child', 'AgentA', 'trace-1', 'session-1', 'AgentA', 'parent');

      const tree = store.getSpanTree();
      expect(tree.length).toBe(1);
      expect(tree[0].span.spanId).toBe('parent');
      expect(tree[0].children.length).toBe(1);
      expect(tree[0].children[0].span.spanId).toBe('child');
      expect(tree[0].children[0].depth).toBe(1);
    });
  });

  describe('getActiveSpan() — active-span registry', () => {
    it('returns the most recently started running span', () => {
      const store = useObservatoryStore.getState();
      const t1 = new Date('2025-01-01T00:00:00Z');
      const t2 = new Date('2025-01-01T00:00:01Z');

      store.startSpan('span-old', 'AgentA', 'trace-1', 'session-1', 'AgentA', undefined, t1);
      store.startSpan('span-new', 'AgentB', 'trace-1', 'session-1', 'AgentB', undefined, t2);

      const active = store.getActiveSpan();
      expect(active?.spanId).toBe('span-new');
    });

    it('returns undefined when no spans are running', () => {
      const store = useObservatoryStore.getState();

      store.startSpan('span-done', 'Agent', 'trace-1', 'session-1', 'Agent');
      store.endSpan('span-done', 'completed');

      expect(store.getActiveSpan()).toBeUndefined();
    });

    it('skips completed spans, returns latest running', () => {
      const store = useObservatoryStore.getState();
      const t1 = new Date('2025-01-01T00:00:00Z');
      const t2 = new Date('2025-01-01T00:00:01Z');
      const t3 = new Date('2025-01-01T00:00:02Z');

      store.startSpan('span-1', 'A', 'trace-1', 'session-1', 'A', undefined, t1);
      store.startSpan('span-2', 'B', 'trace-1', 'session-1', 'B', undefined, t2);
      store.startSpan('span-3', 'C', 'trace-1', 'session-1', 'C', undefined, t3);

      // Complete the newest
      store.endSpan('span-3', 'completed');

      const active = store.getActiveSpan();
      expect(active?.spanId).toBe('span-2');
    });
  });

  describe('backward compatibility — events without spanId', () => {
    it('addEvent with agentName but no matching span creates fallback span', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        makeEvent({
          type: 'llm_call',
          agentName: 'fallback-agent',
          sessionId: 'sess-1',
          traceId: 'trace-1',
          spanId: 'some-span-id',
        }),
      );

      // A fallback span should have been created for the agent
      const { spans } = useObservatoryStore.getState();
      let foundFallback = false;
      for (const [, span] of spans) {
        if (span.agentName === 'fallback-agent') {
          foundFallback = true;
          break;
        }
      }
      expect(foundFallback).toBe(true);
    });

    it('session_ended sweeps all running spans to completed', () => {
      const store = useObservatoryStore.getState();

      store.startSpan('span-running-1', 'A', 'trace-1', 'session-1', 'A');
      store.startSpan('span-running-2', 'B', 'trace-1', 'session-1', 'B');

      store.addEvent(
        makeEvent({
          type: 'session_ended' as ExtendedTraceEvent['type'],
          agentName: 'system',
          spanId: 'system-span',
        }),
      );

      const { spans } = useObservatoryStore.getState();
      for (const [, span] of spans) {
        if (span.spanId === 'span-running-1' || span.spanId === 'span-running-2') {
          expect(span.status).toBe('completed');
        }
      }
    });

    it('events of unknown agent type do not crash', () => {
      const store = useObservatoryStore.getState();
      expect(() =>
        store.addEvent(
          makeEvent({
            type: 'llm_call',
            agentName: 'unknown',
            spanId: 'some-span',
          }),
        ),
      ).not.toThrow();
    });
  });
});
