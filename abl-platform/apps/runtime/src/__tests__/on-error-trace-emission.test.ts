/**
 * ON_ERROR Trace Emission — Slice 1 lock test (ABLP-412)
 *
 * Regression risk from plan: adding classifier subtypes and a handoff branch
 * must not cause duplicate trace events. Each handled error should emit:
 *   - exactly ONE `agent_error_handled` (for loop-level) OR
 *   - exactly ONE `error_handler_resolved` (for tool-call-level)
 * per error instance.
 *
 * The existing tool_error trace at the raw-error site is kept; the new work
 * must not double-fire it.
 *
 * Contract:
 *   - 1 loop-level error → 1 agent_error_handled
 *   - 1 tool error with handler match → 1 error_handler_resolved + 0 duplicate
 *     tool_call_error
 *   - 1 tool error without handler match → 1 tool_call_error + 0 handler_resolved
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { injectMockClient } from './execution/pre-refactor/helpers/mock-llm-client.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ErrorHandlingConfig } from '@abl/compiler/platform/ir/schema.js';

const AGENT = `
AGENT: Trace_Agent

GOAL: "Test trace emission"

PERSONA: "Tracer"
`;

describe('ON_ERROR trace emission — no duplicates (Slice 1 ABLP-412)', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('single loop-level error produces exactly one agent_error_handled', async () => {
    const mockClient = injectMockClient(executor);
    mockClient.setResponseHandler(() => {
      throw new Error('LLM fail once');
    });

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT], 'Trace_Agent'),
    );

    const errorHandling: ErrorHandlingConfig = {
      handlers: [{ type: 'unknown_error', then: 'continue', respond: 'Handled.' }],
      default_handler: { type: 'DEFAULT', then: 'escalate' },
    };
    session.agentIR!.error_handling = errorHandling;

    const tc = createTraceCollector();
    await executor.executeMessage(session.id, 'Hi', undefined, tc.callback);

    const handled = filterTraces(tc.traces, 'agent_error_handled');
    expect(handled).toHaveLength(1);
    expect(handled[0].data.action).toBe('continue');
  });

  test('handled tool error emits error_handler_resolved but not tool_call_error', async () => {
    const mockClient = injectMockClient(executor);
    let count = 0;
    mockClient.setResponseHandler((_s, _m, tools) => {
      if ((tools as any[]).some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'ex-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'ex-1', name: '_extract_entities', input: {} }],
        };
      }
      count++;
      if (count === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'flaky', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'tc-1', name: 'flaky', input: {} }],
        };
      }
      return {
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'done' }],
      };
    });

    const TOOL_AGENT = `
AGENT: Tool_Trace_Agent

GOAL: "Call flaky tool"

PERSONA: "Tracer"

TOOLS:
  flaky() -> object
    description: "Fails"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([TOOL_AGENT], 'Tool_Trace_Agent'),
    );
    session.toolExecutor = {
      execute: async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
    } as any;

    session.agentIR!.error_handling = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'Tool error handled.',
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'escalate' },
    };

    const tc = createTraceCollector();
    const chunks: string[] = [];
    const result = await executor.executeMessage(
      session.id,
      'Use the tool',
      (chunk) => chunks.push(chunk),
      tc.callback,
    );

    const handlerResolved = filterTraces(tc.traces, 'error_handler_resolved');
    const toolCallError = filterTraces(tc.traces, 'tool_call_error');
    const responseTraces = filterTraces(tc.traces, 'error_handler_response');

    expect(handlerResolved.length).toBeGreaterThanOrEqual(1);
    expect(responseTraces.length).toBeGreaterThanOrEqual(1);
    expect(responseTraces[0].data.respond).toBe('Tool error handled.');
    expect(chunks.join('')).not.toContain('Tool error handled.');
    expect(result.response).toBe('done');
    // tool_call_error is the "no handler" path; must NOT fire when a handler matched.
    expect(toolCallError.length).toBe(0);
  });

  test('unhandled tool error (no matching handler, no default) emits tool_call_error exactly once', async () => {
    const mockClient = injectMockClient(executor);
    let count = 0;
    mockClient.setResponseHandler((_s, _m, tools) => {
      if ((tools as any[]).some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'ex-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'ex-1', name: '_extract_entities', input: {} }],
        };
      }
      count++;
      if (count === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'flaky', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'tc-1', name: 'flaky', input: {} }],
        };
      }
      return {
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'done' }],
      };
    });

    const TOOL_AGENT = `
AGENT: No_Handler_Agent

GOAL: "Call flaky tool without handler"

PERSONA: "Bare"

TOOLS:
  flaky() -> object
    description: "Fails"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([TOOL_AGENT], 'No_Handler_Agent'),
    );
    session.toolExecutor = {
      execute: async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
    } as any;

    // Explicitly clear error_handling → no match → raw tool_call_error path
    session.agentIR!.error_handling = undefined as unknown as ErrorHandlingConfig;

    const tc = createTraceCollector();
    await executor.executeMessage(session.id, 'Use the tool', undefined, tc.callback);

    const toolCallError = filterTraces(tc.traces, 'tool_call_error');
    const handlerResolved = filterTraces(tc.traces, 'error_handler_resolved');

    expect(toolCallError).toHaveLength(1);
    expect(handlerResolved).toHaveLength(0);
  });
});
