import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { validateABL } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

function compileOne(source: string, agentName: string) {
  const parsed = parseAgentBasedABL(source);
  expect(parsed.errors).toEqual([]);
  expect(parsed.document).not.toBeNull();

  const output = compileABLtoIR([parsed.document!]);
  expect(output.compilation_errors ?? []).toEqual([]);

  return output.agents[agentName];
}

function validateOne(source: string, filename = 'digression.abl') {
  return validateABL([{ filename, source }]);
}

describe('Canonical digression syntax', () => {
  test('parses canonical digressions as matching metadata plus ordered DO actions', () => {
    const parsed = parseAgentBasedABL(`
AGENT: Canonical_Digression_Parser

GOAL: "Test canonical digression parser"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: help_request
      KEYWORDS: [help, explain, what can you do]
      CONDITION: support_mode != "handoff_only"
      DO:
        - RESPOND: "I can help with that."
        - SET:
            last_digression = help_request
        - RESUME

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE
`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.flow?.globalDigressions).toBeDefined();

    const digression = parsed.document?.flow?.globalDigressions?.[0] as any;
    expect(digression.intent).toBe('help_request');
    expect(digression.keywords).toEqual(['help', 'explain', 'what can you do']);
    expect(digression.condition).toBe('support_mode != "handoff_only"');
    expect(digression.do).toBeDefined();
    expect(digression.do).toHaveLength(3);
    expect(digression.do[0]).toHaveProperty('respond', 'I can help with that.');
    expect(digression.do[1]).toHaveProperty('set');
    expect(digression.do[2]).toHaveProperty('resume', true);
  });

  test('global and step digressions compile to the same normalized DO shape', () => {
    const ir = compileOne(
      `
AGENT: Canonical_Digression_Shapes

GOAL: "Test canonical digression IR"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: help_request
      KEYWORDS: [help]
      CONDITION: support_mode == "enabled"
      DO:
        - RESPOND: "I can help with that."
        - SET:
            last_digression = help_request
        - RESUME

collect:
  REASONING: false
  GATHER:
    - destination: required
  DIGRESSIONS:
    - INTENT: step_help_request
      KEYWORDS: [help]
      CONDITION: support_mode == "enabled"
      DO:
        - RESPOND: "I can help with that."
        - SET:
            last_digression = help_request
        - RESUME
  THEN: COMPLETE
`,
      'Canonical_Digression_Shapes',
    );

    const globalDigression = ir.flow?.global_digressions?.[0] as any;
    const stepDigression = ir.flow?.definitions.collect?.digressions?.[0] as any;

    expect(globalDigression).toBeDefined();
    expect(stepDigression).toBeDefined();
    expect(globalDigression.do).toBeDefined();
    expect(stepDigression.do).toBeDefined();
    expect(globalDigression.do).toEqual(stepDigression.do);
  });

  test('legacy flat digressions emit a deprecation warning and normalize into DO actions', () => {
    const source = `
AGENT: Legacy_Digression_Sugar

GOAL: "Test legacy digression sugar"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: cancel quit exit
      RESPOND: "Stopping now."
      CLEAR: [destination]
      RESUME: true

collect:
  REASONING: false
  GATHER:
    - destination: required
  THEN: COMPLETE
`;

    const diagnostics = validateOne(source);
    expect(
      diagnostics.warnings.some(
        (warning) =>
          warning.message.includes('legacy') &&
          warning.message.includes('INTENT') &&
          warning.message.includes('KEYWORDS'),
      ),
    ).toBe(true);

    const ir = compileOne(source, 'Legacy_Digression_Sugar');
    const digression = ir.flow?.global_digressions?.[0] as any;

    expect(digression.do).toBeDefined();
    expect(digression.do).toEqual([
      { respond: 'Stopping now.' },
      { clear: ['destination'] },
      { resume: true },
    ]);
  });

  test('rejects mixing legacy execution fields with a DO block in the same digression', () => {
    const result = validateOne(`
AGENT: Mixed_Digression_Syntax

GOAL: "Test mixed digression syntax"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "Legacy response"
      DO:
        - RESUME

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE
`);

    expect(
      result.errors.some(
        (error) =>
          error.message.includes('DO') &&
          error.message.includes('RESPOND') &&
          error.message.includes('mixed'),
      ),
    ).toBe(true);
  });

  test('rejects unknown digression properties', () => {
    const result = validateOne(`
AGENT: Unknown_Digression_Property

GOAL: "Test unknown digression property"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: help_request
      KEYWORDS: [help]
      SURPRISE: true
      DO:
        - RESUME

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE
`);

    expect(result.errors.some((error) => error.message.includes('SURPRISE'))).toBe(true);
  });

  test('rejects actions after terminal RESUME or GOTO', () => {
    const result = validateOne(`
AGENT: Digression_Terminal_Ordering

GOAL: "Test digression terminal ordering"

FLOW:
  entry_point: collect
  steps:
    - collect
    - cancelled

  global_digressions:
    - INTENT: cancel_request
      KEYWORDS: [cancel]
      DO:
        - RESPOND: "Cancelling"
        - RESUME
        - RESPOND: "This action is unreachable"

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE

cancelled:
  RESPOND: "Cancelled"
  THEN: COMPLETE
`);

    expect(
      result.errors.some(
        (error) =>
          error.message.includes('RESUME') && error.message.toLowerCase().includes('unreachable'),
      ),
    ).toBe(true);
  });

  test('warns when INTENT looks like a keyword list instead of a semantic id', () => {
    const result = validateOne(`
AGENT: Phrase_Like_Intent_Warning

GOAL: "Test phrase-like intent warning"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: "cancel quit exit"
      RESPOND: "Stopping now."

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE
`);

    expect(
      result.warnings.some(
        (warning) =>
          warning.message.includes('INTENT') &&
          warning.message.includes('KEYWORDS') &&
          warning.message.includes('cancel_request'),
      ),
    ).toBe(true);
  });

  test('validates canonical digression CALL tools and DELEGATE targets', () => {
    const result = validateOne(`
AGENT: Digression_Reference_Validation

GOAL: "Test canonical digression reference validation"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: weather_query
      KEYWORDS: [weather]
      DO:
        - CALL: missing_weather_tool()
        - RESUME
    - INTENT: specialist_request
      KEYWORDS: [specialist]
      DO:
        - DELEGATE: Missing_Agent
          RETURN: true
          ON_RETURN:
            MAP:
              forecast: weather_result
        - RESUME

collect:
  REASONING: false
  GATHER:
    - value: required
  THEN: COMPLETE
`);

    expect(result.errors.some((error) => error.message.includes('missing_weather_tool'))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.message.includes('Missing_Agent'))).toBe(true);
  });

  test('rejects duplicate digression intents across global and step scopes at compile time', () => {
    const result = validateOne(`
AGENT: Duplicate_Digression_Scope_Collision

GOAL: "Test duplicate digression scope validation"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    - INTENT: help_request
      RESPOND: "Global help"

collect:
  REASONING: false
  GATHER:
    - value: required
  DIGRESSIONS:
    - INTENT: Help_Request
      RESPOND: "Step help"
  THEN: COMPLETE
`);

    expect(
      result.errors.some(
        (error) =>
          error.code === VALIDATION_CODES.DUPLICATE_DIGRESSION_INTENT &&
          error.path === 'flow.steps.collect.digressions[0].intent',
      ),
    ).toBe(true);
  });

  test('rejects duplicate digression intents within the same DIGRESSIONS block', () => {
    const result = validateOne(`
AGENT: Duplicate_Digression_Same_Step

GOAL: "Test duplicate digressions in a single step"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - value: required
  DIGRESSIONS:
    - INTENT: cancel_request
      RESPOND: "First cancel"
    - INTENT: cancel_request
      RESPOND: "Second cancel"
  THEN: COMPLETE
`);

    expect(
      result.errors.some(
        (error) =>
          error.code === VALIDATION_CODES.DUPLICATE_DIGRESSION_INTENT &&
          error.path === 'flow.steps.collect.digressions[1].intent',
      ),
    ).toBe(true);
  });
});
