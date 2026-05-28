/**
 * Runtime-Evaluated Completion Tests
 *
 * Tests for checkAndMarkComplete() — the post-turn server-side completion
 * evaluation that replaced the LLM-driven __complete_conversation__ tool.
 *
 * Covers:
 * - COMPLETE conditions evaluated against actual session state
 * - __complete_conversation__ tool NOT in LLM tool list
 * - IS SET / IS NOT SET condition evaluation
 * - RESPOND message interpolation
 * - STORE directive (context snapshot)
 * - Trace event emission (completion_check, decision)
 * - Edge cases: already complete, after handoff/escalate, no conditions
 * - Multiple conditions (first match wins)
 * - Gather fields alone do NOT trigger completion
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';

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
    operationType?: string,
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const jsonStr = JSON.stringify(entities);
    const previousHandler = this.responseHandler;
    this.responseHandler = (systemPrompt, messages, tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: jsonStr,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: jsonStr }],
        };
      }
      return previousHandler(systemPrompt, messages, tools, operationType);
    };
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    operationType?: string,
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools, operationType);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools, operationType);
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
// DSL FIXTURES
// =============================================================================

const AGENT_WITH_COMPLETE_CONDITIONS = `
AGENT: Booking_Agent
GOAL: "Handle agent tasks"

ROLE: "You are a hotel booking assistant."

PERSONA: "Helpful and professional"

GATHER:
  destination:
    prompt: "Travel destination"
    type: string
    required: true

  checkin:
    prompt: "Check-in date"
    type: string
    required: true

  checkout:
    prompt: "Check-out date"
    type: string
    required: true

COMPLETE:
  - WHEN: destination IS SET AND checkin IS SET AND checkout IS SET
    RESPOND: "Booking complete for {{destination}} from {{checkin}} to {{checkout}}."
`;

const AGENT_WITH_MULTIPLE_CONDITIONS = `
AGENT: Support_Agent
GOAL: "Handle agent tasks"

ROLE: "You are a support agent."

PERSONA: "Friendly"

GATHER:
  issue_type:
    prompt: "Type of issue"
    type: string
    required: true

  resolution:
    prompt: "Resolution provided"
    type: string
    required: true

COMPLETE:
  - WHEN: resolution == "self_resolved"
    RESPOND: "Glad you resolved it yourself!"
  - WHEN: issue_type IS SET AND resolution IS SET
    RESPOND: "Your {{issue_type}} issue has been resolved: {{resolution}}"
`;

const AGENT_WITH_STORE = `
AGENT: Data_Agent
GOAL: "Handle agent tasks"

ROLE: "You collect survey data."

PERSONA: "Professional"

GATHER:
  name:
    prompt: "Respondent name"
    type: string
    required: true

  rating:
    prompt: "Satisfaction rating"
    type: string
    required: true

COMPLETE:
  - WHEN: name IS SET AND rating IS SET
    RESPOND: "Thank you {{name}}, your rating of {{rating}} has been recorded."
    STORE: survey_response
`;

const AGENT_NO_COMPLETE = `
AGENT: Simple_Agent
GOAL: "Handle agent tasks"

ROLE: "You are a simple assistant."

PERSONA: "Helpful"

GATHER:
  question:
    prompt: "User question"
    type: string
    required: true
`;

const AGENT_EQUALITY_CONDITION = `
AGENT: Status_Agent
GOAL: "Handle agent tasks"

ROLE: "You track task status."

PERSONA: "Efficient"

GATHER:
  task:
    prompt: "Task description"
    type: string
    required: true

  status:
    prompt: "Task status"
    type: string
    required: true

COMPLETE:
  - WHEN: status == "done"
    RESPOND: "Task marked as complete."
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Runtime-Evaluated Completion (Option C)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 1. __complete_conversation__ tool NOT offered to LLM
  // ===========================================================================
  describe('Tool exclusion', () => {
    test('should NOT include __complete_conversation__ in tools sent to LLM', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Hello, I want to book a hotel');

      // Verify __complete_conversation__ is NOT in any call's tools
      for (const call of mockClient.calls) {
        const toolNames = (call.tools as Array<{ name: string }>).map((t) => t.name);
        expect(toolNames).not.toContain('__complete_conversation__');
      }
    });

    test('should NOT mention completion tool in system prompt', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Hello');

      // Check all calls — none should mention __complete_conversation__ in system prompt
      expect(mockClient.calls.length).toBeGreaterThan(0);
      for (const call of mockClient.calls) {
        expect(call.systemPrompt).not.toContain('__complete_conversation__');
      }
    });
  });

  // ===========================================================================
  // 2. Basic completion condition matching
  // ===========================================================================
  describe('Condition evaluation', () => {
    test('should auto-complete when all IS SET conditions are met', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // Pre-populate state so conditions match after LLM turn
      session.data.values.destination = 'Paris';
      session.data.values.checkin = 'March 15';
      session.data.values.checkout = 'March 20';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(
        session.id,
        'I want to go to Paris March 15-20',
        undefined,
        (e) => traces.push(e),
      );

      expect(session.isComplete).toBe(true);
      expect(result.action?.type).toBe('complete');
    });

    test('should NOT auto-complete when conditions are not met', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // Only set one field — conditions require all three
      session.data.values.destination = 'Paris';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(
        session.id,
        'I want to go to Paris',
        undefined,
        (e) => traces.push(e),
      );

      expect(session.isComplete).toBe(false);
      expect(result.action?.type).not.toBe('complete');
    });

    test('should match equality conditions (==)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_EQUALITY_CONDITION], 'Status_Agent'),
      );

      session.data.values.task = 'Write tests';
      session.data.values.status = 'done';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(session.id, 'Task is done');

      expect(session.isComplete).toBe(true);
      expect(result.action?.type).toBe('complete');
    });

    test('should NOT match when equality condition fails', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_EQUALITY_CONDITION], 'Status_Agent'),
      );

      session.data.values.task = 'Write tests';
      session.data.values.status = 'in_progress';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(session.id, 'Still working');

      expect(session.isComplete).toBe(false);
    });
  });

  // ===========================================================================
  // 3. Multiple conditions — first match wins
  // ===========================================================================
  describe('Multiple conditions', () => {
    test('should match first condition when multiple could match', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_MULTIPLE_CONDITIONS], 'Support_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // Both conditions could match, but "self_resolved" is first
      session.data.values.issue_type = 'billing';
      session.data.values.resolution = 'self_resolved';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'I fixed it myself', undefined, (e) =>
        traces.push(e),
      );

      expect(session.isComplete).toBe(true);

      // The auto_complete decision should reference the first condition
      const decision = traces.find((t) => t.type === 'decision' && t.data.type === 'auto_complete');
      expect(decision).toBeDefined();
      expect(decision!.data.condition).toBe('resolution == "self_resolved"');
    });

    test('should fall through to second condition when first does not match', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_MULTIPLE_CONDITIONS], 'Support_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      session.data.values.issue_type = 'billing';
      session.data.values.resolution = 'credited';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'The credit was applied', undefined, (e) =>
        traces.push(e),
      );

      expect(session.isComplete).toBe(true);

      const decision = traces.find((t) => t.type === 'decision' && t.data.type === 'auto_complete');
      expect(decision).toBeDefined();
      expect(decision!.data.condition).toContain('issue_type IS SET');
    });
  });

  // ===========================================================================
  // 4. Trace events
  // ===========================================================================
  describe('Trace events', () => {
    test('should emit completion_check trace for each evaluated condition', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_MULTIPLE_CONDITIONS], 'Support_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // Neither condition matches
      session.data.values.issue_type = 'billing';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'I have a billing issue', undefined, (e) =>
        traces.push(e),
      );

      const completionChecks = traces.filter((t) => t.type === 'completion_check');
      // Should have checked both conditions
      expect(completionChecks.length).toBe(2);
      expect(completionChecks[0].data.result).toBe(false);
      expect(completionChecks[1].data.result).toBe(false);
      expect(completionChecks[0].data.source).toBe('post_turn_eval');
    });

    test('should emit decision trace with auto_complete type when completing', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      session.data.values.destination = 'Tokyo';
      session.data.values.checkin = 'April 1';
      session.data.values.checkout = 'April 5';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Booking Tokyo April 1-5', undefined, (e) =>
        traces.push(e),
      );

      const decision = traces.find((t) => t.type === 'decision' && t.data.type === 'auto_complete');
      expect(decision).toBeDefined();
      expect(decision!.data.agent).toBe('Booking_Agent');
      expect(decision!.data.condition).toContain('destination IS SET');
    });

    test('should stop checking after first matching condition', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_MULTIPLE_CONDITIONS], 'Support_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // First condition matches
      session.data.values.resolution = 'self_resolved';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Fixed it', undefined, (e) => traces.push(e));

      const completionChecks = traces.filter((t) => t.type === 'completion_check');
      // Only first condition should be checked (it matched)
      expect(completionChecks.length).toBe(1);
      expect(completionChecks[0].data.result).toBe(true);
    });
  });

  // ===========================================================================
  // 5. STORE directive
  // ===========================================================================
  describe('STORE directive', () => {
    test('should store context snapshot when STORE is configured', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_STORE], 'Data_Agent'),
      );

      session.data.values.name = 'Alice';
      session.data.values.rating = '5';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Done');

      expect(session.isComplete).toBe(true);

      const stored = session.data.values['_stored_survey_response'];
      expect(stored).toBeDefined();
      expect(stored.key).toBe('survey_response');
      expect(stored.value.name).toBe('Alice');
      expect(stored.value.rating).toBe('5');
      expect(stored.timestamp).toBeDefined();
      expect(stored.sessionId).toBe(session.id);
      expect(stored.agentName).toBe('Data_Agent');
    });

    test('should emit data_stored trace when STORE is used', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_STORE], 'Data_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      session.data.values.name = 'Bob';
      session.data.values.rating = '4';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Done', undefined, (e) => traces.push(e));

      const decision = traces.find((t) => t.type === 'decision' && t.data.type === 'auto_complete');
      expect(decision).toBeDefined();
      expect(decision!.data.stored).toBe('survey_response');
    });
  });

  // ===========================================================================
  // 6. Edge cases — skip conditions
  // ===========================================================================
  describe('Edge cases', () => {
    test('should NOT evaluate if session is already complete', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      session.data.values.destination = 'Paris';
      session.data.values.checkin = 'March 15';
      session.data.values.checkout = 'March 20';

      // Pre-mark as complete
      session.isComplete = true;

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Already complete', undefined, (e) =>
        traces.push(e),
      );

      // Should not have any post-turn completion_check traces
      const postTurnChecks = traces.filter(
        (t) => t.type === 'completion_check' && t.data.source === 'post_turn_eval',
      );
      expect(postTurnChecks.length).toBe(0);
    });

    test('should NOT evaluate when result action is already complete', async () => {
      // If the scripted flow or tool handler already set action=complete,
      // the post-turn check should not run again
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // Pre-set all values so conditions would match
      session.data.values.destination = 'Berlin';
      session.data.values.checkin = 'July 1';
      session.data.values.checkout = 'July 5';

      // First call: should auto-complete
      mockClient.setEntityExtractionResponse({});

      const result1 = await executor.executeMessage(
        session.id,
        'Book Berlin July 1-5',
        undefined,
        (e) => traces.push(e),
      );

      expect(result1.action?.type).toBe('complete');
      expect(session.isComplete).toBe(true);

      // Count how many post-turn completion checks happened — should be exactly 1
      const completionChecks = traces.filter(
        (t) => t.type === 'completion_check' && t.data.source === 'post_turn_eval',
      );
      expect(completionChecks.length).toBe(1);
    });

    test('should NOT auto-complete when agent has no COMPLETE conditions', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_NO_COMPLETE], 'Simple_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      session.data.values.question = 'What is the meaning of life?';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(session.id, 'Some question', undefined, (e) =>
        traces.push(e),
      );

      expect(session.isComplete).toBe(false);
      expect(result.action?.type).not.toBe('complete');

      // No completion_check traces should exist
      const completionChecks = traces.filter((t) => t.type === 'completion_check');
      expect(completionChecks.length).toBe(0);
    });

    test('should set conversationPhase to complete when auto-completing', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );

      session.data.values.destination = 'London';
      session.data.values.checkin = 'May 1';
      session.data.values.checkout = 'May 5';

      mockClient.setEntityExtractionResponse({});

      await executor.executeMessage(session.id, 'Book it');

      expect(session.state.conversationPhase).toBe('complete');
    });
  });

  // ===========================================================================
  // 7. Gather fields alone do NOT trigger completion
  // ===========================================================================
  describe('Gather completeness does NOT auto-complete', () => {
    test('should NOT auto-complete just because all gather fields are set (no COMPLETE block)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_NO_COMPLETE], 'Simple_Agent'),
      );

      session.data.values.question = 'Something';

      mockClient.setEntityExtractionResponse({});

      const result = await executor.executeMessage(session.id, 'Answer me');

      // All gather fields set, but no COMPLETE conditions → no completion
      expect(session.isComplete).toBe(false);
    });
  });

  // ===========================================================================
  // 8. Completion via post-turn check after LLM end_turn
  // ===========================================================================
  describe('Completion flow integration', () => {
    test('should auto-complete via post-turn check even when LLM does not explicitly complete', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_COMPLETE_CONDITIONS], 'Booking_Agent'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

      // LLM extracts all fields in one turn
      mockClient.setEntityExtractionResponse({
        destination: 'Rome',
        checkin: 'June 1',
        checkout: 'June 5',
      });

      const result = await executor.executeMessage(
        session.id,
        'Book Rome June 1-5',
        undefined,
        (e) => traces.push(e),
      );

      // Post-turn check should fire and complete the session
      expect(session.isComplete).toBe(true);
      expect(result.action?.type).toBe('complete');

      // Verify the trace event chain
      const completionCheck = traces.find(
        (t) => t.type === 'completion_check' && t.data.result === true,
      );
      expect(completionCheck).toBeDefined();

      const decision = traces.find((t) => t.type === 'decision' && t.data.type === 'auto_complete');
      expect(decision).toBeDefined();
    });
  });
});
