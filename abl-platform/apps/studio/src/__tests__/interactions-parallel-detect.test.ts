/**
 * Parallel Detection — Tests for swim lane data computation.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';
import {
  detectParallelTools,
  type ParallelLane,
} from '../components/observatory/interactions/SwimLaneTimeline';
import type { ExtendedTraceEvent } from '../types';

let id = 0;
const base = new Date('2026-03-31T10:00:00Z').getTime();

function makeToolEvent(
  tool: string,
  startOffsetMs: number,
  durationMs: number,
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  id++;
  return {
    id: `evt-${id}`,
    type: 'tool_call' as ExtendedTraceEvent['type'],
    timestamp: new Date(base + startOffsetMs),
    durationMs,
    traceId: 'trace-1',
    spanId: `span-${id}`,
    sessionId: 'sess-1',
    agentName: 'test-agent',
    data: { tool, status: 'success', ...overrides?.data },
    ...overrides,
  };
}

function makeFanOutEvent(
  type: string,
  startOffsetMs: number,
  data: Record<string, unknown>,
): ExtendedTraceEvent {
  id++;
  return {
    id: `evt-${id}`,
    type: type as ExtendedTraceEvent['type'],
    timestamp: new Date(base + startOffsetMs),
    traceId: 'trace-1',
    spanId: `span-${id}`,
    sessionId: 'sess-1',
    agentName: 'test-agent',
    data,
  };
}

describe('detectParallelTools', () => {
  it('detects overlapping tool calls as parallel', () => {
    const events = [
      makeToolEvent('get_balance', 0, 300),
      makeToolEvent('check_loyalty', 50, 400),
      makeToolEvent('get_history', 100, 200),
    ];

    const result = detectParallelTools(events);

    expect(result.lanes).toHaveLength(3);
    expect(result.isParallel).toBe(true);
  });

  it('returns non-parallel for sequential tool calls', () => {
    const events = [makeToolEvent('step_1', 0, 100), makeToolEvent('step_2', 200, 100)];

    const result = detectParallelTools(events);

    expect(result.isParallel).toBe(false);
  });

  it('calculates time savings', () => {
    const events = [makeToolEvent('a', 0, 300), makeToolEvent('b', 0, 400)];

    const result = detectParallelTools(events);

    // Sequential would be 700ms, parallel is 400ms
    expect(result.sequentialMs).toBe(700);
    expect(result.parallelMs).toBe(400);
    expect(result.savedMs).toBe(300);
  });

  it('handles single tool call', () => {
    const events = [makeToolEvent('only_one', 0, 200)];

    const result = detectParallelTools(events);

    expect(result.isParallel).toBe(false);
    expect(result.lanes).toHaveLength(1);
  });

  it('normalizes dotted tool event types before computing lanes', () => {
    const events = [
      makeToolEvent('get_balance', 0, 300, {
        type: 'tool.call.completed' as ExtendedTraceEvent['type'],
      }),
      makeToolEvent('check_loyalty', 50, 300, {
        type: 'tool.call.failed' as ExtendedTraceEvent['type'],
        data: { tool: 'check_loyalty', error: 'timeout' },
      }),
    ];

    const result = detectParallelTools(events);

    expect(result.isParallel).toBe(true);
    expect(result.lanes).toHaveLength(2);
    expect(result.lanes[1].status).toBe('failed');
  });

  it('builds lanes from fan-out task lifecycle events', () => {
    const events = [
      makeFanOutEvent('fan_out_start', 0, { taskCount: 2, targets: ['crm_lookup', 'billing'] }),
      makeFanOutEvent('fan_out_task_start', 10, { target: 'crm_lookup', type: 'tool' }),
      makeFanOutEvent('fan_out_task_start', 20, { target: 'billing', type: 'tool' }),
      makeFanOutEvent('fan_out_task_complete', 140, {
        target: 'crm_lookup',
        type: 'tool',
        status: 'completed',
      }),
      makeFanOutEvent('fan_out_task_complete', 160, {
        target: 'billing',
        type: 'tool',
        status: 'error',
        error: 'timeout',
      }),
      makeFanOutEvent('fan_out_complete', 180, { taskCount: 2, totalDurationMs: 180 }),
    ];

    const result = detectParallelTools(events);

    expect(result.lanes).toHaveLength(2);
    expect(result.lanes.map((lane) => lane.tool)).toEqual(['crm_lookup', 'billing']);
    expect(result.isParallel).toBe(true);
    expect(result.lanes[0].durationMs).toBe(130);
    expect(result.lanes[1].status).toBe('failed');
  });
});
