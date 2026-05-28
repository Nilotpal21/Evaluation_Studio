import { describe, test, expect } from 'vitest';
import {
  shouldEmitTrace,
  emitDecisionTrace,
  buildFlowToolCallStartTraceData,
  buildFlowToolCallCompletionTraceData,
} from '../../services/execution/trace-helpers.js';

describe('shouldEmitTrace', () => {
  test('minimal level emits error events', () => {
    expect(shouldEmitTrace('error', 'minimal')).toBe(true);
    expect(shouldEmitTrace('escalation', 'minimal')).toBe(true);
  });

  test('minimal level blocks standard events', () => {
    expect(shouldEmitTrace('flow_step_enter', 'minimal')).toBe(false);
    expect(shouldEmitTrace('tool_call', 'minimal')).toBe(false);
  });

  test('standard level emits standard events', () => {
    expect(shouldEmitTrace('flow_step_enter', 'standard')).toBe(true);
    expect(shouldEmitTrace('constraint_check', 'standard')).toBe(true);
    expect(shouldEmitTrace('correction', 'standard')).toBe(true);
  });

  test('standard level blocks verbose events', () => {
    expect(shouldEmitTrace('extraction_strategy_resolved', 'standard')).toBe(false);
    expect(shouldEmitTrace('memory_unavailable', 'standard')).toBe(false);
    expect(shouldEmitTrace('gather_field_activation', 'standard')).toBe(false);
  });

  test('verbose level emits decision trace events', () => {
    expect(shouldEmitTrace('extraction_strategy_resolved', 'verbose')).toBe(true);
    expect(shouldEmitTrace('memory_trigger_evaluated', 'verbose')).toBe(true);
    expect(shouldEmitTrace('constraint_backtrack', 'verbose')).toBe(true);
    expect(shouldEmitTrace('gather_complete_reason', 'verbose')).toBe(true);
    expect(shouldEmitTrace('validation_fail_open', 'verbose')).toBe(true);
  });

  test('verbose level blocks debug events', () => {
    expect(shouldEmitTrace('llm_call', 'verbose')).toBe(false);
    expect(shouldEmitTrace('engine_decision', 'verbose')).toBe(false);
  });

  test('debug level emits everything', () => {
    expect(shouldEmitTrace('llm_call', 'debug')).toBe(true);
    expect(shouldEmitTrace('engine_decision', 'debug')).toBe(true);
    expect(shouldEmitTrace('extraction_strategy_resolved', 'debug')).toBe(true);
    expect(shouldEmitTrace('error', 'debug')).toBe(true);
  });

  test('unknown event types default to standard level', () => {
    expect(shouldEmitTrace('some_new_event', 'standard')).toBe(true);
    expect(shouldEmitTrace('some_new_event', 'minimal')).toBe(false);
  });
});

describe('emitDecisionTrace', () => {
  test('calls onTraceEvent when verbosity allows', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

    emitDecisionTrace(handler, 'verbose', 'extraction_strategy_resolved', { field: 'destination' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('extraction_strategy_resolved');
    expect(events[0].data.field).toBe('destination');
  });

  test('does not call onTraceEvent when verbosity too low', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

    emitDecisionTrace(handler, 'standard', 'extraction_strategy_resolved', {
      field: 'destination',
    });
    expect(events).toHaveLength(0);
  });

  test('no-ops when onTraceEvent is undefined', () => {
    // Should not throw
    emitDecisionTrace(undefined, 'verbose', 'extraction_strategy_resolved', { field: 'test' });
  });

  test('defaults to standard verbosity when undefined', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

    emitDecisionTrace(handler, undefined, 'flow_step_enter', { step: 'greet' });
    expect(events).toHaveLength(1); // standard event passes at default standard verbosity

    emitDecisionTrace(handler, undefined, 'extraction_strategy_resolved', { field: 'x' });
    expect(events).toHaveLength(1); // verbose event blocked at default standard verbosity
  });
});

// =============================================================================
// FLOW tool-call trace builders — ABLP-1094
//
// The Debug UI groups a TOOL CALL card's call+result by toolCallId. The LLM
// reasoning path emits a tool_call_start (pre-execution) and a completed
// tool_call (post-execution) that share toolCallId and carry input/output.
// The FLOW step path historically emitted a bare tool_call (no toolCallId,
// no output) plus an orphan tool_result, so the UI rendered only Input.
// These builders give the FLOW path the same shape as the LLM path.
// =============================================================================

describe('buildFlowToolCallStartTraceData', () => {
  test('produces an LLM-path-compatible start payload', () => {
    const data = buildFlowToolCallStartTraceData({
      toolCallId: 'tc-abc',
      toolName: 'lookup_member',
      input: { memberId: 'm-123' },
      agent: 'support-agent',
    });

    expect(data).toEqual({
      toolCallId: 'tc-abc',
      toolName: 'lookup_member',
      tool: 'lookup_member',
      input: { memberId: 'm-123' },
      isActionTool: false,
      agent: 'support-agent',
    });
  });

  test('marks action tools (handoff_*, delegate_*) via isActionTool', () => {
    const data = buildFlowToolCallStartTraceData({
      toolCallId: 'tc-1',
      toolName: '__handoff_to_billing',
      input: {},
      agent: 'router',
    });
    expect(data.isActionTool).toBe(true);
  });

  test('spreads httpMeta first so tool fields override on key collision', () => {
    const data = buildFlowToolCallStartTraceData({
      toolCallId: 'tc-1',
      toolName: 'fetch_invoice',
      input: { id: 'inv-9' },
      agent: 'billing',
      httpMeta: { method: 'GET', endpoint: 'https://api.example.test/invoice' },
    });
    expect(data.method).toBe('GET');
    expect(data.endpoint).toBe('https://api.example.test/invoice');
    expect(data.toolName).toBe('fetch_invoice');
  });
});

describe('buildFlowToolCallCompletionTraceData', () => {
  test('carries input AND output with shared toolCallId so Debug UI fuses the card', () => {
    const data = buildFlowToolCallCompletionTraceData({
      toolCallId: 'tc-abc',
      toolName: 'lookup_member',
      input: { memberId: 'm-123' },
      output: { name: 'Alice' },
      success: true,
      latencyMs: 87,
      agent: 'support-agent',
    });

    expect(data).toEqual({
      phase: 'complete',
      toolCallId: 'tc-abc',
      toolName: 'lookup_member',
      tool: 'lookup_member',
      input: { memberId: 'm-123' },
      output: { name: 'Alice' },
      success: true,
      latencyMs: 87,
      isActionTool: false,
      agent: 'support-agent',
    });
  });

  test('includes error fields when present and marks success false', () => {
    const data = buildFlowToolCallCompletionTraceData({
      toolCallId: 'tc-fail',
      toolName: 'flaky_tool',
      input: {},
      output: { __error: 'boom' },
      success: false,
      latencyMs: 12,
      agent: 'support-agent',
      error: 'boom',
      errorCode: 'tool_runtime_error',
    });

    expect(data.success).toBe(false);
    expect(data.error).toBe('boom');
    expect(data.errorCode).toBe('tool_runtime_error');
  });

  test('omits error fields when not provided (clean payload on success)', () => {
    const data = buildFlowToolCallCompletionTraceData({
      toolCallId: 'tc-ok',
      toolName: 'lookup_member',
      input: {},
      output: { ok: 1 },
      success: true,
      latencyMs: 5,
      agent: 'support-agent',
    });
    expect('error' in data).toBe(false);
    expect('errorCode' in data).toBe(false);
  });
});
