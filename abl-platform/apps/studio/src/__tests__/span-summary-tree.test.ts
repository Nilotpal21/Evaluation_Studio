import { describe, expect, it } from 'vitest';
import type { ExtendedTraceEvent, Span } from '../types';
import type { SpanSummary } from '../features/observatory/metrics';
import {
  buildSpanSummariesFromEvents,
  buildSpanSummaryTimeline,
  buildSpanSummaryTree,
  findSpanSummaryTimelineNode,
  flattenVisibleSpanSummaryTimelineNodes,
} from '../features/observatory/selectors';

function makeSummary(overrides: Partial<Span> = {}): SpanSummary {
  return {
    span: {
      spanId: 'span-1',
      traceId: 'trace-1',
      parentSpanId: undefined,
      name: 'root',
      startTime: new Date('2026-03-22T00:00:00.000Z'),
      durationMs: 100,
      status: 'completed',
      agentName: 'agent-a',
      sessionId: 'session-1',
      events: [],
      attributes: {},
      ...overrides,
    },
  };
}

function makeEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: 'event-1',
    type: 'llm_call',
    timestamp: new Date('2026-03-22T00:00:00.000Z'),
    durationMs: 100,
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'agent-a',
    data: {},
    ...overrides,
  };
}

describe('buildSpanSummaryTree', () => {
  it('nests child spans beneath their parents and assigns depths', () => {
    const tree = buildSpanSummaryTree([
      makeSummary({ spanId: 'root', name: 'Root' }),
      makeSummary({ spanId: 'child', parentSpanId: 'root', name: 'Child' }),
      makeSummary({ spanId: 'grandchild', parentSpanId: 'child', name: 'Grandchild' }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].summary.span.spanId).toBe('root');
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].summary.span.spanId).toBe('child');
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].summary.span.spanId).toBe('grandchild');
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('keeps spans with missing parents at the root level', () => {
    const tree = buildSpanSummaryTree([
      makeSummary({ spanId: 'orphan', parentSpanId: 'missing', name: 'Orphan' }),
      makeSummary({ spanId: 'root', name: 'Root' }),
    ]);

    expect(tree.map((node) => node.summary.span.spanId)).toEqual(['orphan', 'root']);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
  });

  it('preserves sibling order from the source summaries', () => {
    const tree = buildSpanSummaryTree([
      makeSummary({ spanId: 'root', name: 'Root' }),
      makeSummary({ spanId: 'second-child', parentSpanId: 'root', name: 'Second' }),
      makeSummary({ spanId: 'first-child', parentSpanId: 'root', name: 'First' }),
    ]);

    expect(tree[0].children.map((node) => node.summary.span.spanId)).toEqual([
      'second-child',
      'first-child',
    ]);
  });

  it('computes waterfall timeline bounds and relative offsets', () => {
    const timeline = buildSpanSummaryTimeline([
      makeSummary({
        spanId: 'root',
        name: 'Root',
        startTime: new Date('2026-03-22T00:00:00.000Z'),
        durationMs: 200,
      }),
      makeSummary({
        spanId: 'child',
        parentSpanId: 'root',
        name: 'Child',
        startTime: new Date('2026-03-22T00:00:00.050Z'),
        durationMs: 50,
      }),
      makeSummary({
        spanId: 'sibling',
        name: 'Sibling',
        startTime: new Date('2026-03-22T00:00:00.250Z'),
        durationMs: 150,
      }),
    ]);

    expect(timeline.startTime?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(timeline.endTime?.toISOString()).toBe('2026-03-22T00:00:00.400Z');
    expect(timeline.totalDurationMs).toBe(400);
    expect(timeline.roots.map((node) => node.summary.span.spanId)).toEqual(['root', 'sibling']);
    expect(timeline.roots[0].offsetMs).toBe(0);
    expect(timeline.roots[0].widthPct).toBe(50);
    expect(timeline.roots[0].children[0].offsetMs).toBe(50);
    expect(timeline.roots[0].children[0].offsetPct).toBe(12.5);
    expect(timeline.roots[1].offsetPct).toBe(62.5);
    expect(timeline.roots[1].widthPct).toBe(37.5);
  });

  it('flattens only visible waterfall nodes and finds selections by span id', () => {
    const timeline = buildSpanSummaryTimeline([
      makeSummary({ spanId: 'root', name: 'Root' }),
      makeSummary({ spanId: 'child', parentSpanId: 'root', name: 'Child' }),
      makeSummary({ spanId: 'grandchild', parentSpanId: 'child', name: 'Grandchild' }),
      makeSummary({ spanId: 'sibling', name: 'Sibling' }),
    ]);

    expect(
      flattenVisibleSpanSummaryTimelineNodes(timeline.roots, new Set(['child'])).map(
        (node) => node.summary.span.spanId,
      ),
    ).toEqual(['root', 'child', 'sibling']);

    expect(findSpanSummaryTimelineNode(timeline.roots, 'grandchild')?.summary.span.name).toBe(
      'Grandchild',
    );
    expect(findSpanSummaryTimelineNode(timeline.roots, 'missing')).toBeNull();
  });

  it('groups repeated trace events into one span summary before building the tree', () => {
    const summaries = buildSpanSummariesFromEvents([
      makeEvent({
        id: 'evt-root',
        type: 'agent_enter',
        spanId: 'root',
        timestamp: new Date('2026-03-22T00:00:00.000Z'),
        durationMs: 300,
        data: {
          eventType: 'agent_enter',
          spanName: 'Agent Enter',
        },
      }),
      makeEvent({
        id: 'evt-child-start',
        type: 'flow_step_enter',
        spanId: 'child',
        parentSpanId: 'root',
        timestamp: new Date('2026-03-22T00:00:00.050Z'),
        durationMs: 50,
        data: {
          eventType: 'flow_step_enter',
          spanName: 'Flow Step Enter',
          summary: 'collect_destination',
        },
      }),
      makeEvent({
        id: 'evt-child-llm',
        type: 'llm_call',
        spanId: 'child',
        parentSpanId: 'root',
        timestamp: new Date('2026-03-22T00:00:00.120Z'),
        durationMs: 80,
        data: {
          cost: 0.03,
          eventType: 'llm_call',
          hasError: false,
          promptTokens: 10,
          completionTokens: 4,
          spanName: 'LLM Call',
        },
      }),
      makeEvent({
        id: 'evt-child-llm-2',
        type: 'llm_call',
        spanId: 'child',
        parentSpanId: 'root',
        timestamp: new Date('2026-03-22T00:00:00.220Z'),
        durationMs: 40,
        data: {
          cost: 0.01,
          eventType: 'llm_call',
          hasError: false,
          promptTokens: 2,
          completionTokens: 1,
          spanName: 'LLM Call',
        },
      }),
    ]);

    expect(summaries).toHaveLength(2);

    const childSummary = summaries.find((summary) => summary.span.spanId === 'child');
    expect(childSummary).toBeDefined();
    expect(childSummary?.span.events).toHaveLength(3);
    expect(childSummary?.span.durationMs).toBe(210);
    expect(childSummary?.span.attributes).toMatchObject({
      eventType: 'flow_step_enter',
      summary: 'collect_destination',
    });
    expect(childSummary?.cost).toBe(0.04);
    expect(childSummary?.totalTokens).toBe(17);

    const timeline = buildSpanSummaryTimeline(summaries);
    expect(timeline.roots).toHaveLength(1);
    expect(timeline.roots[0].children.map((node) => node.summary.span.spanId)).toEqual(['child']);
  });
});
