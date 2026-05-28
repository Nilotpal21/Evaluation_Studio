/**
 * Integration Tests: Interactions Tab Event Processing
 *
 * Tests the service boundary: fixtures → event-processor → interactions output.
 * No mocked components, no API/DB/WebSocket — pure logic-level integration.
 */

import { describe, it, expect } from 'vitest';
import { processEventsToInteractions } from '../components/observatory/interactions/event-processor';
import {
  createTraceEvent,
  createUserMessageEvent,
  createLLMCallEvent,
  createToolCallEvent,
  createAgentResponseEvent,
  createAgentEnterEvent,
  createAgentExitEvent,
  createDelegateStartEvent,
  createDelegateCompleteEvent,
  createInteractionFixture,
} from './fixtures/trace-events';
import {
  assertInteractionCount,
  assertTokenTotals,
  assertAgentPath,
  assertLLMCallCount,
  assertToolCallCount,
  sortEventsByTimestamp,
} from './helpers/test-utils';

describe('Integration: Event Processor Groups Events into Interactions', () => {
  it('INT-1: processes 3 user messages into 3 interactions', () => {
    // Setup: Create fixtures with 3 user messages, 6 LLM calls (2 per interaction), 4 tool calls
    const interaction1Events = [
      createUserMessageEvent('User message 1', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:00:01Z'),
        },
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:00:02Z'),
        },
      }),
      createToolCallEvent({
        tool: 'search',
        status: 'success',
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:00:03Z'),
        },
      }),
      createAgentResponseEvent('Agent response 1', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:00:04Z'),
      }),
    ];

    const interaction2Events = [
      createUserMessageEvent('User message 2', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:01:00Z'),
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:01:01Z'),
        },
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:01:02Z'),
        },
      }),
      createToolCallEvent({
        tool: 'api-call',
        status: 'success',
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:01:03Z'),
        },
      }),
      createToolCallEvent({
        tool: 'database-query',
        status: 'success',
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:01:04Z'),
        },
      }),
      createAgentResponseEvent('Agent response 2', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:01:05Z'),
      }),
    ];

    const interaction3Events = [
      createUserMessageEvent('User message 3', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:02:00Z'),
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:02:01Z'),
        },
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:02:02Z'),
        },
      }),
      createToolCallEvent({
        tool: 'email-send',
        status: 'success',
        overrides: {
          sessionId: 'int_test_session',
          timestamp: new Date('2024-01-01T00:02:03Z'),
        },
      }),
      createAgentResponseEvent('Agent response 3', {
        sessionId: 'int_test_session',
        timestamp: new Date('2024-01-01T00:02:04Z'),
      }),
    ];

    const allEvents = sortEventsByTimestamp([
      ...interaction1Events,
      ...interaction2Events,
      ...interaction3Events,
    ]);

    // Act: Process events
    const processed = processEventsToInteractions(allEvents);

    // Assert: 3 interactions created
    assertInteractionCount(processed, 3);

    // Assert: Each interaction has correct structure
    expect(processed.interactions[0].steps.length).toBeGreaterThan(0);
    expect(processed.interactions[1].steps.length).toBeGreaterThan(0);
    expect(processed.interactions[2].steps.length).toBeGreaterThan(0);

    // Assert: Session summary has correct counts
    expect(processed.summary.interactionCount).toBe(3);
    assertLLMCallCount(processed.summary, 6);
    assertToolCallCount(processed.summary, 4);
  });

  it('INT-1: each interaction has correct step types (user_input, llm_call, tool_call, agent_response)', () => {
    const events = [
      createUserMessageEvent('Test message', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createLLMCallEvent({
        inputTokens: 100,
        outputTokens: 50,
        overrides: { timestamp: new Date('2024-01-01T00:00:01Z') },
      }),
      createToolCallEvent({
        tool: 'search',
        overrides: { timestamp: new Date('2024-01-01T00:00:02Z') },
      }),
      createAgentResponseEvent('Test response', {
        timestamp: new Date('2024-01-01T00:00:03Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    expect(processed.interactions).toHaveLength(1);
    const interaction = processed.interactions[0];

    // Verify step types are present
    const stepTypes = interaction.steps.map((s) => s.type);
    expect(stepTypes).toContain('user_input');
    expect(stepTypes).toContain('llm_call');
    expect(stepTypes).toContain('tool_call');
    expect(stepTypes).toContain('agent_response');
  });

  it('INT-1: filters out pure-init interactions (no user_input or agent_response)', () => {
    const events = [
      // Pure init events (should be filtered)
      createAgentEnterEvent('test-agent', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      // Real interaction (should be kept)
      createUserMessageEvent('User message', {
        timestamp: new Date('2024-01-01T00:01:00Z'),
      }),
      createAgentResponseEvent('Agent response', {
        timestamp: new Date('2024-01-01T00:01:01Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Should have only 1 interaction (the real one, not the init)
    assertInteractionCount(processed, 1);
  });
});

describe('Integration: Token Calculation Aggregates Across Interactions', () => {
  it('INT-2: session-level totals aggregate correctly (3 LLM calls, 100 in + 50 out each)', () => {
    const interaction1 = createInteractionFixture({
      userMessage: 'Message 1',
      agentResponse: 'Response 1',
      includeLLMCall: true,
      includeToolCall: false,
      baseTimestamp: new Date('2024-01-01T00:00:00Z'),
    });

    const interaction2 = createInteractionFixture({
      userMessage: 'Message 2',
      agentResponse: 'Response 2',
      includeLLMCall: true,
      includeToolCall: false,
      baseTimestamp: new Date('2024-01-01T00:01:00Z'),
    });

    const interaction3 = createInteractionFixture({
      userMessage: 'Message 3',
      agentResponse: 'Response 3',
      includeLLMCall: true,
      includeToolCall: false,
      baseTimestamp: new Date('2024-01-01T00:02:00Z'),
    });

    const allEvents = [...interaction1, ...interaction2, ...interaction3];
    const processed = processEventsToInteractions(allEvents);

    // Assert: Session-level totals = 3 calls × (100 in + 50 out)
    assertTokenTotals(processed.summary, 300, 150);
    assertLLMCallCount(processed.summary, 3);
  });

  it('INT-2: per-interaction totals aggregate correctly', () => {
    const events = [
      createUserMessageEvent('Message 1', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createLLMCallEvent({
        inputTokens: 200,
        outputTokens: 100,
        overrides: { timestamp: new Date('2024-01-01T00:00:01Z') },
      }),
      createLLMCallEvent({
        inputTokens: 150,
        outputTokens: 75,
        overrides: { timestamp: new Date('2024-01-01T00:00:02Z') },
      }),
      createAgentResponseEvent('Response 1', {
        timestamp: new Date('2024-01-01T00:00:03Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    assertInteractionCount(processed, 1);

    // Interaction should have total tokens from both LLM calls
    // Note: Per-interaction totals are calculated in the event processor
    expect(processed.summary.totalTokensIn).toBe(350); // 200 + 150
    expect(processed.summary.totalTokensOut).toBe(175); // 100 + 75
  });

  it('INT-2: cost calculation uses correct token totals (if pricing data available)', () => {
    const events = [
      createUserMessageEvent('Test', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createLLMCallEvent({
        model: 'gpt-4',
        inputTokens: 1000,
        outputTokens: 500,
        cost: 0.05, // $0.03 for 1K input + $0.02 for 500 output (example pricing)
        overrides: { timestamp: new Date('2024-01-01T00:00:01Z') },
      }),
      createAgentResponseEvent('Response', {
        timestamp: new Date('2024-01-01T00:00:02Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Cost should be aggregated from LLM calls
    expect(processed.summary.totalCost).toBeGreaterThan(0);
    // With 1 call at $0.05, total should be $0.05
    expect(processed.summary.totalCost).toBe(0.05);
  });

  it('INT-2: handles multiple models with different pricing', () => {
    const events = [
      createUserMessageEvent('Test', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createLLMCallEvent({
        model: 'gpt-4',
        inputTokens: 1000,
        outputTokens: 500,
        cost: 0.05,
        overrides: { timestamp: new Date('2024-01-01T00:00:01Z') },
      }),
      createLLMCallEvent({
        model: 'gpt-3.5-turbo',
        inputTokens: 2000,
        outputTokens: 1000,
        cost: 0.003,
        overrides: { timestamp: new Date('2024-01-01T00:00:02Z') },
      }),
      createAgentResponseEvent('Response', {
        timestamp: new Date('2024-01-01T00:00:03Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Total tokens: 1000 + 2000 = 3000 in, 500 + 1000 = 1500 out
    assertTokenTotals(processed.summary, 3000, 1500);
    // Total cost: 0.05 + 0.003 = 0.053
    expect(processed.summary.totalCost).toBeCloseTo(0.053, 3);
    assertLLMCallCount(processed.summary, 2);
  });
});

describe('Integration: Agent Path Construction', () => {
  it('INT-6: builds correct agent sequence from agent_enter/agent_exit events', () => {
    const events = [
      createAgentEnterEvent('agent-a', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createUserMessageEvent('Test message', {
        agentName: 'agent-a',
        timestamp: new Date('2024-01-01T00:00:01Z'),
      }),
      createAgentResponseEvent('Response from A', {
        agentName: 'agent-a',
        timestamp: new Date('2024-01-01T00:00:02Z'),
      }),
      createAgentExitEvent('agent-a', 'completed', {
        timestamp: new Date('2024-01-01T00:00:03Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Verify agent path was built
    expect(processed.agentPath).toBeDefined();
    expect(processed.agentPath.length).toBeGreaterThan(0);
    assertAgentPath(processed.agentPath, ['agent-a']);
  });

  it('INT-6: detects agent switches at correct interaction boundaries', () => {
    const events = [
      // Agent A processes first message
      createAgentEnterEvent('agent-a', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createUserMessageEvent('Message 1', {
        agentName: 'agent-a',
        timestamp: new Date('2024-01-01T00:00:01Z'),
      }),
      createAgentResponseEvent('Response 1', {
        agentName: 'agent-a',
        timestamp: new Date('2024-01-01T00:00:02Z'),
      }),
      // Handoff to Agent B - delegate events are system events with no agentName
      {
        ...createDelegateStartEvent('agent-a', 'agent-b', 'handoff', {
          timestamp: new Date('2024-01-01T00:00:03Z'),
        }),
        agentName: '',
      },
      createAgentExitEvent('agent-a', 'handoff', {
        timestamp: new Date('2024-01-01T00:00:04Z'),
      }),
      createAgentEnterEvent('agent-b', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:05Z'),
      }),
      {
        ...createDelegateCompleteEvent('agent-a', 'agent-b', {
          timestamp: new Date('2024-01-01T00:00:06Z'),
        }),
        agentName: '',
      },
      // Agent B processes second message
      createUserMessageEvent('Message 2', {
        agentName: 'agent-b',
        timestamp: new Date('2024-01-01T00:01:00Z'),
      }),
      createAgentResponseEvent('Response 2', {
        agentName: 'agent-b',
        timestamp: new Date('2024-01-01T00:01:01Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Should have agent path with both agents
    assertAgentPath(processed.agentPath, ['agent-a', 'agent-b']);

    // Should have agent switches detected
    expect(processed.agentSwitches).toBeDefined();
    expect(processed.agentSwitches.length).toBeGreaterThan(0);
  });

  it('INT-6: tracks agent mode (reasoning vs scripted) correctly', () => {
    const events = [
      createAgentEnterEvent('reasoning-agent', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createUserMessageEvent('Message to reasoning agent', {
        agentName: 'reasoning-agent',
        timestamp: new Date('2024-01-01T00:00:01Z'),
      }),
      createAgentResponseEvent('Reasoning response', {
        agentName: 'reasoning-agent',
        timestamp: new Date('2024-01-01T00:00:02Z'),
      }),
      createAgentExitEvent('reasoning-agent', 'completed', {
        timestamp: new Date('2024-01-01T00:00:03Z'),
      }),
      // Switch to scripted agent - first event from scripted-agent must be a flow event
      // for buildAgentPath to detect scripted mode (it checks the type of the first event)
      {
        ...createTraceEvent({
          type: 'flow_step_enter',
          agentName: 'scripted-agent',
          timestamp: new Date('2024-01-01T00:00:04Z'),
          data: {
            step: 'greeting',
            flowName: 'customer-support',
          },
        }),
      },
      createUserMessageEvent('Message to scripted agent', {
        agentName: 'scripted-agent',
        timestamp: new Date('2024-01-01T00:01:00Z'),
      }),
      createAgentResponseEvent('Scripted response', {
        agentName: 'scripted-agent',
        timestamp: new Date('2024-01-01T00:01:01Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    assertAgentPath(processed.agentPath, ['reasoning-agent', 'scripted-agent']);

    // Verify agent modes are tracked
    // Note: Mode is inferred from event types, not from agent_enter data.mode
    expect(processed.agentPath[0].mode).toBe('reasoning');
    expect(processed.agentPath[1].mode).toBe('scripted');
  });

  it('INT-6: handles single-agent sessions correctly', () => {
    const events = [
      createAgentEnterEvent('single-agent', 'reasoning', {
        timestamp: new Date('2024-01-01T00:00:00Z'),
      }),
      createUserMessageEvent('Message 1', {
        agentName: 'single-agent',
        timestamp: new Date('2024-01-01T00:00:01Z'),
      }),
      createAgentResponseEvent('Response 1', {
        agentName: 'single-agent',
        timestamp: new Date('2024-01-01T00:00:02Z'),
      }),
      createUserMessageEvent('Message 2', {
        agentName: 'single-agent',
        timestamp: new Date('2024-01-01T00:01:00Z'),
      }),
      createAgentResponseEvent('Response 2', {
        agentName: 'single-agent',
        timestamp: new Date('2024-01-01T00:01:01Z'),
      }),
    ];

    const processed = processEventsToInteractions(events);

    // Should have 2 interactions, 1 agent
    assertInteractionCount(processed, 2);
    assertAgentPath(processed.agentPath, ['single-agent']);
    expect(processed.summary.agentCount).toBe(1);
  });
});
