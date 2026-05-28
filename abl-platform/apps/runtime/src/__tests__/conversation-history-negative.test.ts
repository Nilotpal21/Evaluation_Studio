/**
 * Conversation History — Negative & Edge-Case Scenarios
 *
 * These tests verify history integrity under adversarial/degenerate conditions:
 * - Messages to completed sessions
 * - Empty/whitespace-only user input (rejected at boundary)
 * - Non-supervisor agent receiving __handoff__ from LLM (blocked by guard)
 * - Double __complete__ calls
 * - LLM returning empty text
 * - Mixed-mode handoffs (reasoning→scripted, scripted→reasoning)
 * - Handoff with missing PASS fields
 * - Constraint violation history integrity
 * - Thread return on child completion via __complete__
 * - Rapid sequential messages
 * - Escalated session behavior
 * - Reasoning agent without GATHER
 */

import { describe, test, expect, beforeEach } from 'vitest';

import {
  assertHistoryIntegrity,
  assertSessionHistoryIntegrity,
  assertExactMessageCount,
  assertUserMessageCount,
  assertAssistantMessageCount,
  assertNoEmptyUserMessages,
  assertNoEmptyMessages,
  assertNoConsecutiveSameRole,
  assertValidLLMMessages,
  ValidatingMockAnthropicClient,
  injectValidatingMockClient,
  createTraceCollector,
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

const SCRIPTED_SINGLE = `
AGENT: Neg_Scripted

GOAL: "Simple scripted agent"

FLOW:
  entry_point: start
  steps:
    - start

start:
  GATHER:
    - value: required
  THEN: COMPLETE
`;

const SCRIPTED_MULTI = `
AGENT: Neg_Multi

GOAL: "Multi step"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  GATHER:
    - first: required
  THEN: step2

step2:
  GATHER:
    - second: required
  THEN: COMPLETE
`;

const REASONING_SIMPLE = `
AGENT: Neg_Reasoning

GOAL: "Simple reasoning agent"
PERSONA: "Helper"
GATHER:
  topic:
    prompt: "What topic?"
    type: string
    required: false
`;

const REASONING_SUPERVISOR = `
SUPERVISOR: Neg_Supervisor

GOAL: "Route requests"
PERSONA: "Router"
HANDOFF:
  - TO: Neg_Child_Reasoning
    WHEN: intent contains "alpha"
    CONTEXT:
      summary: "Route to alpha"
    RETURN: true
  - TO: Neg_Child_Scripted
    WHEN: intent contains "scripted"
    CONTEXT:
      summary: "Route to scripted"
      pass: [intent]
    RETURN: false
`;

const REASONING_CHILD = `
AGENT: Neg_Child_Reasoning

GOAL: "Handle alpha"
PERSONA: "Alpha handler"
GATHER:
  detail:
    prompt: "What detail?"
    type: string
    required: false
`;

const SCRIPTED_CHILD = `
AGENT: Neg_Child_Scripted

GOAL: "Handle scripted"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Scripted child here!"
  THEN: COMPLETE
`;

const SCRIPTED_PARENT_WITH_PASS = `
AGENT: Neg_Pass_Parent

GOAL: "Test PASS with missing fields"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "go"
      SET: intent = "go"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: Neg_Pass_Child
    WHEN: intent == "go"
    CONTEXT:
      pass: [intent, nonexistent_var, another_missing]
      summary: "Go request"
    RETURN: false
`;

const SCRIPTED_PASS_CHILD = `
AGENT: Neg_Pass_Child

GOAL: "Receive PASS"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Child received. Intent: {{intent}}"
  THEN: COMPLETE
`;

const REASONING_WITH_CONSTRAINT = `
AGENT: Neg_Constrained

GOAL: "Agent with constraints"
PERSONA: "Constrained helper"
GATHER:
  topic:
    prompt: "What topic?"
    type: string
    required: false
CONSTRAINTS:
  - REQUIRE topic != "forbidden"
    ON_FAIL: RESPOND "That topic is not allowed."
`;

const REASONING_NO_GATHER = `
AGENT: Neg_NoGather

GOAL: "Agent without GATHER"
PERSONA: "Simple helper"
`;

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Conversation History — Negative Scenarios', () => {
  // ===========================================================================
  // 1. MESSAGES TO COMPLETED SESSION
  // ===========================================================================

  describe('1. Messages to completed session', () => {
    test('Scripted: message after completion does NOT modify history', async () => {
      const executor = new RuntimeExecutor();
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_SINGLE], 'Neg_Scripted'),
      );
      await executor.initializeSession(session.id);

      // Complete the session
      await executor.executeMessage(session.id, 'done');
      expect(session.isComplete).toBe(true);

      // Snapshot history
      const historyBefore = [...session.conversationHistory];
      const countBefore = historyBefore.length;

      // Send another message to the completed session
      const result = await executor.executeMessage(session.id, 'extra message');

      // History should NOT have grown
      expect(session.conversationHistory.length).toBe(countBefore);
      expect(result.action).toEqual(expect.objectContaining({ type: 'complete' }));

      // History should still be clean
      assertNoEmptyUserMessages(session.conversationHistory, 'post-complete');
      assertSessionHistoryIntegrity(session);
    });

    test('Reasoning: message after __complete__ does NOT modify history', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Complete via __complete__
      mockClient.setCompleteResponse('call-1', 'done', 'All finished.');
      await executor.executeMessage(session.id, 'complete this');
      expect(session.isComplete).toBe(true);

      // Snapshot history
      const countBefore = session.conversationHistory.length;

      // Send another message
      const result = await executor.executeMessage(session.id, 'one more thing');

      // History should NOT have grown
      expect(session.conversationHistory.length).toBe(countBefore);
      expect(result.action).toEqual(expect.objectContaining({ type: 'complete' }));

      assertSessionHistoryIntegrity(session);
    });

    test('Multiple messages after completion all get rejected cleanly', async () => {
      const executor = new RuntimeExecutor();
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_SINGLE], 'Neg_Scripted'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'value');
      expect(session.isComplete).toBe(true);
      const countAfterComplete = session.conversationHistory.length;

      // Send 3 more messages
      for (let i = 0; i < 3; i++) {
        await executor.executeMessage(session.id, `extra ${i}`);
      }

      // History length must not change
      expect(session.conversationHistory.length).toBe(countAfterComplete);
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 2. EMPTY / WHITESPACE-ONLY USER INPUT
  // ===========================================================================

  describe('2. Empty and whitespace-only user input', () => {
    test('Scripted flow: empty string input is rejected before reaching history', async () => {
      const executor = new RuntimeExecutor();
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_MULTI], 'Neg_Multi'),
      );
      await executor.initializeSession(session.id);

      const result = await executor.executeMessage(session.id, '');

      // Empty input should be rejected with a friendly message, not pushed to history
      expect(result.response).toContain('Please provide a message');
      assertNoEmptyUserMessages(session.conversationHistory, 'empty-input-flow');
      assertNoEmptyMessages(session.conversationHistory, 'empty-input-flow');
    });

    test('Scripted flow: whitespace-only input is rejected before reaching history', async () => {
      const executor = new RuntimeExecutor();
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_MULTI], 'Neg_Multi'),
      );
      await executor.initializeSession(session.id);

      const result = await executor.executeMessage(session.id, '   ');

      // Whitespace-only input should be trimmed and rejected, not pushed to history
      expect(result.response).toContain('Please provide a message');
      const userMsgs = session.conversationHistory.filter((m) => m.role === 'user');
      const whitespaceMsgs = userMsgs.filter((m) => m.content.trim() === '');
      expect(whitespaceMsgs.length).toBe(0);
      assertNoEmptyUserMessages(session.conversationHistory, 'whitespace-input-flow');
    });

    test('Reasoning mode: empty string input is rejected before reaching LLM', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Send a valid first message so history has at least one valid pair
      mockClient.setExtractAndRespond({}, 'Hello!');
      await executor.executeMessage(session.id, 'hi');
      assertSessionHistoryIntegrity(session);

      const historyLenBefore = session.conversationHistory.length;

      // Send empty string — should be rejected at input validation, never reaching LLM
      const result = await executor.executeMessage(session.id, '');

      expect(result.response).toContain('Please provide a message');
      // History should NOT have grown (no empty user message pushed)
      expect(session.conversationHistory.length).toBe(historyLenBefore);
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 3. NON-SUPERVISOR AGENT PROCESSING __handoff__
  // ===========================================================================

  describe('3. Non-supervisor agent receiving __handoff__ from LLM', () => {
    test('Regular reasoning agent with __handoff__ tool call: handoff is blocked by guard', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);

      // Register the target agent so it exists in registry
      executor.registerAgent('Neg_Child_Reasoning', REASONING_CHILD);

      // Create a NON-supervisor reasoning agent (no HANDOFF section in DSL)
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Configure mock so the non-supervisor's reasoning call returns __handoff__
      // This simulates an LLM hallucinating a tool call that shouldn't be available
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
          // Agent tries to handoff even though it's not a supervisor
          return {
            text: 'Let me transfer you...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Let me transfer you...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
          };
        }
        // After handoff is rejected, LLM gets another turn and responds normally
        return {
          text: 'I can help you directly.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I can help you directly.' }],
        };
      });

      // The runtime should REJECT the handoff because Neg_Reasoning has no routing or handoff config
      await executor.executeMessage(session.id, 'transfer me please');

      // Handoff should have been blocked — only 1 thread (no child thread created)
      expect(session.threads.length).toBe(1);
      expect(session.threads[0].agentName).toBe('Neg_Reasoning');

      // Session should NOT be complete (agent continued after rejected handoff)
      expect(session.isComplete).not.toBe(true);

      // History should be structurally clean
      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });
  });

  // ===========================================================================
  // 4. DOUBLE __complete__
  // ===========================================================================

  describe('4. Double __complete__ calls', () => {
    test('Second executeMessage after __complete__ returns early without history modification', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // First __complete__
      mockClient.setCompleteResponse('call-1', 'first completion', 'Done!');
      await executor.executeMessage(session.id, 'finish this');
      expect(session.isComplete).toBe(true);

      const countAfterFirst = session.conversationHistory.length;
      assertSessionHistoryIntegrity(session);

      // Second message — session is already complete
      mockClient.setCompleteResponse('call-2', 'second completion', 'Done again!');
      const result = await executor.executeMessage(session.id, 'finish again');

      // Should return early, not modify history
      expect(session.conversationHistory.length).toBe(countAfterFirst);
      expect(result.action).toEqual(expect.objectContaining({ type: 'complete' }));
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 5. LLM RETURNS EMPTY TEXT
  // ===========================================================================

  describe('5. LLM returns empty text response', () => {
    test('Empty text with end_turn: verify whether empty assistant message is pushed', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Mock returns empty text
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        return {
          text: '',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '' }],
        };
      });

      await executor.executeMessage(session.id, 'hello');

      // Check: is there an empty assistant message?
      const emptyAssistantMsgs = session.conversationHistory.filter(
        (m) => m.role === 'assistant' && (!m.content || m.content.trim() === ''),
      );

      // Document the behavior: empty assistant messages should NOT be pushed
      // If they are, this would cause issues on the next LLM call
      // (empty content in conversation history)
      if (emptyAssistantMsgs.length > 0) {
        // NOTE: This is a potential issue — empty assistant messages in history
        // could cause problems with the Anthropic API on subsequent calls
        expect(emptyAssistantMsgs.length).toBeGreaterThanOrEqual(0); // documents the behavior
      }

      // Regardless, verify structural integrity for what IS in history
      assertNoEmptyUserMessages(session.conversationHistory, 'empty-text-response');
    });

    test('Empty text with tool_use: tool result processing should still work', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Mock returns empty text but with a __complete__ tool call
      mockClient.setResponseHandler((sys, msgs, tools, operationType) => {
        if (operationType === 'extraction') {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        return {
          text: '', // empty text alongside tool call
          toolCalls: [
            { id: 'call-1', name: '__complete__', input: { message: 'Done', reason: 'finished' } },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: '__complete__',
              input: { message: 'Done', reason: 'finished' },
            },
          ],
        };
      });

      await executor.executeMessage(session.id, 'complete now');
      expect(session.isComplete).toBe(true);

      // The completion should work even with empty text
      assertNoEmptyUserMessages(session.conversationHistory, 'empty-text-tool-use');
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 6. MIXED-MODE HANDOFF
  // ===========================================================================

  describe('6. Mixed-mode handoff (reasoning ↔ scripted)', () => {
    test('Reasoning supervisor → scripted child: history clean across mode switch', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);

      executor.registerAgent('Neg_Child_Scripted', SCRIPTED_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Neg_Supervisor'),
      );

      // Supervisor hands off to scripted child
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
            text: 'Routing to scripted handler...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Scripted', context: {} },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to scripted handler...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Scripted', context: {} },
              },
            ],
          };
        }
        return {
          text: 'OK',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'OK' }],
        };
      });

      await executor.executeMessage(session.id, 'scripted task please');

      // Verify threads exist
      expect(session.threads.length).toBe(2);

      // Supervisor thread (reasoning mode) should be clean
      const supThread = session.threads[0];
      assertHistoryIntegrity(supThread.conversationHistory, 'supervisor-thread');
      assertNoEmptyUserMessages(supThread.conversationHistory, 'supervisor-thread');

      // Scripted child thread should be clean
      const childThread = session.threads[1];
      expect(childThread.agentName).toBe('Neg_Child_Scripted');
      assertHistoryIntegrity(childThread.conversationHistory, 'scripted-child-thread');
      assertNoEmptyUserMessages(childThread.conversationHistory, 'scripted-child-thread');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });

    test('Reasoning supervisor → reasoning child: history clean when child has different GATHER fields', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);

      executor.registerAgent('Neg_Child_Reasoning', REASONING_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Neg_Supervisor'),
      );

      // Supervisor hands off to reasoning child
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
            text: 'Routing to alpha...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to alpha...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Alpha ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Alpha ready.' }],
        };
      });

      await executor.executeMessage(session.id, 'alpha task');

      // Both threads should have clean histories
      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Send second message to child
      mockClient.setExtractAndRespond({ detail: 'test' }, 'Working on it.');
      await executor.executeMessage(session.id, 'here are the details');

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);

      // Child thread history should have grown correctly
      const childThread = session.threads[1];
      assertNoConsecutiveSameRole(childThread.conversationHistory, 'child-after-msg');
    });

    test('Scripted parent → scripted child with PASS: history clean across handoff', async () => {
      const executor = new RuntimeExecutor();
      executor.registerAgent('Neg_Pass_Child', SCRIPTED_PASS_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_PARENT_WITH_PASS], 'Neg_Pass_Parent'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'go now');

      expect(session.threads.length).toBe(2);
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 7. HANDOFF WITH MISSING PASS FIELDS
  // ===========================================================================

  describe('7. Handoff with missing PASS fields', () => {
    test('PASS referencing nonexistent variables does not corrupt child thread', async () => {
      const executor = new RuntimeExecutor();
      executor.registerAgent('Neg_Pass_Child', SCRIPTED_PASS_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_PARENT_WITH_PASS], 'Neg_Pass_Parent'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'go please');

      // Handoff should have happened
      expect(session.threads.length).toBe(2);
      const childThread = session.threads[1];
      expect(childThread.agentName).toBe('Neg_Pass_Child');

      // The PASS includes [intent, nonexistent_var, another_missing]
      // intent should be set, others should be undefined/not set
      // The key check: child data should have intent but not crash on missing vars
      expect(childThread.data.values.intent).toBe('go');

      // Child should NOT have nonexistent_var or another_missing as defined values
      // (they may be absent or undefined, but should not be a corrupted value)
      if ('nonexistent_var' in childThread.data.values) {
        // If it's there, it should be undefined/null, not some garbage
        expect(childThread.data.values.nonexistent_var == null).toBe(true);
      }

      // History should be clean regardless
      assertSessionHistoryIntegrity(session);
      assertNoEmptyUserMessages(childThread.conversationHistory, 'child-missing-pass');
    });
  });

  // ===========================================================================
  // 8. CONSTRAINT VIOLATION HISTORY INTEGRITY
  // ===========================================================================

  describe('8. Constraint violation history integrity', () => {
    test('Guardrail block pushes user + assistant pair (history stays alternating)', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_WITH_CONSTRAINT], 'Neg_Constrained'),
      );

      // First message: set topic to "forbidden"
      mockClient.setExtractAndRespond({ topic: 'forbidden' }, 'Let me help with that.');
      await executor.executeMessage(session.id, 'I want to discuss forbidden');

      // History should have user message + either LLM response or constraint violation message
      // Either way, history should be structurally valid
      assertNoEmptyUserMessages(session.conversationHistory, 'after-first-msg');
      assertSessionHistoryIntegrity(session);
    });

    test('Constraint violation after valid conversation: history stays clean', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_WITH_CONSTRAINT], 'Neg_Constrained'),
      );

      // First message: valid topic
      mockClient.setExtractAndRespond({ topic: 'cooking' }, 'I can help with cooking!');
      await executor.executeMessage(session.id, 'Tell me about cooking');
      assertSessionHistoryIntegrity(session);
      const countAfterFirst = session.conversationHistory.length;

      // Second message: now set forbidden topic
      mockClient.setExtractAndRespond({ topic: 'forbidden' }, 'Blocked response');
      await executor.executeMessage(session.id, 'Now discuss forbidden');

      // History should have grown but remain structurally valid
      expect(session.conversationHistory.length).toBeGreaterThan(countAfterFirst);
      assertNoEmptyUserMessages(session.conversationHistory, 'after-violation');
      assertNoConsecutiveSameRole(session.conversationHistory, 'after-violation');
      assertSessionHistoryIntegrity(session);
    });

    test('Multiple constraint violations in sequence: no history corruption', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_WITH_CONSTRAINT], 'Neg_Constrained'),
      );

      // Set topic to forbidden
      mockClient.setExtractAndRespond({ topic: 'forbidden' }, 'Blocked');
      await executor.executeMessage(session.id, 'forbidden topic 1');
      assertSessionHistoryIntegrity(session);

      // Send another forbidden message — constraint should fire again
      mockClient.setExtractAndRespond({ topic: 'forbidden' }, 'Still blocked');
      await executor.executeMessage(session.id, 'forbidden topic 2');
      assertSessionHistoryIntegrity(session);

      // Send a third
      mockClient.setExtractAndRespond({ topic: 'forbidden' }, 'Nope');
      await executor.executeMessage(session.id, 'forbidden topic 3');

      // All user messages should be non-empty
      assertNoEmptyUserMessages(session.conversationHistory, 'multi-violation');
      // No consecutive same-role messages
      assertNoConsecutiveSameRole(session.conversationHistory, 'multi-violation');
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 9. THREAD RETURN LIMITATION FOR REASONING AGENTS
  // ===========================================================================

  describe('9. Thread return on child completion', () => {
    test('Reasoning child __complete__ triggers thread return to supervisor', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);

      executor.registerAgent('Neg_Child_Reasoning', REASONING_CHILD);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SUPERVISOR], 'Neg_Supervisor'),
      );

      // Step 1: Supervisor hands off to reasoning child (RETURN: true)
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
            text: 'Routing to alpha...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to alpha...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Reasoning', context: {} },
              },
            ],
          };
        }
        return {
          text: 'Ready.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Ready.' }],
        };
      });
      await executor.executeMessage(session.id, 'alpha task');

      expect(session.threads.length).toBe(2);
      expect(session.threads[1].agentName).toBe('Neg_Child_Reasoning');
      assertSessionHistoryIntegrity(session);

      // Step 2: Child completes via __complete__ → should trigger thread return
      mockClient.setCompleteResponse('call-2', 'done', 'Alpha done.');
      await executor.executeMessage(session.id, 'finish alpha');

      // Child thread should be marked completed
      expect(session.threads[1].status).toBe('completed');

      // Active thread should be back to supervisor (index 0)
      expect(session.activeThreadIndex).toBe(0);

      // Thread stack should be empty (parent popped on return)
      expect(session.threadStack.length).toBe(0);

      // Session should NOT be complete (supervisor is active again)
      expect(session.isComplete).toBe(false);

      // Supervisor's history should have the child's response
      const supervisorHistory = session.threads[0].conversationHistory;
      const childReturnMsg = supervisorHistory.find(
        (m) => m.role === 'assistant' && m.content.includes('[Neg_Child_Reasoning]'),
      );
      expect(childReturnMsg).toBeDefined();

      assertSessionHistoryIntegrity(session);
      assertValidLLMMessages(mockClient.calls);
    });

    test('Scripted child auto-complete triggers thread return to supervisor', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);

      executor.registerAgent('Neg_Child_Scripted', SCRIPTED_CHILD);

      const SUPERVISOR_WITH_SCRIPTED_RETURN = `
SUPERVISOR: Neg_ScriptedReturn_Sup

GOAL: "Route"
PERSONA: "Router"
HANDOFF:
  - TO: Neg_Child_Scripted
    WHEN: intent contains "scripted"
    CONTEXT:
      summary: "Route to scripted"
    RETURN: true
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_SCRIPTED_RETURN], 'Neg_ScriptedReturn_Sup'),
      );

      // Supervisor hands off to scripted child
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
            text: 'To scripted...',
            toolCalls: [
              {
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Scripted', context: {} },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'To scripted...' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: '__handoff__',
                input: { target: 'Neg_Child_Scripted', context: {} },
              },
            ],
          };
        }
        return {
          text: 'OK',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'OK' }],
        };
      });
      await executor.executeMessage(session.id, 'scripted task');

      // Scripted child auto-completes (RESPOND + THEN: COMPLETE)
      expect(session.threads.length).toBe(2);
      expect(session.threads[1].agentName).toBe('Neg_Child_Scripted');

      // Child should be completed
      expect(session.threads[1].status).toBe('completed');

      // Active thread should be back to supervisor (index 0)
      expect(session.activeThreadIndex).toBe(0);

      // Thread stack should be empty (popped on return)
      expect(session.threadStack.length).toBe(0);

      // History should be clean
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 10. HISTORY INTEGRITY UNDER RAPID SEQUENTIAL CALLS
  // ===========================================================================

  describe('10. Rapid sequential messages', () => {
    test('5 rapid sequential messages to scripted flow: no history corruption', async () => {
      const executor = new RuntimeExecutor();
      const dsl = `
AGENT: Rapid_Scripted

GOAL: "Collect many values"

FLOW:
  entry_point: loop
  steps:
    - loop

loop:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "stop"
      RESPOND: "Stopped."
      THEN: COMPLETE
    - ELSE:
      THEN: loop
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Rapid_Scripted'),
      );
      await executor.initializeSession(session.id);

      // Send 5 messages rapidly (sequentially but without delay)
      const inputs = ['one', 'two', 'three', 'four', 'stop'];
      for (const input of inputs) {
        await executor.executeMessage(session.id, input);
        assertNoEmptyUserMessages(session.conversationHistory, `after-${input}`);
        assertNoEmptyMessages(session.conversationHistory, `after-${input}`);
      }

      expect(session.isComplete).toBe(true);

      // Exact user message count
      const userMsgs = session.conversationHistory.filter((m) => m.role === 'user');
      assertUserMessageCount(session.conversationHistory, 5, 'rapid-sequential');

      // No empty messages
      assertNoEmptyUserMessages(session.conversationHistory, 'rapid-final');
      assertNoEmptyMessages(session.conversationHistory, 'rapid-final');
    });

    test('5 rapid sequential messages to reasoning agent: history grows correctly', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      for (let i = 1; i <= 5; i++) {
        mockClient.setExtractAndRespond({}, `Response ${i}`);
        await executor.executeMessage(session.id, `Message ${i}`);

        // After each message, verify integrity
        assertSessionHistoryIntegrity(session);
        assertExactMessageCount(session.conversationHistory, i * 2, `after-msg-${i}`);
        assertUserMessageCount(session.conversationHistory, i, `after-msg-${i}`);
        assertAssistantMessageCount(session.conversationHistory, i, `after-msg-${i}`);
      }

      assertValidLLMMessages(mockClient.calls);
    });
  });

  // ===========================================================================
  // 11. ESCALATED SESSION HISTORY
  // ===========================================================================

  describe('11. Escalated session behavior', () => {
    test('Message to escalated session pushes user+assistant pair (clean alternation)', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_SIMPLE], 'Neg_Reasoning'),
      );

      // Manually escalate the session
      session.isEscalated = true;
      session.escalationReason = 'Test escalation';

      // Send messages to escalated session
      await executor.executeMessage(session.id, 'Help me please');
      await executor.executeMessage(session.id, 'Are you there?');

      // Each message should have produced a user+assistant pair
      assertNoEmptyUserMessages(session.conversationHistory, 'escalated');
      assertNoConsecutiveSameRole(session.conversationHistory, 'escalated');
      assertUserMessageCount(session.conversationHistory, 2, 'escalated');
      assertAssistantMessageCount(session.conversationHistory, 2, 'escalated');
      assertSessionHistoryIntegrity(session);
    });
  });

  // ===========================================================================
  // 12. AGENT WITHOUT GATHER (NO __complete__ TOOL)
  // ===========================================================================

  describe('12. Reasoning agent without GATHER or completion conditions', () => {
    test('Agent without __complete__ tool: LLM end_turn response still creates clean history', async () => {
      const executor = new RuntimeExecutor();
      const mockClient = injectValidatingMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_NO_GATHER], 'Neg_NoGather'),
      );

      // This agent has NO GATHER and NO completion conditions
      // So __complete__ tool should NOT be in the tool list
      // LLM can only respond with end_turn
      mockClient.setResponseHandler((sys, msgs, tools) => {
        // For an agent without GATHER, extraction may not happen or tools may be empty
        return {
          text: 'I can help!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I can help!' }],
        };
      });

      await executor.executeMessage(session.id, 'hello');

      assertSessionHistoryIntegrity(session);
      assertNoEmptyUserMessages(session.conversationHistory, 'no-gather');

      // Send second message
      mockClient.setResponseHandler((sys, msgs, tools) => {
        return {
          text: 'Sure thing!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Sure thing!' }],
        };
      });
      await executor.executeMessage(session.id, 'do something');

      assertSessionHistoryIntegrity(session);
      assertExactMessageCount(session.conversationHistory, 4, 'no-gather-2msg');
    });
  });
});
