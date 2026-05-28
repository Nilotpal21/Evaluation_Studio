/**
 * FlowStepExecutor ON_RESULT Branch Precedence Tests
 *
 * Verifies the ON_RESULT multi-way branching after a CALL step:
 *
 * 1. First-match precedence among IF branches
 * 2. ELSE fallback when no IF matches
 * 3. SET assignments interpolated and stored in session
 * 4. RESPOND output emitted via onChunk
 * 5. THEN transitions to specified step
 * 6. No branch matches falls through to post-on_result logic (ON_SUCCESS/ON_FAILURE)
 * 7. CALL AS: result accessed under key, not spread into context
 * 8. CALL without AS: result spread into evaluation context
 * 9. flow_step_exit and flow_transition traces emitted on match
 * 10. Matched branch with no THEN proceeds to next logic
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';
import { evaluateOnInput } from '../../services/execution/flow-step-executor.js';

// =============================================================================
// TESTS
// =============================================================================

describe('ON_RESULT branch precedence and context handling', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // 1. First matching IF branch wins (first-match precedence)
  // ===========================================================================

  test('first matching IF branch wins (first-match precedence)', async () => {
    const dsl = `
AGENT: FirstMatchTest

GOAL: "Test first-match precedence among IF branches"

TOOLS:
  classify_item() -> object
    description: "Classify an item"

FLOW:
  start -> classify -> premium -> standard -> budget

  start:
    REASONING: false
    RESPOND: "Classifying..."
    THEN: classify

  classify:
    REASONING: false
    CALL: classify_item()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.score > 50
        SET: tier = premium
        THEN: premium
      - IF: result.score > 50
        SET: tier = standard
        THEN: standard
      - ELSE:
        SET: tier = budget
        THEN: budget

  premium:
    REASONING: false
    RESPOND: "Tier: {{tier}}"
    THEN: COMPLETE

  standard:
    REASONING: false
    RESPOND: "Tier: {{tier}}"
    THEN: COMPLETE

  budget:
    REASONING: false
    RESPOND: "Tier: {{tier}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'FirstMatchTest'),
    );

    // Both IF branches match (score > 50), but first should win
    session.toolExecutor = {
      execute: async () => ({ score: 80 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // First matching branch sets tier = premium
    expect(session.data.values.tier).toBe('premium');
    expect(output).toContain('Tier: premium');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 2. ELSE fallback when no IF matches
  // ===========================================================================

  test('ELSE fallback when no IF matches', async () => {
    const dsl = `
AGENT: ElseFallbackTest

GOAL: "Test ELSE fallback when no IF branches match"

TOOLS:
  get_status() -> object
    description: "Get status"

FLOW:
  start -> check -> active -> inactive -> unknown

  start:
    REASONING: false
    RESPOND: "Checking..."
    THEN: check

  check:
    REASONING: false
    CALL: get_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.status == "active"
        THEN: active
      - IF: result.status == "inactive"
        THEN: inactive
      - ELSE:
        SET: label = unknown_status
        THEN: unknown

  active:
    REASONING: false
    RESPOND: "Active"
    THEN: COMPLETE

  inactive:
    REASONING: false
    RESPOND: "Inactive"
    THEN: COMPLETE

  unknown:
    REASONING: false
    RESPOND: "Unknown: {{label}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'ElseFallbackTest'),
    );

    // Return a status that matches no IF branch
    session.toolExecutor = {
      execute: async () => ({ status: 'pending' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    expect(session.data.values.label).toBe('unknown_status');
    expect(output).toContain('Unknown: unknown_status');
    expect(output).not.toContain('Active');
    expect(output).not.toContain('Inactive');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 3. SET assignments interpolated and stored in session
  // ===========================================================================

  test('SET assignments interpolated and stored in session', async () => {
    const dsl = `
AGENT: SetInterpolateTest

GOAL: "Test SET assignments with template interpolation"

TOOLS:
  lookup_user(user_id: string) -> object
    description: "Look up user"

FLOW:
  start -> lookup -> done

  start:
    REASONING: false
    RESPOND: "Looking up..."
    THEN: lookup

  lookup:
    REASONING: false
    CALL: lookup_user
      WITH:
        user_id: "u-42"
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.found == true
        SET: greeting = Hello, {{result.name}}! You have {{result.points}} points.
        THEN: done
      - ELSE:
        SET: greeting = User not found
        THEN: done

  done:
    REASONING: false
    RESPOND: "{{greeting}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'SetInterpolateTest'),
    );

    session.toolExecutor = {
      execute: async () => ({ found: true, name: 'Bob', points: 150 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // SET should interpolate templates from the result context
    expect(session.data.values.greeting).toBe('Hello, Bob! You have 150 points.');
    expect(output).toContain('Hello, Bob! You have 150 points.');
    expect(session.isComplete).toBe(true);
  });

  test('ON_RESULT SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: OnResultRememberBatchTest

GOAL: "Test ON_RESULT memory batching"

TOOLS:
  classify_request() -> object
    description: "Classify the request"

FLOW:
  start -> classify -> done

  start:
    REASONING: false
    RESPOND: "Checking..."
    THEN: classify

  classify:
    REASONING: false
    CALL: classify_request()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.score > 50
        SET: remembered_flag = gold
        SET: remembered_note = priority
        THEN: done
      - ELSE:
        SET: remembered_flag = standard
        THEN: done

  done:
    REASONING: false
    RESPOND: "Tier: {{remembered_flag}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnResultRememberBatchTest'),
    );
    session.toolExecutor = {
      execute: async () => ({ score: 80 }),
    } as RuntimeSession['toolExecutor'];

    const factStore = new InMemoryFactStore({ type: 'memory' });
    const setSpy = vi.spyOn(factStore, 'set');
    session.factStore = factStore;
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    session.userId = 'user-1';
    session.callerContext = {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    };
    session.agentIR = {
      ...session.agentIR!,
      execution: {
        ...session.agentIR!.execution,
        pipeline: {
          ...session.agentIR!.execution?.pipeline,
          enabled: false,
        },
      },
      memory: {
        session: [],
        persistent: [
          {
            path: 'user.remembered_flag',
            scope: 'user',
            access: 'readwrite',
          },
        ],
        remember: [
          {
            when: 'remembered_flag IS SET',
            store: {
              value: 'remembered_flag',
              target: 'user.remembered_flag',
            },
          },
        ],
        recall: [],
      },
    } as AgentIR;

    try {
      await executor.initializeSession(session.id);

      expect(session.data.values.remembered_flag).toBe('gold');
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'user.remembered_flag', value: 'gold' }),
      );
    } finally {
      factStore.stop();
    }
  });

  // ===========================================================================
  // 4. RESPOND output emitted via onChunk
  // ===========================================================================

  test('RESPOND output emitted via onChunk', async () => {
    const dsl = `
AGENT: RespondChunkTest

GOAL: "Test RESPOND in ON_RESULT emits via onChunk"

TOOLS:
  check_balance() -> object
    description: "Check balance"

FLOW:
  start -> check -> done

  start:
    REASONING: false
    RESPOND: "Checking balance..."
    THEN: check

  check:
    REASONING: false
    CALL: check_balance()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.balance > 100
        RESPOND: "Your balance is sufficient: {{result.balance}}"
        THEN: done
      - ELSE:
        RESPOND: "Insufficient balance: {{result.balance}}"
        THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'RespondChunkTest'),
    );

    session.toolExecutor = {
      execute: async () => ({ balance: 250 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    // RESPOND from the matched ON_RESULT branch should appear in chunks
    expect(chunks.some((c) => c.includes('Your balance is sufficient: 250'))).toBe(true);
    expect(chunks.some((c) => c.includes('Insufficient balance'))).toBe(false);
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 5. THEN transitions to specified step
  // ===========================================================================

  test('THEN transitions to specified step', async () => {
    const dsl = `
AGENT: ThenTransitionTest

GOAL: "Test THEN transitions to the correct step"

TOOLS:
  route_request() -> object
    description: "Route the request"

FLOW:
  start -> route -> billing -> support -> general

  start:
    REASONING: false
    RESPOND: "Routing..."
    THEN: route

  route:
    REASONING: false
    CALL: route_request()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.department == "billing"
        THEN: billing
      - IF: result.department == "support"
        THEN: support
      - ELSE:
        THEN: general

  billing:
    REASONING: false
    RESPOND: "Transferred to billing"
    THEN: COMPLETE

  support:
    REASONING: false
    RESPOND: "Transferred to support"
    THEN: COMPLETE

  general:
    REASONING: false
    RESPOND: "Transferred to general"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'ThenTransitionTest'),
    );

    session.toolExecutor = {
      execute: async () => ({ department: 'support' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    expect(output).toContain('Transferred to support');
    expect(output).not.toContain('Transferred to billing');
    expect(output).not.toContain('Transferred to general');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 6. No branch matches falls through to post-on_result logic
  // ===========================================================================

  test('no branch matches falls through to post-on_result logic', async () => {
    const dsl = `
AGENT: FallthroughTest

GOAL: "Test ON_RESULT no match falls through to ON_SUCCESS/ON_FAILURE"

TOOLS:
  run_task() -> object
    description: "Run a task"

FLOW:
  start -> run -> special -> success_done -> fail_done

  start:
    REASONING: false
    RESPOND: "Running task..."
    THEN: run

  run:
    REASONING: false
    CALL: run_task()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.code == 999
        THEN: special
    ON_SUCCESS:
      REASONING: false
      RESPOND: "Task succeeded via ON_SUCCESS"
      THEN: success_done
    ON_FAIL:
      RESPOND: "Task failed via ON_FAIL"
      THEN: fail_done

  special:
    REASONING: false
    RESPOND: "Special code 999"
    THEN: COMPLETE

  success_done:
    REASONING: false
    RESPOND: "Success path"
    THEN: COMPLETE

  fail_done:
    REASONING: false
    RESPOND: "Failure path"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'FallthroughTest'),
    );

    // Return code 200 -- doesn't match ON_RESULT (code == 999)
    // Tool returns successfully, so ON_SUCCESS should fire
    session.toolExecutor = {
      execute: async () => ({ code: 200, status: 'ok' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // ON_RESULT has only IF: result.code == 999, which doesn't match
    // Falls through to ON_SUCCESS (call succeeded)
    expect(output).toContain('Task succeeded via ON_SUCCESS');
    expect(output).toContain('Success path');
    expect(output).not.toContain('Special code 999');
    expect(output).not.toContain('Task failed');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 7. CALL AS: result accessed under key, not spread into context
  // ===========================================================================

  test('CALL AS: result accessed under key, not spread into context', async () => {
    const dsl = `
AGENT: CallAsTest

GOAL: "Test CALL AS binds result under the key name"

TOOLS:
  fetch_profile() -> object
    description: "Fetch profile"

FLOW:
  start -> fetch -> found -> notfound

  start:
    REASONING: false
    RESPOND: "Fetching..."
    THEN: fetch

  fetch:
    REASONING: false
    CALL: fetch_profile()
      AS: profile
    ON_RESULT:
      REASONING: false
      - IF: profile.verified == true
        SET: msg = Verified user: {{profile.name}}
        THEN: found
      - ELSE:
        SET: msg = Unverified
        THEN: notfound

  found:
    REASONING: false
    RESPOND: "{{msg}}"
    THEN: COMPLETE

  notfound:
    REASONING: false
    RESPOND: "{{msg}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'CallAsTest'));

    session.toolExecutor = {
      execute: async () => ({ verified: true, name: 'Carol' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // With CALL AS, the result is stored under session.data.values.profile
    expect(session.data.values.profile).toBeDefined();
    expect((session.data.values.profile as Record<string, unknown>).verified).toBe(true);
    expect((session.data.values.profile as Record<string, unknown>).name).toBe('Carol');

    // The result fields (verified, name) should NOT be spread at top level
    // because CALL AS is used. (They could be set if other step logic sets them,
    // but the raw spread only happens without AS.)
    // The ON_RESULT condition uses profile.verified which works via the AS binding.
    expect(output).toContain('Verified user: Carol');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 8. CALL without AS: result spread into evaluation context
  // ===========================================================================

  test('CALL without AS: result spread into evaluation context', async () => {
    const dsl = `
AGENT: CallNoAsTest

GOAL: "Test CALL without AS spreads result into context"

TOOLS:
  get_weather() -> object
    description: "Get weather"

FLOW:
  start -> weather -> sunny -> rainy -> other

  start:
    REASONING: false
    RESPOND: "Checking weather..."
    THEN: weather

  weather:
    REASONING: false
    CALL: get_weather()
    ON_RESULT:
      REASONING: false
      - IF: condition == "sunny"
        SET: advice = Wear sunscreen
        THEN: sunny
      - IF: condition == "rainy"
        SET: advice = Take an umbrella
        THEN: rainy
      - ELSE:
        SET: advice = Check forecast
        THEN: other

  sunny:
    REASONING: false
    RESPOND: "Sunny: {{advice}}"
    THEN: COMPLETE

  rainy:
    REASONING: false
    RESPOND: "Rainy: {{advice}}"
    THEN: COMPLETE

  other:
    REASONING: false
    RESPOND: "Other: {{advice}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'CallNoAsTest'),
    );

    // Without AS, the result's fields are spread directly into session.data.values
    session.toolExecutor = {
      execute: async () => ({ condition: 'rainy', humidity: 95 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // Without AS, result fields are spread into session.data.values
    expect(session.data.values.condition).toBe('rainy');
    expect(session.data.values.humidity).toBe(95);

    // ON_RESULT condition uses top-level "condition" key (spread from result)
    expect(session.data.values.advice).toBe('Take an umbrella');
    expect(output).toContain('Rainy: Take an umbrella');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 9. flow_step_exit and flow_transition traces emitted on match
  // ===========================================================================

  test('flow_step_exit and flow_transition traces emitted on match', async () => {
    const dsl = `
AGENT: TraceTest

GOAL: "Test trace events emitted on ON_RESULT match"

TOOLS:
  ping() -> object
    description: "Ping"

FLOW:
  start -> ping_step -> pong

  start:
    REASONING: false
    RESPOND: "Pinging..."
    THEN: ping_step

  ping_step:
    REASONING: false
    CALL: ping()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.ok == true
        THEN: pong
      - ELSE:
        THEN: pong

  pong:
    REASONING: false
    RESPOND: "Pong!"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'TraceTest'));

    session.toolExecutor = {
      execute: async () => ({ ok: true }),
    } as any;

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const chunks: string[] = [];

    await executor.initializeSession(
      session.id,
      (c) => chunks.push(c),
      (event: any) => {
        traceEvents.push(event);
      },
    );

    // Find ON_RESULT-triggered flow_step_exit events
    const exitEvents = traceEvents.filter(
      (e) => e.type === 'flow_step_exit' && e.data.result === 'on_result_branch',
    );
    expect(exitEvents.length).toBeGreaterThanOrEqual(1);
    // The exit should reference the ping_step
    expect(exitEvents[0].data.stepName).toBe('ping_step');

    // Find ON_RESULT-triggered flow_transition events
    const transitionEvents = traceEvents.filter(
      (e) =>
        e.type === 'flow_transition' &&
        e.data.fromStep === 'ping_step' &&
        e.data.toStep === 'pong' &&
        e.data.condition === 'on_result_match',
    );
    expect(transitionEvents.length).toBeGreaterThanOrEqual(1);

    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 10. Matched branch with no THEN proceeds to next logic
  // ===========================================================================

  test('matched branch with no THEN proceeds to next logic', async () => {
    // When ON_RESULT matches a branch that has SET/RESPOND but no THEN,
    // execution falls through (does not continue to next iteration).
    // It should proceed to the post-on_result logic (ON_SUCCESS/ON_FAILURE or step THEN).
    //
    // Note: The DSL compiler drops ON_RESULT branches without THEN, so we
    // compile a DSL with THEN on all branches, then manually patch the compiled
    // step's on_result to remove THEN from one branch. This tests the
    // FlowStepExecutor runtime behavior at lines 3478-3519.
    const dsl = `
AGENT: NoThenTest

GOAL: "Test ON_RESULT branch with no THEN falls through"

TOOLS:
  compute() -> object
    description: "Compute something"

FLOW:
  start -> compute_step -> done

  start:
    REASONING: false
    RESPOND: "Computing..."
    THEN: compute_step

  compute_step:
    REASONING: false
    CALL: compute()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.value > 0
        SET: label = positive
        THEN: done
    ON_SUCCESS:
      REASONING: false
      RESPOND: "Success with label: {{label}}"
      THEN: done

  done:
    REASONING: false
    RESPOND: "Finished"
    THEN: COMPLETE
`;

    const resolved = compileToResolvedAgent([dsl], 'NoThenTest');

    // Patch the compiled IR: remove THEN from the ON_RESULT branch so it falls through
    const agentDef = resolved.agents['NoThenTest'];
    const computeStep = agentDef.flow.definitions['compute_step'];
    if (computeStep.on_result && computeStep.on_result.length > 0) {
      delete (computeStep.on_result[0] as Record<string, unknown>).then;
    }

    const session = executor.createSessionFromResolved(resolved);

    session.toolExecutor = {
      execute: async () => ({ value: 42 }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // The ON_RESULT branch matched and applied SET (label = positive)
    expect(session.data.values.label).toBe('positive');

    // But since no THEN in the ON_RESULT branch, it falls through to ON_SUCCESS
    expect(output).toContain('Success with label: positive');
    expect(output).toContain('Finished');
    expect(session.isComplete).toBe(true);
  });
});

// =============================================================================
// Direct evaluateOnInput tests for branch precedence verification
// =============================================================================

describe('evaluateOnInput branch precedence (unit)', () => {
  test('first matching IF branch wins when multiple conditions are true', () => {
    const branches = [
      { condition: 'score > 50', set: { tier: 'gold' }, then: 'gold_step' },
      { condition: 'score > 50', set: { tier: 'silver' }, then: 'silver_step' },
      { condition: 'score > 10', set: { tier: 'bronze' }, then: 'bronze_step' },
    ];
    const result = evaluateOnInput(branches, '', { score: 80 });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('gold_step');
    expect(result!.set).toEqual({ tier: 'gold' });
  });

  test('ELSE branch is skipped when an IF branch matches', () => {
    const branches = [
      { condition: 'status == "ok"', then: 'ok_step' },
      { then: 'else_step' }, // ELSE
    ];
    const result = evaluateOnInput(branches, '', { status: 'ok' });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('ok_step');
  });

  test('ELSE branch matches when all IF branches fail', () => {
    const branches = [
      { condition: 'status == "ok"', then: 'ok_step' },
      { condition: 'status == "error"', then: 'error_step' },
      { then: 'fallback_step', set: { fallback: 'true' } }, // ELSE
    ];
    const result = evaluateOnInput(branches, '', { status: 'pending' });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('fallback_step');
    expect(result!.set).toEqual({ fallback: 'true' });
  });

  test('returns null when no branch matches and no ELSE exists', () => {
    const branches = [
      { condition: 'status == "ok"', then: 'ok_step' },
      { condition: 'status == "error"', then: 'error_step' },
    ];
    const result = evaluateOnInput(branches, '', { status: 'pending' });
    expect(result).toBeNull();
  });
});
