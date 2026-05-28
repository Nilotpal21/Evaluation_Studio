import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

function parseStepGoal(goalSource: string): string | undefined {
  const result = parseAgentBasedABL(`
AGENT: FlowGoalParser
GOAL: "Agent fallback goal"

FLOW:
  steps:
    - classify

  classify:
    REASONING: true
${goalSource}
`);

  expect(result.errors).toEqual([]);
  return result.document?.flow?.definitions.classify.goal;
}

describe('Agent-based parser FLOW step GOAL', () => {
  test('parses pipe-style multiline step goals', () => {
    expect(
      parseStepGoal(`    GOAL: |
      Classify the request into exactly one bucket.
      Return only the bucket name.`),
    ).toBe('Classify the request into exactly one bucket.\nReturn only the bucket name.');
  });

  test('parses blank multiline step goals without flattening lines', () => {
    expect(
      parseStepGoal(`    GOAL:
      Produce one unified reply.
      Include contract names and expiration dates.`),
    ).toBe('Produce one unified reply.\nInclude contract names and expiration dates.');
  });

  test('preserves inline step goal behavior', () => {
    expect(parseStepGoal('    GOAL: Classify contract questions')).toBe(
      'Classify contract questions',
    );
  });

  test('treats canonical BEHAVIOR block as reasoning goal text', () => {
    expect(
      parseStepGoal(`    BEHAVIOR: |
      Normalize yes/no answers.
      Examples:
        "yeah" -> "yes"`),
    ).toBe('Normalize yes/no answers.\nExamples:\n  "yeah" -> "yes"');
  });

  test('accepts legacy same-indent BEHAVIOR blocks without creating fake steps', () => {
    const result = parseAgentBasedABL(`
AGENT: LegacyBehavior
GOAL: "Agent fallback goal"

FLOW:
  entry_point: normalize_and_classify
  steps:

normalize_and_classify:
  REASONING: true
  AVAILABLE_TOOLS: [external_responder]
  BEHAVIOR: |
  STEP 1: NORMALIZE INPUT
  Examples:
    "No, later" -> "no"
  THEN: speak_error

speak_error:
  REASONING: false
  RESPOND: "Please try again."
`);

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.document!.flow!.definitions)).toEqual([
      'normalize_and_classify',
      'speak_error',
    ]);
    expect(result.document!.flow!.definitions.normalize_and_classify.goal).toContain(
      'Examples:\n  "No, later" -> "no"',
    );
    expect(result.document!.flow!.definitions.normalize_and_classify.then).toBe('speak_error');
  });
});
