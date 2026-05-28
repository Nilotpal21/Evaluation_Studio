/**
 * IR Compiler Tests for DSL Extensions
 *
 * Verifies that new AST fields (SET, CLEAR, TRANSFORM, CALL WITH/AS, ON_RESULT)
 * are correctly mapped to their IR (snake_case) equivalents.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('IR Compiler: DSL extension field mapping', () => {
  test('should map SET assignments to IR (set field)', () => {
    const agent = compileFromDSL(
      `
AGENT: SetIRTest

GOAL: "Test SET in IR"

FLOW:
  start -> end

  start:
    REASONING: false
    SET:
      counter = ADD(counter, 1)
      name = UPPER("hello")
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'SetIRTest',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.set).toBeDefined();
    expect(startStep.set).toHaveLength(2);
    expect(startStep.set![0]).toEqual({ variable: 'counter', expression: 'ADD(counter, 1)' });
    expect(startStep.set![1]).toEqual({ variable: 'name', expression: 'UPPER("hello")' });
  });

  test('should map CLEAR to IR (clear field)', () => {
    const agent = compileFromDSL(
      `
AGENT: ClearIRTest

GOAL: "Test CLEAR in IR"

FLOW:
  start -> end

  start:
    REASONING: false
    CLEAR: tempData, scratchPad
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'ClearIRTest',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.clear).toEqual(['tempData', 'scratchPad']);
  });

  test('should map TRANSFORM to IR with snake_case fields', () => {
    const agent = compileFromDSL(
      `
AGENT: TransformIRTest

GOAL: "Test TRANSFORM in IR"

FLOW:
  start -> process -> end

  start:
    REASONING: false
    RESPOND: "Welcome"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: data.items AS item INTO results
      FILTER: item.active == true
      MAP:
        name: item.name
        value: item.amount
      SORT_BY: name ASC
      LIMIT: 10
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'TransformIRTest',
    );

    const processStep = agent.flow!.definitions['process'];
    expect(processStep.transform).toBeDefined();
    expect(processStep.transform!.source).toBe('data.items');
    // IR uses snake_case: item_var, not itemVar
    expect(processStep.transform!.item_var).toBe('item');
    expect(processStep.transform!.target).toBe('results');
    expect(processStep.transform!.filter).toBe('item.active == true');
    expect(processStep.transform!.map).toEqual({ name: 'item.name', value: 'item.amount' });
    // IR uses snake_case: sort_by, not sortBy
    expect(processStep.transform!.sort_by).toEqual({ field: 'name', order: 'asc' });
    expect(processStep.transform!.limit).toBe(10);
  });

  test('should map CALL WITH/AS to IR (call_with, call_as)', () => {
    const agent = compileFromDSL(
      `
AGENT: CallIRTest

GOAL: "Test CALL WITH/AS in IR"

TOOLS:
  get_data(id: string, type: string) -> object

FLOW:
  start -> end

  start:
    REASONING: false
    CALL: get_data
      WITH:
        id: session.userId
        type: "account"
      AS: apiResult
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'CallIRTest',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.call).toBe('get_data');
    // IR uses snake_case: call_with, call_as
    expect(startStep.call_with).toEqual({
      id: 'session.userId',
      type: '"account"',
    });
    expect(startStep.call_as).toBe('apiResult');
  });

  test('should map ON_RESULT to IR (on_result)', () => {
    const agent = compileFromDSL(
      `
AGENT: OnResultIRTest

GOAL: "Test ON_RESULT in IR"

TOOLS:
  check_status() -> object

FLOW:
  start -> check -> success -> error

  start:
    REASONING: false
    RESPOND: "Checking"
    THEN: check

  check:
    REASONING: false
    CALL: check_status
      AS: result
    ON_RESULT:
      - IF: result.ok == true
        THEN: success
      - ELSE:
        RESPOND: "Error occurred"
        THEN: error

  success:
    REASONING: false
    RESPOND: "Success"
    THEN: COMPLETE

  error:
    REASONING: false
    RESPOND: "Error"
    THEN: COMPLETE
`,
      'OnResultIRTest',
    );

    const checkStep = agent.flow!.definitions['check'];
    // IR uses snake_case: on_result
    expect(checkStep.on_result).toBeDefined();
    expect(checkStep.on_result).toHaveLength(2);
    expect(checkStep.on_result![0].condition).toBe('result.ok == true');
    expect(checkStep.on_result![0].then).toBe('success');
    expect(checkStep.on_result![1].condition).toBeUndefined();
    expect(checkStep.on_result![1].respond).toBe('Error occurred');
    expect(checkStep.on_result![1].then).toBe('error');
  });

  test('should compile call_spec for lifecycle and branch invocation surfaces', () => {
    const agent = compileFromDSL(
      `
AGENT: LifecycleCallSpecIRTest

GOAL: "Test call_spec compilation outside flow-step CALL"

TOOLS:
  lookup_member(memberId: string) -> object
  audit_turn(turnId: string) -> object
  refresh_options(userId: string) -> object

ON_START:
  CALL: lookup_member
    WITH:
      memberId: session.member_id
    AS: memberProfile

HOOKS:
  before_turn:
    CALL: audit_turn
      WITH:
        turnId: session.turn_id
      AS: auditResult

FLOW:
  start -> done

  start:
    REASONING: false
    RESPOND: "Checking"
    ON_INPUT:
      - IF: input contains "check"
        CALL: lookup_member
          WITH:
            memberId: session.member_id
          AS: branchLookup
        THEN: done
      - ELSE:
        THEN: COMPLETE
    DIGRESSIONS:
      - INTENT: help
        DO:
          - CALL: audit_turn
            WITH:
              turnId: session.turn_id
            AS: digressionAudit
          - RESUME
    SUB_INTENTS:
      - INTENT: "show more"
        CALL: refresh_options
          WITH:
            userId: session.user_id
          AS: moreOptions
        RESUME: true

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'LifecycleCallSpecIRTest',
    );

    expect(agent.on_start?.call_spec).toEqual({
      tool: 'lookup_member',
      with: { memberId: 'session.member_id' },
      as: 'memberProfile',
    });
    expect(agent.hooks?.before_turn?.call_spec).toEqual({
      tool: 'audit_turn',
      with: { turnId: 'session.turn_id' },
      as: 'auditResult',
    });
    expect(agent.flow?.definitions['start'].on_input?.[0]?.call_spec).toEqual({
      tool: 'lookup_member',
      with: { memberId: 'session.member_id' },
      as: 'branchLookup',
    });
    expect(agent.flow?.definitions['start'].digressions?.[0]?.do?.[0]?.call_spec).toEqual({
      tool: 'audit_turn',
      with: { turnId: 'session.turn_id' },
      as: 'digressionAudit',
    });
    expect(agent.flow?.definitions['start'].sub_intents?.[0]?.call_spec).toEqual({
      tool: 'refresh_options',
      with: { userId: 'session.user_id' },
      as: 'moreOptions',
    });
  });

  test('should map all extensions together in a complete agent', () => {
    const agent = compileFromDSL(
      `
AGENT: CompleteIRTest

GOAL: "Complete test"

TOOLS:
  fetch_data(query: string) -> object

FLOW:
  init -> fetch -> transform -> display -> cleanup

  init:
    REASONING: false
    SET: retries = 0
    THEN: fetch

  fetch:
    REASONING: false
    SET: retries = ADD(retries, 1)
    CALL: fetch_data
      WITH:
        query: "accounts"
      AS: fetchResult
    ON_RESULT:
      - IF: fetchResult.status == 200
        THEN: transform
      - ELSE:
        THEN: cleanup

  transform:
    REASONING: false
    TRANSFORM: fetchResult.data AS item INTO processed
      FILTER: item.enabled == true
      MAP:
        label: item.name
      SORT_BY: label ASC
      LIMIT: 50
    THEN: display

  display:
    REASONING: false
    RESPOND: "Results ready"
    THEN: cleanup

  cleanup:
    REASONING: false
    CLEAR: fetchResult, processed
    THEN: COMPLETE
`,
      'CompleteIRTest',
    );

    const defs = agent.flow!.definitions;

    // init: SET
    expect(defs['init'].set).toHaveLength(1);
    expect(defs['init'].set![0].variable).toBe('retries');

    // fetch: SET + call_with + call_as + on_result
    expect(defs['fetch'].set).toHaveLength(1);
    expect(defs['fetch'].call_with).toEqual({ query: '"accounts"' });
    expect(defs['fetch'].call_as).toBe('fetchResult');
    expect(defs['fetch'].on_result).toHaveLength(2);

    // transform: transform with snake_case
    expect(defs['transform'].transform!.item_var).toBe('item');
    expect(defs['transform'].transform!.sort_by).toEqual({ field: 'label', order: 'asc' });

    // cleanup: clear
    expect(defs['cleanup'].clear).toEqual(['fetchResult', 'processed']);
  });
});
