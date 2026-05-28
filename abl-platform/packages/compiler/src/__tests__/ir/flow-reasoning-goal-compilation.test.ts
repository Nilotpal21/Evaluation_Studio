import { parseAgentBasedABL } from '@abl/core';
import { describe, expect, test } from 'vitest';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileStepGoal(goalSource: string): string {
  const parsed = parseAgentBasedABL(`
AGENT: FlowGoalCompiler
GOAL: "Agent fallback goal"

FLOW:
  steps:
    - synthesize

  synthesize:
    REASONING: true
${goalSource}
`);

  expect(parsed.errors).toEqual([]);
  expect(parsed.document).not.toBeNull();

  const output = compileABLtoIR([parsed.document!]);
  const step = output.agents.FlowGoalCompiler.flow!.definitions.synthesize;
  return step.reasoning_zone!.goal;
}

describe('compileABLtoIR FLOW reasoning step GOAL', () => {
  test('compiles pipe-style multiline step goals into reasoning_zone.goal', () => {
    expect(
      compileStepGoal(`    GOAL: |
      Produce ONE unified reply.
      Include all relevant contracts.`),
    ).toBe('Produce ONE unified reply.\nInclude all relevant contracts.');
  });

  test('never compiles a block scalar marker as the reasoning goal', () => {
    expect(
      compileStepGoal(`    GOAL: |
      Classify contract-expiration requests.`),
    ).not.toBe('|');
  });
});
