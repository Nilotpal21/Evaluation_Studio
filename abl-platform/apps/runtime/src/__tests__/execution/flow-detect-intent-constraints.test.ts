/**
 * Flow DetectIntent & Constraint Violation Tests
 *
 * Tests for:
 * - detectIntent: keyword matching, quoted phrase matching, condition evaluation
 * - Regex entity extraction fallback (extractEntitiesForFields)
 * - Constraint violation actions: respond, escalate, handoff, block
 * - Constraint auto-guard (unset variables pass by default)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('Flow DetectIntent & Constraints', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // DETECT INTENT — via digression/sub-intent matching
  // ===========================================================================

  describe('DetectIntent matching', () => {
    test('Lexical fallback matches KEYWORDS phrases in the user message', async () => {
      const dsl = `
AGENT: Quoted_Intent_Test

GOAL: "Test quoted intent"

FLOW:
  entry_point: collect
  steps:
    - collect
    - cancelled

  global_digressions:
    REASONING: false
    - INTENT: cancel_request
      KEYWORDS: [cancel booking]
      RESPOND: "Booking cancelled."
      GOTO: cancelled

collect:
  GATHER:
    - name: required
  THEN: COMPLETE

cancelled:
  RESPOND: "Session ended."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Quoted_Intent_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I want to cancel booking please', (c) =>
        chunks.push(c),
      );

      expect(chunks.join('')).toContain('Booking cancelled');
    });

    test('Lexical fallback uses KEYWORDS instead of semantic INTENT text', async () => {
      const dsl = `
AGENT: Keyword_Intent_Test

GOAL: "Test keyword intent"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "Here is some help."

collect:
  GATHER:
    - value: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Keyword_Intent_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I need some help', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Here is some help');
    });

    test('Lexical fallback matches any KEYWORDS entry in declaration order', async () => {
      const dsl = `
AGENT: Multi_Keyword_Test

GOAL: "Test multi keyword"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: cancel_request
      KEYWORDS: [cancel, quit, exit]
      RESPOND: "Goodbye!"

collect:
  GATHER:
    - value: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Multi_Keyword_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I want to quit', (c) => chunks.push(c));
      expect(chunks.join('')).toContain('Goodbye!');
    });

    test('Digression does not match when no KEYWORDS entries are present in the message', async () => {
      const dsl = `
AGENT: No_Match_Test

GOAL: "Test no match"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: cancel_request
      KEYWORDS: [cancel]
      RESPOND: "Cancelled!"

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'No_Match_Test'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'hello my name is Alice');
      expect(session.data.values.name).toBeDefined();
      expect(session.isComplete).toBe(true);
    });

    test('Global digression CONDITION is evaluated after a KEYWORDS match candidate is found', async () => {
      const dsl = `
AGENT: Global_Condition_Test

GOAL: "Test global digression condition"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      CONDITION: support_mode == "enabled"
      RESPOND: "Support is available."

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Global_Condition_Test'),
      );
      await executor.initializeSession(session.id);
      session.data.values.support_mode = 'disabled';

      await executor.executeMessage(session.id, 'help please');

      expect(session.data.values.name).toBeDefined();
      expect(session.isComplete).toBe(true);
    });

    test('Sub-intent with quoted phrase matches', async () => {
      const dsl = `
AGENT: SubIntent_Quoted_Test

GOAL: "Test sub-intent quoted phrase"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "change mind"
      RESPOND: "OK, what would you prefer instead?"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Quoted_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'actually I change mind about this', (c) =>
        chunks.push(c),
      );

      expect(chunks.join('')).toContain('what would you prefer instead');
      // Should remain on collect step (sub-intent doesn't navigate)
      expect(session.currentFlowStep).toBe('collect');
    });
  });

  // ===========================================================================
  // REGEX ENTITY EXTRACTION (no LLM client)
  // ===========================================================================

  describe('Regex entity extraction fallback', () => {
    test('Single field collects raw user input', async () => {
      const dsl = `
AGENT: Regex_Single_Test

GOAL: "Test single field extraction"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Regex_Single_Test'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'Alice');

      // Single field → raw input stored
      expect(session.data.values.name).toBe('Alice');
      expect(session.isComplete).toBe(true);
    });

    test('Entity extraction emits trace event with method: regex', async () => {
      const dsl = `
AGENT: Regex_Trace_Test

GOAL: "Test extraction trace"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - city: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Regex_Trace_Test'),
      );
      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'Paris', undefined, (e) => traces.push(e));

      const extractionTrace = traces.find((t) => t.type === 'entity_extraction');
      expect(extractionTrace).toBeDefined();
      expect(extractionTrace!.data.method).toBe('regex_fallback');
      expect(extractionTrace!.data.requestedFields).toEqual(['city']);
    });
  });

  // ===========================================================================
  // CONSTRAINT VIOLATION ACTIONS
  // ===========================================================================

  describe('Constraint violation actions', () => {
    test('input-based constraints evaluate against the current user message', async () => {
      const dsl = `
AGENT: Constraint_Input_Context_Test

GOAL: "Test current-turn input constraints"

CONSTRAINTS:
  - REQUIRE input contains "vip"
    ON_FAIL: Please mention vip in your request.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - notes: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Input_Context_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'regular request', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Please mention vip in your request.');
    });

    test('Constraint violation with RESPOND shows custom message', async () => {
      // Use proper DSL format: CONSTRAINTS:\n  - REQUIRE condition\n    ON_FAIL: message
      // Constraints evaluate against session.data.values context
      const dsl = `
AGENT: Constraint_Respond_Test

GOAL: "Test constraint respond"

CONSTRAINTS:
  - REQUIRE num_guests <= 10
    ON_FAIL: Sorry, we cannot accommodate more than 10 guests.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - notes: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Respond_Test'),
      );
      // Set data that violates constraint
      session.data.values.num_guests = 15;
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'some notes', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('cannot accommodate more than 10 guests');
    });

    test('Constraint violation with ESCALATE sets escalation state', async () => {
      const dsl = `
AGENT: Constraint_Escalate_Test

GOAL: "Test constraint escalate"

CONSTRAINTS:
  - REQUIRE estimated_total <= 5000
    ON_FAIL: ESCALATE "Booking exceeds budget limit"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - notes: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Escalate_Test'),
      );
      session.data.values.estimated_total = 8000;
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'proceed', (c) => chunks.push(c));

      expect(session.isEscalated).toBe(true);
      expect(session.escalationReason).toContain('Booking exceeds budget limit');
    });

    test('Constraint violation with HANDOFF executes a real handoff', async () => {
      const primaryDsl = `
AGENT: Constraint_Handoff_Test

GOAL: "Test constraint handoff"

CONSTRAINTS:
  - REQUIRE priority != "critical"
    ON_FAIL: HANDOFF Specialist_Agent Critical issue detected

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - notes: required
  THEN: COMPLETE
`;
      const specialistDsl = `
AGENT: Specialist_Agent

GOAL: "Handle escalated critical issues"

FLOW:
  entry_point: help
  steps:
    - help

help:
  RESPOND: "Specialist taking over."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([primaryDsl, specialistDsl], 'Constraint_Handoff_Test'),
      );
      session.data.values.priority = 'critical';
      session.handoffReturnInfo = { Specialist_Agent: false };
      await executor.initializeSession(session.id);

      const result = await executor.executeMessage(session.id, 'help');
      const activeThread = session.threads[session.activeThreadIndex];

      expect(result.response).toBeTruthy();
      expect(activeThread?.agentName).toBe('Specialist_Agent');
      expect(
        activeThread?.conversationHistory.some(
          (message) =>
            message.role === 'assistant' &&
            typeof message.content === 'string' &&
            message.content.includes('Specialist taking over.'),
        ),
      ).toBe(true);
      expect(session.handoffStack).toContain('Specialist_Agent');
    });

    test('Constraint violation emits trace events', async () => {
      const dsl = `
AGENT: Constraint_Trace_Test

GOAL: "Test constraint traces"

CONSTRAINTS:
  - REQUIRE score >= 0
    ON_FAIL: Score cannot be negative.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - value: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Trace_Test'),
      );
      session.data.values.score = -5;
      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'continue', undefined, (e) => traces.push(e));

      const violationTrace = traces.find((t) => t.type === 'constraint_check');
      expect(violationTrace).toBeDefined();
      expect(violationTrace!.data.passed).toBe(false);
    });

    test('No constraint violation when values are valid', async () => {
      const dsl = `
AGENT: Constraint_Pass_Test

GOAL: "Test constraint pass"

CONSTRAINTS:
  - REQUIRE num_guests <= 10
    ON_FAIL: Too many guests.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Pass_Test'),
      );
      session.data.values.num_guests = 3;
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'Alice');

      // Normal flow should proceed
      expect(session.data.values.name).toBe('Alice');
      expect(session.isComplete).toBe(true);
    });

    test('Constraint with context variable checks session data', async () => {
      const dsl = `
AGENT: Constraint_Context_Test

GOAL: "Test constraint context"

CONSTRAINTS:
  - REQUIRE budget <= 10000
    ON_FAIL: Budget exceeds limit.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - request: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Context_Test'),
      );
      session.data.values.budget = 15000;
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'proceed with purchase', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Budget exceeds limit');
    });

    test('Post-extraction violations only clear the offending gathered field', async () => {
      const dsl = `
AGENT: Constraint_Clear_Field_Test

GOAL: "Test targeted field clearing"

CONSTRAINTS:
  - REQUIRE num_guests <= 10
    ON_FAIL: Too many guests.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - email: required
      type: email
    - num_guests: required
      type: number
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Constraint_Clear_Field_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(
        session.id,
        'Contact me at traveler@example.com and book for 15 guests',
        (c) => chunks.push(c),
      );

      expect(chunks.join('')).toContain('Too many guests');
      expect(session.data.values.email).toBe('traveler@example.com');
      expect(session.data.values.num_guests).toBeUndefined();
      expect(session.waitingForInput).toEqual(['num_guests']);
    });

    test('structural BEFORE calling blocks a flow CALL before the tool executes', async () => {
      const dsl = `
AGENT: Flow_Before_Call_Test

GOAL: "Test structural BEFORE in flow mode"

TOOLS:
  search_aggregate(query: string) -> { results: array }
    description: "Search aggregate results"

CONSTRAINTS:
  - REQUIRE measure_field IS SET BEFORE calling search_aggregate
    ON_FAIL: Select a measure before running the aggregate search.

FLOW:
  entry_point: run_search
  steps:
    - run_search

run_search:
  REASONING: false
  CALL: search_aggregate(query)
  RESPOND: "This should not be reached."
  THEN: COMPLETE
`;
      let toolCalls = 0;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Flow_Before_Call_Test'),
      );
      session.toolExecutor = {
        execute: async () => {
          toolCalls++;
          return { results: [] };
        },
      } as any;

      const result = await executor.initializeSession(session.id);

      expect(toolCalls).toBe(0);
      expect(result?.response).toContain('Select a measure before running the aggregate search.');
      expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
        'Select a measure before running the aggregate search.',
      );
    });

    test('structural BEFORE returning results blocks a flow response before delivery', async () => {
      const dsl = `
AGENT: Flow_Before_Response_Test

GOAL: "Test structural BEFORE response checkpoints in flow mode"

CONSTRAINTS:
  - REQUIRE results_reviewed == true BEFORE returning results
    ON_FAIL: Review the results before responding.

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "This should not be returned."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Flow_Before_Response_Test'),
      );

      const result = await executor.initializeSession(session.id);

      expect(result?.response).toContain('Review the results before responding.');
      expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
        'Review the results before responding.',
      );
    });
  });

  // ===========================================================================
  // CONSTRAINT AUTO-GUARD (unset variables)
  // ===========================================================================

  describe('Constraint auto-guard', () => {
    test('Constraint with unset variable passes (auto-guard)', async () => {
      // When a constraint references a variable that is not yet set,
      // the auto-guard should make it pass (not fail)
      const dsl = `
AGENT: AutoGuard_Test

GOAL: "Test auto-guard"

CONSTRAINTS:
  - REQUIRE destination != origin
    ON_FAIL: Destination and origin must differ.

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - destination: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'AutoGuard_Test'),
      );
      // Neither destination nor origin is set
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'Paris');

      // Auto-guard should let unset variables pass
      expect(session.data.values.destination).toBeDefined();
      expect(session.isComplete).toBe(true);
    });
  });
});
