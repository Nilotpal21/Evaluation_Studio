import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { FillerMessageService } from '../../services/filler/filler-service.js';
import { getFillerMessage } from '../../services/filler/message-pools.js';
import { DEFAULT_FILLER_CONFIG } from '../../services/filler/types.js';
import type { StatusEvent, StatusOperation } from '../../services/filler/types.js';

type FillerTraceEvent = {
  type: string;
  data?: Record<string, unknown>;
};

function isCompletedToolCallTrace(data: Record<string, unknown> | undefined): boolean {
  if (!data) {
    return false;
  }

  return (
    data.phase === 'complete' ||
    data.latencyMs !== undefined ||
    data.durationMs !== undefined ||
    data.output !== undefined ||
    data.result !== undefined ||
    data.success !== undefined ||
    data.status === 'rejected' ||
    data.status === 'success' ||
    data.status === 'error'
  );
}

function traceToFillerOperation(event: FillerTraceEvent): StatusOperation | null {
  switch (event.type) {
    case 'tool_call_start':
      return 'tool_call';
    case 'tool_call':
      if (isCompletedToolCallTrace(event.data)) {
        return null;
      }
      return 'tool_call';
    case 'handoff':
    case 'handoff_progress':
      return 'handoff';
    case 'delegate_start':
    case 'fan_out_start':
      return 'delegation';
    case 'dsl_collect':
      return 'extraction';
    case 'constraint_check':
      return 'constraint_check';
    default:
      return null;
  }
}

describe('Filler integration with trace events', () => {
  let service: FillerMessageService;
  let emitted: StatusEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    service = new FillerMessageService(
      'sess-1',
      {
        ...DEFAULT_FILLER_CONFIG,
        chatDelayMs: 100,
        cooldownMs: 50,
      },
      (e) => emitted.push(e),
    );
  });

  afterEach(() => {
    service.destroy();
    vi.useRealTimers();
  });

  test('tool_call_start trace event queues a filler that fires after delay', () => {
    const event = { type: 'tool_call_start', data: { toolName: 'custom_lookup_tool' } };
    const op = traceToFillerOperation(event);
    expect(op).toBe('tool_call');

    const text = getFillerMessage(op!, [], event.data.toolName as string);
    service.queueFiller(op!, text);

    // Before delay — no emission
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(0);

    // After delay — filler fires
    vi.advanceTimersByTime(60);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('tool_call');
    expect(emitted[0].transient).toBe(true);
  });

  test('legacy start-side tool_call trace event still queues filler', () => {
    const event = { type: 'tool_call', data: { tool: 'custom_lookup_tool', params: {} } };
    const op = traceToFillerOperation(event);

    expect(op).toBe('tool_call');
  });

  test('completed tool_call trace event does not queue a late filler', () => {
    const event = {
      type: 'tool_call',
      data: {
        phase: 'complete',
        toolName: 'custom_lookup_tool',
        output: { ok: true },
        success: true,
        latencyMs: 5000,
      },
    };

    const op = traceToFillerOperation(event);

    expect(op).toBeNull();
  });

  test('handoff trace event queues handoff filler', () => {
    const op = traceToFillerOperation({ type: 'handoff' });
    expect(op).toBe('handoff');

    const text = getFillerMessage(op!);
    service.queueFiller(op!, text);

    vi.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('handoff');
  });

  test('fast tool completion cancels filler before user sees it', () => {
    const op = traceToFillerOperation({ type: 'tool_call_start', data: {} })!;
    service.queueFiller(op, getFillerMessage(op));

    // Tool completes in 50ms (before 100ms delay)
    vi.advanceTimersByTime(50);
    service.cancel(); // Tool completed, response streaming

    vi.advanceTimersByTime(200);
    expect(emitted).toHaveLength(0); // User never saw the filler
  });

  test('sequence: tool_call → delay → filler shown → response cancels', () => {
    const op = traceToFillerOperation({ type: 'tool_call_start', data: {} })!;
    service.queueFiller(op, 'Searching products...');

    vi.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('Searching products.');

    // Response starts streaming
    service.cancel();
    // No more fillers should fire
  });

  test('unknown trace event types are ignored', () => {
    expect(traceToFillerOperation({ type: 'llm_call' })).toBeNull();
    expect(traceToFillerOperation({ type: 'user_message' })).toBeNull();
    expect(traceToFillerOperation({ type: 'agent_response' })).toBeNull();
  });
});
