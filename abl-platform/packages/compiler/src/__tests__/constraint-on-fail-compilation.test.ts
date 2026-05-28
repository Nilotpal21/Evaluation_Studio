import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import {
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
} from '../platform/constants.js';

function compileDsl(dsl: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();

  return compileABLtoIR([parseResult.document!]);
}

function compileDocuments(dsls: string[]) {
  const parseResults = dsls.map((dsl) => {
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    expect(parseResult.document).not.toBeNull();
    return parseResult;
  });

  return {
    output: compileABLtoIR(parseResults.map((parseResult) => parseResult.document!)),
    primaryDocument: parseResults[0].document!,
  };
}

function compileConstraintOnFail(onFailLine: string) {
  return compileFirstConstraint(`
AGENT: Constraint_On_Fail_Test
GOAL: "Test constraint ON_FAIL compilation"

CONSTRAINTS:
  - REQUIRE age >= 18
    ${onFailLine}
`).on_fail;
}

function compileFirstConstraint(dsl: string, additionalDsl: string[] = []) {
  const { output, primaryDocument } = compileDocuments([
    `
${dsl}
`,
    ...additionalDsl,
  ]);
  expect(output.compilation_errors).toBeUndefined();

  const agent = output.agents[primaryDocument.name];
  expect(agent).toBeDefined();
  expect(agent.constraints.constraints).toHaveLength(1);

  return agent.constraints.constraints[0];
}

describe('constraint ON_FAIL compilation', () => {
  test('compiles BLOCK without leaking the keyword into a respond action', () => {
    const action = compileConstraintOnFail('ON_FAIL: BLOCK');
    expect(action).toEqual({ type: 'block' });
  });

  test('compiles BLOCK with custom text into block reason and message', () => {
    expect(compileConstraintOnFail('ON_FAIL: BLOCK "Adults only."')).toEqual({
      type: 'block',
      message: 'Adults only.',
      reason: 'Adults only.',
    });
  });

  test('compiles RESPOND with inline text into respond.message', () => {
    expect(compileConstraintOnFail('ON_FAIL: RESPOND "Sorry, max 10 guests."')).toEqual({
      type: 'respond',
      message: 'Sorry, max 10 guests.',
    });
  });

  test('compiles REDACT into a redact action', () => {
    expect(compileConstraintOnFail('ON_FAIL: REDACT')).toEqual({
      type: 'redact',
      message: undefined,
    });
  });

  test('preserves ESCALATE reason text', () => {
    expect(compileConstraintOnFail('ON_FAIL: ESCALATE Needs human review')).toEqual({
      type: 'escalate',
      reason: 'Needs human review',
    });
  });

  test('preserves HANDOFF target text', () => {
    expect(
      compileFirstConstraint(
        `
AGENT: Constraint_On_Fail_Test
GOAL: "Test constraint ON_FAIL compilation"

CONSTRAINTS:
  - REQUIRE age >= 18
    ON_FAIL: HANDOFF billing_agent
`,
        [
          `
AGENT: billing_agent
GOAL: "Handle billing issues"
`,
        ],
      ).on_fail,
    ).toEqual({
      type: 'handoff',
      target: 'billing_agent',
      message: undefined,
    });
  });

  test('bare HANDOFF without a target compiles to handoff without target', () => {
    expect(compileConstraintOnFail('ON_FAIL: HANDOFF')).toEqual({
      type: 'handoff',
    });
  });

  test('retains LIMIT as an IR kind while aliasing its condition to standard constraint handling', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Limit_Kind_Test
GOAL: "Test limit constraint compilation"

CONSTRAINTS:
  - LIMIT daily_wire_used + amount <= daily_wire_limit
    ON_FAIL: RESPOND "Limit exceeded."
`);

    expect(constraint.kind).toBe('limit');
    expect(constraint.condition).toContain('daily_wire_used + amount <= daily_wire_limit');
    expect(constraint.on_fail).toEqual({
      type: 'respond',
      message: 'Limit exceeded.',
    });
  });

  test('retains RESTRICT as an IR kind and lowers it to existing runtime semantics', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Restrict_Kind_Test
GOAL: "Test restrict constraint compilation"

CONSTRAINTS:
  - RESTRICT beneficiary_country IN ["CU", "IR"]
    ON_FAIL: RESPOND "Destination prohibited."
`);

    expect(constraint.kind).toBe('restrict');
    expect(constraint.condition).toContain('NOT (beneficiary_country IN ["CU", "IR"])');
    expect(constraint.on_fail).toEqual({
      type: 'respond',
      message: 'Destination prohibited.',
    });
  });

  test('lowers inline constraint-level WHEN to implication semantics and preserves applies_when metadata', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_When_Test
GOAL: "Test conditional constraint compilation"

CONSTRAINTS:
  - REQUIRE ssn IS NOT SET WHEN channel == "voice"
    ON_FAIL: RESPOND "SSN cannot be collected on voice."
`);

    expect(constraint.applies_when).toBe('channel == "voice"');
    expect(constraint.condition).toBe('NOT (channel == "voice") OR (ssn IS NOT SET)');
  });

  test('lowers IMPLIES to OR semantics before runtime evaluation', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Implies_Test
GOAL: "Test implies compilation"

CONSTRAINTS:
  - REQUIRE dispute_type == "card" IMPLIES card_unique_id != ""
    ON_FAIL: RESPOND "Card disputes require an identifier."
`);

    expect(constraint.condition).toBe('NOT (dispute_type == "card") OR (card_unique_id != "")');
  });

  test('lowers structural BEFORE tool checkpoints and preserves checkpoint metadata', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Before_Tool_Test
GOAL: "Test BEFORE tool checkpoint compilation"

CONSTRAINTS:
  - REQUIRE measure_field IS SET BEFORE calling search_aggregate()
    ON_FAIL: RESPOND "Select a measure first."
`);

    expect(constraint.checkpoint).toEqual({ kind: 'tool_call', target: 'search_aggregate' });
    expect(constraint.condition).toBe(
      `NOT (${CONSTRAINT_CHECKPOINT_KIND_KEY} == "tool_call" AND ${CONSTRAINT_CHECKPOINT_TARGET_KEY} == "search_aggregate") OR (measure_field IS SET)`,
    );
  });

  test('does not auto-guard checkpointed tool constraints', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Before_Tool_Boolean_Test
GOAL: "Test BEFORE tool checkpoint compilation without auto-guard"

CONSTRAINTS:
  - REQUIRE ready_for_search == true BEFORE calling search
    ON_FAIL: RESPOND "Confirm the search before calling the tool."
`);

    expect(constraint.checkpoint).toEqual({ kind: 'tool_call', target: 'search' });
    expect(constraint.condition).toBe(
      `NOT (${CONSTRAINT_CHECKPOINT_KIND_KEY} == "tool_call" AND ${CONSTRAINT_CHECKPOINT_TARGET_KEY} == "search") OR (ready_for_search == true)`,
    );
  });

  test('lowers structural BEFORE response checkpoints and preserves checkpoint metadata', () => {
    const constraint = compileFirstConstraint(`
AGENT: Constraint_Before_Response_Test
GOAL: "Test BEFORE response checkpoint compilation"

CONSTRAINTS:
  - REQUIRE aggregation_validated == true BEFORE returning results
    ON_FAIL: RESPOND "Validate the aggregation before responding."
`);

    expect(constraint.checkpoint).toEqual({ kind: 'response' });
    expect(constraint.condition).toBe(
      'NOT (_abl_constraint_checkpoint_kind == "response") OR (aggregation_validated == true)',
    );
  });

  test('warns when non-structural BEFORE targets are retained as warning-only no-ops', () => {
    const output = compileDsl(`
AGENT: Constraint_Before_Compatibility_Test
GOAL: "Test BEFORE compatibility warning"

CONSTRAINTS:
  - REQUIRE user_verified == true BEFORE action == "view_account"
    ON_FAIL: RESPOND "Verify the user first."
`);

    const constraint =
      output.agents['Constraint_Before_Compatibility_Test'].constraints.constraints[0];
    expect(constraint.checkpoint).toBeUndefined();
    expect(constraint.condition).toBe('true');
    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'Constraint_Before_Compatibility_Test',
          severity: 'warning',
          message:
            'W824: Constraint BEFORE target "action == "view_account"" is not a supported structural checkpoint. The construct is retained for compatibility, but has no runtime effect; use IMPLIES or WHEN for non-structural conditions. Supported structural targets: "calling <tool>" and "returning results".',
        }),
      ]),
    );
  });

  test('warns when a named constraint phase is treated as a label only', () => {
    const output = compileDsl(`
AGENT: Constraint_Phase_Label_Test
GOAL: "Test constraint phase warnings"

CONSTRAINTS:
  pre_booking:
    - REQUIRE age >= 18
      ON_FAIL: RESPOND "Adults only."
`);

    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'Constraint_Phase_Label_Test',
          severity: 'warning',
          message:
            'W823: Constraint phase "pre_booking" has no runtime effect. All constraints evaluate every turn; phase names are treated as labels for readability only.',
        }),
      ]),
    );
  });

  test('does not warn for the default always constraint phase', () => {
    const output = compileDsl(`
AGENT: Constraint_Phase_Always_Test
GOAL: "Test always constraint phase"

CONSTRAINTS:
  always:
    - REQUIRE age >= 18
      ON_FAIL: RESPOND "Adults only."
`);

    const phaseWarnings =
      output.compilation_warnings?.filter((warning) => warning.message.startsWith('W823:')) ?? [];
    expect(phaseWarnings).toHaveLength(0);
  });

  test('warns when top-level gather sets both required:false and default', () => {
    const output = compileDsl(`
AGENT: Gather_Default_Top_Level_Test
GOAL: "Test gather default warning"

GATHER:
  email:
    prompt: "What is your email?"
    type: string
    required: false
    default: "none"
`);

    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'Gather_Default_Top_Level_Test',
          severity: 'warning',
          message:
            'W822: GATHER field "email" sets both required:false and default. Fields with defaults already satisfy missing-field checks; remove required:false for clarity.',
        }),
      ]),
    );
  });

  test('warns when flow gather sets both required:false and default', () => {
    const output = compileDsl(`
AGENT: Gather_Default_Flow_Test
GOAL: "Test flow gather default warning"

FLOW:
  entry_point: collect_contact
  steps:
    - collect_contact

collect_contact:
  REASONING: false
  GATHER:
    - email:
        TYPE: string
        PROMPT: "What is your email?"
        REQUIRED: false
        DEFAULT: "none"
`);

    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'Gather_Default_Flow_Test',
          severity: 'warning',
          message:
            'W822: FLOW step "collect_contact" GATHER field "email" sets both required:false and default. Fields with defaults already satisfy missing-field checks; remove required:false for clarity.',
        }),
      ]),
    );
  });
});
