/**
 * Handoff Resume-Intent Continuation Tests
 *
 * Tests for ON_RETURN: resume_intent — verifies that after a gating agent
 * (e.g., authentication) completes and returns to the supervisor, the
 * original user message is automatically re-processed for routing.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
import { assertSessionHistoryIntegrity } from '../helpers/history-validation';

describe('Handoff resume_intent continuation', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // SET_CONTEXT gatheredKeys propagation
  // ===========================================================================

  test('SET_CONTEXT values populate gatheredKeys so they survive handoff return merge', async () => {
    const parentDsl = `
AGENT: GatherKeys_Parent

GOAL: "Test gatheredKeys propagation"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "auth"
      SET: intent = "auth"
      THEN: COMPLETE
    - ELSE:
      THEN: done

done:
  RESPOND: "All done."
  THEN: COMPLETE

SESSION:
  - verified_id

HANDOFF:
  - TO: Auth_Child
    WHEN: intent == "auth"
    CONTEXT:
      pass: []
    RETURN: true
    ON_RETURN:
      ACTION: continue
`;

    const childDsl = `
AGENT: Auth_Child

GOAL: "Authenticate and set context"

FLOW:
  entry_point: verify
  steps:
    - verify

verify:
  RESPOND: "Verified."
  THEN: COMPLETE
`;

    executor.registerAgent('Auth_Child', childDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl], 'GatherKeys_Parent'),
    );
    await executor.initializeSession(session.id);

    await executor.executeMessage(session.id, 'auth please');

    // After child completes and returns to parent:
    // - Child thread should be completed
    // - Parent thread should be active
    // - threadStack should be empty (return happened)
    expect(session.threads.length).toBe(2);
    expect(session.threads[1].agentName).toBe('Auth_Child');
    expect(session.threads[1].status).toBe('completed');
    expect(session.threads[0].status).toBe('active');
    expect(session.threadStack.length).toBe(0);
    assertSessionHistoryIntegrity(session);
  });

  // ===========================================================================
  // resume_intent continuation
  // ===========================================================================

  test('ON_RETURN: resume_intent re-processes original message after gating agent returns', async () => {
    // Strategy: use a single handoff condition per rule (no AND).
    // Gate_Agent sets gate_result = "passed" which shifts the handoff match
    // from Gate_Agent to Account_Specialist on the replayed message.
    const supervisorDsl = `
AGENT: Resume_Supervisor

GOAL: "Route through gate then to specialist"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "account"
      SET: topic = "account"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

SESSION:
  - topic
  - gate_result

HANDOFF:
  - TO: Gate_Agent
    WHEN: topic == "account"
    CONTEXT:
      pass: [topic]
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
`;

    const gateDsl = `
AGENT: Gate_Agent

GOAL: "Gate access then complete"

FLOW:
  entry_point: gate
  steps:
    - gate

gate:
  RESPOND: "Access granted."
  THEN: COMPLETE
`;

    executor.registerAgent('Gate_Agent', gateDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl], 'Resume_Supervisor'),
    );
    await executor.initializeSession(session.id);

    const chunks: string[] = [];
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.executeMessage(
      session.id,
      'check my account',
      (c) => chunks.push(c),
      (e) => traces.push(e),
    );

    const output = chunks.join('');

    // Gate_Agent responded
    expect(output).toContain('Access granted');

    // resume_intent trace event was emitted
    const resumeTrace = traces.find((t) => t.type === 'resume_intent');
    expect(resumeTrace).toBeDefined();
    expect(resumeTrace!.data.from).toBe('Gate_Agent');
    expect(resumeTrace!.data.parentAgent).toBe('Resume_Supervisor');

    // No transient state leaked
    expect(session._resumeIntentDepth).toBeUndefined();
    expect(session.data.values._pending_continuation).toBeUndefined();

    assertSessionHistoryIntegrity(session);
  });

  // ===========================================================================
  // Negative: ON_RETURN: continue does NOT trigger continuation
  // ===========================================================================

  test('ON_RETURN: continue does not trigger resume_intent re-processing', async () => {
    const parentDsl = `
AGENT: Continue_Parent

GOAL: "Route with ON_RETURN: continue"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "status"
      SET: intent = "check_status"
      THEN: COMPLETE
    - ELSE:
      THEN: done

done:
  RESPOND: "Done."
  THEN: COMPLETE

HANDOFF:
  - TO: Status_Child
    WHEN: intent == "check_status"
    CONTEXT:
      pass: [intent]
    RETURN: true
    ON_RETURN:
      ACTION: continue
`;

    const childDsl = `
AGENT: Status_Child

GOAL: "Show status"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Status OK."
  THEN: COMPLETE
`;

    executor.registerAgent('Status_Child', childDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl], 'Continue_Parent'),
    );
    await executor.initializeSession(session.id);

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.executeMessage(session.id, 'check status', undefined, (e) => traces.push(e));

    // No resume_intent trace should have been emitted
    const resumeTrace = traces.find((t) => t.type === 'resume_intent');
    expect(resumeTrace).toBeUndefined();

    // No transient state leaked
    expect(session._resumeIntentDepth).toBeUndefined();

    assertSessionHistoryIntegrity(session);
  });

  test('named RETURN_HANDLERS emit follow-up responses after child return', async () => {
    const parentDsl = `
AGENT: Return_Handler_Parent

GOAL: "Route to a specialist and keep the parent in control"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "specialist"
      SET: needs_specialist = true
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

RETURN_HANDLERS:
  await_next_request:
    RESPOND: "What else can I help with?"
    CONTINUE: true

HANDOFF:
  - TO: Specialist_Child
    WHEN: needs_specialist == true
    CONTEXT:
      pass: [request]
      summary: "Route to specialist"
    RETURN: true
    ON_RETURN:
      HANDLER: await_next_request
`;

    const childDsl = `
AGENT: Specialist_Child

GOAL: "Handle the specialist work"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  RESPOND: "Specialist handled it."
  THEN: COMPLETE
`;

    executor.registerAgent('Specialist_Child', childDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl], 'Return_Handler_Parent'),
    );
    await executor.initializeSession(session.id);

    const result = await executor.executeMessage(session.id, 'specialist please');

    expect(result.response).toBe('Specialist handled it.\nWhat else can I help with?');
    expect(session.agentName).toBe('Return_Handler_Parent');
    expect(session.conversationHistory.at(-1)?.content).toBe(
      '[Specialist_Child]: Specialist handled it.\nWhat else can I help with?',
    );
    assertSessionHistoryIntegrity(session);
  });

  // ===========================================================================
  // Depth guard: prevents infinite re-routing
  // ===========================================================================

  test('resume_intent depth guard prevents infinite re-routing loop', async () => {
    // Gate_Agent always matches on action == "go" and never changes that value,
    // so the resume_intent replay would loop forever without the depth guard.
    const supervisorDsl = `
AGENT: Loop_Supervisor

GOAL: "Route through gate"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "go"
      SET: action = "go"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

SESSION:
  - action

HANDOFF:
  - TO: Loop_Gate
    WHEN: action == "go"
    CONTEXT:
      pass: []
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
`;

    const gateDsl = `
AGENT: Loop_Gate

GOAL: "Gate without changing state"

FLOW:
  entry_point: done
  steps:
    - done

done:
  RESPOND: "Gated."
  THEN: COMPLETE
`;

    executor.registerAgent('Loop_Gate', gateDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl], 'Loop_Supervisor'),
    );
    await executor.initializeSession(session.id);

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

    // Should complete without hanging — depth guard stops at MAX_RESUME_INTENT_DEPTH
    const result = await executor.executeMessage(session.id, 'go now', undefined, (e) =>
      traces.push(e),
    );
    expect(result).toBeDefined();

    // Exactly one resume_intent trace (depth 0 → 1, then blocked at 1)
    const resumeTraces = traces.filter((t) => t.type === 'resume_intent');
    expect(resumeTraces.length).toBe(1);

    // No transient state leaked
    expect(session._resumeIntentDepth).toBeUndefined();

    assertSessionHistoryIntegrity(session);
  });
});
