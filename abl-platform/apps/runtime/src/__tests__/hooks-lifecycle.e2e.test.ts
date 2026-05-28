/**
 * Hooks Lifecycle E2E Tests
 *
 * Tests HOOKS lifecycle execution through the full RuntimeExecutor stack.
 * Uses mock LLM client to isolate hook behavior from LLM variability.
 * Hooks config is injected onto agentIR after session creation since the
 * DSL parser's HOOKS SET format (inline `set: key = value`) differs from
 * common YAML block style — direct IR injection tests the runtime wiring.
 *
 * Verifies:
 * - before_agent fires during session initialization
 * - after_agent fires during session end
 * - before_turn fires before each reasoning turn
 * - after_turn fires after each reasoning turn
 * - SET/RESPOND actions execute at each lifecycle point
 * - Hook execution order: before_turn → LLM → after_turn
 * - Non-critical hook failure continues
 * - Trace events emitted for hook execution
 * - No hooks = no overhead
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { injectMockClient } from './execution/pre-refactor/helpers/mock-llm-client.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { HooksConfig } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// DSL FIXTURES
// =============================================================================

const BASIC_AGENT = `
AGENT: Hook_Agent

GOAL: "Test hooks lifecycle"
PERSONA: "Helpful assistant"
`;

const PLAIN_AGENT = `
AGENT: Plain_Agent

GOAL: "Agent without hooks"
PERSONA: "Helpful assistant"
`;

const FLOW_AGENT = `
AGENT: Hook_Flow_Agent

GOAL: "Test hooks lifecycle in flow mode"
PERSONA: "Helpful assistant"

FLOW:
  entry_point: welcome
  steps:
    - welcome

welcome:
  REASONING: false
  RESPOND: "Flow welcome."
  THEN: COMPLETE
`;

// =============================================================================
// HELPERS
// =============================================================================

function makeHooksConfig(overrides?: Partial<HooksConfig>): HooksConfig {
  return {
    before_agent: overrides?.before_agent,
    after_agent: overrides?.after_agent,
    before_turn: overrides?.before_turn,
    after_turn: overrides?.after_turn,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Hooks Lifecycle E2E', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('before_agent / after_agent', () => {
    it('before_agent SET fires during session initialization', async () => {
      injectMockClient(executor);

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      // Inject hooks config onto agentIR
      session.agentIR!.hooks = makeHooksConfig({
        before_agent: { set: { agent_initialized: 'true' } },
      });

      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      expect(session.data.values.agent_initialized).toBe('true');

      // Verify hook_executed trace event
      const hookTraces = filterTraces(tc.traces, 'hook_executed');
      const beforeAgentTrace = hookTraces.find((t) => t.data.hookType === 'before_agent');
      expect(beforeAgentTrace).toBeDefined();
      expect(beforeAgentTrace!.data.success).toBe(true);
      expect(beforeAgentTrace!.data.actionsExecuted).toContain('set:agent_initialized');
    });

    it('before_agent structured RESPOND surfaces structured payloads on initializeSession result', async () => {
      injectMockClient(executor);

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_agent: {
          respond: 'Welcome before start.',
          rich_content: {
            markdown: '### Welcome before start',
          },
          voice_config: {
            plain_text: 'Welcome before start.',
          },
          actions: {
            elements: [{ id: 'begin', type: 'button', label: 'Begin' }],
          },
        },
      });

      const result = await executor.initializeSession(session.id);

      expect(result?.response).toBe('Welcome before start.');
      expect(result?.richContent).toEqual({
        markdown: '### Welcome before start',
      });
      expect(result?.voiceConfig).toEqual({
        plain_text: 'Welcome before start.',
      });
      expect(result?.actions).toEqual({
        elements: [{ id: 'begin', type: 'button', label: 'Begin' }],
      });
    });

    it('before_agent structured RESPOND is returned when flow initialization also executes the first step', async () => {
      injectMockClient(executor);

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([FLOW_AGENT], 'Hook_Flow_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_agent: {
          respond: 'Welcome before flow.',
          rich_content: {
            markdown: '### Welcome before flow',
          },
          voice_config: {
            plain_text: 'Welcome before flow.',
          },
          actions: {
            elements: [{ id: 'flow-begin', type: 'button', label: 'Begin Flow' }],
          },
        },
      });

      const chunks: string[] = [];
      const result = await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

      expect(chunks.join('')).toContain('Welcome before flow.');
      expect(chunks.join('')).toContain('Flow welcome.');
      expect(result?.response).toContain('Welcome before flow.');
      expect(result?.response).toContain('Flow welcome.');
      expect(result?.richContent).toEqual({
        markdown: '### Welcome before flow',
      });
      expect(result?.voiceConfig).toEqual({
        plain_text: 'Welcome before flow.',
      });
      expect(result?.actions).toEqual({
        elements: [{ id: 'flow-begin', type: 'button', label: 'Begin Flow' }],
      });
    });

    it('lazy initialization suppresses before_agent starter output while preserving hook side effects', async () => {
      const mockClient = injectMockClient(executor);

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_agent: {
          set: { agent_initialized: 'true' },
          respond: 'Welcome before start.',
          rich_content: {
            markdown: '### Welcome before start',
          },
          actions: {
            elements: [{ id: 'begin', type: 'button', label: 'Begin' }],
          },
        },
      });

      mockClient.setResponseHandler(() => ({
        text: 'Processed first message.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Processed first message.' }],
      }));

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'hello', (chunk) =>
        chunks.push(chunk),
      );

      expect(result.response).toBe('Processed first message.');
      expect(chunks.join('')).not.toContain('Welcome before start.');
      expect(result.richContent).toBeUndefined();
      expect(result.actions).toBeUndefined();
      expect(session.data.values.agent_initialized).toBe('true');
      expect(
        session.conversationHistory.some(
          (entry) =>
            entry.role === 'assistant' && String(entry.content).includes('Welcome before start.'),
        ),
      ).toBe(false);
    });

    it('after_agent SET fires during session end', async () => {
      injectMockClient(executor);

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        after_agent: { set: { agent_finalized: 'true' } },
      });

      // End session fires after_agent hook (fire-and-forget)
      executor.endSession(session.id);

      // Wait for the async fire-and-forget to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(session.data.values.agent_finalized).toBe('true');
    });
  });

  describe('before_turn / after_turn', () => {
    it('before_turn and after_turn SET fire during executeMessage', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_turn: { set: { turn_started: 'true' } },
        after_turn: { set: { turn_completed: 'true' } },
      });

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hi', undefined, tc.callback);

      expect(result.response).toBeDefined();
      expect(session.data.values.turn_started).toBe('true');
      expect(session.data.values.turn_completed).toBe('true');

      // Verify trace events for both hooks
      const hookTraces = filterTraces(tc.traces, 'hook_executed');
      const beforeTurn = hookTraces.find((t) => t.data.hookType === 'before_turn');
      const afterTurn = hookTraces.find((t) => t.data.hookType === 'after_turn');
      expect(beforeTurn).toBeDefined();
      expect(afterTurn).toBeDefined();
      expect(beforeTurn!.data.success).toBe(true);
      expect(afterTurn!.data.success).toBe(true);
    });

    it('after_turn RESPOND appends message to conversation history', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_turn: { respond: 'Processing your request...' },
        after_turn: { respond: 'Done processing.' },
      });

      await executor.executeMessage(session.id, 'Hi');

      const assistantMessages = session.conversationHistory
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content);

      expect(assistantMessages).toContain('Processing your request...');
      expect(assistantMessages).toContain('Done processing.');
    });

    it('after_turn structured RESPOND preserves contentEnvelope on the emitted assistant history entry', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        after_turn: {
          respond: 'Choose next step.',
          rich_content: {
            markdown: '### Next step',
          },
          voice_config: {
            plain_text: 'Choose next step.',
          },
          actions: {
            elements: [{ id: 'done', type: 'button', label: 'Done' }],
          },
        },
      });

      await executor.executeMessage(session.id, 'Hi');

      const emittedHookMessage = session.conversationHistory.find(
        (message) => message.role === 'assistant' && message.content === 'Choose next step.',
      ) as
        | {
            contentEnvelope?: {
              richContent?: { markdown?: string };
              voiceConfig?: { plain_text?: string };
              actions?: { elements?: Array<{ label?: string }> };
            };
          }
        | undefined;

      expect(emittedHookMessage?.contentEnvelope?.richContent).toEqual({
        markdown: '### Next step',
      });
      expect(emittedHookMessage?.contentEnvelope?.voiceConfig).toEqual({
        plain_text: 'Choose next step.',
      });
      expect(emittedHookMessage?.contentEnvelope?.actions).toEqual({
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      });
    });

    it('after_turn structured RESPOND surfaces structured payloads on the returned execution result', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        after_turn: {
          respond: 'Choose next step.',
          rich_content: {
            markdown: '### Next step',
          },
          voice_config: {
            plain_text: 'Choose next step.',
          },
          actions: {
            elements: [{ id: 'done', type: 'button', label: 'Done' }],
          },
        },
      });

      const result = await executor.executeMessage(session.id, 'Hi');

      expect(result.richContent).toEqual({
        markdown: '### Next step',
      });
      expect(result.voiceConfig).toEqual({
        plain_text: 'Choose next step.',
      });
      expect(result.actions).toEqual({
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      });
    });

    it('before_turn structured RESPOND surfaces structured payloads on the returned execution result when no later payload overrides it', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_turn: {
          respond: 'Pick an option first.',
          rich_content: {
            markdown: '### Pick an option',
          },
          voice_config: {
            plain_text: 'Pick an option first.',
          },
          actions: {
            elements: [{ id: 'pick', type: 'button', label: 'Pick' }],
          },
        },
      });

      const result = await executor.executeMessage(session.id, 'Hi');

      expect(result.richContent).toEqual({
        markdown: '### Pick an option',
      });
      expect(result.voiceConfig).toEqual({
        plain_text: 'Pick an option first.',
      });
      expect(result.actions).toEqual({
        elements: [{ id: 'pick', type: 'button', label: 'Pick' }],
      });
    });

    it('hook execution order: before_turn fires before LLM, after_turn fires after', async () => {
      const mockClient = injectMockClient(executor);
      const eventOrder: string[] = [];

      mockClient.setResponseHandler(() => {
        eventOrder.push('llm_call');
        return {
          text: 'Response',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Response' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_turn: { set: { turn_started: 'true' } },
        after_turn: { set: { turn_completed: 'true' } },
      });

      const traceCallback = (event: { type: string; data: Record<string, unknown> }) => {
        if (event.type === 'hook_executed') {
          eventOrder.push(`hook:${event.data.hookType}`);
        }
      };

      await executor.executeMessage(session.id, 'Hi', undefined, traceCallback);

      // Verify order: before_turn → LLM → after_turn
      const hookAndLlm = eventOrder.filter(
        (e) => e === 'llm_call' || e === 'hook:before_turn' || e === 'hook:after_turn',
      );
      expect(hookAndLlm[0]).toBe('hook:before_turn');
      expect(hookAndLlm[1]).toBe('llm_call');
      expect(hookAndLlm[hookAndLlm.length - 1]).toBe('hook:after_turn');
    });
  });

  describe('no hooks (IR-gated)', () => {
    it('agent without hooks runs normally without errors', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello from plain agent!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello from plain agent!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([PLAIN_AGENT], 'Plain_Agent'),
      );
      const tc = createTraceCollector();

      const result = await executor.executeMessage(session.id, 'Hi', undefined, tc.callback);

      expect(result.response).toContain('Hello from plain agent!');

      // No hook_executed trace events should be emitted
      const hookTraces = filterTraces(tc.traces, 'hook_executed');
      expect(hookTraces).toHaveLength(0);
    });
  });

  describe('hook failure is non-fatal (E2E-6)', () => {
    it('non-critical hook failure does not block main LLM execution', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Main execution succeeded!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Main execution succeeded!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      // Inject a before_turn hook with CALL to a nonexistent tool
      session.agentIR!.hooks = makeHooksConfig({
        before_turn: {
          call: 'nonexistent_tool',
          set: { hook_attempted: 'true' },
        },
      });

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      // Main execution should succeed despite hook failure
      expect(result.response).toContain('Main execution succeeded!');

      // SET from the same hook config should have been applied (SET runs before CALL)
      expect(session.data.values.hook_attempted).toBe('true');

      // Hook trace should show the failure
      const hookTraces = filterTraces(tc.traces, 'hook_executed');
      const beforeTurnTrace = hookTraces.find((t) => t.data.hookType === 'before_turn');
      expect(beforeTurnTrace).toBeDefined();
    });

    it('critical hook failure does not crash subsequent turns', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        return {
          text: `Response ${callCount}`,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: `Response ${callCount}` }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      // Hook with CALL that will fail (no tool binding)
      session.agentIR!.hooks = makeHooksConfig({
        before_turn: { call: 'missing_audit_tool' },
      });

      // First turn — hook fails but execution continues
      const result1 = await executor.executeMessage(session.id, 'Turn 1');
      expect(result1.response).toBeDefined();

      // Second turn — session should still be usable
      const result2 = await executor.executeMessage(session.id, 'Turn 2');
      expect(result2.response).toBeDefined();
    });
  });

  describe('hooks overhead', () => {
    it('SET/RESPOND hooks add negligible overhead (< 100ms)', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Fast',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Fast' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Hook_Agent'),
      );

      session.agentIR!.hooks = makeHooksConfig({
        before_turn: { set: { turn_started: 'true' }, respond: 'Starting...' },
        after_turn: { set: { turn_completed: 'true' }, respond: 'Done.' },
      });

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      const hookTraces = filterTraces(tc.traces, 'hook_executed');
      for (const trace of hookTraces) {
        expect(trace.data.durationMs).toBeLessThan(100);
      }
    });
  });
});
