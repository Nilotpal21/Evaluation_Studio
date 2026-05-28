/**
 * validateABL Export Tests
 *
 * Tests the standalone validateABL function that parses + compiles + validates.
 */

import { describe, test, expect } from 'vitest';
import { validateABL } from '../platform/ir/validate-ir.js';

describe('validateABL', () => {
  test('returns empty diagnostics for valid ABL source', () => {
    const result = validateABL([
      {
        filename: 'greeting.abl',
        source: `AGENT: greeting_agent
GOAL: "Greet users"
PERSONA: "Friendly assistant"
`,
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test('returns parse errors for invalid ABL syntax', () => {
    const result = validateABL([
      {
        filename: 'broken.abl',
        source: 'this is not valid ABL at all',
      },
    ]);
    // Should have at least one parse/compilation error
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns validation errors for broken references', () => {
    const result = validateABL([
      {
        filename: 'bad_refs.abl',
        source: `AGENT: bad_agent

GOAL: "Test bad refs"

FLOW:
  steps: step_a
  step_a:
    REASONING: false
    RESPOND: Hello
    THEN: nonexistent_step
`,
      },
    ]);
    // DANGLING_STEP_REF has severity 'error', routed to compilation_errors
    expect(
      result.errors.some((d) => d.message.includes('nonexistent_step') && d.type === 'validation'),
    ).toBe(true);
  });

  test('handles empty documents array', () => {
    const result = validateABL([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
