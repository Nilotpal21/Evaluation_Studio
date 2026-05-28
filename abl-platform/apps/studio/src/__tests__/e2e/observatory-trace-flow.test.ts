/**
 * E2E: Observatory Event Processing
 *
 * Tests that trace events flow correctly to the Observatory UI store:
 * 1. Create events with traceId, spanId, parentSpanId
 * 2. Feed into observatory-store.addEvent()
 * 3. Verify getSpanTree() produces correct tree structure
 * 4. Verify span_end events update span status/duration
 * 5. Verify events without spanId are handled gracefully
 * 6. Verify getActiveSpan() returns correct span
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../../store/observatory-store';
import type { ExtendedTraceEvent } from '../../types';

function createEvent(overrides: Partial<ExtendedTraceEvent>): ExtendedTraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: 'agent_enter' as ExtendedTraceEvent['type'],
    timestamp: new Date(),
    traceId: 'trace-1',
    spanId: `span-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-1',
    agentName: 'greeter',
    data: {},
    ...overrides,
  };
}

describe('Observatory Event Processing E2E', () => {
  beforeEach(() => {
    // Reset store state between tests
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
  });

  describe('agent_enter → span creation', () => {
    it('creates a span when agent_enter event is added', () => {
      const store = useObservatoryStore.getState();

      const event = createEvent({
        type: 'agent_enter',
        traceId: 'trace-1',
        spanId: 'span-root',
        agentName: 'greeter',
      });

      store.addEvent(event);

      const span = store.getSpan('span-root');
      expect(span).toBeDefined();
      expect(span!.traceId).toBe('trace-1');
      expect(span!.agentName).toBe('greeter');
      expect(span!.status).toBe('running');
    });

    it('creates parent-child spans with correct linking', () => {
      const store = useObservatoryStore.getState();

      // Parent agent enters
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-parent',
          agentName: 'supervisor',
        }),
      );

      // Child agent enters
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-child',
          parentSpanId: 'span-parent',
          agentName: 'worker',
        }),
      );

      const parentSpan = store.getSpan('span-parent');
      const childSpan = store.getSpan('span-child');

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(childSpan!.parentSpanId).toBe('span-parent');
    });
  });

  describe('getSpanTree() tree structure', () => {
    it('builds correct tree with root and children', () => {
      const store = useObservatoryStore.getState();

      // Root agent
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-root',
          agentName: 'supervisor',
        }),
      );

      // Child agent
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-child-1',
          parentSpanId: 'span-root',
          agentName: 'worker-1',
        }),
      );

      // Grandchild agent
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-grandchild',
          parentSpanId: 'span-child-1',
          agentName: 'sub-worker',
        }),
      );

      const tree = store.getSpanTree();

      // Should have one root
      expect(tree.length).toBe(1);
      expect(tree[0].span.spanId).toBe('span-root');
      expect(tree[0].depth).toBe(0);

      // Root has one child
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].span.spanId).toBe('span-child-1');
      expect(tree[0].children[0].depth).toBe(1);

      // Child has one grandchild
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].span.spanId).toBe('span-grandchild');
      expect(tree[0].children[0].children[0].depth).toBe(2);
    });

    it('handles multiple root spans', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-root-1',
          agentName: 'agent-a',
        }),
      );

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-2',
          spanId: 'span-root-2',
          agentName: 'agent-b',
        }),
      );

      const tree = store.getSpanTree();
      expect(tree.length).toBe(2);
    });

    it('treats orphaned child spans (missing parent) as roots', () => {
      const store = useObservatoryStore.getState();

      // Child with no parent in the store
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-orphan',
          parentSpanId: 'span-nonexistent',
          agentName: 'orphan-agent',
        }),
      );

      const tree = store.getSpanTree();
      expect(tree.length).toBe(1);
      expect(tree[0].span.spanId).toBe('span-orphan');
      expect(tree[0].depth).toBe(0);
    });
  });

  describe('span_end events → status/duration update', () => {
    it('updates span status to completed on span_end', () => {
      const store = useObservatoryStore.getState();

      const startTime = new Date('2024-01-01T00:00:00Z');
      const endTime = new Date('2024-01-01T00:00:01Z');

      // Start span
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-1',
          agentName: 'greeter',
          timestamp: startTime,
        }),
      );

      expect(store.getSpan('span-1')!.status).toBe('running');

      // End span
      store.addEvent(
        createEvent({
          type: 'span_end',
          traceId: 'trace-1',
          spanId: 'span-1',
          agentName: 'greeter',
          timestamp: endTime,
          data: { status: 'completed', spanName: 'greeter' },
        }),
      );

      const span = store.getSpan('span-1');
      expect(span!.status).toBe('completed');
      expect(span!.endTime).toEqual(endTime);
      expect(span!.durationMs).toBe(1000);
    });

    it('updates span status to error on span_end with error status', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-err',
          agentName: 'failing-agent',
        }),
      );

      store.addEvent(
        createEvent({
          type: 'span_end',
          traceId: 'trace-1',
          spanId: 'span-err',
          agentName: 'failing-agent',
          data: { status: 'error', spanName: 'failing-agent' },
        }),
      );

      const span = store.getSpan('span-err');
      expect(span!.status).toBe('error');
    });

    it('agent_exit ends span with correct status', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-exit',
          agentName: 'greeter',
        }),
      );

      store.addEvent(
        createEvent({
          type: 'agent_exit',
          traceId: 'trace-1',
          spanId: 'span-exit',
          agentName: 'greeter',
          data: { result: 'success' },
        }),
      );

      const span = store.getSpan('span-exit');
      expect(span!.status).toBe('completed');
    });
  });

  describe('getActiveSpan()', () => {
    it('returns the most recently started running span', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-first',
          agentName: 'first',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }),
      );

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          traceId: 'trace-1',
          spanId: 'span-second',
          agentName: 'second',
          timestamp: new Date('2024-01-01T00:00:01Z'),
        }),
      );

      const activeSpan = store.getActiveSpan();
      expect(activeSpan).toBeDefined();
      expect(activeSpan!.spanId).toBe('span-second');
    });

    it('returns undefined when all spans are completed', () => {
      const store = useObservatoryStore.getState();

      // Manually start and end a span to avoid fallback span creation
      store.startSpan('span-done', 'agent', 'trace-1', 'sess-1', 'agent');
      store.endSpan('span-done', 'completed');

      const activeSpan = useObservatoryStore.getState().getActiveSpan();
      expect(activeSpan).toBeUndefined();
    });

    it('skips completed spans and returns running one', () => {
      const store = useObservatoryStore.getState();

      // Manually manage spans to avoid fallback span creation side effects
      store.startSpan(
        'span-completed',
        'done-agent',
        'trace-1',
        'sess-1',
        'done-agent',
        undefined,
        new Date('2024-01-01T00:00:00Z'),
      );
      store.endSpan('span-completed', 'completed');

      store.startSpan(
        'span-running',
        'active-agent',
        'trace-1',
        'sess-1',
        'active-agent',
        undefined,
        new Date('2024-01-01T00:00:02Z'),
      );

      const activeSpan = useObservatoryStore.getState().getActiveSpan();
      expect(activeSpan).toBeDefined();
      expect(activeSpan!.agentName).toBe('active-agent');
      expect(activeSpan!.status).toBe('running');
    });
  });

  describe('metric tracking through events', () => {
    it('tracks LLM call count and token usage', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'llm_call' as ExtendedTraceEvent['type'],
          agentName: 'greeter',
          data: {
            model: 'claude-3',
            usage: { inputTokens: 100, outputTokens: 50 },
          },
        }),
      );

      store.addEvent(
        createEvent({
          type: 'llm_call' as ExtendedTraceEvent['type'],
          agentName: 'greeter',
          data: {
            model: 'claude-3',
            usage: { inputTokens: 200, outputTokens: 100 },
          },
        }),
      );

      const state = useObservatoryStore.getState();
      expect(state.totalLLMCalls).toBe(2);
      expect(state.totalTokensIn).toBe(300);
      expect(state.totalTokensOut).toBe(150);
    });

    it('tracks tool call count', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'tool_call' as ExtendedTraceEvent['type'],
          agentName: 'greeter',
          data: { tool: 'weather', result: { temp: 72 } },
        }),
      );

      const state = useObservatoryStore.getState();
      expect(state.totalToolCalls).toBe(1);
    });
  });

  describe('session_ended sweeps all running spans', () => {
    it('completes all running spans on session_ended', () => {
      const store = useObservatoryStore.getState();

      // Start two agents
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          spanId: 'span-a',
          agentName: 'agent-a',
        }),
      );
      store.addEvent(
        createEvent({
          type: 'agent_enter',
          spanId: 'span-b',
          agentName: 'agent-b',
        }),
      );

      expect(store.getSpan('span-a')!.status).toBe('running');
      expect(store.getSpan('span-b')!.status).toBe('running');

      // Session ends
      store.addEvent(
        createEvent({
          type: 'session_ended' as ExtendedTraceEvent['type'],
          agentName: 'system',
          data: {},
        }),
      );

      expect(store.getSpan('span-a')!.status).toBe('completed');
      expect(store.getSpan('span-b')!.status).toBe('completed');
    });
  });

  describe('flow node auto-creation', () => {
    it('auto-creates flow nodes for agents seen in events', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          agentName: 'supervisor',
          spanId: 'span-sup',
        }),
      );

      const state = useObservatoryStore.getState();
      const node = state.flowNodes.find((n) => n.agentName === 'supervisor');
      expect(node).toBeDefined();
      expect(node!.status).toBe('active');
    });

    it('creates flow edges on handoff events', () => {
      const store = useObservatoryStore.getState();

      store.addEvent(
        createEvent({
          type: 'agent_enter',
          agentName: 'supervisor',
          spanId: 'span-sup',
        }),
      );

      store.addEvent(
        createEvent({
          type: 'handoff' as ExtendedTraceEvent['type'],
          agentName: 'supervisor',
          spanId: 'span-sup',
          data: { fromAgent: 'supervisor', toAgent: 'worker' },
        }),
      );

      const state = useObservatoryStore.getState();
      const edge = state.flowEdges.find((e) => e.from === 'supervisor' && e.to === 'worker');
      expect(edge).toBeDefined();

      // Target agent node should be auto-created
      const workerNode = state.flowNodes.find((n) => n.agentName === 'worker');
      expect(workerNode).toBeDefined();
    });
  });

  describe('clearEvents resets state', () => {
    it('clears all spans, events, and flow data', () => {
      useObservatoryStore.getState().addEvent(
        createEvent({
          type: 'agent_enter',
          spanId: 'span-1',
          agentName: 'agent',
        }),
      );

      const afterAdd = useObservatoryStore.getState();
      expect(afterAdd.events.length).toBeGreaterThan(0);
      expect(afterAdd.spans.size).toBeGreaterThan(0);

      useObservatoryStore.getState().clearEvents();

      const cleared = useObservatoryStore.getState();
      expect(cleared.events).toHaveLength(0);
      expect(cleared.spans.size).toBe(0);
      expect(cleared.flowNodes).toHaveLength(0);
      expect(cleared.flowEdges).toHaveLength(0);
    });
  });
});
