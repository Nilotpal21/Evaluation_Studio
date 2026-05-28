/**
 * Unit tests for CALL WITH/AS parameter resolution in FlowStepExecutor.
 *
 * CALL WITH: Resolves explicit parameters from session context before executing a tool.
 * CALL AS: Binds the tool result to a named variable instead of flat-spreading into session data.
 *
 * These tests verify parameter resolution, result binding, trace events,
 * success_when evaluation, and edge cases (missing tool executor, nested paths).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('CALL WITH/AS parameter resolution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // =========================================================================
  // 1. CALL WITH resolves values from session context
  // =========================================================================
  test('CALL WITH resolves values from session context', async () => {
    const dsl = `
AGENT: WithResolve

GOAL: "Test WITH parameter resolution from context"

TOOLS:
  lookup(id: string, type: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: lookup
      WITH:
        id: userId
        type: "premium"
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'WithResolve'),
    );
    session.data.values.userId = 'u-42';

    let capturedName: string | undefined;
    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (name: string, args: Record<string, unknown>) => {
        capturedName = name;
        capturedArgs = args;
        return { status: 'ok' };
      },
    } as any;

    await executor.initializeSession(session.id);

    expect(capturedName).toBe('lookup');
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.id).toBe('u-42');
    expect(capturedArgs!.type).toBe('premium');
  });

  // =========================================================================
  // 2. CALL WITH resolves string literals
  // =========================================================================
  test('CALL WITH resolves string literals', async () => {
    const dsl = `
AGENT: WithLiterals

GOAL: "Test WITH literal string resolution"

TOOLS:
  run_action(action: string, mode: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: run_action
      WITH:
        action: "create"
        mode: "batch"
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'WithLiterals'),
    );

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { result: 'created' };
      },
    } as any;

    await executor.initializeSession(session.id);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.action).toBe('create');
  });

  // =========================================================================
  // 3. CALL AS binds result to named variable
  // =========================================================================
  test('CALL AS binds result to named variable', async () => {
    const dsl = `
AGENT: AsBinding

GOAL: "Test AS result binding"

TOOLS:
  fetch_data(query: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: fetch_data
      WITH:
        query: "test"
      AS: apiData
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'AsBinding'));

    session.toolExecutor = {
      execute: async () => ({ items: [1, 2, 3], total: 3 }),
    } as any;

    await executor.initializeSession(session.id);

    // Result should be bound under the AS variable name
    expect(session.data.values.apiData).toEqual({ items: [1, 2, 3], total: 3 });
    // Result should NOT be flat-spread (items and total should not be top-level)
    expect(session.data.values.items).toBeUndefined();
    expect(session.data.values.total).toBeUndefined();
  });

  // =========================================================================
  // 4. CALL without AS -> flat spread into session
  // =========================================================================
  test('CALL without AS flat-spreads result into session values', async () => {
    const dsl = `
AGENT: NoAsSpread

GOAL: "Test CALL without AS"

TOOLS:
  get_status(id: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: get_status
      WITH:
        id: "abc"
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'NoAsSpread'));

    session.toolExecutor = {
      execute: async () => ({ status: 'ok', count: 5 }),
    } as any;

    await executor.initializeSession(session.id);

    // Without AS, result should be flat-spread into session.data.values
    expect(session.data.values.status).toBe('ok');
    expect(session.data.values.count).toBe(5);
    // Also stored nested under the tool name
    expect(session.data.values.get_status).toEqual({ status: 'ok', count: 5 });
  });

  // =========================================================================
  // 5. CALL WITH + AS combined
  // =========================================================================
  test('CALL WITH + AS combined: params resolved AND result bound to variable', async () => {
    const dsl = `
AGENT: WithAsCombined

GOAL: "Test combined WITH and AS"

TOOLS:
  search(term: string, limit: number) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: search
      WITH:
        term: searchQuery
        limit: "10"
      AS: searchResult
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'WithAsCombined'),
    );
    session.data.values.searchQuery = 'flights';

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { results: ['a', 'b'], count: 2 };
      },
    } as any;

    await executor.initializeSession(session.id);

    // WITH: params should be resolved from context
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.term).toBe('flights');
    // "10" in DSL WITH compiles to the IR string '"10"' (with embedded quotes).
    // resolveValue strips quotes, returning the string '10'.
    expect(capturedArgs!.limit).toBe('10');

    // AS: result should be bound to the named variable
    expect(session.data.values.searchResult).toEqual({ results: ['a', 'b'], count: 2 });
    // Should NOT be flat-spread
    expect(session.data.values.results).toBeUndefined();
    expect(session.data.values.count).toBeUndefined();
  });

  // =========================================================================
  // 6. CALL WITH no tool executor -> error result
  // =========================================================================
  test('CALL WITH no tool executor produces error result', async () => {
    const dsl = `
AGENT: NoExecutor

GOAL: "Test no tool executor error path"

TOOLS:
  some_tool(x: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: some_tool
      WITH:
        x: "value"
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'NoExecutor'));
    // Explicitly remove the tool executor that wireToolExecutor() sets
    // to exercise the no-executor error path in the CALL WITH branch
    session.toolExecutor = undefined;

    await executor.initializeSession(session.id);

    // The call result should have __error since no executor is set
    // Without AS, it's flat-spread, so __error appears in session.data.values
    expect(session.data.values.__error).toBeDefined();
    expect(String(session.data.values.__error)).toContain('No tool executor configured');
  });

  // =========================================================================
  // 7. CALL AS with success_when condition (passing)
  // =========================================================================
  test('CALL AS with success_when condition: ON_SUCCESS branch taken', async () => {
    const dsl = `
AGENT: SuccessWhenPass

GOAL: "Test success_when evaluation"

TOOLS:
  api_call(id: string) -> object

FLOW:
  start -> success_step -> failure_step

  start:
    REASONING: false
    CALL: api_call
      WITH:
        id: "test"
      AS: result
    ON_SUCCESS:
      REASONING: false
      RESPOND: "Success: code 200"
      THEN: success_step
    ON_FAIL:
      RESPOND: "Failed"
      THEN: failure_step

  success_step:
    REASONING: false
    RESPOND: "Reached success"
    THEN: COMPLETE

  failure_step:
    REASONING: false
    RESPOND: "Reached failure"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'SuccessWhenPass'),
    );

    // Manually set success_when on the compiled IR step
    const startStep = session.agentIR!.flow!.definitions['start'];
    startStep.success_when = 'result.code == 200';

    session.toolExecutor = {
      execute: async () => ({ code: 200, data: 'ok' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Success: code 200');
    expect(output).toContain('Reached success');
    expect(output).not.toContain('Failed');
  });

  // =========================================================================
  // 8. CALL AS with success_when failing
  // =========================================================================
  test('CALL AS with success_when condition: ON_FAILURE branch taken', async () => {
    const dsl = `
AGENT: SuccessWhenFail

GOAL: "Test success_when failure"

TOOLS:
  api_call(id: string) -> object

FLOW:
  start -> success_step -> failure_step

  start:
    REASONING: false
    CALL: api_call
      WITH:
        id: "test"
      AS: result
    ON_SUCCESS:
      REASONING: false
      RESPOND: "Success"
      THEN: success_step
    ON_FAIL:
      RESPOND: "Failed: code not 200"
      THEN: failure_step

  success_step:
    REASONING: false
    RESPOND: "Reached success"
    THEN: COMPLETE

  failure_step:
    REASONING: false
    RESPOND: "Reached failure"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'SuccessWhenFail'),
    );

    // Manually set success_when on the compiled IR step
    const startStep = session.agentIR!.flow!.definitions['start'];
    startStep.success_when = 'result.code == 200';

    session.toolExecutor = {
      execute: async () => ({ code: 500, error: undefined, success: true }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Failed: code not 200');
    expect(output).toContain('Reached failure');
    expect(output).not.toContain('Success');
  });

  // =========================================================================
  // 9. dsl_call trace event with source: 'call_with'
  // =========================================================================
  test('dsl_call trace event emitted with source call_with', async () => {
    const dsl = `
AGENT: TraceTest

GOAL: "Test trace event emission"

TOOLS:
  trace_tool(x: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: trace_tool
      WITH:
        x: myVal
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'TraceTest'));
    session.data.values.myVal = 'hello-world';

    session.toolExecutor = {
      execute: async () => ({ ok: true }),
    } as any;

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.initializeSession(session.id, undefined, (evt) => traceEvents.push(evt));

    // Find the dsl_call event
    const dslCallEvents = traceEvents.filter((e) => e.type === 'dsl_call');
    expect(dslCallEvents.length).toBeGreaterThanOrEqual(1);

    const callEvent = dslCallEvents[0];
    expect(callEvent.data.source).toBe('call_with');
    expect(callEvent.data.toolName).toBe('trace_tool');
    expect(callEvent.data.params).toBeDefined();
    expect((callEvent.data.params as Record<string, unknown>).x).toBe('hello-world');
    expect(callEvent.data.contextBefore).toBeDefined();
    expect(callEvent.data.agentName).toBe('TraceTest');
  });

  // =========================================================================
  // 10. CALL WITH resolves nested dotted paths
  // =========================================================================
  test('CALL WITH resolves nested dotted paths', async () => {
    const dsl = `
AGENT: DottedPath

GOAL: "Test dotted path resolution"

TOOLS:
  greet(name: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: greet
      WITH:
        name: user.firstName
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'DottedPath'));
    session.data.values.user = { firstName: 'Alice', lastName: 'Smith' };

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { greeting: 'Hello Alice' };
      },
    } as any;

    await executor.initializeSession(session.id);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.name).toBe('Alice');
  });

  test('CALL WITH resolves variables assigned from prior nested tool results', async () => {
    const dsl = `
AGENT: PinVerifier

GOAL: "Verify a user-entered PIN against a stored hash"

TOOLS:
  verify_pin(source_pin: string, target_pin: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: verify_pin
      WITH:
        source_pin: stored_pin
        target_pin: pin
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'PinVerifier'),
    );
    session.data.values.lookup_phone_record = {
      result: [{ pin: 'e82c4b19b8151ddc25d4d93baf7b908f' }],
    };
    session.data.values.stored_pin = 'e82c4b19b8151ddc25d4d93baf7b908f';
    session.data.values.pin = '2468';

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { matched: false };
      },
    } as any;

    await executor.initializeSession(session.id);

    expect(capturedArgs).toEqual({
      source_pin: 'e82c4b19b8151ddc25d4d93baf7b908f',
      target_pin: '2468',
    });
  });

  test('CALL WITH falls back from session-prefixed paths to flat session values', async () => {
    const dsl = `
AGENT: WithSessionFallback

GOAL: "Keep CALL WITH aligned with inline named CALL argument resolution"

TOOLS:
  lookup(customerId: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: lookup
      WITH:
        customerId: session.customerId
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'WithSessionFallback'),
    );
    session.data.values.customerId = 'cust-123';

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { ok: true };
      },
    } as any;

    await executor.initializeSession(session.id);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.customerId).toBe('cust-123');
  });

  // =========================================================================
  // ABLP-714 — preserve declared types of CALL WITH values
  //
  // Regression test for the bug where every CALL WITH value was funneled
  // through `String(expr)` before template resolution, producing
  //   String([])         === ""
  //   String(["a","b"])  === "a,b"
  // which then failed the tool param validator with
  //   "expected type 'array', got 'string'".
  // =========================================================================
  describe('ABLP-714: CALL WITH preserves non-string types', () => {
    test('empty literal array passes through as []', async () => {
      const dsl = `
AGENT: WithEmptyArray

GOAL: "Test empty literal array"

TOOLS:
  search(productIds: array, sections: array) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: search
      WITH:
        productIds: []
        sections: ["specs", "sellingPoints"]
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'WithEmptyArray'),
      );

      let capturedArgs: Record<string, unknown> | undefined;
      session.toolExecutor = {
        execute: async (_name: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true };
        },
      } as any;

      await executor.initializeSession(session.id);

      expect(capturedArgs).toBeDefined();
      expect(Array.isArray(capturedArgs!.productIds)).toBe(true);
      expect(capturedArgs!.productIds).toEqual([]);
      expect(Array.isArray(capturedArgs!.sections)).toBe(true);
      expect(capturedArgs!.sections).toEqual(['specs', 'sellingPoints']);
    });

    test('bare variable reference resolving to an array stays an array', async () => {
      const dsl = `
AGENT: WithBareArrayRef

GOAL: "Test bare variable reference resolving to array"

TOOLS:
  search(productIds: array) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: search
      WITH:
        productIds: productIds
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'WithBareArrayRef'),
      );
      session.data.values.productIds = ['P_iphone_15', 'P_galaxy_s24'];

      let capturedArgs: Record<string, unknown> | undefined;
      session.toolExecutor = {
        execute: async (_name: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true };
        },
      } as any;

      await executor.initializeSession(session.id);

      expect(capturedArgs).toBeDefined();
      expect(Array.isArray(capturedArgs!.productIds)).toBe(true);
      expect(capturedArgs!.productIds).toEqual(['P_iphone_15', 'P_galaxy_s24']);
    });

    test('array literal containing a bare variable reference preserves array shape', async () => {
      const dsl = `
AGENT: WithArrayOfBareRefs

GOAL: "Test array literal containing bare variable reference"

TOOLS:
  search(productIds: array) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: search
      WITH:
        productIds: [productId]
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'WithArrayOfBareRefs'),
      );
      session.data.values.productId = 'P_iphone_15';

      let capturedArgs: Record<string, unknown> | undefined;
      session.toolExecutor = {
        execute: async (_name: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true };
        },
      } as any;

      await executor.initializeSession(session.id);

      expect(capturedArgs).toBeDefined();
      expect(Array.isArray(capturedArgs!.productIds)).toBe(true);
      expect(capturedArgs!.productIds).toEqual(['P_iphone_15']);
    });

    test('numeric and boolean literals pass through as their declared types', async () => {
      const dsl = `
AGENT: WithScalars

GOAL: "Test numeric and boolean literals"

TOOLS:
  search(topK: number, includeStale: boolean) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    CALL: search
      WITH:
        topK: 8
        includeStale: false
    RESPOND: "Done"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'WithScalars'),
      );

      let capturedArgs: Record<string, unknown> | undefined;
      session.toolExecutor = {
        execute: async (_name: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true };
        },
      } as any;

      await executor.initializeSession(session.id);

      expect(capturedArgs).toBeDefined();
      expect(capturedArgs!.topK).toBe(8);
      expect(typeof capturedArgs!.topK).toBe('number');
      expect(capturedArgs!.includeStale).toBe(false);
      expect(typeof capturedArgs!.includeStale).toBe('boolean');
    });
  });
});
