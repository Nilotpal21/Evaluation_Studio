import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

function compileSingleAgent(dsl: string) {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.errors).toEqual([]);
  expect(parsed.document).toBeTruthy();
  return compileABLtoIR([parsed.document!]);
}

describe('tool confirmation validation', () => {
  it('warns when a side-effecting tool omits confirm policy', () => {
    const output = compileSingleAgent(`
AGENT: PaymentAgent
GOAL: "Charge customer cards"

TOOLS:
  charge_card(amount: number) -> object
    description: "Charge the customer's card"
    side_effects: true
`);

    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'PaymentAgent',
          code: VALIDATION_CODES.SIDE_EFFECT_TOOL_WITHOUT_CONFIRMATION,
          severity: 'warning',
          type: 'validation',
        }),
      ]),
    );
    expect(
      output.compilation_warnings?.find(
        (entry) => entry.code === VALIDATION_CODES.SIDE_EFFECT_TOOL_WITHOUT_CONFIRMATION,
      )?.message,
    ).toContain('confirm: when_side_effects');
  });

  it('does not warn when a side-effecting tool declares confirm policy', () => {
    const output = compileSingleAgent(`
AGENT: PaymentAgent
GOAL: "Charge customer cards"

TOOLS:
  charge_card(amount: number) -> object
    description: "Charge the customer's card"
    side_effects: true
    confirm: when_side_effects
`);

    expect(
      output.compilation_warnings?.some(
        (entry) => entry.code === VALIDATION_CODES.SIDE_EFFECT_TOOL_WITHOUT_CONFIRMATION,
      ) ?? false,
    ).toBe(false);
  });
});
