/**
 * TDD lock tests for Slice 6 [ABLP-415] — enum_set in GatherFieldSemantics.
 *
 * Bruce Wilcox flagged that the enumeration-set metadata for a GATHER field
 * lives on the top-level `GatherField.enum_values` rather than inside
 * `GatherFieldSemantics` alongside `format`, `components`, `unit`, etc.
 *
 * Architectural symmetry fix: accept `enum_set:` inside the `SEMANTICS:`
 * sub-block and normalize it to the top-level `enum_values` during compile.
 * The semantics object retains `enum_set` for round-trip / introspection;
 * runtime consumers continue to read `enum_values` (no breaking change).
 *
 * Contract locked by these tests:
 *   GATHER field with `SEMANTICS: { enum_set: [...] }` produces an IR
 *   GatherField whose `semantics.enum_set` is set AND whose `enum_values`
 *   mirrors the same array.
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('GATHER SEMANTICS.enum_set alias (Slice 6 / ABLP-415)', () => {
  test('top-level GATHER: enum_set in semantics populates both semantics.enum_set and enum_values', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  size:
    PROMPT: "What size?"
    TYPE: string
    SEMANTICS:
      enum_set: [small, medium, large]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields.find((f) => f.name === 'size');
    expect(field).toBeDefined();

    expect(field!.semantics).toBeDefined();
    expect(field!.semantics!.enum_set).toEqual(['small', 'medium', 'large']);
    expect(field!.enum_values).toEqual(['small', 'medium', 'large']);
  });

  test('semantics.enum_set is undefined when not specified', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  city:
    PROMPT: "What city?"
    TYPE: string
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields.find((f) => f.name === 'city');
    expect(field).toBeDefined();

    expect(field!.semantics?.enum_set).toBeUndefined();
  });

  test('enum_set coexists with other semantics properties (format, unit, locale)', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  currency_choice:
    PROMPT: "Which currency?"
    TYPE: string
    SEMANTICS:
      format: "currency_code"
      enum_set: [USD, EUR, GBP, JPY]
      locale: "en-US"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields.find((f) => f.name === 'currency_choice');
    expect(field).toBeDefined();

    expect(field!.semantics!.format).toBe('currency_code');
    expect(field!.semantics!.enum_set).toEqual(['USD', 'EUR', 'GBP', 'JPY']);
    expect(field!.semantics!.locale).toBe('en-US');
    expect(field!.enum_values).toEqual(['USD', 'EUR', 'GBP', 'JPY']);
  });

  test('FLOW-step GATHER: enum_set in semantics populates enum_values on IR', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - priority:
          TYPE: string
          PROMPT: "Priority level?"
          SEMANTICS:
            enum_set: [low, medium, high, urgent]
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    expect(step.gather).toBeDefined();

    const field = step.gather!.fields.find((f) => f.name === 'priority');
    expect(field).toBeDefined();
    expect(field!.enum_values).toEqual(['low', 'medium', 'high', 'urgent']);
    expect(field!.semantics?.enum_set).toEqual(['low', 'medium', 'high', 'urgent']);
  });

  test('top-level options wins when both options and semantics.enum_set are specified', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  tier:
    PROMPT: "Which tier?"
    TYPE: string
    OPTIONS: [bronze, silver, gold]
    SEMANTICS:
      enum_set: [platinum, diamond]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields.find((f) => f.name === 'tier');
    expect(field).toBeDefined();

    expect(field!.enum_values).toEqual(['bronze', 'silver', 'gold']);
    expect(field!.semantics!.enum_set).toEqual(['platinum', 'diamond']);
  });

  test('FLOW-step GATHER: options wins when both options and semantics.enum_set are specified', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - severity:
          TYPE: string
          PROMPT: "Severity?"
          OPTIONS: [sev1, sev2, sev3]
          SEMANTICS:
            enum_set: [minor, major, blocker]
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    const field = step.gather!.fields.find((f) => f.name === 'severity');
    expect(field).toBeDefined();

    expect(field!.enum_values).toEqual(['sev1', 'sev2', 'sev3']);
    expect(field!.semantics!.enum_set).toEqual(['minor', 'major', 'blocker']);
  });

  test('top-level options still works when enum_set is absent (back-compat)', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin_class:
    prompt: "Cabin class?"
    type: string
    options: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields.find((f) => f.name === 'cabin_class');
    expect(field).toBeDefined();

    expect(field!.enum_values).toEqual(['economy', 'business', 'first']);
    expect(field!.semantics?.enum_set).toBeUndefined();
  });
});
