/**
 * ON_RESULT Multi-Way Branching Tests
 *
 * Tests for the ON_RESULT feature in FlowStepExecutor:
 * After a CALL step executes, ON_RESULT branches are evaluated using evaluateOnInput(),
 * and the first matching branch determines the next step.
 *
 * Covers:
 * - First IF branch matching -> transition
 * - ELSE branch fallback when no IF matches
 * - SET assignments within branches
 * - RESPOND output from branches
 * - CALL AS binding (result bound to named variable)
 * - CALL without AS (result fields spread into context)
 * - Fallthrough to normal branching when no ON_RESULT branch matches
 * - Trace events (flow_step_exit with on_result_branch, flow_transition with on_result_match)
 * - Multiple IF branches with first-match-wins semantics
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('ON_RESULT multi-way branching', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // 1. First IF branch matches -> transitions to branch.then
  // ===========================================================================

  test('ON_RESULT first branch matches -> transitions to branch.then', async () => {
    const dsl = `
AGENT: OnResult_FirstMatch

GOAL: "Test ON_RESULT first IF match"

TOOLS:
  check_status() -> object
    description: "Check status"

FLOW:
  start -> check -> active_step -> inactive_step

  start:
    REASONING: false
    RESPOND: "Starting check"
    THEN: check

  check:
    CALL: check_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.status == "active"
        THEN: active_step
      - ELSE:
        THEN: inactive_step

  active_step:
    REASONING: false
    RESPOND: "Status is active!"
    THEN: COMPLETE

  inactive_step:
    REASONING: false
    RESPOND: "Status is inactive."
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_FirstMatch'),
    );
    session.toolExecutor = {
      execute: async () => ({ status: 'active' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Status is active!');
    expect(output).not.toContain('Status is inactive');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 2. ELSE branch fallback when no IF matches
  // ===========================================================================

  test('ON_RESULT ELSE branch -> fallback when no IF matches', async () => {
    const dsl = `
AGENT: OnResult_Else

GOAL: "Test ON_RESULT ELSE fallback"

TOOLS:
  check_status() -> object
    description: "Check status"

FLOW:
  start -> check -> active_step -> fallback

  start:
    REASONING: false
    RESPOND: "Starting check"
    THEN: check

  check:
    CALL: check_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.status == "active"
        THEN: active_step
      - ELSE:
        RESPOND: "Unknown status, falling back."
        THEN: fallback

  active_step:
    REASONING: false
    RESPOND: "Status is active!"
    THEN: COMPLETE

  fallback:
    REASONING: false
    RESPOND: "Reached fallback step."
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_Else'),
    );
    session.toolExecutor = {
      execute: async () => ({ status: 'unknown' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Unknown status, falling back.');
    expect(output).toContain('Reached fallback step.');
    expect(output).not.toContain('Status is active');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 3. SET assignments in ON_RESULT branch
  // ===========================================================================

  test('ON_RESULT with SET assignments in branch', async () => {
    const dsl = `
AGENT: OnResult_Set

GOAL: "Test ON_RESULT SET"

TOOLS:
  check_status() -> object
    description: "Check status"

FLOW:
  start -> check -> done

  start:
    REASONING: false
    RESPOND: "Checking..."
    THEN: check

  check:
    CALL: check_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.status == "active"
        SET: message = Status is {{result.status}}
        THEN: done
      - ELSE:
        SET: message = Failed
        THEN: done

  done:
    REASONING: false
    RESPOND: "Result: {{message}}"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_Set'),
    );
    session.toolExecutor = {
      execute: async () => ({ status: 'active' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    expect(session.data.values.message).toBe('Status is active');
    const output = chunks.join('');
    expect(output).toContain('Result: Status is active');
  });

  // ===========================================================================
  // 4. RESPOND in ON_RESULT branch
  // ===========================================================================

  test('ON_RESULT with RESPOND in branch', async () => {
    const dsl = `
AGENT: OnResult_Respond

GOAL: "Test ON_RESULT RESPOND"

TOOLS:
  count_items() -> object
    description: "Count items"

FLOW:
  start -> count -> done

  start:
    REASONING: false
    RESPOND: "Counting..."
    THEN: count

  count:
    REASONING: false
    CALL: count_items()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.count > 0
        RESPOND: "Found: {{result.count}} items"
        THEN: done
      - ELSE:
        RESPOND: "No items found"
        THEN: done

  done:
    REASONING: false
    RESPOND: "Finished."
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_Respond'),
    );
    session.toolExecutor = {
      execute: async () => ({ count: 5 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Found: 5 items');
    expect(output).toContain('Finished.');
    expect(output).not.toContain('No items found');
  });

  // ===========================================================================
  // 5. CALL AS binding: result bound to named variable
  // ===========================================================================

  test('ON_RESULT with call_as binding evaluates condition against named variable', async () => {
    const dsl = `
AGENT: OnResult_CallAs

GOAL: "Test ON_RESULT with CALL AS"

TOOLS:
  fetch_api() -> object
    description: "Fetch API"

FLOW:
  start -> fetch -> ok_step -> err_step

  start:
    REASONING: false
    RESPOND: "Fetching..."
    THEN: fetch

  fetch:
    REASONING: false
    CALL: fetch_api()
      AS: apiResult
    ON_RESULT:
      REASONING: false
      - IF: apiResult.code == 200
        RESPOND: "API returned 200"
        THEN: ok_step
      - ELSE:
        RESPOND: "API error"
        THEN: err_step

  ok_step:
    REASONING: false
    RESPOND: "Success path"
    THEN: COMPLETE

  err_step:
    REASONING: false
    RESPOND: "Error path"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_CallAs'),
    );
    session.toolExecutor = {
      execute: async () => ({ code: 200, data: 'payload' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('API returned 200');
    expect(output).toContain('Success path');
    // Verify the result is stored under the AS variable name
    expect(session.data.values.apiResult).toEqual({ code: 200, data: 'payload' });
  });

  // ===========================================================================
  // 6. CALL without AS: result fields spread into context
  // ===========================================================================

  test('ON_RESULT without call_as spreads result fields into context', async () => {
    const dsl = `
AGENT: OnResult_NoAs

GOAL: "Test ON_RESULT without AS"

TOOLS:
  check_ok() -> object
    description: "Check OK"

FLOW:
  start -> check -> pass -> fail

  start:
    REASONING: false
    RESPOND: "Checking..."
    THEN: check

  check:
    CALL: check_ok()
    ON_RESULT:
      REASONING: false
      - IF: ok == true
        RESPOND: "Check passed"
        THEN: pass
      - ELSE:
        RESPOND: "Check failed"
        THEN: fail

  pass:
    REASONING: false
    RESPOND: "Pass step reached"
    THEN: COMPLETE

  fail:
    REASONING: false
    RESPOND: "Fail step reached"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_NoAs'),
    );
    session.toolExecutor = {
      execute: async () => ({ ok: true, detail: 'all good' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Check passed');
    expect(output).toContain('Pass step reached');
    expect(output).not.toContain('Check failed');
  });

  // ===========================================================================
  // 7. No ON_RESULT branch matches -> falls through to normal branching
  // ===========================================================================

  test('ON_RESULT no branch matches -> falls through to normal THEN handling', async () => {
    const dsl = `
AGENT: OnResult_Fallthrough

GOAL: "Test ON_RESULT fallthrough"

TOOLS:
  get_data() -> object
    description: "Get data"

FLOW:
  start -> fetch -> default_next

  start:
    REASONING: false
    RESPOND: "Fetching..."
    THEN: fetch

  fetch:
    REASONING: false
    CALL: get_data()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.code == 200
        THEN: default_next
      - IF: result.code == 404
        THEN: default_next
    RESPOND: "Fell through to step respond"
    THEN: default_next

  default_next:
    REASONING: false
    RESPOND: "Reached default_next"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_Fallthrough'),
    );
    // Return a code that matches neither 200 nor 404
    session.toolExecutor = {
      execute: async () => ({ code: 500 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    // Since no ON_RESULT branch matched, it should fall through to step's RESPOND + THEN
    expect(output).toContain('Fell through to step respond');
    expect(output).toContain('Reached default_next');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 8. Trace events: flow_step_exit and flow_transition
  // ===========================================================================

  test('ON_RESULT emits correct trace events', async () => {
    const dsl = `
AGENT: OnResult_Trace

GOAL: "Test ON_RESULT trace events"

TOOLS:
  check_status() -> object
    description: "Check status"

FLOW:
  start -> check -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: check

  check:
    CALL: check_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.ok == true
        THEN: done
      - ELSE:
        THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_Trace'),
    );
    session.toolExecutor = {
      execute: async () => ({ ok: true }),
    } as any;

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.initializeSession(session.id, undefined, (e) => traces.push(e));

    // Find flow_step_exit with result: 'on_result_branch' for the 'check' step
    const exitEvent = traces.find(
      (t) =>
        t.type === 'flow_step_exit' &&
        t.data.stepName === 'check' &&
        t.data.result === 'on_result_branch',
    );
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.data.agentName).toBe('OnResult_Trace');

    // Find flow_transition with condition: 'on_result_match'
    const transitionEvent = traces.find(
      (t) =>
        t.type === 'flow_transition' &&
        t.data.fromStep === 'check' &&
        t.data.toStep === 'done' &&
        t.data.condition === 'on_result_match',
    );
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent!.data.agentName).toBe('OnResult_Trace');

    const decisionEvent = traces.find(
      (t) =>
        t.type === 'decision' &&
        t.data.decisionKind === 'flow_transition' &&
        t.data.condition === 'on_result_match',
    );
    expect(decisionEvent).toBeDefined();
    expect((decisionEvent!.data.trigger as { source?: string }).source).toBe('call_result');
  });

  // ===========================================================================
  // 9. Multiple IF branches -> first match wins
  // ===========================================================================

  test('ON_RESULT multiple IF branches -> first match wins', async () => {
    const dsl = `
AGENT: OnResult_FirstWins

GOAL: "Test ON_RESULT first match wins"

TOOLS:
  get_score() -> object
    description: "Get score"

FLOW:
  start -> evaluate -> high -> medium -> low

  start:
    REASONING: false
    RESPOND: "Evaluating..."
    THEN: evaluate

  evaluate:
    REASONING: false
    CALL: get_score()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.score > 90
        RESPOND: "Excellent!"
        THEN: high
      - IF: result.score > 50
        RESPOND: "Good"
        THEN: medium
      - IF: result.score > 10
        RESPOND: "Needs improvement"
        THEN: low
      - ELSE:
        RESPOND: "Very low"
        THEN: low

  high:
    REASONING: false
    RESPOND: "High path"
    THEN: COMPLETE

  medium:
    REASONING: false
    RESPOND: "Medium path"
    THEN: COMPLETE

  low:
    REASONING: false
    RESPOND: "Low path"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_FirstWins'),
    );
    // Score of 75 matches second branch (> 50) but not first (> 90)
    session.toolExecutor = {
      execute: async () => ({ score: 75 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    // Should match second branch (score > 50), not third (score > 10)
    expect(output).toContain('Good');
    expect(output).toContain('Medium path');
    expect(output).not.toContain('Excellent');
    expect(output).not.toContain('Needs improvement');
    expect(output).not.toContain('Very low');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 9. Deterministic gate: ON_RESULT without CALL
  //    Step has REASONING: false and ON_RESULT IF/ELSE only — no CALL.
  //    Branches must evaluate against session vars (deterministic gate),
  //    or the step exits with `result: 'waiting'` and the agent goes silent.
  //    Repro for the AIS_Orchestrator empty-response symptom.
  // ===========================================================================

  test('ON_RESULT without CALL evaluates against user message and routes (ELSE path)', async () => {
    const dsl = `
AGENT: OnResult_GateNoCall_Else

GOAL: "Test ON_RESULT deterministic gate without CALL"

FLOW:
  start -> gate -> match_path -> default_path

  start:
    REASONING: false
    RESPOND: "Send a message"
    ON_INPUT:
      - ELSE:
        THEN: gate

  gate:
    REASONING: false
    ON_RESULT:
      - IF: STARTS_WITH(input, "__feedback__")
        SET: intent = "feedback"
        THEN: match_path
      - ELSE:
        THEN: default_path

  match_path:
    REASONING: false
    RESPOND: "Feedback received"
    THEN: COMPLETE

  default_path:
    REASONING: false
    RESPOND: "Default path"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_GateNoCall_Else'),
    );

    const initChunks: string[] = [];
    await executor.initializeSession(session.id, (c) => initChunks.push(c));

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'hello world', (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Default path');
    expect(output).not.toContain('Feedback received');
    expect(session.isComplete).toBe(true);
  });

  test('ON_RESULT without CALL routes through IF when session var matches', async () => {
    const dsl = `
AGENT: OnResult_GateNoCall_IF

GOAL: "Test ON_RESULT deterministic gate matches first IF against session vars"

FLOW:
  seed -> gate -> match_path -> default_path

  seed:
    REASONING: false
    SET: utterance = __feedback__:rating=5
    THEN: gate

  gate:
    REASONING: false
    ON_RESULT:
      - IF: STARTS_WITH(utterance, "__feedback__")
        SET: intent = "feedback"
        THEN: match_path
      - ELSE:
        THEN: default_path

  match_path:
    REASONING: false
    RESPOND: "Feedback path"
    THEN: COMPLETE

  default_path:
    REASONING: false
    RESPOND: "Default path"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResult_GateNoCall_IF'),
    );

    const chunks: string[] = [];
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.initializeSession(
      session.id,
      (c) => chunks.push(c),
      (e) => traces.push(e),
    );

    const output = chunks.join('');
    expect(output).toContain('Feedback path');
    expect(output).not.toContain('Default path');
    expect(session.data.values.intent).toContain('feedback');
    expect(session.isComplete).toBe(true);

    const decisionEvent = traces.find(
      (t) =>
        t.type === 'decision' &&
        t.data.decisionKind === 'flow_transition' &&
        t.data.condition === 'on_result_match',
    );
    expect(decisionEvent).toBeDefined();
    expect((decisionEvent!.data.trigger as { source?: string }).source).toBe('flow_context');
  });
});
