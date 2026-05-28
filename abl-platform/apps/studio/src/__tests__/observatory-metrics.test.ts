import { describe, expect, test } from 'vitest';
import type { Span } from '../types';
import {
  buildSpanSummaries,
  getDecisionEvents,
  getSpanLlmMetrics,
  summarizeSpanSummaries,
} from '../features/observatory/metrics';
import {
  collectAllSpanIds,
  collectVisibleSpanIds,
  findAncestorSpanIds,
  hasDescendantSpan,
  selectSelectedSpan,
  selectSpanSummaries,
} from '../features/observatory/selectors';

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'span-1',
    startTime: new Date('2025-01-01T10:00:00Z'),
    durationMs: 1500,
    status: 'completed',
    agentName: 'agent-1',
    sessionId: 'session-1',
    events: [],
    attributes: {},
    ...overrides,
  };
}

describe('observatory metrics', () => {
  test('aggregates cost, tokens, and latency from llm_call events only', () => {
    const span = makeSpan({
      events: [
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:00Z'),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: {
            cost: 0.12,
            promptTokens: 10,
            completionTokens: 4,
            latencyMs: 1200,
          },
        },
        {
          id: 'evt-2',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:01Z'),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: {
            usage: {
              inputTokens: 3,
              outputTokens: 2,
            },
            durationMs: 800,
          },
        },
        {
          id: 'evt-3',
          type: 'tool_call',
          timestamp: new Date('2025-01-01T10:00:02Z'),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: {
            cost: 9.99,
            promptTokens: 999,
            completionTokens: 999,
            latencyMs: 999,
          },
        },
      ],
    });

    expect(getSpanLlmMetrics(span)).toEqual({
      llmCallCount: 2,
      cost: 0.12,
      hasCost: true,
      promptTokens: 13,
      completionTokens: 6,
      totalTokens: 19,
      hasTokens: true,
      latencyMs: 2000,
      hasLatency: true,
    });
  });

  test('builds span summaries and totals from shared metric logic', () => {
    const rootSpan = makeSpan({
      spanId: 'span-root',
      name: 'root',
      durationMs: 3000,
      events: [
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:00Z'),
          traceId: 'trace-1',
          spanId: 'span-root',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: { cost: 0.05, tokensIn: 10, tokensOut: 5 },
        },
      ],
    });
    const childSpan = makeSpan({
      spanId: 'span-child',
      name: 'child',
      durationMs: 500,
      status: 'error',
      events: [
        {
          id: 'evt-2',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:01Z'),
          traceId: 'trace-1',
          spanId: 'span-child',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: { cost: 0.02, promptTokens: 2, completionTokens: 1 },
        },
      ],
    });

    const summaries = buildSpanSummaries([rootSpan, childSpan]);

    expect(summaries).toEqual([
      {
        span: rootSpan,
        cost: 0.05,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        latencyMs: undefined,
      },
      {
        span: childSpan,
        cost: 0.02,
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        latencyMs: undefined,
      },
    ]);

    expect(summarizeSpanSummaries(summaries)).toEqual({
      totalCost: 0.07,
      totalTokens: 18,
      totalDuration: 3500,
      errorCount: 1,
      spanCount: 2,
    });
  });

  test('returns decision events separately from llm metrics', () => {
    const decisionEvent = {
      id: 'evt-decision',
      type: 'decision' as const,
      timestamp: new Date('2025-01-01T10:00:00Z'),
      traceId: 'trace-1',
      spanId: 'span-1',
      sessionId: 'session-1',
      agentName: 'agent-1',
      data: { decisionKind: 'next_step' },
    };
    const span = makeSpan({
      events: [
        decisionEvent,
        {
          id: 'evt-llm',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:01Z'),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'session-1',
          agentName: 'agent-1',
          data: { cost: 0.01 },
        },
      ],
    });

    expect(getDecisionEvents(span)).toEqual([decisionEvent]);
  });
});

describe('observatory selectors', () => {
  test('selects span summaries and selected span from a map', () => {
    const spanA = makeSpan({ spanId: 'span-a', name: 'A' });
    const spanB = makeSpan({ spanId: 'span-b', name: 'B' });
    const spans = new Map([
      [spanA.spanId, spanA],
      [spanB.spanId, spanB],
    ]);

    expect(selectSelectedSpan(spans, 'span-b')).toBe(spanB);
    expect(selectSelectedSpan(spans, 'missing')).toBeNull();
    expect(selectSpanSummaries(spans)).toEqual(buildSpanSummaries([spanA, spanB]));
  });

  test('computes visible tree IDs and ancestors from collapse state', () => {
    const root = makeSpan({ spanId: 'root', name: 'root' });
    const child = makeSpan({ spanId: 'child', name: 'child', parentSpanId: 'root' });
    const grandchild = makeSpan({
      spanId: 'grandchild',
      name: 'grandchild',
      parentSpanId: 'child',
    });
    const sibling = makeSpan({ spanId: 'sibling', name: 'sibling' });

    const tree = [
      {
        span: root,
        depth: 0,
        children: [
          {
            span: child,
            depth: 1,
            children: [
              {
                span: grandchild,
                depth: 2,
                children: [],
              },
            ],
          },
        ],
      },
      {
        span: sibling,
        depth: 0,
        children: [],
      },
    ];

    expect(collectAllSpanIds(tree)).toEqual(new Set(['root', 'child', 'grandchild', 'sibling']));
    expect(collectVisibleSpanIds(tree, new Set(['child']))).toEqual(['root', 'child', 'sibling']);
    expect(findAncestorSpanIds(tree, 'grandchild')).toEqual(['root', 'child']);
    expect(hasDescendantSpan(tree[0], 'grandchild')).toBe(true);
    expect(hasDescendantSpan(tree[1], 'grandchild')).toBe(false);
  });
});
