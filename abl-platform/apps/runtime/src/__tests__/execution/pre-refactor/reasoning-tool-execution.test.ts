/**
 * Pre-Refactor Test: Reasoning Mode & Tool Execution
 *
 * Covers the agentic loop, tool use, max iterations, system tool handling,
 * tool error paths, and tool result integration.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  buildTools,
} from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { MockAnthropicClient, injectMockClient } from './helpers/mock-llm-client';

// =============================================================================
// FIXTURES
// =============================================================================

const TOOL_AGENT = `
AGENT: Tool_Agent

GOAL: "Help with searches"
PERSONA: "Search assistant"

TOOLS:
  search(query: string) -> {results: object[]}
  lookup(id: string) -> {item: object}
`;

const CONSENT_BLOCK_AGENT = `
AGENT: Consent_Block_Agent

GOAL: "Refund eligible orders"
PERSONA: "Support assistant"

TOOLS:
  issue_refund(order_id: string, refund_amount: number) -> {refund_id: string}
    description: "Issue a refund"
    side_effects: true
    confirm: when_side_effects
    immutable: [order_id]
    consent_required_in: conversation
    consent_scope: [order_id, refund_amount]
    consent_action: "refund"
    consent_fallback: block
`;

const ESCALATION_AGENT = `
AGENT: Escalate_Agent

GOAL: "Help and escalate when needed"
PERSONA: "Support agent"

ESCALATE:
  - WHEN: issue_type == "billing"
    MESSAGE: "Transferring to billing department"
    PRIORITY: high
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Reasoning Mode & Tool Execution', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ---------------------------------------------------------------------------
  // Basic reasoning execution
  // ---------------------------------------------------------------------------

  describe('Basic Reasoning', () => {
    test('returns text response from LLM', async () => {
      mockClient.setResponseHandler(() => ({
        text: 'I can help you search.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I can help you search.' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      const result = await executor.executeMessage(session.id, 'help me search');

      expect(result.response).toContain('I can help you search.');
      // Plain text response with no tool calls → action type is 'continue'
      expect(result.action.type).toBe('continue');
    });

    test('conversation history grows with each turn', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );

      await executor.executeMessage(session.id, 'hello');
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(2); // user + assistant

      await executor.executeMessage(session.id, 'search for hotels');
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  describe('Tool Calls', () => {
    test('executes tool call and returns result to LLM', async () => {
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          // First call: LLM wants to use a tool
          return {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search', input: { query: 'hotels' } }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'tc1', name: 'search', input: { query: 'hotels' } },
            ],
          };
        }
        // Second call: LLM produces final response
        return {
          text: 'Found 3 hotels for you.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Found 3 hotels for you.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      // Set up mock tool executor
      session.toolExecutor = {
        execute: async (name: string, input: Record<string, unknown>) => {
          if (name === 'search') {
            return { results: [{ name: 'Hotel A' }, { name: 'Hotel B' }, { name: 'Hotel C' }] };
          }
          return {};
        },
      } as any;

      const result = await executor.executeMessage(session.id, 'find me hotels');
      expect(result.response).toContain('Found 3 hotels');
    });

    test('emits tool_call trace event', async () => {
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search', input: { query: 'test' } }],
            stopReason: 'tool_use',
            rawContent: [{ type: 'tool_use', id: 'tc1', name: 'search', input: { query: 'test' } }],
          };
        }
        return {
          text: 'Done.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Done.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      session.toolExecutor = {
        execute: async () => ({ result: 'ok' }),
      } as any;

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'search', undefined, tc.callback);

      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('tool error does not crash session', async () => {
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
          text: 'Sorry, the search failed.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Sorry, the search failed.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      session.toolExecutor = {
        execute: async () => {
          throw new Error('Tool service unavailable');
        },
      } as any;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'search', undefined, tc.callback);

      // Session should survive the error
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);

      // Tool call trace should still be emitted (tool was called, even though it threw)
      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
      expect(toolTraces[0].data.toolName).toBe('search');

      // LLM should have received the error as a tool result (2nd call)
      expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('blocks tool dispatch when conversation consent fallback is block', async () => {
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'tc-refund',
                name: 'issue_refund',
                input: { order_id: 'ORD-123', refund_amount: 49.99 },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'tc-refund',
                name: 'issue_refund',
                input: { order_id: 'ORD-123', refund_amount: 49.99 },
              },
            ],
          };
        }
        return {
          text: 'I need your consent before I can continue.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I need your consent before I can continue.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([CONSENT_BLOCK_AGENT], 'Consent_Block_Agent'),
      );
      const execute = vi.fn(async () => ({ refund_id: 'RF-123' }));
      session.toolExecutor = { execute } as any;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Can you help me with order ORD-123?',
        undefined,
        tc.callback,
      );

      expect(result.response).toContain('consent');
      expect(execute).not.toHaveBeenCalled();
      expect(session.data.values._pending_tool_confirmation).toBeUndefined();
      expect(filterTraces(tc.traces, 'tool_confirmation_requested')).toHaveLength(0);
      expect(filterTraces(tc.traces, 'tool_confirmation_rejected')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            toolName: 'issue_refund',
            reason: 'conversation_consent_missing',
          }),
        }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // System tools (__complete__, __escalate__)
  // ---------------------------------------------------------------------------

  describe('System Tool: Complete', () => {
    test('__complete__ completes session', async () => {
      // The system tool constant is '__complete__' (not '__complete_conversation__').
      // No entity extraction branch needed — Tool_Agent has no GATHER fields.
      mockClient.setResponseHandler(() => ({
        text: 'All done!',
        toolCalls: [{ id: 'tc1', name: '__complete__', input: { reason: 'Task finished' } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'text', text: 'All done!' },
          { type: 'tool_use', id: 'tc1', name: '__complete__', input: { reason: 'Task finished' } },
        ],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      await executor.executeMessage(session.id, 'we are done');

      expect(session.isComplete).toBe(true);
    });
  });

  describe('System Tool: Escalate', () => {
    test('__escalate__ escalates session', async () => {
      mockClient.setResponseHandler((_s, _m, tools) => {
        if (tools.length === 0) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        return {
          text: 'Let me connect you with a human.',
          toolCalls: [{ id: 'tc1', name: '__escalate__', input: { reason: 'Customer unhappy' } }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Let me connect you with a human.' },
            {
              type: 'tool_use',
              id: 'tc1',
              name: '__escalate__',
              input: { reason: 'Customer unhappy' },
            },
          ],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ESCALATION_AGENT], 'Escalate_Agent'),
      );
      await executor.executeMessage(session.id, 'I need to talk to a human');

      expect(session.isEscalated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Max iterations
  // ---------------------------------------------------------------------------

  describe('Max Iterations', () => {
    test('reasoning loop stops after max iterations', async () => {
      // Always return tool calls to trigger infinite loop
      mockClient.setResponseHandler((_s, _m, tools) => {
        if (tools.length === 0) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        return {
          text: '',
          toolCalls: [{ id: `tc_${Date.now()}`, name: 'search', input: { query: 'loop' } }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: `tc_${Date.now()}`, name: 'search', input: { query: 'loop' } },
          ],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );
      session.toolExecutor = {
        execute: async () => ({ result: 'ok' }),
      } as any;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'search forever',
        undefined,
        tc.callback,
      );

      // Should produce a response (loop terminated by max iterations)
      expect(result.response).toBeDefined();

      // LLM call count should be bounded — not infinite
      // The default max turns is typically 10-25; verify it stopped
      expect(mockClient.calls.length).toBeLessThanOrEqual(30);
      // Should have made more than 1 call (proving the loop ran)
      expect(mockClient.calls.length).toBeGreaterThan(1);

      // Tool call traces should be bounded too
      const toolTraces = filterTraces(tc.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
      expect(toolTraces.length).toBeLessThanOrEqual(30);
    });
  });

  // ---------------------------------------------------------------------------
  // Build tools
  // ---------------------------------------------------------------------------

  describe('Tool Building', () => {
    test('builds tool definitions from agent IR', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );

      const tools = buildTools(session);

      // Should include the declared tools
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('lookup');
    });

    test('does NOT include __complete_conversation__ tool (Option C)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TOOL_AGENT], 'Tool_Agent'),
      );

      const tools = buildTools(session);
      const toolNames = tools.map((t: any) => t.name);

      // Complete tool should NOT be in the list (runtime evaluates completion, not LLM)
      expect(toolNames).not.toContain('__complete_conversation__');
    });
  });
});
