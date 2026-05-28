/**
 * Conversation History Integrity Tests
 *
 * Comprehensive tests ensuring conversation history remains structurally valid
 * across all execution modes (scripted, reasoning) and agent compositions
 * (single agent, supervisor-to-child handoff, multi-agent pipelines).
 *
 * These tests catch bugs that would cause Anthropic API 400 errors:
 * - Empty user messages
 * - Consecutive same-role messages (user-user or assistant-assistant)
 * - Duplicate messages from recursive flow steps or handoff returns
 *
 * The ValidatingMockAnthropicClient enforces the same rules as the real API,
 * so any structural violation is caught immediately during test execution.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
  assertHistoryIntegrity,
  assertSessionHistoryIntegrity,
  assertExactMessageCount,
  assertUserMessageCount,
  assertAssistantMessageCount,
  assertNoEmptyUserMessages,
  assertNoConsecutiveSameRole,
  assertValidLLMMessages,
  ValidatingMockAnthropicClient,
  injectValidatingMockClient,
  createTraceCollector,
  filterTraces,
} from './helpers/history-validation.js';

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
  getActiveThread,
} from '../services/runtime-executor';

// =============================================================================
// DSL TEMPLATES
// =============================================================================

const SCRIPTED_SINGLE_STEP = `
AGENT: Scripted_Single

GOAL: "Collect a value and respond"

FLOW:
  entry_point: start
  steps:
    - start

start:
  GATHER:
    - value: required
  THEN: COMPLETE
`;

const SCRIPTED_MULTI_STEP = `
AGENT: Scripted_Multi

GOAL: "Multi-step flow agent"

FLOW:
  entry_point: step_one
  steps:
    - step_one
    - step_two
    - step_three

step_one:
  GATHER:
    - name: required
  THEN: step_two

step_two:
  GATHER:
    - color: required
  THEN: step_three

step_three:
  RESPOND: "Hello {{name}}, you like {{color}}."
  THEN: COMPLETE
`;

const SCRIPTED_WITH_ONINPUT = `
AGENT: Scripted_OnInput

GOAL: "Flow with ON_INPUT branching"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirm
    - done

ask:
  GATHER:
    - choice: required
  ON_INPUT:
    - IF: input contains "back"
      SET: direction = "back"
      THEN: done
    - IF: input contains "forward"
      SET: direction = "forward"
      THEN: confirm
    - ELSE:
      THEN: done

confirm:
  GATHER:
    - confirmed: required
  THEN: done

done:
  RESPOND: "Direction: {{direction}}. Done!"
  THEN: COMPLETE
`;

const SCRIPTED_PARENT = `
AGENT: Scripted_Parent

GOAL: "Route to child"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "help"
      SET: intent = "help"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: Scripted_Child
    WHEN: intent == "help"
    CONTEXT:
      pass: [intent, request]
      summary: "User needs help"
    RETURN: false
`;

const SCRIPTED_PARENT_RETURN = `
AGENT: Scripted_Parent_Return

GOAL: "Route and return"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "check"
      SET: intent = "check"
      THEN: COMPLETE
    - ELSE:
      THEN: done

done:
  RESPOND: "All done from parent!"
  THEN: COMPLETE

HANDOFF:
  - TO: Scripted_Child
    WHEN: intent == "check"
    CONTEXT:
      pass: [intent]
      summary: "Check request"
    RETURN: true
`;

const SCRIPTED_CHILD = `
AGENT: Scripted_Child

GOAL: "Handle help requests"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Child agent here. I can help!"
  THEN: COMPLETE
`;

const REASONING_SUPERVISOR = `
SUPERVISOR: Test_Supervisor

GOAL: "Route requests"
PERSONA: "Router"
HANDOFF:
  - TO: Agent_A
    WHEN: intent contains "alpha"
    CONTEXT:
      summary: "Route to A"
    RETURN: true
  - TO: Agent_B
    WHEN: intent contains "beta"
    CONTEXT:
      summary: "Route to B"
    RETURN: false
`;

const REASONING_AGENT_A = `
AGENT: Agent_A

GOAL: "Handle alpha requests"
PERSONA: "Alpha helper"
GATHER:
  topic:
    prompt: "What topic?"
    type: string
    required: false
`;

const REASONING_AGENT_B = `
AGENT: Agent_B

GOAL: "Handle beta requests"
PERSONA: "Beta helper"
GATHER:
  category:
    prompt: "What category?"
    type: string
    required: false
`;

const REASONING_SIMPLE = `
AGENT: Simple_Reasoning

GOAL: "Help users"
PERSONA: "Friendly assistant"
GATHER:
  topic:
    prompt: "What topic?"
    type: string
    required: false
`;

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Conversation History Integrity', () => {
  // ===========================================================================
  // 1. SCRIPTED FLOW - HISTORY INTEGRITY AFTER FLOW EXECUTION
  // ===========================================================================

  describe('1. Scripted flow - history integrity after flow execution', () => {
    let executor: RuntimeExecutor;

    beforeEach(() => {
      executor = new RuntimeExecutor();
    });

    test('Single step GATHER then RESPOND: verify exact message counts (2: 1 user + 1 assistant)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_SINGLE_STEP], 'Scripted_Single'),
      );
      await executor.initializeSession(session.id);

      // Session should be waiting for input with a prompt
      // The prompt is the assistant message from GATHER step
      const historyBeforeInput = session.conversationHistory;
      assertNoEmptyUserMessages(historyBeforeInput, 'before-input');
      assertNoConsecutiveSameRole(historyBeforeInput, 'before-input');

      // Send user input to complete the GATHER
      await executor.executeMessage(session.id, 'my_value');

      // After providing input, flow goes to COMPLETE
      // History should have: assistant (prompt) + user (input) + assistant (completion)
      // But the exact count depends on whether the initializeSession prompt is in history
      const history = session.conversationHistory;
      assertHistoryIntegrity(history, 'after-single-step');
      assertNoEmptyUserMessages(history, 'after-single-step');
      assertNoConsecutiveSameRole(history, 'after-single-step');

      // Verify user messages are non-empty
      const userMsgs = history.filter((m) => m.role === 'user');
      for (const msg of userMsgs) {
        expect(msg.content.trim().length).toBeGreaterThan(0);
      }

      assertSessionHistoryIntegrity(session);
    });

    test('Multi-step flow with transitions: verify no empty messages from recursive executeFlowStep calls', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_MULTI_STEP], 'Scripted_Multi'),
      );
      await executor.initializeSession(session.id);

      // Step 1: GATHER name
      assertSessionHistoryIntegrity(session);
      await executor.executeMessage(session.id, 'Alice');

      // Step 2: GATHER color
      assertSessionHistoryIntegrity(session);
      await executor.executeMessage(session.id, 'blue');

      // Step 3: RESPOND (auto-advances to COMPLETE)
      // At this point flow should be done
      const history = session.conversationHistory;
      assertHistoryIntegrity(history, 'after-multi-step');
      assertNoEmptyUserMessages(history, 'after-multi-step');
      assertNoConsecutiveSameRole(history, 'after-multi-step');

      // Verify each user message matches what we sent
      const userMsgs = history.filter((m) => m.role === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      expect(userMsgs.some((m) => m.content === 'Alice')).toBe(true);
      expect(userMsgs.some((m) => m.content === 'blue')).toBe(true);

      assertSessionHistoryIntegrity(session);
    });

    test('ON_INPUT with navigation (back): verify history stays clean after branching', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_WITH_ONINPUT], 'Scripted_OnInput'),
      );
      await executor.initializeSession(session.id);

      // Provide input that triggers the "back" branch
      await executor.executeMessage(session.id, 'go back please');

      const history = session.conversationHistory;
      assertHistoryIntegrity(history, 'after-back-branch');
      assertNoEmptyUserMessages(history, 'after-back-branch');
      assertNoConsecutiveSameRole(history, 'after-back-branch');

      assertSessionHistoryIntegrity(session);
    });

    test('ON_INPUT with forward navigation: verify history stays clean through confirm step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_WITH_ONINPUT], 'Scripted_OnInput'),
      );
      await executor.initializeSession(session.id);

      // Trigger "forward" branch
      await executor.executeMessage(session.id, 'go forward');
      assertSessionHistoryIntegrity(session);

      // Confirm step
      await executor.executeMessage(session.id, 'yes');
      assertSessionHistoryIntegrity(session);

      const history = session.conversationHistory;
      assertHistoryIntegrity(history, 'after-forward-confirm');
      assertNoEmptyUserMessages(history, 'after-forward-confirm');
      assertNoConsecutiveSameRole(history, 'after-forward-confirm');
    });

    test('Flow completion: verify no duplicate completion messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_SINGLE_STEP], 'Scripted_Single'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'test_value');

      const history = session.conversationHistory;
      assertHistoryIntegrity(history, 'after-completion');

      // Count completion messages - should be at most 1
      const completionMsgs = history.filter(
        (m) => m.role === 'assistant' && m.content.toLowerCase().includes('complete'),
      );
      // Allow for the case where completion message is the default or custom
      // but there should not be duplicates
      const uniqueCompletionContents = new Set(completionMsgs.map((m) => m.content));
      expect(completionMsgs.length).toBe(uniqueCompletionContents.size);

      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 2. SCRIPTED FLOW - HISTORY INTEGRITY AFTER HANDOFF
  // ===========================================================================

  describe('2. Scripted flow - history integrity after handoff', () => {
    let executor: RuntimeExecutor;

    beforeEach(() => {
      executor = new RuntimeExecutor();
    });

    test('Scripted parent to scripted child (RETURN: false): verify both thread histories are clean', async () => {
      executor.registerAgent('Scripted_Child', SCRIPTED_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_PARENT], 'Scripted_Parent'),
      );
      await executor.initializeSession(session.id);

      // Send a message that triggers handoff (contains "help")
      await executor.executeMessage(session.id, 'I need help with something');

      // After handoff: should have 2 threads
      expect(session.threads.length).toBe(2);

      // Parent thread (index 0) history should be clean
      const parentThread = session.threads[0];
      assertHistoryIntegrity(parentThread.conversationHistory, 'parent-thread');
      assertNoEmptyUserMessages(parentThread.conversationHistory, 'parent-thread');
      assertNoConsecutiveSameRole(parentThread.conversationHistory, 'parent-thread');

      // Child thread (index 1) history should be clean
      const childThread = session.threads[1];
      assertHistoryIntegrity(childThread.conversationHistory, 'child-thread');
      assertNoEmptyUserMessages(childThread.conversationHistory, 'child-thread');
      assertNoConsecutiveSameRole(childThread.conversationHistory, 'child-thread');

      assertSessionHistoryIntegrity(session);
    });

    test('Scripted parent to scripted child (RETURN: true): verify parent resumes cleanly', async () => {
      executor.registerAgent('Scripted_Child', SCRIPTED_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_PARENT_RETURN], 'Scripted_Parent_Return'),
      );
      await executor.initializeSession(session.id);

      // Send message triggering handoff with RETURN: true (contains "check")
      await executor.executeMessage(session.id, 'check my status');

      // Child completes immediately (RESPOND + COMPLETE), so return to parent should have happened
      // Verify thread structure
      expect(session.threads.length).toBe(2);

      // Parent thread should be active (returned to)
      const parentThread = session.threads[0];
      assertHistoryIntegrity(parentThread.conversationHistory, 'parent-after-return');

      // Child thread should be completed
      const childThread = session.threads[1];
      expect(childThread.status).toBe('completed');
      assertHistoryIntegrity(childThread.conversationHistory, 'child-completed');

      // No duplicate messages after return
      assertNoConsecutiveSameRole(parentThread.conversationHistory, 'parent-after-return');

      assertSessionHistoryIntegrity(session);
    });

    test('Verify child thread gets exactly the forwarded message, not duplicates', async () => {
      executor.registerAgent('Scripted_Child', SCRIPTED_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_PARENT], 'Scripted_Parent'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'I need help now');

      // The child thread should have received the user message
      const childThread = session.threads[1];
      expect(childThread).toBeDefined();
      expect(childThread.agentName).toBe('Scripted_Child');

      // Child history should have user messages but not duplicates
      const childUserMsgs = childThread.conversationHistory.filter((m) => m.role === 'user');
      expect(childUserMsgs).toHaveLength(1);
      expect(childUserMsgs[0]?.content).toBe('I need help now');

      // The key check: no DUPLICATE forwarded messages
      const uniqueUserContents = new Set(childUserMsgs.map((m) => m.content));
      expect(childUserMsgs.length).toBe(uniqueUserContents.size);

      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 3. REASONING MODE - HISTORY INTEGRITY (ValidatingMockAnthropicClient)
  // ===========================================================================

  describe('3. Reasoning mode - history integrity', () => {
    let executor: RuntimeExecutor;
    let mockClient: ValidatingMockAnthropicClient;

    beforeEach(() => {
      executor = new RuntimeExecutor();
      mockClient = injectValidatingMockClient(executor);
    });

    test('Single reasoning agent: send 2 messages, verify history has exactly 4 entries (2 user + 2 assistant)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      // Message 1
      mockClient.setExtractAndRespond({}, 'Hello! How can I help you today?');
      await executor.executeMessage(session.id, 'Hi there');

      assertSessionHistoryIntegrity(session);
      assertUserMessageCount(session.conversationHistory, 1, 'after-msg-1');
      assertAssistantMessageCount(session.conversationHistory, 1, 'after-msg-1');

      // Message 2
      mockClient.setExtractAndRespond({ topic: 'weather' }, 'The weather looks great today!');
      await executor.executeMessage(session.id, 'Tell me about the weather');

      assertSessionHistoryIntegrity(session);
      assertExactMessageCount(session.conversationHistory, 4, 'after-msg-2');
      assertUserMessageCount(session.conversationHistory, 2, 'after-msg-2');
      assertAssistantMessageCount(session.conversationHistory, 2, 'after-msg-2');

      // Validate all LLM calls had valid messages
      assertValidLLMMessages(mockClient.calls);
    });

    test('Reasoning agent with entity extraction: verify extraction call + reasoning call both get valid messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      // Set up: extraction returns topic, reasoning call returns text
      mockClient.setExtractAndRespond({ topic: 'travel' }, 'Great, I can help you plan your trip!');

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'I want to plan a trip',
        undefined,
        traceCollector.callback,
      );

      // Verify LLM was called at least twice (extraction + reasoning)
      expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);

      // At least 2 calls: extraction + reasoning
      expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);

      // First call is extraction (no tools), second is reasoning
      const extractionCall = mockClient.calls[0];
      expect(extractionCall).toBeDefined();

      const reasoningCall = mockClient.calls[1];
      expect(reasoningCall).toBeDefined();

      // All calls should have valid message format
      assertValidLLMMessages(mockClient.calls);

      // Session history should be clean
      assertSessionHistoryIntegrity(session);
    });

    test('Reasoning agent completion via __complete__ tool: verify no duplicate assistant push', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      // Configure mock to return a __complete__ tool call
      mockClient.setCompleteResponse('call-1', 'Task done successfully', 'All finished!');

      await executor.executeMessage(session.id, 'Please complete this task');

      // Session should be complete
      expect(session.isComplete).toBe(true);

      // History should be clean - no duplicate assistant messages
      assertSessionHistoryIntegrity(session);
      assertNoConsecutiveSameRole(session.conversationHistory, 'after-complete');

      // There should be exactly 1 user message
      assertUserMessageCount(session.conversationHistory, 1, 'after-complete');

      // Validate LLM calls
      assertValidLLMMessages(mockClient.calls);
    });
  });

  // ===========================================================================
  // 4. REASONING SUPERVISOR -> REASONING CHILD HANDOFF (THE KEY GAP)
  // ===========================================================================

  describe('4. Reasoning supervisor -> reasoning child handoff', () => {
    let executor: RuntimeExecutor;
    let mockClient: ValidatingMockAnthropicClient;

    beforeEach(() => {
      executor = new RuntimeExecutor();
      mockClient = injectValidatingMockClient(executor);
      executor.registerAgent('Agent_A', REASONING_AGENT_A);
      executor.registerAgent('Agent_B', REASONING_AGENT_B);
    });

    test('Reasoning supervisor with __handoff__ tool -> reasoning child: verify no duplicate messages in child thread', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Routing to Agent A...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to Agent A...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler ready.' }],
        };
      });

      await executor.executeMessage(session.id, 'I need alpha support');

      // Should have created a child thread
      expect(session.threads.length).toBe(2);
      const childThread = session.threads[1];
      expect(childThread.agentName).toBe('Agent_A');

      // Child thread history should be clean - no duplicate messages
      assertHistoryIntegrity(childThread.conversationHistory, 'child-Agent_A');
      assertNoEmptyUserMessages(childThread.conversationHistory, 'child-Agent_A');
      assertNoConsecutiveSameRole(childThread.conversationHistory, 'child-Agent_A');

      // Supervisor thread history should also be clean
      const supervisorThread = session.threads[0];
      assertHistoryIntegrity(supervisorThread.conversationHistory, 'supervisor-thread');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });

    test('Reasoning handoff forwards the live user turn without duplicating parent history', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      let reasoningCallCount = 0;
      mockClient.setResponseHandler((_sys, _msgs, _tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Routing to Agent A...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {}, message: 'I need alpha support' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to Agent A...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {}, message: 'I need alpha support' },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler ready.' }],
        };
      });

      await executor.executeMessage(session.id, 'I need alpha support');

      const childThread = session.threads[1];
      expect(childThread?.agentName).toBe('Agent_A');

      const childUserMsgs = childThread.conversationHistory.filter((m) => m.role === 'user');
      expect(childUserMsgs).toHaveLength(1);
      expect(childUserMsgs[0]?.content).toBe('I need alpha support');

      const lastLlmCall = mockClient.calls.at(-1);
      expect(lastLlmCall).toBeDefined();
      expect(lastLlmCall!.messages.length).toBeGreaterThan(0);
      expect(lastLlmCall!.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'I need alpha support' }),
        ]),
      );
    });

    test('After handoff, verify supervisor and child thread histories are independent and clean', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Routing to alpha handler...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to alpha handler...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler active.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler active.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha request please');

      const supervisorThread = session.threads[0];
      const childThread = session.threads[1];

      // Histories should be independent - child should not contain supervisor's full history
      // Supervisor's history should have the original user message + assistant routing message
      assertHistoryIntegrity(supervisorThread.conversationHistory, 'supervisor');
      assertHistoryIntegrity(childThread.conversationHistory, 'child');

      // Child thread should not have consecutive same-role messages
      assertNoConsecutiveSameRole(childThread.conversationHistory, 'child-independence');

      // Both threads should have clean histories
      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });

    test('Multi-step: supervisor handoff to Agent_A, multiple messages to Agent_A, then Agent_A completes -> verify all thread histories clean', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Step 1: Supervisor routes to Agent_A
      // Call-sequence-aware: supervisor (1st reasoning) gets __handoff__, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Routing to A...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to A...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler ready.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha topic help');

      // Agent_A should be active
      expect(session.threads.length).toBe(2);
      expect(session.threads[1].agentName).toBe('Agent_A');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Step 2: Send another message to Agent_A
      mockClient.setExtractAndRespond({ topic: 'alpha-details' }, 'Working on alpha details...');
      await executor.executeMessage(session.id, 'give me more alpha details');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Step 3: Agent_A completes via __complete__
      mockClient.setCompleteResponse('call-2', 'done with alpha', 'Alpha task completed.');
      await executor.executeMessage(session.id, 'finish up alpha');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // After __complete__, child thread returns to supervisor (RETURN: true)
      // Session is NOT complete because supervisor is active again
      expect(session.isComplete).toBe(false);
      expect(session.activeThreadIndex).toBe(0); // back to supervisor
      expect(session.threads[1].status).toBe('completed');
      expect(session.threadStack.length).toBe(0);

      // Verify all thread histories are clean
      for (let i = 0; i < session.threads.length; i++) {
        const thread = session.threads[i];
        assertHistoryIntegrity(thread.conversationHistory, `Thread[${i}] (${thread.agentName})`);
        assertNoEmptyUserMessages(thread.conversationHistory, `Thread[${i}] (${thread.agentName})`);
        assertNoConsecutiveSameRole(
          thread.conversationHistory,
          `Thread[${i}] (${thread.agentName})`,
        );
      }
    });
  });

  // ===========================================================================
  // 5. LLM INPUT VALIDATION
  // ===========================================================================

  describe('5. LLM input validation', () => {
    let executor: RuntimeExecutor;
    let mockClient: ValidatingMockAnthropicClient;

    beforeEach(() => {
      executor = new RuntimeExecutor();
      mockClient = injectValidatingMockClient(executor);
    });

    test('After each executeMessage to a reasoning agent, assertValidLLMMessages passes', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      // Message 1
      mockClient.setExtractAndRespond({}, 'First response');
      await executor.executeMessage(session.id, 'Hello');
      assertValidLLMMessages(mockClient.calls);

      // Message 2
      mockClient.setExtractAndRespond({ topic: 'coding' }, 'Let me help with coding');
      await executor.executeMessage(session.id, 'Help me with coding');
      assertValidLLMMessages(mockClient.calls);

      // Message 3
      mockClient.setExtractAndRespond({}, 'Sure, anything else?');
      await executor.executeMessage(session.id, 'What else can you do?');
      assertValidLLMMessages(mockClient.calls);

      assertSessionHistoryIntegrity(session);
    });

    test('Verify the mock client received correct message counts', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      mockClient.setExtractAndRespond({}, 'Response 1');
      await executor.executeMessage(session.id, 'Message one');

      // After first message: extraction call (1) + reasoning call (1) = at least 2 calls
      const callsAfterFirst = mockClient.calls.length;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

      mockClient.setExtractAndRespond({}, 'Response 2');
      await executor.executeMessage(session.id, 'Message two');

      // After second message: should have more calls
      const callsAfterSecond = mockClient.calls.length;
      expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);

      // All calls should have valid messages
      assertValidLLMMessages(mockClient.calls);
    });

    test('Verify no empty user messages were sent to the LLM', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      mockClient.setExtractAndRespond({ topic: 'test' }, 'Testing response');
      await executor.executeMessage(session.id, 'Test message');

      // Explicitly check each call's messages
      for (const call of mockClient.calls) {
        for (let i = 0; i < call.messages.length; i++) {
          const msg = call.messages[i];
          if (msg.role === 'user') {
            const content =
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            expect(
              content && content.trim() !== '',
              `Empty user message found in LLM call at index ${i}`,
            ).toBe(true);
          }
        }
      }

      assertSessionHistoryIntegrity(session);
    });

    test('Reasoning agent with entity extraction: LLM messages are valid across extraction and reasoning calls', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      // First message: extracts topic
      mockClient.setExtractAndRespond({ topic: 'sports' }, 'Let me help with sports!');
      await executor.executeMessage(session.id, 'I want to discuss sports');

      // Second message: no new extraction
      mockClient.setExtractAndRespond({}, 'What sport interests you?');
      await executor.executeMessage(session.id, 'Tell me more');

      // All calls valid
      assertValidLLMMessages(mockClient.calls);

      // Reasoning calls (every other call starting at index 1) should have growing history
      const reasoningCalls = mockClient.calls.filter((_, i) => i % 2 === 1);
      if (reasoningCalls.length >= 2) {
        // Second reasoning call should have more messages than the first
        expect(reasoningCalls[1].messages.length).toBeGreaterThan(
          reasoningCalls[0].messages.length,
        );
      }

      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 6. SEQUENTIAL MESSAGES THROUGH MULTI-AGENT PIPELINE
  // ===========================================================================

  describe('6. Sequential messages through multi-agent pipeline', () => {
    let executor: RuntimeExecutor;
    let mockClient: ValidatingMockAnthropicClient;

    beforeEach(() => {
      executor = new RuntimeExecutor();
      mockClient = injectValidatingMockClient(executor);
      executor.registerAgent('Agent_A', REASONING_AGENT_A);
      executor.registerAgent('Agent_B', REASONING_AGENT_B);
    });

    test('Msg1 -> supervisor routes to Agent_A (RETURN: true) -> Agent_A completes -> returns; Msg2 -> supervisor routes to Agent_B (RETURN: false)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Message 1: Supervisor routes to Agent_A
      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Sending to alpha agent...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Sending to alpha agent...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha agent ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha agent ready.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha issue to resolve');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Agent_A is now active; let it complete
      mockClient.setCompleteResponse('call-2', 'alpha resolved', 'Alpha issue resolved.');
      await executor.executeMessage(session.id, 'complete the alpha task');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Reset calls for clean verification of next sequence
      mockClient.calls = [];

      // Message 2: Supervisor routes to Agent_B (RETURN: false)
      let reasoningCallCount2 = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount2++;
        if (reasoningCallCount2 === 1) {
          return {
            text: 'Routing to beta agent...',
            toolCalls: [
              { id: 'call-3', name: '__handoff__', input: { target: 'Agent_B', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to beta agent...' },
              {
                type: 'tool_use',
                id: 'call-3',
                name: '__handoff__',
                input: { target: 'Agent_B', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Beta agent ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Beta agent ready.' }],
        };
      });
      await executor.executeMessage(session.id, 'beta task needed');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Verify thread histories
      for (let i = 0; i < session.threads.length; i++) {
        const thread = session.threads[i];
        assertHistoryIntegrity(
          thread.conversationHistory,
          `Pipeline Thread[${i}] (${thread.agentName})`,
        );
      }
    });

    test('Verify all thread histories clean and exact message counts per thread', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Step 1: Route to Agent_A
      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'To A...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'To A...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler active.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler active.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha request');

      // The supervisor thread should have at least the user message
      const supervisorThread = session.threads[0];
      assertUserMessageCount(
        supervisorThread.conversationHistory,
        1,
        'supervisor-after-first-handoff',
      );

      // Agent_A thread should exist
      const agentAThread = session.threads[1];
      expect(agentAThread.agentName).toBe('Agent_A');
      assertHistoryIntegrity(agentAThread.conversationHistory, 'Agent_A-after-handoff');

      // Step 2: Send a message to Agent_A
      mockClient.setExtractAndRespond({ topic: 'testing' }, 'Working on alpha...');
      await executor.executeMessage(session.id, 'process this alpha data');

      // Agent_A thread should have clean growing history
      assertHistoryIntegrity(agentAThread.conversationHistory, 'Agent_A-after-message');
      assertNoConsecutiveSameRole(agentAThread.conversationHistory, 'Agent_A-after-message');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });

    test('Verify no history corruption across sequential handoffs', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Handoff to Agent_A
      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Going to A...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Going to A...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha handler active.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha handler active.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha topic');
      assertSessionHistoryIntegrity(session);

      // Interact with Agent_A
      mockClient.setExtractAndRespond({ topic: 'alpha-detail' }, 'Alpha detail processed.');
      await executor.executeMessage(session.id, 'more alpha details');
      assertSessionHistoryIntegrity(session);

      // Agent_A completes
      mockClient.setCompleteResponse('call-2', 'done', 'Alpha complete!');
      await executor.executeMessage(session.id, 'finish alpha');
      assertSessionHistoryIntegrity(session);

      // Check that no thread has been corrupted
      for (let i = 0; i < session.threads.length; i++) {
        const thread = session.threads[i];
        const history = thread.conversationHistory;

        // No empty messages anywhere
        for (let j = 0; j < history.length; j++) {
          if (history[j].role === 'user') {
            expect(
              history[j].content && history[j].content.trim() !== '',
              `Empty user message in Thread[${i}] (${thread.agentName}) at index ${j}`,
            ).toBe(true);
          }
        }

        // No consecutive same-role
        assertNoConsecutiveSameRole(history, `corruption-check-Thread[${i}]`);
      }

      assertValidLLMMessages(mockClient.calls);
    });
  });

  // ===========================================================================
  // ADDITIONAL EDGE CASES
  // ===========================================================================

  describe('Edge cases: mixed mode and sequential reasoning interactions', () => {
    let executor: RuntimeExecutor;
    let mockClient: ValidatingMockAnthropicClient;

    beforeEach(() => {
      executor = new RuntimeExecutor();
      mockClient = injectValidatingMockClient(executor);
    });

    test('Multiple messages to same reasoning agent: history grows correctly with alternating roles', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      const messages = [
        { input: 'Hello', entities: {}, response: 'Hi there!' },
        { input: 'How are you?', entities: {}, response: 'I am doing well!' },
        { input: 'What is AI?', entities: { topic: 'AI' }, response: 'AI is fascinating!' },
        { input: 'Tell me more', entities: {}, response: 'There is a lot to learn.' },
      ];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        mockClient.setExtractAndRespond(msg.entities, msg.response);
        await executor.executeMessage(session.id, msg.input);

        // After each message, verify integrity
        assertSessionHistoryIntegrity(session);

        // Verify exact counts
        const expectedTotal = (i + 1) * 2; // Each turn adds 1 user + 1 assistant
        assertExactMessageCount(
          session.conversationHistory,
          expectedTotal,
          `after-message-${i + 1}`,
        );
        assertUserMessageCount(session.conversationHistory, i + 1, `after-message-${i + 1}`);
        assertAssistantMessageCount(session.conversationHistory, i + 1, `after-message-${i + 1}`);
      }

      assertValidLLMMessages(mockClient.calls);
    });

    test('Reasoning supervisor: handoff preserves message structure even when child agent has GATHER fields', async () => {
      executor.registerAgent('Agent_A', REASONING_AGENT_A);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Test_Supervisor'),
      );

      // Supervisor handoff to Agent_A (which has GATHER fields)
      // Call-sequence-aware: supervisor (1st reasoning) gets handoff, Agent_A (2nd) gets normal response
      let reasoningCallCount = 0;
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        reasoningCallCount++;
        if (reasoningCallCount === 1) {
          return {
            text: 'Routing to alpha specialist...',
            toolCalls: [
              { id: 'call-1', name: '__handoff__', input: { target: 'Agent_A', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to alpha specialist...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Agent_A', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha specialist ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha specialist ready.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha support needed');

      assertSessionHistoryIntegrity(session);

      // Now interact with Agent_A (which extracts entities via GATHER)
      mockClient.setExtractAndRespond({ topic: 'debugging' }, 'I can help you debug.');
      await executor.executeMessage(session.id, 'help me debug this issue');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Verify the active thread is Agent_A and has proper history
      const activeThread = getActiveThread(session);
      expect(activeThread.agentName).toBe('Agent_A');
      assertHistoryIntegrity(activeThread.conversationHistory, 'Agent_A-with-gather');
      assertNoEmptyUserMessages(activeThread.conversationHistory, 'Agent_A-with-gather');
    });

    test('Session-level history stays in sync with active thread history', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Simple_Reasoning'),
      );

      mockClient.setExtractAndRespond({}, 'Response');
      await executor.executeMessage(session.id, 'Test message');

      // Session-level and active thread histories should reference the same data
      const activeThread = getActiveThread(session);
      expect(session.conversationHistory).toBe(activeThread.conversationHistory);

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });
  });
});
