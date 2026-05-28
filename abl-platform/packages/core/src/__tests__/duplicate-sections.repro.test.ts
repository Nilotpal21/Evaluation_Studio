// REGRESSION: ABLP-1032
/**
 * ABLP-1032 Reproduction Test — Duplicate top-level sections silently overwrite
 *
 * Every affected section (DELEGATE, HANDOFF, TOOLS, MEMORY) is tested to verify
 * that when two blocks of the same section appear in a single agent file, both
 * blocks' contents are preserved. Singleton sections are tested separately to
 * verify duplicate blocks are reported instead of silently overwriting.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('ABLP-1032: Duplicate top-level sections must accumulate or error', () => {
  test('two DELEGATE: blocks should accumulate both entries', () => {
    const dsl = `
AGENT: MultiDelegate

GOAL: "Route to multiple agents"

DELEGATE:
  - AGENT: SummaryAgent
    WHEN: user asks for a summary
    PURPOSE: "Summarize the conversation"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Use the summary in your reply"

DELEGATE:
  - AGENT: BillingAgent
    WHEN: user asks about billing
    PURPOSE: "Handle billing queries"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Answer based on billing result"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.delegate).toHaveLength(2);
    expect(result.document!.delegate.map((d) => d.agent)).toContain('SummaryAgent');
    expect(result.document!.delegate.map((d) => d.agent)).toContain('BillingAgent');
  });

  test('two HANDOFF: blocks should accumulate both entries', () => {
    const dsl = `
AGENT: MultiHandoff

GOAL: "Route to multiple agents via handoff"

HANDOFF:
  - TO: SupportAgent
    WHEN: user needs support

HANDOFF:
  - TO: SalesAgent
    WHEN: user wants to buy
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.handoff).toHaveLength(2);
    expect(result.document!.handoff.map((h) => h.to)).toContain('SupportAgent');
    expect(result.document!.handoff.map((h) => h.to)).toContain('SalesAgent');
  });

  test('two TOOLS: blocks should accumulate both entries', () => {
    const dsl = `
AGENT: MultiTools

GOAL: "Agent with tools split across blocks"

TOOLS:
  search(query: string) -> object
    description: "Search the web"

TOOLS:
  calculate(expression: string) -> object
    description: "Perform calculations"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.tools).toHaveLength(2);
    expect(result.document!.tools.map((t) => t.name)).toContain('search');
    expect(result.document!.tools.map((t) => t.name)).toContain('calculate');
  });

  test('repeated TOOLS: blocks reject duplicate tool names instead of forwarding ambiguous keys', () => {
    const dsl = `
AGENT: DuplicateTools

GOAL: "Agent with duplicate tool keys"

TOOLS:
  search(query: string) -> object
    description: "Search the web"

TOOLS:
  search(term: string) -> object
    description: "Conflicting search signature"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.tools).toHaveLength(1);
    expect(result.document!.tools[0].parameters[0].name).toBe('query');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate TOOLS entry "search"')]),
    );
  });

  test('two MEMORY: blocks should merge session vars from both', () => {
    const dsl = `
AGENT: MultiMemory

GOAL: "Agent with memory split across blocks"

MEMORY:
  SESSION:
    - name: userId
      type: string
      description: "The user ID"

MEMORY:
  SESSION:
    - name: orderId
      type: string
      description: "The order ID"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.memory.session.length).toBeGreaterThanOrEqual(2);
    expect(result.document!.memory.session.map((s) => s.name)).toContain('userId');
    expect(result.document!.memory.session.map((s) => s.name)).toContain('orderId');
  });

  test('repeated MEMORY blocks reject duplicate session variable names', () => {
    const dsl = `
AGENT: DuplicateSessionMemory

GOAL: "Keep first session memory declaration"

MEMORY:
  SESSION:
    - NAME: userId
      TYPE: string

MEMORY:
  SESSION:
    - NAME: userId
      TYPE: number
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.memory.session).toHaveLength(1);
    expect(result.document!.memory.session[0].type).toBe('string');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate MEMORY SESSION entry "userId"')]),
    );
  });

  test('repeated MEMORY blocks reject duplicate persistent paths', () => {
    const dsl = `
AGENT: DuplicatePersistentMemory

GOAL: "Keep first persistent memory declaration"

MEMORY:
  PERSISTENT:
    - PATH: user.profile
      TYPE: object

MEMORY:
  PERSISTENT:
    - PATH: user.profile
      TYPE: string
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.memory.persistent).toHaveLength(1);
    expect(result.document!.memory.persistent[0].type).toBe('object');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate MEMORY PERSISTENT entry "user.profile"'),
      ]),
    );
  });

  test('TEMPLATES: correctly accumulates (control — should pass)', () => {
    const dsl = `
AGENT: TemplatesControl

GOAL: "Agent with templates in multiple blocks"

TEMPLATES:
  greeting:
    text: "Hello!"

TEMPLATES:
  farewell:
    text: "Goodbye!"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.templates).toBeDefined();
    expect(result.document!.templates!.length).toBeGreaterThanOrEqual(2);
  });

  test('duplicate singleton sections report parser errors and keep the first value', () => {
    const dsl = `
AGENT: DuplicateSingletons

GOAL: "First goal"

LANGUAGE: en-US

EXECUTION:
  model: "gpt-4.1-mini"

GOAL: "Second goal"

LANGUAGE: fr-FR

EXECUTION:
  model: "gpt-4.1"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.goal.description).toBe('First goal');
    expect(result.document!.language).toBe('en-US');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate section GOAL:'),
        expect.stringContaining('Duplicate section LANGUAGE:'),
        expect.stringContaining('Duplicate section EXECUTION:'),
      ]),
    );
  });

  test('duplicate document header sections report parser errors and keep the first value', () => {
    const dsl = `
AGENT: HeaderFirst

VERSION: "1.0.0"

DESCRIPTION: "First description"

GOAL: "Keep first header values"

AGENT: HeaderSecond

SUPERVISOR: HeaderSupervisor

VERSION: "2.0.0"

DESCRIPTION: |
  Second description should not overwrite.
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.name).toBe('HeaderFirst');
    expect(result.document!.meta!.name).toBe('HeaderFirst');
    expect(result.document!.meta!.kind).toBe('agent-based');
    expect(result.document!.meta!.version).toBe('1.0.0');
    expect(result.document!.meta!.description).toBe('First description');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate section AGENT/SUPERVISOR:'),
        expect.stringContaining('Duplicate section VERSION:'),
        expect.stringContaining('Duplicate section DESCRIPTION:'),
      ]),
    );
  });

  test('duplicate IDENTITY blocks report parser errors and keep the first mapped values', () => {
    const dsl = `
AGENT: DuplicateIdentity

IDENTITY:
  role: "First role"
  persona: "First persona"
  limitations: [first limit]

IDENTITY:
  role: "Second role"
  persona: "Second persona"
  limitations: [second limit]
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.goal.description).toBe('First role');
    expect(result.document!.persona.description).toBe('First persona');
    expect(result.document!.limitations).toEqual([{ description: 'first limit' }]);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate section IDENTITY:')]),
    );
  });

  test('FLOW and legacy STEPS are mutually exclusive because both populate doc.flow', () => {
    const dsl = `
AGENT: DuplicateFlowShapes

GOAL: "Keep the first flow shape"

FLOW:
  start:
    REASONING: false
    SAY: "First flow wins"

STEPS:
  1. LegacyWelcome
     RESPOND "Legacy flow should not overwrite FLOW"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.flow?.definitions.start).toBeDefined();
    expect(result.document!.flow?.definitions.LegacyWelcome).toBeUndefined();
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate section FLOW/STEPS:')]),
    );
  });

  test('repeated RETURN_HANDLERS blocks reject duplicate handler names', () => {
    const dsl = `
AGENT: DuplicateReturnHandlers

GOAL: "Keep first return handler"

RETURN_HANDLERS:
  resume:
    RESPOND: "First handler"

RETURN_HANDLERS:
  resume:
    RESPOND: "Second handler"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.returnHandlers?.resume.respond).toBe('First handler');
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate RETURN_HANDLERS entry "resume"')]),
    );
  });

  test('repeated LOOKUP_TABLES blocks reject duplicate table names', () => {
    const dsl = `
AGENT: DuplicateLookupTables

GOAL: "Keep first lookup table"

LOOKUP_TABLES:
  codes:
    source: inline
    values: [A]

LOOKUP_TABLES:
  codes:
    source: inline
    values: [B]
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document).not.toBeNull();
    expect(result.document!.lookupTables?.codes.values).toEqual(['A']);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate LOOKUP_TABLES entry "codes"')]),
    );
  });
});
