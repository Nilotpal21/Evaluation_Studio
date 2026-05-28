import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

describe('INTENTS: section parser', () => {
  it('TC-INT-01 parses categories with descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "Customer asking about charges"
  setup: "Customer needs help setting up"

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "billing"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Customer asking about charges' },
      { name: 'setup', description: 'Customer needs help setting up' },
    ]);
  });

  it('TC-INT-02 parses categories without descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing
  setup
  escalation
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: undefined },
      { name: 'setup', description: undefined },
      { name: 'escalation', description: undefined },
    ]);
  });

  it('TC-INT-03 parses mixed — some with descriptions, some without', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "Charges and payments"
  setup
  escalation: "Wants human agent"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Charges and payments' },
      { name: 'setup', description: undefined },
      { name: 'escalation', description: 'Wants human agent' },
    ]);
  });

  it('TC-INT-04 handles single-quoted descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: 'Charges and payments'
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Charges and payments' },
    ]);
  });

  it('TC-INT-05 handles dash-prefixed entries', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  - billing: "Charges"
  - setup
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Charges' },
      { name: 'setup', description: undefined },
    ]);
  });

  it('TC-INT-06 skips comments and blank lines', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  # This is a comment
  billing: "Charges"

  // Another comment
  setup
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Charges' },
      { name: 'setup', description: undefined },
    ]);
  });

  it('TC-INT-07 returns undefined when INTENTS block is absent', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "billing"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toBeUndefined();
  });

  it('TC-INT-08 parses supervisor lexical fallback config without treating it as an intent', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  LEXICAL_FALLBACK: never
  billing: "Charges"
  setup

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "billing"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intentConfig).toEqual({ lexicalFallback: 'never' });
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'Charges' },
      { name: 'setup', description: undefined },
    ]);
  });

  it('TC-INT-09 warns on duplicate intent names and deduplicates', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "First billing description"
  setup
  billing: "Second billing description"
`;
    const result = parseAgentBasedABL(input);
    // Should keep first occurrence, warn on duplicate
    expect(result.document?.intents).toEqual([
      { name: 'billing', description: 'First billing description' },
      { name: 'setup', description: undefined },
    ]);
    expect(
      result.warnings.some((w) => w.message.includes('billing') && w.message.includes('Duplicate')),
    ).toBe(true);
  });

  it('TC-INT-10 warns on invalid entries', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  123invalid
  billing: "Valid one"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intents).toEqual([{ name: 'billing', description: 'Valid one' }]);
    expect(result.warnings.some((w) => w.message.includes('Invalid INTENTS entry'))).toBe(true);
  });

  it('TC-INT-11 warns on invalid lexical fallback values', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  LEXICAL_FALLBACK: maybe
  billing: "Charges"
`;
    const result = parseAgentBasedABL(input);
    expect(result.document?.intentConfig).toBeUndefined();
    expect(result.document?.intents).toEqual([{ name: 'billing', description: 'Charges' }]);
    expect(
      result.warnings.some((w) => w.message.includes('Invalid INTENTS lexical fallback')),
    ).toBe(true);
  });
});
