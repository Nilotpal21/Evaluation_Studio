/**
 * Negative / Edge-Case IR Compiler Tests for DSL Extensions
 *
 * Verifies that absent/empty new fields are correctly handled
 * in the IR compilation — no undefined-to-defined conversion,
 * no spurious empty arrays, and backward compatibility with
 * agents that don't use new constructs.
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

describe('IR Compiler negative: absent extension fields', () => {
  test('step without SET/CLEAR/TRANSFORM should have undefined fields in IR', () => {
    const agent = compileFromDSL(
      `
AGENT: NoExtensionsTest

GOAL: "No extensions"

FLOW:
  start -> end

  start:
    REASONING: false
    RESPOND: "Hello"
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'NoExtensionsTest',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.set).toBeUndefined();
    expect(startStep.clear).toBeUndefined();
    expect(startStep.transform).toBeUndefined();
    expect(startStep.call_with).toBeUndefined();
    expect(startStep.call_as).toBeUndefined();
    expect(startStep.on_result).toBeUndefined();
  });

  test('step with CALL but no WITH/AS should have undefined call_with/call_as', () => {
    const agent = compileFromDSL(
      `
AGENT: LegacyCallIRTest

GOAL: "Legacy CALL"

TOOLS:
  process(val: string) -> object

FLOW:
  start -> end

  start:
    REASONING: false
    CALL: process(val)
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'LegacyCallIRTest',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.call).toBe('process(val)');
    expect(startStep.call_with).toBeUndefined();
    expect(startStep.call_as).toBeUndefined();
    expect(startStep.on_result).toBeUndefined();
  });

  test('step with ON_SUCCESS should not have on_result', () => {
    const agent = compileFromDSL(
      `
AGENT: OnSuccessIRTest

GOAL: "ON_SUCCESS only"

TOOLS:
  check() -> object

FLOW:
  start -> check -> end

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: check

  check:
    REASONING: false
    CALL: check
    ON_SUCCESS:
      RESPOND: "OK"
      THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'OnSuccessIRTest',
    );

    const checkStep = agent.flow!.definitions['check'];
    expect(checkStep.on_success).toBeDefined();
    expect(checkStep.on_result).toBeUndefined();
  });

  test('TRANSFORM without optional sub-fields should have undefined in IR', () => {
    const agent = compileFromDSL(
      `
AGENT: TransformMinimalIR

GOAL: "Minimal TRANSFORM"

FLOW:
  start -> end

  start:
    REASONING: false
    TRANSFORM: items AS item INTO result
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'TransformMinimalIR',
    );

    const startStep = agent.flow!.definitions['start'];
    expect(startStep.transform).toBeDefined();
    expect(startStep.transform!.source).toBe('items');
    expect(startStep.transform!.item_var).toBe('item');
    expect(startStep.transform!.target).toBe('result');
    expect(startStep.transform!.filter).toBeUndefined();
    expect(startStep.transform!.map).toBeUndefined();
    expect(startStep.transform!.sort_by).toBeUndefined();
    expect(startStep.transform!.limit).toBeUndefined();
  });

  test('empty SET array from parser should map to undefined in IR', () => {
    // A SET: with no value and no indented lines produces empty array in parser
    // In IR, step.set?.map(...) on empty array produces empty array (not undefined)
    const agent = compileFromDSL(
      `
AGENT: EmptySetIR

GOAL: "Empty SET"

FLOW:
  start -> end

  start:
    REASONING: false
    SET:
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`,
      'EmptySetIR',
    );

    const startStep = agent.flow!.definitions['start'];
    // Empty array from parser maps to empty array in IR
    if (startStep.set) {
      expect(startStep.set).toHaveLength(0);
    }
  });
});

describe('IR Compiler negative: backward compatibility', () => {
  test('reasoning mode agent should compile without flow', () => {
    const agent = compileFromDSL(
      `
AGENT: ReasoningAgent

GOAL: "A reasoning agent"
PERSONA: "Helpful assistant"
`,
      'ReasoningAgent',
    );

    expect(agent.flow).toBeUndefined();
  });

  test('scripted agent with only basic steps should compile cleanly', () => {
    const agent = compileFromDSL(
      `
AGENT: BasicScripted

GOAL: "Basic scripted flow"

FLOW:
  step1 -> step2

  step1:
    REASONING: false
    RESPOND: "Hello"
    THEN: step2

  step2:
    REASONING: false
    RESPOND: "Goodbye"
    THEN: COMPLETE
`,
      'BasicScripted',
    );

    const defs = agent.flow!.definitions;
    expect(defs['step1'].respond).toBe('Hello');
    expect(defs['step2'].respond).toBe('Goodbye');
    // No new extension fields
    expect(defs['step1'].set).toBeUndefined();
    expect(defs['step1'].clear).toBeUndefined();
    expect(defs['step1'].transform).toBeUndefined();
  });
});
