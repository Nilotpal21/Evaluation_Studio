/**
 * Reasoning Zone Init Guard Tests
 *
 * Validates that reasoning zones in flow steps:
 * 1. Are skipped during initialization (empty currentMessage)
 * 2. Execute normally when a real user message is present
 * 3. Use buildTools(session) which includes dynamic system tools
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockLLMClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return {
      text: 'Reasoning zone response',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Reasoning zone response' }],
    };
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

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
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
// ABL FIXTURES
// =============================================================================

const FLOW_WITH_REASONING_ZONE = `
AGENT: ReasoningFlowAgent

GOAL: "Test reasoning zone in flow"

PERSONA: "Helpful assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"

ON_START:
  respond: "Welcome! How can I help?"

FLOW:
  entry_point: assist
  steps:
    - assist

assist:
  REASONING: true
  GOAL: "Help the user with their request"
  THEN: COMPLETE
`;

const FLOW_WITH_MULTILINE_REASONING_GOAL = `
AGENT: MultilineReasoningFlowAgent

GOAL: "Agent-level fallback should not be used"

PERSONA: "Helpful assistant"

FLOW:
  entry_point: synthesize
  steps:
    - synthesize

synthesize:
  REASONING: true
  GOAL: |
    Produce ONE unified reply.
    Include contract names and expiration dates.
  THEN: COMPLETE
`;

const FLOW_WITH_REASONING_ZONE_NO_STEP_GOAL = `
AGENT: ReasoningFlowAgentFallback

GOAL: "Use the agent-level goal as the fallback reasoning goal"

PERSONA: "Helpful assistant"

FLOW:
  entry_point: assist
  steps:
    - assist

assist:
  REASONING: true
  THEN: COMPLETE
`;

const FLOW_WITH_REASONING_AND_HANDOFF = `
AGENT: SupervisorFlow

GOAL: "Route users to specialists"

PERSONA: "Helpful routing assistant"

ON_START:
  respond: "Welcome!"

HANDOFF:
  - TO: specialist_agent
    WHEN: "User needs specialist help"

FLOW:
  entry_point: triage
  steps:
    - triage

triage:
  REASONING: true
  GOAL: "Determine user intent and route appropriately"
  THEN: COMPLETE
`;

const FLOW_WITH_REASONING_EXIT_STATE = `
AGENT: ReasoningExitFlow

GOAL: "Move from reasoning selection to details"

PERSONA: "Helpful assistant"

FLOW:
  entry_point: step_one
  steps:
    - step_one
    - step_two

step_one:
  REASONING: true
  EXIT_WHEN: selection_made == "yes"
  RESPOND: "Ask the user to select an option. When the user picks, set selection_made to yes."
  THEN: step_two

step_two:
  REASONING: false
  RESPOND: "Details for your selection."
    FORMATS:
      MARKDOWN: |
        **Details for your selection**

        Rich card content here
    ACTIONS:
      - BUTTON: "Confirm" -> confirm
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Reasoning zone init guard', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('reasoning zone is NOT entered during initialization (ON_START)', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_ZONE], 'ReasoningFlowAgent'),
    );

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    // ON_START should produce welcome message
    const output = chunks.join('');
    expect(output).toContain('Welcome');

    // The reasoning LLM should NOT have been called during init
    // (the guard `step.reasoning_zone && currentMessage` prevents this)
    expect(mock.calls.length).toBe(0);
  });

  test('reasoning zone IS entered when user sends a real message', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_ZONE], 'ReasoningFlowAgent'),
    );

    // Initialize first
    await executor.initializeSession(session.id);

    // Flow should park on the reasoning zone step (not advance past it)
    expect(session.currentFlowStep).toBe('assist');

    // Now send a real message — reasoning zone should activate
    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'find hotels in paris', (c) => chunks.push(c));

    // The LLM should have been called in the reasoning zone
    expect(mock.calls.length).toBeGreaterThan(0);
  });

  test('ABLP-555 uses the step-level reasoning GOAL in the LLM system prompt', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_ZONE], 'ReasoningFlowAgent'),
    );

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'find hotels in paris');

    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls[0].systemPrompt).toContain('Goal: Help the user with their request');
    expect(mock.calls[0].systemPrompt).not.toContain('Goal: Test reasoning zone in flow');
  });

  test('ABLP-555 preserves multiline step-level reasoning GOAL in the LLM system prompt', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_MULTILINE_REASONING_GOAL], 'MultilineReasoningFlowAgent'),
    );

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'List contracts expiring in 2026');

    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls[0].systemPrompt).toContain(
      'Goal: Produce ONE unified reply.\nInclude contract names and expiration dates.',
    );
    expect(mock.calls[0].systemPrompt).not.toContain('Goal: |');
    expect(mock.calls[0].systemPrompt).not.toContain(
      'Goal: Agent-level fallback should not be used',
    );
  });

  test('ABLP-555 falls back to the agent GOAL when the reasoning step omits GOAL', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_ZONE_NO_STEP_GOAL], 'ReasoningFlowAgentFallback'),
    );

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'summarize this request');

    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls[0].systemPrompt).toContain(
      'Goal: Use the agent-level goal as the fallback reasoning goal',
    );
  });

  test('reasoning zone receives system tools from buildTools (handoff_to_*)', async () => {
    const mock = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_AND_HANDOFF], 'SupervisorFlow'),
    );

    // Initialize first
    await executor.initializeSession(session.id);

    // Send message to trigger reasoning zone
    await executor.executeMessage(session.id, 'I need specialist help');

    // Verify the LLM was called with tools that include the system handoff tool
    expect(mock.calls.length).toBeGreaterThan(0);
    const toolNames = mock.calls[0].tools.map((t: any) => t.name);

    // buildTools(session) should include both DSL-defined tools and dynamic system tools
    // The HANDOFF rule generates a handoff_to_specialist_agent tool
    expect(toolNames).toContain('handoff_to_specialist_agent');
  });

  test('reasoning zone can update EXIT_WHEN state and transition to formatted next step', async () => {
    const mock = injectMockClient(executor);
    mock.chatWithToolUse = vi.fn(
      async (
        systemPrompt: string,
        messages: Array<{ role: string; content: unknown }>,
        tools: unknown[],
      ) => {
        mock.calls.push({ systemPrompt, messages, tools });
        return {
          text: '',
          toolCalls: [
            {
              id: 'set-selection',
              name: '__set_context__',
              input: { updates: { selection_made: 'yes' } },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'set-selection',
              name: '__set_context__',
              input: { updates: { selection_made: 'yes' } },
            },
          ],
        };
      },
    ) as unknown as MockLLMClient['chatWithToolUse'];

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_WITH_REASONING_EXIT_STATE], 'ReasoningExitFlow'),
    );
    await executor.initializeSession(session.id);

    const chunks: string[] = [];
    const result = await executor.executeMessage(session.id, 'I pick the first option', (chunk) =>
      chunks.push(chunk),
    );

    const toolNames = mock.calls[0].tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('__set_context__');
    expect(session.data.values.selection_made).toBe('yes');
    expect(session.currentFlowStep).toBe('step_two');
    expect(chunks.join('')).toContain('Details for your selection.');
    expect(result.richContent?.markdown).toContain('Rich card content here');
    expect(result.actions?.elements?.[0]).toMatchObject({
      id: 'confirm',
      label: 'Confirm',
      type: 'button',
    });
  });
});
