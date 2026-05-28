import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';

describe('compileABLtoIR output contract', () => {
  test('mirrors compilation diagnostics onto errors and warnings aliases', () => {
    const parsed = parseAgentBasedABL(`
AGENT: OutputContractAgent
GOAL: "Exercise compiler output aliases"

FLOW:
  start -> follow_up

  start:
      REASONING: false
    THEN: missing_step

  follow_up:
      REASONING: false
    COMPLETE_WHEN: ready == true
    RESPOND: "Done"
    THEN: COMPLETE
`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.document).toBeTruthy();

    const output = compileABLtoIR([parsed.document!]);

    expect(output.compilation_errors).toBeDefined();
    expect(output.errors).toEqual(output.compilation_errors);
    expect(output.compilation_warnings).toBeDefined();
    expect(output.warnings).toEqual(output.compilation_warnings);
  });
});
