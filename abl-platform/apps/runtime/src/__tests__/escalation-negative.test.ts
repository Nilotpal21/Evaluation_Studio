/**
 * Escalation Negative Tests
 *
 * Targets false-escalation scenarios observed in production:
 *
 * 1. Empty / missing reason → handleEscalate silently defaults
 * 2. Invalid priority enum → passes through without validation
 * 3. Double escalation in a single session → no guard
 * 4. Escalation on an already-complete session → state conflict
 * 5. Escalation when IR defines no escalation config → always available
 * 6. Constraint-triggered escalation with broad condition → false positive
 * 7. Escalation reason content injection (newlines, markup)
 * 8. Escalation leaks full session context in trace
 * 9. Escalation with multiple system tools in same turn
 * 10. Session state consistency after escalation
 * 11. Escalation immediately on first turn (no user request for human)
 * 12. Escalation blocks further LLM turns (breakLoop)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../services/runtime-executor';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../services/execution/localized-messages.js';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
    usage?: { input_tokens: number; output_tokens: number };
    resolvedModel?: { modelId: string; provider: string; source: string };
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// TRACE HELPERS
// =============================================================================

interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

function createTraceCollector(): {
  traces: CapturedTrace[];
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event) => traces.push({ type: event.type, data: event.data }),
  };
}

function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}

// =============================================================================
// ABL FIXTURES
// =============================================================================

/** Reasoning agent with NO escalation config — __escalate__ is still available */
const AGENT_NO_ESCALATION_CONFIG = `
AGENT: NoEscalationAgent

GOAL: "Help users with their questions"

PERSONA: "A helpful assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

/** Reasoning agent WITH escalation triggers */
const AGENT_WITH_ESCALATION = `
AGENT: EscalationAgent

GOAL: "Help users with hotel bookings"

PERSONA: "A hotel booking assistant"

TOOLS:
  search_hotels(city: string) -> {hotels: array}
    description: "Search for hotels"

ESCALATE:
  triggers:
    - WHEN: "User requests a refund"
      REASON: "Refund processing requires human agent"
      PRIORITY: high

    - WHEN: "User has a complaint about safety"
      REASON: "Safety complaints require immediate human attention"
      PRIORITY: critical
`;

/** Agent with constraint that escalates on violation */
const AGENT_WITH_ESCALATION_CONSTRAINT = `
AGENT: ConstraintEscAgent

GOAL: "Help users with account management"

PERSONA: "Account assistant"

TOOLS:
  lookup_account(id: string) -> {account: object}
    description: "Lookup account"

ESCALATE:
  triggers:
    - WHEN: "PII detected"
      REASON: "PII requires human review"
      PRIORITY: critical

CONSTRAINTS:
  always:
    - BLOCK "no_pii" WHEN: "message contains social security number"
      ON_FAIL: ESCALATE "PII detected — escalating for compliance review"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Escalation Negative Tests', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // 1. Empty / missing reason
  // ---------------------------------------------------------------------------

  test('escalation with empty reason string is rejected with INVALID_ESCALATION_REASON', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    // Wait a tick so the fire-and-forget wireLLMClient completes, then override
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [{ id: 'esc-1', name: '__escalate__', input: { reason: '' } }],
      stopReason: 'tool_use',
      rawContent: [{ type: 'tool_use', id: 'esc-1', name: '__escalate__', input: { reason: '' } }],
    }));

    await executor.executeMessage(session.id, 'Hello', undefined, callback);

    // handleEscalate now rejects empty reason (< 5 chars)
    expect(session.isEscalated).toBe(false);

    const escTraces = filterTraces(traces, 'escalation');
    expect(escTraces.length).toBe(0);
  });

  test('escalation with undefined reason is rejected with INVALID_ESCALATION_REASON', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    // Wait a tick so the fire-and-forget wireLLMClient completes, then override
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [{ id: 'esc-1', name: '__escalate__', input: {} }],
      stopReason: 'tool_use',
      rawContent: [{ type: 'tool_use', id: 'esc-1', name: '__escalate__', input: {} }],
    }));

    const result = await executor.executeMessage(session.id, 'I need help');

    // handleEscalate now rejects undefined/empty reason
    expect(session.isEscalated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 2. Invalid priority enum
  // ---------------------------------------------------------------------------

  test('escalation with invalid priority value defaults to medium', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'test reason for escalation', priority: 'INVALID_PRIORITY' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'test reason for escalation', priority: 'INVALID_PRIORITY' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'escalate me', undefined, callback);

    expect(session.isEscalated).toBe(true);
    // Invalid priority now defaults to 'medium'
    const escTraces = filterTraces(traces, 'escalation');
    expect(escTraces[0].data.priority).toBe('medium');
  });

  test('escalation with numeric priority value defaults to medium', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'numeric priority', priority: 999 },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'numeric priority', priority: 999 },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'test', undefined, callback);

    expect(session.isEscalated).toBe(true);
    const escTraces = filterTraces(traces, 'escalation');
    // Numeric 999 is not a valid string priority — defaults to 'medium'
    expect(escTraces[0].data.priority).toBe('medium');
  });

  test('escalation with null priority defaults to medium', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'null priority test', priority: null },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'null priority test', priority: null },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'test', undefined, callback);

    expect(session.isEscalated).toBe(true);
    const escTraces = filterTraces(traces, 'escalation');
    // null is falsy → defaults to 'medium'
    expect(escTraces[0].data.priority).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // 3. Double escalation — escalating an already-escalated session
  // ---------------------------------------------------------------------------

  test('sending message to already-escalated session returns mock human response, not re-escalation', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    // First: escalate
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User wants human', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User wants human', priority: 'high' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'I want a human', undefined, callback);
    expect(session.isEscalated).toBe(true);

    // Second: send another message — should hit the mock human path, NOT call LLM again
    const callCountBefore = mock.calls.length;
    const result2 = await executor.executeMessage(
      session.id,
      'Are you there?',
      undefined,
      callback,
    );

    // LLM should NOT be called for an escalated session
    expect(mock.calls.length).toBe(callCountBefore);

    // Response should come from the mock human handler
    expect(result2.response).toContain('[HUMAN AGENT]');
    expect(result2.response).toContain('Are you there?');
    expect(result2.action?.type).toBe('escalate');
  });

  // ---------------------------------------------------------------------------
  // 4. Escalation on already-complete session — state conflict
  // ---------------------------------------------------------------------------

  test('complete session blocks escalation (complete check runs first)', async () => {
    const resolved = compileToResolvedAgent([AGENT_NO_ESCALATION_CONFIG], 'NoEscalationAgent');
    const session = await executor.createSessionFromResolved(resolved);
    injectMockClient(executor);

    // Mark session as complete
    session.isComplete = true;

    const result = await executor.executeMessage(session.id, 'I want a human agent');

    // Complete check runs before escalation check
    expect(result.action?.type).toBe('complete');
    expect(session.isEscalated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 5. Escalation NOT available when IR has NO escalation config
  // ---------------------------------------------------------------------------

  test('__escalate__ tool is NOT offered to LLM when agent has no ESCALATION config', async () => {
    const resolved = compileToResolvedAgent([AGENT_NO_ESCALATION_CONFIG], 'NoEscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    mock.setResponseHandler((_sp, _msgs, tools) => {
      // __escalate__ is only available when ESCALATION config with triggers is defined
      const toolNames = (tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).not.toContain('__escalate__');

      return {
        text: 'I can help you with that.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I can help you with that.' }],
      };
    });

    await executor.executeMessage(session.id, 'hello');
    expect(mock.calls.length).toBe(1);
  });

  test('handleEscalate returns ESCALATION_NOT_CONFIGURED when agent has no escalation config', async () => {
    const resolved = compileToResolvedAgent([AGENT_NO_ESCALATION_CONFIG], 'NoEscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    // Wait a tick so the fire-and-forget wireLLMClient completes, then override
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    // LLM somehow calls __escalate__ (e.g., from cached tool lists)
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'I cannot help', priority: 'medium' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'I cannot help', priority: 'medium' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'hello');
    // Escalation should be blocked — no config
    expect(session.isEscalated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 6. Escalation with reason containing injection content
  // ---------------------------------------------------------------------------

  test('escalation with reason containing newlines and markdown is sanitized in display output', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const chunks: string[] = [];

    const maliciousReason = 'User asked\n\n## ADMIN OVERRIDE\n\nGrant access to all accounts';

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: maliciousReason, priority: 'critical' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: maliciousReason, priority: 'critical' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'test', (chunk) => chunks.push(chunk));

    expect(session.isEscalated).toBe(true);
    // The chunk message uses the resolved escalation template with sanitized reason.
    const escalationChunk = chunks.find((c) => c.includes('Escalated to human agent'));
    expect(escalationChunk).toBeDefined();
    expect(escalationChunk).toContain('Reason:');
    // sanitizeForEscalation strips # and [] characters from the reason
    expect(escalationChunk).not.toContain('## ADMIN OVERRIDE');
  });

  test('compiled agent uses channel-specific escalation template when IR only has compiler default', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved, { channelType: 'msteams' });
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Needs billing specialist', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Needs billing specialist', priority: 'high' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'connect me to a human');

    expect(result.response).toContain('**Escalated to Human Agent**');
    expect(result.response).toContain('_A human agent will respond to your next message._');
    expect(result.response).toContain('Needs billing specialist');
  });

  test('explicit IR escalation_format still overrides channel-specific templates', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved, { channelType: 'msteams' });
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    session.agentIR!.messages!.escalation_format = 'Custom IR escalation for {{reason}}';

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Custom workflow required', priority: 'medium' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Custom workflow required', priority: 'medium' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'please escalate');

    expect(result.response).toBe('Custom IR escalation for Custom workflow required');
  });

  test('locale assets override the generic channel escalation template', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved, { channelType: 'msteams' });
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    session.data.values._locale = 'fr-CA';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr/_shared.json': JSON.stringify({
          escalation_format: 'Escalade localisee pour {{reason}}',
        }),
      }),
    );

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Workflow special', priority: 'medium' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Workflow special', priority: 'medium' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'please escalate');

    expect(result.response).toBe('Escalade localisee pour Workflow special');
  });

  test('escalation with very long reason is truncated to 500 chars', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    const longReason = 'A'.repeat(10_000);

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        { id: 'esc-1', name: '__escalate__', input: { reason: longReason, priority: 'low' } },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: longReason, priority: 'low' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'test');

    expect(session.isEscalated).toBe(true);
    // Reason is now truncated to 500 chars
    expect(session.escalationReason!.length).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // 7. Trace context leakage — full session data exposed in escalation trace
  // ---------------------------------------------------------------------------

  test('escalation trace uses filtered context — sensitive data not leaked', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    // Pre-populate session with sensitive-looking data
    session.data.values['credit_card'] = '4111111111111111';
    session.data.values['ssn'] = '123-45-6789';

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Need help with account', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Need help with account', priority: 'high' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'I need help', undefined, callback);

    const escTraces = filterTraces(traces, 'escalation');
    expect(escTraces.length).toBeGreaterThanOrEqual(1);

    // handleEscalate now uses filterEscalationContext — only context_for_human fields included
    const traceContext = escTraces[0].data.context as Record<string, unknown>;
    expect(traceContext).toBeDefined();
    // Sensitive values should NOT be in the trace (filtered out by context_for_human)
    expect(traceContext['credit_card']).toBeUndefined();
    expect(traceContext['ssn']).toBeUndefined();
    // Minimal safe context is returned when no context_for_human fields specified
    expect(traceContext['agentName']).toBe('EscalationAgent');
    expect(traceContext['conversationTurns']).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 8. Escalation alongside other tool calls in the same turn
  // ---------------------------------------------------------------------------

  test('escalation combined with regular tool call in same turn — escalation wins, loop breaks', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        { id: 'tool-1', name: 'search_hotels', input: { city: 'Paris' } },
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Cannot help user', priority: 'medium' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        { type: 'tool_use', id: 'tool-1', name: 'search_hotels', input: { city: 'Paris' } },
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Cannot help user', priority: 'medium' },
        },
      ],
    }));

    const result = await executor.executeMessage(
      session.id,
      'Search and escalate',
      undefined,
      callback,
    );

    // Escalation wins — session is escalated
    expect(session.isEscalated).toBe(true);
    // breakLoop triggers, so only 1 LLM call made
    expect(mock.calls.length).toBe(1);
    // Response should include the resolved escalation message.
    expect(result.response).toContain('Escalated to human agent');
    expect(result.response).toContain('Reason:');
  });

  // ---------------------------------------------------------------------------
  // 9. Session state consistency after escalation
  // ---------------------------------------------------------------------------

  test('escalation preserves existing session data and conversation history', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    // Wait a tick so the fire-and-forget wireLLMClient completes, then override
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock as any;

    // First turn: normal response
    mock.setResponseHandler(() => ({
      text: 'I found hotels for you.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I found hotels for you.' }],
    }));
    await executor.executeMessage(session.id, 'Find hotels in Paris');

    // Re-set mock client after first executeMessage (ensureSessionLLMClient may overwrite)
    session.llmClient = mock as any;

    // Pre-escalation state
    session.data.values['search_city'] = 'Paris';
    const historyLengthBefore = session.conversationHistory.length;

    // Second turn: escalate
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Complex request', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Complex request', priority: 'high' },
        },
      ],
    }));
    await executor.executeMessage(session.id, 'This is too complex, get me a human');

    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('Complex request');
    // Session data preserved
    expect(session.data.values['search_city']).toBe('Paris');
    // Conversation history grew (user msg + assistant escalation msg + tool messages)
    expect(session.conversationHistory.length).toBeGreaterThan(historyLengthBefore);
  });

  // ---------------------------------------------------------------------------
  // 10. Escalation on very first turn (no user request for human)
  // ---------------------------------------------------------------------------

  test('LLM escalates on first turn — emits warning trace but still allows escalation', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    // LLM decides to escalate immediately on a benign message
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'I cannot help with this', priority: 'low' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'I cannot help with this', priority: 'low' },
        },
      ],
    }));

    const result = await executor.executeMessage(
      session.id,
      'What time is it?',
      undefined,
      callback,
    );

    // First-turn escalation is allowed but emits a warning trace
    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('I cannot help with this');
    expect(result.action?.type).toBe('escalate');

    // Warning trace should be emitted for first-turn escalation
    const warningTraces = filterTraces(traces, 'warning');
    expect(warningTraces.length).toBeGreaterThanOrEqual(1);
    expect(warningTraces[0].data.message).toBe('Escalation triggered on first user message');
  });

  // ---------------------------------------------------------------------------
  // 11. breakLoop guarantee — no further LLM iterations after escalation
  // ---------------------------------------------------------------------------

  test('escalation breaks reasoning loop — no further LLM calls after escalate tool', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    let callCount = 0;
    mock.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // First call: use a tool, then escalate
        return {
          text: 'Let me check.',
          toolCalls: [
            {
              id: 'esc-1',
              name: '__escalate__',
              input: { reason: 'Cannot resolve this issue', priority: 'medium' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool_use',
              id: 'esc-1',
              name: '__escalate__',
              input: { reason: 'Cannot resolve this issue', priority: 'medium' },
            },
          ],
        };
      }
      // This should never be reached
      return {
        text: 'This should not happen.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'This should not happen.' }],
      };
    });

    await executor.executeMessage(session.id, 'Help');

    // Only 1 LLM call — breakLoop prevents iteration 2
    expect(callCount).toBe(1);
    expect(session.isEscalated).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 12. Escalation trace event structure
  // ---------------------------------------------------------------------------

  test('escalation emits complete trace with agent name, reason, priority, and filtered context', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User requested human help', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User requested human help', priority: 'high' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'Get me a human', undefined, callback);

    const escTraces = filterTraces(traces, 'escalation');
    expect(escTraces.length).toBeGreaterThanOrEqual(1);

    const traceData = escTraces[0].data;
    expect(traceData.reason).toBe('User requested human help');
    expect(traceData.priority).toBe('high');
    expect(traceData.agent).toBe('EscalationAgent');
    expect(traceData.context).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 13. Escalation with agent that HAS escalation config
  // ---------------------------------------------------------------------------

  test('agent with ESCALATION config still allows LLM to escalate for reasons outside triggers', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    // LLM escalates for a reason NOT in the defined triggers
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User is upset about check-in time', priority: 'low' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User is upset about check-in time', priority: 'low' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'I hate the check-in time');

    // Escalation goes through — IR triggers are advisory (system prompt only), not enforced
    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('User is upset about check-in time');
  });

  // ---------------------------------------------------------------------------
  // 14. System prompt escalation instructions verification
  // ---------------------------------------------------------------------------

  test('agent with ESCALATION config includes escalation triggers in system prompt', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    let capturedSystemPrompt = '';
    mock.setResponseHandler((sp) => {
      capturedSystemPrompt = sp;
      return {
        text: 'I can help you.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I can help you.' }],
      };
    });

    await executor.executeMessage(session.id, 'Hello');

    // System prompt should include escalation guidance using SYSTEM_PROMPT_TEMPLATES
    expect(capturedSystemPrompt).toContain('Escalation');
    expect(capturedSystemPrompt).toContain('Refund processing requires human agent');
    expect(capturedSystemPrompt).toContain('Safety complaints require immediate human attention');
    // Template text from SYSTEM_PROMPT_TEMPLATES.escalation_attempt_first
    expect(capturedSystemPrompt).toContain(
      'attempt to help the user at least once before escalating',
    );
    // Template text from SYSTEM_PROMPT_TEMPLATES.escalation_not_routing
    expect(capturedSystemPrompt).toContain('Do NOT escalate for normal routing');
  });

  // ---------------------------------------------------------------------------
  // 15. Constraint-triggered escalation
  // ---------------------------------------------------------------------------

  test('constraint violation with ESCALATE action sets escalation state', async () => {
    const resolved = compileToResolvedAgent(
      [AGENT_WITH_ESCALATION_CONSTRAINT],
      'ConstraintEscAgent',
    );
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    // The constraint checker evaluates constraints using LLM. We simulate the
    // constraint being violated by having the LLM return a constraint violation.
    // However, constraint checking happens via the constraint-checker module
    // which is tested separately. Here we test the handleEscalate path directly
    // through a tool call.
    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'PII detected in user message', priority: 'critical' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'PII detected in user message', priority: 'critical' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'My SSN is 123-45-6789');

    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('PII detected in user message');
    expect(result.action?.type).toBe('escalate');
  });

  // ---------------------------------------------------------------------------
  // 16. onChunk callback receives escalation message
  // ---------------------------------------------------------------------------

  test('onChunk receives escalation notification with reason and priority', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const chunks: string[] = [];

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Cannot assist the user', priority: 'high' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Cannot assist the user', priority: 'high' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'help', (chunk) => chunks.push(chunk));

    // onChunk should have received the resolved escalation message.
    const escalationChunk = chunks.find((c) => c.includes('Escalated to human agent'));
    expect(escalationChunk).toBeDefined();
    expect(escalationChunk).toContain('Cannot assist the user'); // reason
  });

  // ---------------------------------------------------------------------------
  // 17. Escalation return value structure
  // ---------------------------------------------------------------------------

  test('executeMessage returns escalation action with reason and priority', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User wants human', priority: 'critical' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'User wants human', priority: 'critical' },
        },
      ],
    }));

    const result = await executor.executeMessage(session.id, 'transfer me');

    expect(result.action).toBeDefined();
    expect(result.action!.type).toBe('escalate');
    expect(result.action!.reason).toBe('User wants human');
    expect(result.action!.priority).toBe('critical');
    // Response should be the resolved escalation message.
    expect(result.response).toContain('Escalated to human agent');
    expect(result.response).toContain('User wants human'); // reason in body
  });

  // ---------------------------------------------------------------------------
  // 18. Escalation response is in conversation history
  // ---------------------------------------------------------------------------

  test('escalation message is added to conversation history', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        {
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Needs human agent', priority: 'medium' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Needs human agent', priority: 'medium' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'I want a person');

    // The user message should be in history
    const userMsgs = session.conversationHistory.filter((m) => m.role === 'user');
    expect(
      userMsgs.some((m) => typeof m.content === 'string' && m.content.includes('I want a person')),
    ).toBe(true);

    // The assistant escalation message should be in history
    const assistantMsgs = session.conversationHistory.filter((m) => m.role === 'assistant');
    expect(
      assistantMsgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('Escalated to human agent'),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 19. Escalation tool_call trace event
  // ---------------------------------------------------------------------------

  test('escalation emits tool_call trace event with correct latency and agent name', async () => {
    const resolved = compileToResolvedAgent([AGENT_WITH_ESCALATION], 'EscalationAgent');
    const session = executor.createSessionFromResolved(resolved);
    const mock = injectMockClient(executor);
    await new Promise((r) => setTimeout(r, 10));
    session.llmClient = mock;
    const { traces, callback } = createTraceCollector();

    mock.setResponseHandler(() => ({
      text: '',
      toolCalls: [
        { id: 'esc-1', name: '__escalate__', input: { reason: 'Trace test', priority: 'low' } },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'esc-1',
          name: '__escalate__',
          input: { reason: 'Trace test', priority: 'low' },
        },
      ],
    }));

    await executor.executeMessage(session.id, 'test trace', undefined, callback);

    // Should have a tool_call trace for __escalate__
    const toolCallTraces = filterTraces(traces, 'tool_call');
    const escalateToolTrace = toolCallTraces.find((t) => t.data.toolName === '__escalate__');
    expect(escalateToolTrace).toBeDefined();
    expect(escalateToolTrace!.data.latencyMs).toBeDefined();
    expect(typeof escalateToolTrace!.data.latencyMs).toBe('number');
    expect(escalateToolTrace!.data.isActionTool).toBe(true);
    // Agent name is now included in tool_call trace events
    expect(escalateToolTrace!.data.agent).toBe('EscalationAgent');
  });
});
