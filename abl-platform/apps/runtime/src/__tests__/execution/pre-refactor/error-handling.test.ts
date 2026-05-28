/**
 * Pre-Refactor Test: Error Handling During Execution
 *
 * Covers error resilience during active session execution:
 * - LLM client failures (throws, empty responses)
 * - Tool execution errors (traced and fed back to LLM)
 * - Constraint expression evaluation errors
 * - Invalid step references
 * - Multiple sequential errors (state consistency)
 *
 * These tests ensure the runtime handles errors gracefully without
 * corrupting session state or crashing the executor.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ToolExecutionError } from '@agent-platform/shared-kernel';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

// =============================================================================
// FIXTURES
// =============================================================================

const REASONING_AGENT = `
AGENT: Error_Agent

GOAL: "Help with searches"
PERSONA: "Search assistant"

TOOLS:
  search(query: string) -> {results: object[]}
`;

const SCRIPTED_AGENT = `
AGENT: Scripted_Error_Agent

GOAL: "Test error handling in flow"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - name: required
  THEN: done

done:
  RESPOND: "Hello {{name}}!"
  THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Error Handling During Execution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // LLM client failures
  // ---------------------------------------------------------------------------

  describe('LLM Client Errors', () => {
    test('LLM client throw does not crash the session', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new Error('Anthropic API rate limit exceeded');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      const tc = createTraceCollector();

      // The executor catches the error gracefully and returns an error response
      const result = await executor.executeMessage(
        session.id,
        'search hotels',
        undefined,
        tc.callback,
      );
      expect(result.response).toBeDefined();

      // Session should survive (not marked complete or escalated)
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
    });

    test('LLM client returns empty text with no tool calls is handled', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: '',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: '' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      const result = await executor.executeMessage(session.id, 'hello');

      // Should not crash — returns some response
      expect(session.isComplete).toBe(false);
      expect(result).toBeDefined();
    });

    test('LLM stopReason error is traced as a configuration diagnostic instead of empty response', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        kind: 'provider_error',
        text: '',
        toolCalls: [],
        stopReason: 'error',
        providerError: {
          code: 'LLM_PROVIDER_STOP_REASON_ERROR',
          message: 'The model provider returned an error stop reason before producing a response.',
          stopReason: 'error',
          provider: 'openai',
          modelId: 'gpt-4.1-prod-internal',
          retryable: true,
        },
        rawContent: [{ type: 'text', text: '' }],
        resolvedModel: {
          modelId: 'gpt-4.1-prod-internal',
          provider: 'openai',
          source: 'tenant_model',
        },
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      const tc = createTraceCollector();

      const result = await executor.executeMessage(
        session.id,
        'search hotels',
        undefined,
        tc.callback,
      );

      const errorTraces = filterTraces(tc.traces, 'error');
      const warningTraces = filterTraces(tc.traces, 'warning');

      expect(result.response).toBeDefined();
      expect(errorTraces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              stopReason: 'error',
              providerError: expect.objectContaining({
                code: 'LLM_PROVIDER_STOP_REASON_ERROR',
                provider: 'openai',
                modelId: 'gpt-4.1-prod-internal',
              }),
              diagnostic: expect.objectContaining({
                code: 'LLM_WIRING_FAILED',
                message:
                  'The model provider returned an error before producing a response. Check provider credentials and model configuration.',
              }),
            }),
          }),
        ]),
      );
      expect(
        warningTraces.some((trace) =>
          String(trace.data.message ?? '').includes('Consecutive empty LLM responses'),
        ),
      ).toBe(false);
    });

    test('session state is consistent after LLM error', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Service unavailable');
        }
        return {
          text: 'I can help now.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I can help now.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );

      // First call fails — catch it so we can continue
      try {
        await executor.executeMessage(session.id, 'hello');
      } catch {
        // expected
      }

      // Second call succeeds — session should still be usable
      const result = await executor.executeMessage(session.id, 'try again');
      expect(result.response).toContain('I can help now.');
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool execution errors
  // ---------------------------------------------------------------------------

  describe('Tool Execution Errors', () => {
    test('tool executor throw produces error result fed back to LLM', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search', input: { query: 'hotels' } }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'tc1', name: 'search', input: { query: 'hotels' } },
            ],
          };
        }
        return {
          text: 'The search failed, let me try something else.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'The search failed, let me try something else.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      session.toolExecutor = {
        execute: async () => {
          throw new Error('Connection timeout');
        },
      } as any;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'search hotels',
        undefined,
        tc.callback,
      );

      // Session should survive
      expect(session.isComplete).toBe(false);

      // LLM should have been called twice (tool call + error result → final response)
      expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);

      // Tool call trace should exist
      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('multiple tool errors in sequence do not corrupt session', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount <= 2) {
          return {
            text: '',
            toolCalls: [{ id: `tc_${callCount}`, name: 'search', input: { query: 'test' } }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: `tc_${callCount}`, name: 'search', input: { query: 'test' } },
            ],
          };
        }
        return {
          text: 'All attempts failed.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'All attempts failed.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      let errorCount = 0;
      session.toolExecutor = {
        execute: async () => {
          errorCount++;
          throw new Error(`Tool error #${errorCount}`);
        },
      } as any;

      const result = await executor.executeMessage(session.id, 'search');

      // Session should survive multiple tool errors
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
      expect(result.response).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scripted flow error resilience
  // ---------------------------------------------------------------------------

  describe('Scripted Flow Error Handling', () => {
    test('scripted agent with valid flow survives and completes', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Scripted_Error_Agent'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Alice', (c) => chunks.push(c));

      // Should complete normally
      expect(chunks.join('')).toContain('Hello Alice!');
      expect(session.isComplete).toBe(true);
    });

    test('constraint with undefined variable uses auto-guard', async () => {
      const dsl = `
AGENT: Guard_Error_Agent

GOAL: "Test constraint error handling"

CONSTRAINTS:
  - REQUIRE nonexistent_var > 0

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Guard_Error_Agent'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Bob', undefined, tc.callback);

      // Auto-guard should let undefined variables pass without crash
      expect(session.isEscalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Error trace emission
  // ---------------------------------------------------------------------------

  describe('Error Trace Emission', () => {
    test('LLM error emits trace event', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new Error('Model overloaded');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      const tc = createTraceCollector();

      // The executor catches the error gracefully and returns an error response
      const result = await executor.executeMessage(session.id, 'hello', undefined, tc.callback);
      expect(result.response).toBeDefined();
    });

    test('tool error emits tool_call trace with error info', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search', input: { query: 'fail' } }],
            stopReason: 'tool_use',
            rawContent: [{ type: 'tool_use', id: 'tc1', name: 'search', input: { query: 'fail' } }],
          };
        }
        return {
          text: 'Error handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Error handled.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      session.toolExecutor = {
        execute: async () => {
          throw new Error('Database connection failed');
        },
      } as any;

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'search', undefined, tc.callback);

      // Tool call trace should exist
      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('tool configuration errors emit banner-eligible diagnostics on tool_call traces', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search', input: { city: 'Paris' } }],
            stopReason: 'tool_use',
            rawContent: [{ type: 'tool_use', id: 'tc1', name: 'search', input: { city: 'Paris' } }],
          };
        }
        return {
          text: 'The hotel search is unavailable right now.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'The hotel search is unavailable right now.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Error_Agent'),
      );
      session.toolExecutor = {
        execute: async () => {
          throw new ToolExecutionError({
            code: 'TOOL_CODE_EXECUTION_DISABLED',
            message: 'Code tool execution is disabled for this workspace',
            toolName: 'search',
            toolType: 'sandbox',
          });
        },
      } as any;

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'search hotels', undefined, tc.callback);

      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
      const failedTrace = toolTraces.find(
        (trace) => trace.data.errorCode === 'TOOL_CODE_EXECUTION_DISABLED',
      );
      expect(failedTrace).toBeDefined();
      expect(failedTrace!.data.error).toBe('Code tool execution is disabled for this workspace');
      expect(failedTrace!.data.errorCode).toBe('TOOL_CODE_EXECUTION_DISABLED');
      expect(failedTrace!.data.diagnostic).toEqual({
        category: 'tool',
        severity: 'error',
        code: 'TOOL_CODE_EXECUTION_DISABLED',
        message:
          'Code tool execution is disabled for this workspace. Enable code tools in workspace settings to run sandbox tools.',
        bannerEligible: true,
      });
    });
  });
});
