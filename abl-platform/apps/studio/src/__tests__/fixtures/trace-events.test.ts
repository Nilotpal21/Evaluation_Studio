/**
 * Trace Event Fixture Factory Validation Tests
 *
 * Validates that fixture factory creates events with correct schema
 * and that event-processor can process them without errors.
 */

import { describe, it, expect } from 'vitest';
import {
  createTraceEvent,
  createUserMessageEvent,
  createLLMCallEvent,
  createToolCallEvent,
  createAgentResponseEvent,
  createGuardrailEvent,
  createAgentEnterEvent,
  createAgentExitEvent,
  createDelegateStartEvent,
  createDelegateCompleteEvent,
  createContextMutationEvent,
  createInteractionFixture,
  traceEvent,
} from './trace-events';
import { processEventsToInteractions } from '../../components/observatory/interactions/event-processor';

describe('Trace Event Fixture Factory', () => {
  describe('createTraceEvent', () => {
    it('creates a valid base trace event', () => {
      const event = createTraceEvent();

      expect(event.id).toBeDefined();
      expect(event.type).toBe('user_message');
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.traceId).toBeDefined();
      expect(event.spanId).toBeDefined();
      expect(event.sessionId).toBe('test_session_001');
      expect(event.agentName).toBe('test-agent');
      expect(event.data).toBeDefined();
    });

    it('applies overrides', () => {
      const event = createTraceEvent({
        type: 'llm_call',
        sessionId: 'custom_session',
        agentName: 'custom-agent',
      });

      expect(event.type).toBe('llm_call');
      expect(event.sessionId).toBe('custom_session');
      expect(event.agentName).toBe('custom-agent');
    });
  });

  describe('traceEvent (fluent builder)', () => {
    it('builds a trace event with fluent API', () => {
      const event = traceEvent()
        .type('tool_call')
        .sessionId('builder_session')
        .agentName('builder-agent')
        .data({ tool: 'test-tool' })
        .build();

      expect(event.type).toBe('tool_call');
      expect(event.sessionId).toBe('builder_session');
      expect(event.agentName).toBe('builder-agent');
      expect(event.data.tool).toBe('test-tool');
    });
  });

  describe('createLLMCallEvent', () => {
    it('creates event with correct token schema (data.usage.inputTokens)', () => {
      const event = createLLMCallEvent({
        model: 'gpt-4',
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.003,
      });

      expect(event.type).toBe('llm_call');
      expect(event.data.model).toBe('gpt-4');

      // CRITICAL: Token data MUST be in data.usage
      expect(event.data.usage).toBeDefined();
      const usage = event.data.usage as Record<string, unknown>;
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);

      // Fallback fields should also be present
      expect(event.data.tokensIn).toBe(100);
      expect(event.data.promptTokens).toBe(100);
      expect(event.data.tokensOut).toBe(50);
      expect(event.data.completionTokens).toBe(50);
    });

    it('token extraction works via event-processor', () => {
      const event = createLLMCallEvent({
        inputTokens: 200,
        outputTokens: 100,
      });

      // event-processor should extract tokens from data.usage.inputTokens
      const events = [
        createUserMessageEvent('test', { timestamp: new Date() }),
        event,
        createAgentResponseEvent('response', {
          timestamp: new Date(Date.now() + 100),
        }),
      ];

      const processed = processEventsToInteractions(events);

      // Should have 1 interaction with token data
      expect(processed.interactions).toHaveLength(1);
      expect(processed.summary.totalTokensIn).toBe(200);
      expect(processed.summary.totalTokensOut).toBe(100);
    });

    it('calculates non-zero token totals from fixtures', () => {
      const events = [
        createUserMessageEvent('test'),
        createLLMCallEvent({ inputTokens: 150, outputTokens: 75 }),
        createLLMCallEvent({ inputTokens: 100, outputTokens: 50 }),
        createAgentResponseEvent('response'),
      ];

      const processed = processEventsToInteractions(events);

      // Total tokens should be sum of both LLM calls
      expect(processed.summary.totalTokensIn).toBe(250);
      expect(processed.summary.totalTokensOut).toBe(125);
      expect(processed.summary.llmCallCount).toBe(2);
    });
  });

  describe('createUserMessageEvent', () => {
    it('creates a user_message event', () => {
      const event = createUserMessageEvent('Hello, agent');

      expect(event.type).toBe('user_message');
      expect(event.data.content).toBe('Hello, agent');
      expect(event.data.role).toBe('user');
    });
  });

  describe('createAgentResponseEvent', () => {
    it('creates an agent_response event', () => {
      const event = createAgentResponseEvent('Hello, user');

      expect(event.type).toBe('agent_response');
      expect(event.data.content).toBe('Hello, user');
      expect(event.data.role).toBe('assistant');
      expect(event.data.contentLength).toBe(11);
    });
  });

  describe('createToolCallEvent', () => {
    it('creates a tool_call event with all fields', () => {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 250);

      const event = createToolCallEvent({
        tool: 'search',
        input: { query: 'test query' },
        result: { results: ['item1', 'item2'] },
        status: 'success',
        latencyMs: 250,
        startTime,
        endTime,
      });

      expect(event.type).toBe('tool_call');
      expect(event.data.tool).toBe('search');
      expect(event.data.toolName).toBe('search');
      expect(event.data.input).toEqual({ query: 'test query' });
      expect(event.data.result).toEqual({ results: ['item1', 'item2'] });
      expect(event.data.success).toBe(true);
      expect(event.data.latencyMs).toBe(250);
      expect(event.data.startTime).toBeDefined();
      expect(event.data.endTime).toBeDefined();
    });

    it('creates a failed tool_call event', () => {
      const event = createToolCallEvent({
        tool: 'api-call',
        status: 'failed',
        error: 'Network timeout',
      });

      expect(event.data.success).toBe(false);
      expect(event.data.error).toBe('Network timeout');
    });
  });

  describe('createGuardrailEvent', () => {
    it('creates a guardrail_check event', () => {
      const event = createGuardrailEvent({
        checkType: 'pii',
        status: 'warn',
        confidence: 0.85,
        findings: ['email detected', 'phone number detected'],
      });

      expect(event.type).toBe('guardrail_check');
      expect(event.data.checkType).toBe('pii');
      expect(event.data.status).toBe('warn');
      expect(event.data.confidence).toBe(0.85);
      expect(event.data.findings).toEqual(['email detected', 'phone number detected']);
      expect(event.data.passed).toBe(false);
    });
  });

  describe('createAgentEnterEvent / createAgentExitEvent', () => {
    it('creates agent lifecycle events', () => {
      const enterEvent = createAgentEnterEvent('test-agent', 'reasoning');
      const exitEvent = createAgentExitEvent('test-agent', 'completed');

      expect(enterEvent.type).toBe('agent_enter');
      expect(enterEvent.agentName).toBe('test-agent');
      expect(enterEvent.data.mode).toBe('reasoning');

      expect(exitEvent.type).toBe('agent_exit');
      expect(exitEvent.agentName).toBe('test-agent');
      expect(exitEvent.data.reason).toBe('completed');
    });
  });

  describe('createDelegateStartEvent / createDelegateCompleteEvent', () => {
    it('creates delegate lifecycle events', () => {
      const startEvent = createDelegateStartEvent(
        'agent-a',
        'agent-b',
        'handoff for specialization',
      );
      const completeEvent = createDelegateCompleteEvent('agent-a', 'agent-b');

      expect(startEvent.type).toBe('delegate_start');
      expect(startEvent.agentName).toBe('agent-a');
      expect(startEvent.data.from).toBe('agent-a');
      expect(startEvent.data.to).toBe('agent-b');
      expect(startEvent.data.reason).toBe('handoff for specialization');

      expect(completeEvent.type).toBe('delegate_complete');
      expect(completeEvent.agentName).toBe('agent-a');
      expect(completeEvent.data.from).toBe('agent-a');
      expect(completeEvent.data.to).toBe('agent-b');
    });
  });

  describe('createContextMutationEvent', () => {
    it('creates a data_stored event with before/after context', () => {
      const before = { userId: 'usr_123', balance: 100 };
      const after = { userId: 'usr_123', balance: 150, lastQuery: 'balance' };

      const event = createContextMutationEvent({
        before,
        after,
        operation: 'merge',
      });

      expect(event.type).toBe('data_stored');
      expect(event.data.operation).toBe('merge');
      expect(event.data.context).toEqual({ before, after });
    });
  });

  describe('createInteractionFixture', () => {
    it('creates a complete interaction with all events', () => {
      const events = createInteractionFixture({
        userMessage: 'What is the weather?',
        agentResponse: 'The weather is sunny',
        includeLLMCall: true,
        includeToolCall: true,
      });

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('user_message');
      expect(events[1].type).toBe('llm_call');
      expect(events[2].type).toBe('tool_call');
      expect(events[3].type).toBe('agent_response');
    });

    it('creates minimal interaction without LLM/tool calls', () => {
      const events = createInteractionFixture({
        includeLLMCall: false,
        includeToolCall: false,
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('user_message');
      expect(events[1].type).toBe('agent_response');
    });

    it('processes to a valid interaction without errors', () => {
      const events = createInteractionFixture({
        userMessage: 'Test message',
        agentResponse: 'Test response',
        includeLLMCall: true,
      });

      const processed = processEventsToInteractions(events);

      expect(processed.interactions).toHaveLength(1);
      expect(processed.interactions[0].steps.length).toBeGreaterThan(0);
      expect(processed.summary.interactionCount).toBe(1);
    });
  });

  describe('Integration with event-processor', () => {
    it('processes multiple interactions from fixtures', () => {
      const interaction1 = createInteractionFixture({
        userMessage: 'Message 1',
        agentResponse: 'Response 1',
        includeLLMCall: true,
        baseTimestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const interaction2 = createInteractionFixture({
        userMessage: 'Message 2',
        agentResponse: 'Response 2',
        includeLLMCall: true,
        baseTimestamp: new Date('2024-01-01T00:01:00Z'),
      });

      const interaction3 = createInteractionFixture({
        userMessage: 'Message 3',
        agentResponse: 'Response 3',
        includeLLMCall: true,
        baseTimestamp: new Date('2024-01-01T00:02:00Z'),
      });

      const allEvents = [...interaction1, ...interaction2, ...interaction3];
      const processed = processEventsToInteractions(allEvents);

      expect(processed.interactions).toHaveLength(3);
      expect(processed.summary.interactionCount).toBe(3);
      expect(processed.summary.llmCallCount).toBe(3);
      expect(processed.summary.totalTokensIn).toBeGreaterThan(0);
      expect(processed.summary.totalTokensOut).toBeGreaterThan(0);
    });
  });
});
