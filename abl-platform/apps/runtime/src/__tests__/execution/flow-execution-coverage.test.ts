/**
 * Flow Execution Coverage Tests
 *
 * Tests for ON_START lifecycle, CHECK conditions, CALL branching (ON_SUCCESS/ON_FAILURE),
 * completion conditions, STORE, and constraint guardrails.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('Flow Execution Coverage', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // ON_START LIFECYCLE
  // ===========================================================================

  describe('ON_START lifecycle', () => {
    test('ON_START SET initializes data values before flow', async () => {
      const dsl = `
AGENT: OnStart_Set_Test

GOAL: "Test ON_START SET"

ON_START:
  set: initialized = true
  set: counter = 0

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Ready! initialized={{initialized}}, counter={{counter}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Set_Test'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('initialized=true');
      expect(output).toContain('counter=0');
      expect(session.data.values.initialized).toBe(true);
      expect(session.data.values.counter).toBe(0);
    });

    test('ON_START RESPOND sends message before first flow step', async () => {
      const dsl = `
AGENT: OnStart_Respond_Test

GOAL: "Test ON_START RESPOND"

ON_START:
  respond: "System starting up..."

FLOW:
  entry_point: main
  steps:
    - main

main:
  RESPOND: "Main step reached."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Respond_Test'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      // ON_START respond should come before main step
      const startIdx = output.indexOf('System starting up...');
      const mainIdx = output.indexOf('Main step reached.');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(mainIdx).toBeGreaterThan(startIdx);
    });

    test('ON_START CALL invokes tool and stores result', async () => {
      const dsl = `
AGENT: OnStart_Call_Test

GOAL: "Test ON_START CALL"

TOOLS:
  init_check() -> {status: string}
    description: "Check initialization status"

ON_START:
  call: init_check

FLOW:
  entry_point: main
  steps:
    - main

main:
  RESPOND: "Status: {{last_init_check_result.status}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Call_Test'),
      );

      // Set up mock tool executor
      session.toolExecutor = {
        execute: async (name: string) => {
          if (name === 'init_check') return { status: 'ready' };
          return { error: 'unknown tool' };
        },
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(session.data.values['last_init_check_result']).toEqual({ status: 'ready' });
    });

    test('ON_START CALL WITH/AS binds structured invocation results before flow responds', async () => {
      const dsl = `
AGENT: OnStart_Call_With_As_Test

GOAL: "Test ON_START CALL WITH/AS"

TOOLS:
  lookup_member(memberId: string) -> {name: string}
    description: "Lookup member profile"

ON_START:
  CALL: lookup_member
    WITH:
      memberId: session.member_id
    AS: memberProfile

FLOW:
  entry_point: main
  steps:
    - main

main:
  RESPOND: "Hello {{memberProfile.name}}"
  THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Call_With_As_Test'),
      );
      session.data.values.session = { member_id: 'mem-42' };

      let capturedArgs: Record<string, unknown> | undefined;
      session.toolExecutor = {
        execute: async (_name: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { name: 'Avery' };
        },
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

      expect(capturedArgs).toEqual({ memberId: 'mem-42' });
      expect(session.data.values.memberProfile).toEqual({ name: 'Avery' });
      expect(chunks.join('')).toContain('Hello Avery');
    });

    test('ON_START trace events are emitted', async () => {
      const dsl = `
AGENT: OnStart_Trace_Test

GOAL: "Test ON_START traces"

ON_START:
  set: lang = english
  respond: "Welcome!"

FLOW:
  entry_point: main
  steps:
    - main

main:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Trace_Test'),
      );
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.initializeSession(session.id, undefined, (e) => traces.push(e));

      expect(traces.find((t) => t.type === 'dsl_on_start')).toBeDefined();
      expect(traces.find((t) => t.type === 'dsl_set' && t.data.variable === 'lang')).toBeDefined();
      expect(
        traces.find((t) => t.type === 'dsl_respond' && t.data.source === 'on_start'),
      ).toBeDefined();
    });
  });

  // ===========================================================================
  // CHECK INLINE CONDITIONS
  // ===========================================================================

  describe('CHECK inline conditions', () => {
    test('CHECK passes → step executes normally', async () => {
      const dsl = `
AGENT: Check_Pass_Test

GOAL: "Test CHECK passing"

FLOW:
  entry_point: setup
  steps:
    - setup
    - guarded

setup:
  RESPOND: "Setting up"
  THEN: guarded

guarded:
  CHECK: count > 0
  RESPOND: "Guard passed, count is {{count}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Check_Pass_Test'),
      );
      // Pre-set count to satisfy CHECK
      session.data.values.count = 5;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Guard passed, count is 5');
      expect(session.isComplete).toBe(true);
    });

    test('CHECK fails with ON_FAIL → redirects to fallback step', async () => {
      const dsl = `
AGENT: Check_Fail_Redirect_Test

GOAL: "Test CHECK fail redirect"

FLOW:
  entry_point: setup
  steps:
    - setup
    - guarded
    - fallback

setup:
  RESPOND: "Setting up"
  THEN: guarded

guarded:
  CHECK: count > 0
  ON_FAIL: fallback
  RESPOND: "This should not appear"
  THEN: COMPLETE

fallback:
  RESPOND: "Redirected to fallback because check failed"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Check_Fail_Redirect_Test'),
      );
      // count is not set → CHECK fails → ON_FAIL redirects to fallback
      session.data.values.count = 0;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Redirected to fallback');
      expect(output).not.toContain('This should not appear');
    });

    test('CHECK fails without ON_FAIL → returns error message', async () => {
      const dsl = `
AGENT: Check_Fail_No_Redirect_Test

GOAL: "Test CHECK fail without redirect"

FLOW:
  entry_point: setup
  steps:
    - setup
    - guarded

setup:
  RESPOND: "Setting up"
  THEN: guarded

guarded:
  CHECK: verified == true
  RESPOND: "Verified!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Check_Fail_No_Redirect_Test'),
      );
      // verified not set → CHECK fails, no ON_FAIL

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain(
        "I can't continue because this step's requirements were not met. Please try again.",
      );
      expect(output).not.toContain('verified == true');
    });
  });

  // ===========================================================================
  // CALL + ON_SUCCESS / ON_FAILURE BRANCHING
  // ===========================================================================

  describe('CALL with ON_SUCCESS/ON_FAILURE branching', () => {
    test('CALL success → ON_SUCCESS branch taken', async () => {
      const dsl = `
AGENT: Call_Success_Test

GOAL: "Test CALL success branching"

TOOLS:
  search_hotels(destination: string) -> {hotels: array}
    description: "Search hotels"

FLOW:
  entry_point: search
  steps:
    - search
    - show_results
    - no_results

search:
  CALL: search_hotels(destination)
  ON_SUCCESS:
    REASONING: false
    RESPOND: "Found hotels!"
    THEN: show_results
  ON_FAIL:
    RESPOND: "No hotels found."
    THEN: no_results

show_results:
  RESPOND: "Showing results"
  THEN: COMPLETE

no_results:
  RESPOND: "Try different search"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Success_Test'),
      );
      session.data.values.destination = 'Paris';
      session.toolExecutor = {
        execute: async () => ({ hotels: [{ name: 'Hotel A', price: 100 }] }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Found hotels!');
      expect(output).toContain('Showing results');
      expect(output).not.toContain('No hotels found');
    });

    test('CALL failure → ON_FAIL branch taken', async () => {
      const dsl = `
AGENT: Call_Failure_Test

GOAL: "Test CALL failure branching"

TOOLS:
  search_hotels(destination: string) -> {hotels: array}
    description: "Search hotels"

FLOW:
  entry_point: search
  steps:
    - search
    - show_results
    - retry

search:
  CALL: search_hotels(destination)
  ON_SUCCESS:
    REASONING: false
    RESPOND: "Found hotels!"
    THEN: show_results
  ON_FAIL:
    RESPOND: "Search failed, please retry."
    THEN: retry

show_results:
  RESPOND: "Showing results"
  THEN: COMPLETE

retry:
  GATHER:
    - destination: required
  THEN: search
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Failure_Test'),
      );
      session.data.values.destination = 'Nowhere';
      session.toolExecutor = {
        execute: async () => ({ _error: true, message: 'Service unavailable' }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Search failed, please retry');
      expect(output).not.toContain('Found hotels');
      expect(session.currentFlowStep).toBe('retry');
    });

    test('CALL success with conditional branches evaluates conditions', async () => {
      const dsl = `
AGENT: Call_Branch_Test

GOAL: "Test CALL conditional branches"

TOOLS:
  check_availability(room_type: string) -> {available: boolean, price: number}
    description: "Check room availability"

FLOW:
  entry_point: check
  steps:
    - check
    - book
    - waitlist

check:
  CALL: check_availability(room_type)
  ON_SUCCESS:
    REASONING: false
    - IF: check_availability.available == true
      SET: can_book = true
      RESPOND: "Room available at \${{check_availability.price}}/night!"
      THEN: book
    - ELSE:
      RESPOND: "No availability, adding to waitlist."
      THEN: waitlist

book:
  RESPOND: "Booking confirmed!"
  THEN: COMPLETE

waitlist:
  RESPOND: "Added to waitlist."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Branch_Test'),
      );
      session.data.values.room_type = 'deluxe';
      session.toolExecutor = {
        execute: async () => ({ available: true, price: 200 }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Room available');
      expect(output).toContain('Booking confirmed');
      expect(session.data.values.can_book).toBe(true); // SET from branch
    });

    test('CALL ON_SUCCESS simple block writes nested paths', async () => {
      const dsl = `
AGENT: Call_Simple_Success_Set_Test

GOAL: "Test simple ON_SUCCESS SET"

TOOLS:
  verify_user(token: string) -> {verified: boolean}
    description: "Verify user"

FLOW:
  entry_point: verify
  steps:
    - verify
    - done

verify:
  REASONING: false
  CALL: verify_user(token)
  ON_SUCCESS:
    REASONING: false
    SET: user.status.authenticated = true
    RESPOND: "Verified!"
    THEN: done

done:
  REASONING: false
  RESPOND: "Welcome, authenticated user!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Simple_Success_Set_Test'),
      );
      session.data.values.token = 'abc123';
      session.toolExecutor = {
        execute: async () => ({ verified: true }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Verified!');
      expect(output).toContain('Welcome, authenticated user!');
      expect(session.data.values.user).toEqual({
        status: { authenticated: true },
      });
    });

    test('CALL stores result accessible via tool name prefix', async () => {
      const dsl = `
AGENT: Call_Result_Test

GOAL: "Test CALL result storage"

TOOLS:
  get_weather(city: string) -> {temp: number, condition: string}
    description: "Get weather"

FLOW:
  entry_point: weather
  steps:
    - weather

weather:
  CALL: get_weather(city)
  ON_SUCCESS:
    REASONING: false
    RESPOND: "Weather: {{get_weather.condition}}, {{get_weather.temp}}F"
    THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Result_Test'),
      );
      session.data.values.city = 'London';
      session.toolExecutor = {
        execute: async () => ({ temp: 55, condition: 'cloudy' }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      // Tool results stored under tool name
      expect(session.data.values['get_weather']).toEqual({ temp: 55, condition: 'cloudy' });
    });

    test('CALL ON_SUCCESS with SET writes to nested paths', async () => {
      const dsl = `
AGENT: Call_Set_Nested_Test

GOAL: "Test SET in ON_SUCCESS branch with dotted path"

TOOLS:
  verify_user(token: string) -> {verified: boolean}
    description: "Verify user"

FLOW:
  entry_point: verify
  steps:
    - verify
    - done

verify:
  CALL: verify_user(token)
  ON_SUCCESS:
    REASONING: false
    - IF: verify_user.verified == true
      SET: user.is_authenticated = true
      RESPOND: "Verified!"
      THEN: done
    - ELSE:
      RESPOND: "Verification failed."
      THEN: COMPLETE

done:
  RESPOND: "Welcome, authenticated user!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Set_Nested_Test'),
      );
      session.data.values.token = 'abc123';
      session.toolExecutor = {
        execute: async () => ({ verified: true }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      // SET user.is_authenticated = true should create nested object
      const user = session.data.values.user as Record<string, unknown>;
      expect(user).toBeDefined();
      expect(user.is_authenticated).toBe(true);
    });

    test('CALL ON_FAIL simple block writes nested paths when success_when fails', async () => {
      const dsl = `
AGENT: Call_Simple_Failure_Set_Test

GOAL: "Test simple ON_FAIL SET"

TOOLS:
  verify_user(token: string) -> object
    description: "Verify user"

FLOW:
  entry_point: verify
  steps:
    - verify

verify:
  REASONING: false
  CALL: verify_user
    WITH:
      token: token
    AS: result
  ON_SUCCESS:
    REASONING: false
    RESPOND: "Verified!"
    THEN: COMPLETE
  ON_FAIL:
    REASONING: false
    SET: user.status.failure_code = "VERIFY_FAILED"
    RESPOND: "Verification failed."
    THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Call_Simple_Failure_Set_Test'),
      );
      const verifyStep = session.agentIR!.flow!.definitions['verify'];
      verifyStep.success_when = 'result.code == 200';
      session.data.values.token = 'abc123';
      session.toolExecutor = {
        execute: async () => ({ code: 500, success: true }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Verification failed.');
      expect(session.data.values.user).toEqual({
        status: { failure_code: 'VERIFY_FAILED' },
      });
    });
  });

  // ===========================================================================
  // COMPLETION CONDITIONS (auto-complete)
  // ===========================================================================

  describe('Completion conditions', () => {
    test('COMPLETE WHEN condition triggers auto-completion', async () => {
      const dsl = `
AGENT: AutoComplete_Test

GOAL: "Test auto-completion"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - answer: required
  THEN: collect

COMPLETE:
  - WHEN: answer == "done"
    RESPOND: "All finished!"
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'AutoComplete_Test'),
      );
      await executor.initializeSession(session.id);

      // First message: doesn't trigger completion
      await executor.executeMessage(session.id, 'hello');
      expect(session.isComplete).not.toBe(true);

      // Second message: triggers completion
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'done', (c) => chunks.push(c));
      expect(session.isComplete).toBe(true);
      expect(chunks.join('')).toContain('All finished!');
    });

    test('COMPLETE WHEN condition does not trigger when not met', async () => {
      const dsl = `
AGENT: NoAutoComplete_Test

GOAL: "Test no auto-completion"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - status: required
  THEN: collect

COMPLETE:
  - WHEN: status == "finished"
    RESPOND: "Done!"
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'NoAutoComplete_Test'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'in progress');

      expect(session.isComplete).not.toBe(true);
      expect(session.currentFlowStep).toBe('collect');
    });

    test('COMPLETE emits completion_check trace events', async () => {
      const dsl = `
AGENT: Complete_Trace_Test

GOAL: "Test completion traces"

FLOW:
  entry_point: step1
  steps:
    - step1

step1:
  GATHER:
    - value: required
  THEN: step1

COMPLETE:
  - WHEN: value == "exit"
    RESPOND: "Bye!"
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Complete_Trace_Test'),
      );
      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'exit', undefined, (e) => traces.push(e));

      const completionCheck = traces.find((t) => t.type === 'completion_check');
      expect(completionCheck).toBeDefined();
      expect(completionCheck!.data.result).toBe(true);
    });
  });

  // ===========================================================================
  // CONSTRAINTS / GUARDRAILS
  // ===========================================================================

  describe('Constraint guardrails', () => {
    test('Constraint violation returns respond action', async () => {
      const dsl = `
AGENT: Constraint_Respond_Test

GOAL: "Test constraint respond"

CONSTRAINTS:
  - REQUIRE destination != origin
    ON_FAIL: Destination and origin cannot be the same

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
      // Set values that violate constraint
      session.data.values.destination = 'Paris';
      session.data.values.origin = 'Paris';

      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'some notes', (c) => chunks.push(c));

      // Constraint should fire before step processes
      expect(result.action?.type).toBe('constraint_blocked');
      expect(chunks.join('')).toContain('Destination and origin cannot be the same');
    });

    test('Constraint passes when values are valid', async () => {
      const dsl = `
AGENT: Constraint_Pass_Test

GOAL: "Test constraint passing"

CONSTRAINTS:
  - REQUIRE destination != origin
    ON_FAIL: Cannot be the same

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
        compileToResolvedAgent([dsl], 'Constraint_Pass_Test'),
      );
      session.data.values.destination = 'Paris';
      session.data.values.origin = 'London';

      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'some notes');

      // Should complete normally
      expect(session.isComplete).toBe(true);
    });

    test('Auto-guarded constraint passes when values are not yet set', async () => {
      const dsl = `
AGENT: Constraint_AutoGuard_Test

GOAL: "Test auto-guard"

CONSTRAINTS:
  - REQUIRE destination != origin
    ON_FAIL: Cannot be the same

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
        compileToResolvedAgent([dsl], 'Constraint_AutoGuard_Test'),
      );
      // Neither destination nor origin is set yet → auto-guard should pass

      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'Paris');

      // Should not be blocked by constraint (auto-guard passes when values not set)
      expect(session.isComplete).toBe(true);
    });

    test('Constraint violation emits trace events', async () => {
      const dsl = `
AGENT: Constraint_Trace_Test

GOAL: "Test constraint traces"

CONSTRAINTS:
  - REQUIRE budget > 0
    ON_FAIL: Budget must be positive

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
        compileToResolvedAgent([dsl], 'Constraint_Trace_Test'),
      );
      session.data.values.budget = -100;

      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'test', undefined, (e) => traces.push(e));

      const violation = traces.find((t) => t.type === 'constraint_violation');
      expect(violation).toBeDefined();
      expect(violation!.data.condition).toContain('budget');
    });
  });

  // ===========================================================================
  // PROMPT + ON_INPUT WITHOUT GATHER
  // ===========================================================================

  describe('RESPOND + ON_INPUT without GATHER', () => {
    test('Step with RESPOND and ON_INPUT but no GATHER branches on input', async () => {
      const dsl = `
AGENT: Prompt_OnInput_Test

GOAL: "Test RESPOND with ON_INPUT"

FLOW:
  entry_point: ask
  steps:
    - ask
    - option_a
    - option_b

ask:
  RESPOND: "Choose A or B:"
  ON_INPUT:
    - IF: input contains "a"
      RESPOND: "You chose A"
      THEN: option_a
    - IF: input contains "b"
      RESPOND: "You chose B"
      THEN: option_b
    - ELSE:
      RESPOND: "Invalid choice, try again"
      THEN: ask

option_a:
  RESPOND: "Executing option A"
  THEN: COMPLETE

option_b:
  RESPOND: "Executing option B"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Prompt_OnInput_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'pick b', (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('You chose B');
      expect(output).toContain('Executing option B');
      expect(session.isComplete).toBe(true);
    });
  });
});
