/**
 * Conversation History Window Tests — M14 Phase 1
 *
 * Verifies that extractEntitiesWithLLM() injects prior conversation history
 * into the system prompt (not the messages array) for the Tier 3 LLM call,
 * enabling coreference resolution for referential user utterances
 * ("the middle one", "same account", "the person I mentioned").
 *
 * Test coverage:
 *
 *  formatConversationContext() unit tests (via extractEntitiesWithLLM)
 *  ├── window = 0  → no context in system prompt, single message (legacy behaviour)
 *  ├── window = 1  → last 1 prior turn in system prompt
 *  ├── window = 2  → last 2 prior turns in system prompt (default)
 *  ├── window > available history → graceful truncation to available turns
 *  ├── window > MAX_CONVERSATION_HISTORY_WINDOW → hard-capped at 10
 *  ├── duplicate trailing user turn stripped (runtime-executor pre-appends it)
 *  ├── multimodal ContentBlock[] messages skipped (string-only)
 *  └── correction handler: correctionValue ≠ raw history entry → no strip
 *
 *  extractEntitiesWithLLM() integration tests
 *  ├── default window (2) includes context in system prompt, 1 message
 *  ├── window = 0 sends exactly 1 message, no context in system prompt
 *  ├── agent-configured window overrides default
 *  ├── llm_call trace event records single message + context in systemPrompt
 *  ├── Category 1: "the middle one" resolved via prior assistant options list
 *  ├── Category 2: "the person I just mentioned" resolved via prior user turn
 *  ├── Category 3: "the option you described" resolved via prior assistant turn
 *  └── hybrid/autonomous pre-loop extraction inherits window from agentIR
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RuntimeSession, ExecutorContext } from '../services/execution/types.js';
import type { RoutingExecutor } from '../services/execution/routing-executor.js';
import { FlowStepExecutor } from '../services/execution/flow-step-executor.js';

// =============================================================================
// Test helpers
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
    currentFlowStep: 'collect_info',
    llmClient: null,
    ...overrides,
  } as RuntimeSession;
}

/**
 * Build a conversation history for tests.
 * Alternates user/assistant messages starting with user unless the first
 * element has an explicit role.
 */
function buildHistory(
  ...turns: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: string; content: string }> {
  return turns;
}

function createMockLLMClient(toolCallInput: Record<string, unknown>) {
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-1', name: '_extract_entities', input: toolCallInput }],
      stopReason: 'tool_use',
      rawContent: [],
      usage: { inputTokens: 20, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    }),
  };
}

function createFlowStepExecutor(): FlowStepExecutor {
  const mockCtx = {} as ExecutorContext;
  const mockRouting = {} as RoutingExecutor;
  return new FlowStepExecutor(mockCtx, mockRouting);
}

/**
 * Extract the messages array sent to chatWithToolUse from a spy call.
 * The messages array is always the second argument (index 1).
 */
function capturedMessages(
  spy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Array<{ role: string; content: string }> {
  return spy.mock.calls[callIndex][1] as Array<{ role: string; content: string }>;
}

/**
 * Extract the system prompt string sent to chatWithToolUse from a spy call.
 * The system prompt is always the first argument (index 0).
 */
function capturedSystemPrompt(spy: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return spy.mock.calls[callIndex][0] as string;
}

// =============================================================================
// Unit tests — formatConversationContext behaviour via extractEntitiesWithLLM
//
// We test formatConversationContext() indirectly through extractEntitiesWithLLM()
// by inspecting the system prompt and messages captured by the mock LLM client.
// All tests assert messages is always a single-element array [{role:'user', content}].
// =============================================================================

describe('conversation history window — context in system prompt', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  // ── window = 0 ────────────────────────────────────────────────────────────

  test('window=0 sends exactly one message, no context in system prompt (legacy behaviour)', async () => {
    const llmClient = createMockLLMClient({ account: '8802' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 0 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'I want to transfer money' },
        { role: 'assistant', content: 'Which account?' },
        { role: 'user', content: 'the savings one' },
      ),
    });

    await executor.extractEntitiesWithLLM('the savings one', ['account'], session, undefined, [
      { name: 'account', type: 'string', prompt: 'Account number' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the savings one' });

    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).not.toContain('PRIOR CONVERSATION');
  });

  // ── negative window ───────────────────────────────────────────────────────

  test('negative window value sends exactly one message (treated as 0)', async () => {
    const llmClient = createMockLLMClient({ account: 'savings' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: -1 } } as any,
      conversationHistory: buildHistory(
        { role: 'assistant', content: 'Which account?' },
        { role: 'user', content: 'the savings one' },
      ),
    });

    await executor.extractEntitiesWithLLM('the savings one', ['account'], session, undefined, [
      { name: 'account', type: 'string', prompt: 'Account' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the savings one' });

    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).not.toContain('PRIOR CONVERSATION');
  });

  // ── default window (2) ────────────────────────────────────────────────────

  test('default window includes last 2 prior turns in system prompt, sends 1 message', async () => {
    const llmClient = createMockLLMClient({ account: 'savings' });
    const session = createMockSession({
      llmClient: llmClient as any,
      // agentIR.execution.conversation_history_window not set → uses DEFAULT (2)
      agentIR: null,
      conversationHistory: buildHistory(
        { role: 'user', content: 'I want to transfer money' },
        { role: 'assistant', content: 'I have savings ×8802 and checking ×4521. Which?' },
        { role: 'user', content: 'the savings one' }, // ← last entry = current user message
      ),
    });

    await executor.extractEntitiesWithLLM('the savings one', ['account'], session, undefined, [
      { name: 'account', type: 'string', prompt: 'Account' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    // Only the current user message as a message
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the savings one' });

    // Prior conversation context is in the system prompt
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
    expect(sysPrompt).toContain('User: I want to transfer money');
    expect(sysPrompt).toContain('Assistant: I have savings ×8802 and checking ×4521. Which?');
  });

  // ── agent-configured window ───────────────────────────────────────────────

  test('agent-configured window=1 includes only last 1 prior turn in system prompt', async () => {
    const llmClient = createMockLLMClient({ option: '18-month' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 1 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'What CDs do you have?' },
        { role: 'assistant', content: '12-month at 4.1%, 18-month at 4.45%, 24-month at 4.6%' },
        { role: 'user', content: 'the middle one' }, // ← current
      ),
    });

    await executor.extractEntitiesWithLLM('the middle one', ['option'], session, undefined, [
      { name: 'option', type: 'string', prompt: 'CD term' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the middle one' });

    // window=1 → only the assistant turn (last 1 prior)
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
    expect(sysPrompt).toContain('18-month');
    // The earlier user turn should NOT be in context (window=1)
    expect(sysPrompt).not.toContain('What CDs do you have?');
  });

  test('agent-configured window=4 includes up to 4 prior turns in system prompt', async () => {
    const llmClient = createMockLLMClient({ city: 'Boston' });
    const history = buildHistory(
      { role: 'user', content: 'I live in Boston' },
      { role: 'assistant', content: 'Got it, Boston.' },
      { role: 'user', content: 'Opening an account' },
      { role: 'assistant', content: 'What is your employer city?' },
      { role: 'user', content: 'same city' }, // ← current
    );
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 4 } } as any,
      conversationHistory: history,
    });

    await executor.extractEntitiesWithLLM('same city', ['city'], session, undefined, [
      { name: 'city', type: 'string', prompt: 'Employer city' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'same city' });

    // All 4 prior turns should be in the system prompt
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('User: I live in Boston');
    expect(sysPrompt).toContain('Assistant: Got it, Boston.');
    expect(sysPrompt).toContain('User: Opening an account');
    expect(sysPrompt).toContain('Assistant: What is your employer city?');
  });

  // ── history smaller than window ───────────────────────────────────────────

  test('gracefully handles history shorter than the window', async () => {
    const llmClient = createMockLLMClient({ name: 'Alice' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 6 } } as any,
      conversationHistory: buildHistory(
        { role: 'assistant', content: 'What is your name?' },
        { role: 'user', content: 'Alice' }, // ← current (only 2 messages total)
      ),
    });

    await executor.extractEntitiesWithLLM('Alice', ['name'], session, undefined, [
      { name: 'name', type: 'string', prompt: 'Name' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Alice' });

    // Only 1 prior turn available despite window=6
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
    expect(sysPrompt).toContain('Assistant: What is your name?');
  });

  test('empty history sends only the current user message, no context in prompt', async () => {
    const llmClient = createMockLLMClient({ name: 'Bob' });
    const session = createMockSession({
      llmClient: llmClient as any,
      conversationHistory: [],
    });

    await executor.extractEntitiesWithLLM('My name is Bob', ['name'], session, undefined, [
      { name: 'name', type: 'string', prompt: 'Name' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'My name is Bob' });

    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).not.toContain('PRIOR CONVERSATION');
  });

  test('empty history with large configured window still sends only one message', async () => {
    const llmClient = createMockLLMClient({ intent: 'open account' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 8 } } as any,
      conversationHistory: [],
    });

    await executor.extractEntitiesWithLLM(
      'I want to open an account',
      ['intent'],
      session,
      undefined,
      [{ name: 'intent', type: 'string', prompt: 'Intent' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'I want to open an account' });
    expect(msgs[0].content).toBeTruthy();

    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).not.toContain('PRIOR CONVERSATION');
  });

  // ── MAX_CONVERSATION_HISTORY_WINDOW hard cap ──────────────────────────────

  test('window larger than 10 is capped at MAX_CONVERSATION_HISTORY_WINDOW=10', async () => {
    const llmClient = createMockLLMClient({ topic: 'home loan' });

    // Build 15 prior turns + 1 current = 16 messages total
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 15; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
    }
    history.push({ role: 'user', content: 'current message' }); // current

    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 99 } } as any, // above cap
      conversationHistory: history,
    });

    await executor.extractEntitiesWithLLM('current message', ['topic'], session, undefined, [
      { name: 'topic', type: 'string', prompt: 'Topic' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    // Always single message
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'current message' });

    // System prompt should contain at most 10 prior turns (capped)
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
    // turn 14 (the last prior) should be present
    expect(sysPrompt).toContain('turn 14');
    // turn 5 (index 5 of 15 prior turns, within last 10) should be present
    expect(sysPrompt).toContain('turn 5');
    // turn 4 (index 4, outside the last 10 prior turns) should NOT be present
    // Prior turns are 0..14 (15 items). Last 10 = turns 5..14.
    expect(sysPrompt).not.toContain('turn 4');
  });

  // ── duplicate trailing user turn stripping ────────────────────────────────

  test('does not duplicate current userMessage when already the last history entry', async () => {
    const llmClient = createMockLLMClient({ account: 'savings' });
    const session = createMockSession({
      llmClient: llmClient as any,
      conversationHistory: buildHistory(
        { role: 'assistant', content: 'Which account do you want?' },
        { role: 'user', content: 'the savings one' }, // ← runtime-executor pre-appended this
      ),
    });

    await executor.extractEntitiesWithLLM(
      'the savings one', // same string as the last history entry
      ['account'],
      session,
      undefined,
      [{ name: 'account', type: 'string', prompt: 'Account' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the savings one' });

    // The prior assistant turn should be in system prompt context
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('Assistant: Which account do you want?');
    // The current user message should NOT appear in the prior conversation context
    // (it was stripped as duplicate)
    expect(sysPrompt).not.toContain('User: the savings one');
  });

  // ── correction handler: different processed value ─────────────────────────

  test('correction handler: correctionValue differs from history — not stripped from context', async () => {
    const llmClient = createMockLLMClient({ account_type: 'joint' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 2 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'Open a checking account' },
        { role: 'assistant', content: 'Noted, checking account.' },
        { role: 'user', content: 'actually use the joint account' }, // raw user input in history
      ),
    });

    // correctionNewValue is a different (shorter) string from the raw input
    await executor.extractEntitiesWithLLM('joint account', ['account_type'], session, undefined, [
      { name: 'account_type', type: 'string', prompt: 'Account type' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    // The message is the correctionNewValue
    expect(msgs[0]).toEqual({ role: 'user', content: 'joint account' });

    // The raw history entry should appear in system prompt context
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('actually use the joint account');
  });

  // ── multimodal content skipping ───────────────────────────────────────────

  test('skips ContentBlock[] (multimodal) history entries — string messages only', async () => {
    const llmClient = createMockLLMClient({ account_type: 'savings' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 4 } } as any,
      conversationHistory: [
        { role: 'user', content: 'I need to open an account' }, // string — included
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'What type of account?' }], // ContentBlock[] — skipped
        },
        { role: 'user', content: 'the savings kind' }, // string — current (stripped then re-appended)
      ],
    });

    await executor.extractEntitiesWithLLM(
      'the savings kind',
      ['account_type'],
      session,
      undefined,
      [{ name: 'account_type', type: 'string', prompt: 'Account type' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the savings kind' });

    // System prompt should include the string user message but not the multimodal one
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('User: I need to open an account');
    // The assistant ContentBlock message should not appear
    expect(sysPrompt).not.toContain('What type of account?');
  });

  // ── current user message always last ─────────────────────────────────────

  test('current userMessage is always the last message regardless of history order', async () => {
    const llmClient = createMockLLMClient({ preference: 'balanced' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 3 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'Tell me about investment options' },
        { role: 'assistant', content: 'We have growth, balanced, and income portfolios.' },
        { role: 'user', content: 'the balanced option you described' },
      ),
    });

    await executor.extractEntitiesWithLLM(
      'the balanced option you described',
      ['preference'],
      session,
      undefined,
      [{ name: 'preference', type: 'string', prompt: 'Investment preference' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('the balanced option you described');
  });
});

// =============================================================================
// Integration tests — coreference resolution via history context
//
// These tests verify that the system prompt receives the history context needed
// to resolve the three M14 coreference failure categories.
// =============================================================================

describe('conversation history window — M14 coreference categories', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  test('Category 1: agent-presented list — system prompt receives the options in context', async () => {
    const llmClient = createMockLLMClient({ cd_term: '18-month' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 2 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'What CD rates do you have?' },
        {
          role: 'assistant',
          content: '1. 12-month at 4.1%\n2. 18-month at 4.45%\n3. 24-month at 4.6%',
        },
        { role: 'user', content: 'the middle one' },
      ),
    });

    await executor.extractEntitiesWithLLM('the middle one', ['cd_term'], session, undefined, [
      { name: 'cd_term', type: 'string', prompt: 'CD term' },
    ]);

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the middle one' });

    // The options list must be in the system prompt context
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
    expect(sysPrompt).toContain('18-month');
    expect(sysPrompt).toContain('12-month');
  });

  test('Category 2: prior user statement — system prompt receives the user-stated context', async () => {
    const llmClient = createMockLLMClient({ beneficiary: 'James Wilson' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 4 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'I need to send money to James Wilson at First Republic Bank' },
        { role: 'assistant', content: 'How much would you like to send?' },
        { role: 'user', content: '$2500' },
        { role: 'assistant', content: 'What is the beneficiary name for the wire transfer?' },
        { role: 'user', content: 'the person I just mentioned' },
      ),
    });

    await executor.extractEntitiesWithLLM(
      'the person I just mentioned',
      ['beneficiary'],
      session,
      undefined,
      [{ name: 'beneficiary', type: 'string', prompt: 'Beneficiary name' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the person I just mentioned' });

    // The turn where the user mentioned James Wilson must be in system prompt
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('James Wilson');
  });

  test('Category 3: dialogue flow reference — system prompt receives the referenced explanation', async () => {
    const llmClient = createMockLLMClient({ investment_preference: 'balanced' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 2 } } as any,
      conversationHistory: buildHistory(
        { role: 'user', content: 'What investment options do you have?' },
        {
          role: 'assistant',
          content:
            'We offer growth (higher risk), balanced (moderate risk), and income (lower risk).',
        },
        { role: 'user', content: 'the balanced option you described' },
      ),
    });

    await executor.extractEntitiesWithLLM(
      'the balanced option you described',
      ['investment_preference'],
      session,
      undefined,
      [{ name: 'investment_preference', type: 'string', prompt: 'Investment preference' }],
    );

    const msgs = capturedMessages(llmClient.chatWithToolUse);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: 'the balanced option you described',
    });

    // The assistant explanation containing "balanced" must be in system prompt
    const sysPrompt = capturedSystemPrompt(llmClient.chatWithToolUse);
    expect(sysPrompt).toContain('balanced');
    expect(sysPrompt).toContain('PRIOR CONVERSATION');
  });

  // ── llm_call trace event reflects actual messages ─────────────────────────

  test('llm_call trace event records single message + context in systemPrompt', async () => {
    const llmClient = createMockLLMClient({ account: 'savings' });
    const session = createMockSession({
      llmClient: llmClient as any,
      agentIR: { execution: { conversation_history_window: 2 } } as any,
      conversationHistory: buildHistory(
        { role: 'assistant', content: 'Savings ×8802 or Checking ×4521. Which?' },
        { role: 'user', content: 'the savings one' },
      ),
    });

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.extractEntitiesWithLLM(
      'the savings one',
      ['account'],
      session,
      (e) => traces.push(e),
      [{ name: 'account', type: 'string', prompt: 'Account' }],
    );

    const llmCallTrace = traces.find((t) => t.type === 'llm_call');
    expect(llmCallTrace).toBeDefined();

    // Messages should be a single-element array
    const tracedMessages = llmCallTrace!.data.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(tracedMessages).toHaveLength(1);
    expect(tracedMessages[0]).toEqual({ role: 'user', content: 'the savings one' });

    // Context should be in the systemPrompt
    const tracedSystemPrompt = llmCallTrace!.data.systemPrompt as string;
    expect(tracedSystemPrompt).toContain('PRIOR CONVERSATION');
    expect(tracedSystemPrompt).toContain('Savings ×8802');
  });

  // ── window respects no-LLM path ───────────────────────────────────────────

  test('no-LLM path (no llmClient) still returns regex results unaffected', async () => {
    const session = createMockSession({
      llmClient: null, // no LLM
      conversationHistory: buildHistory(
        { role: 'assistant', content: 'What is your phone number?' },
        { role: 'user', content: '+1 415-555-1234' },
      ),
    });

    const result = await executor.extractEntitiesWithLLM(
      '+1 415-555-1234',
      ['phone'],
      session,
      undefined,
      [{ name: 'phone', type: 'phone', prompt: 'Phone' }],
    );

    // Result should still work; no crash from history window code
    expect(result).toBeDefined();
  });
});
