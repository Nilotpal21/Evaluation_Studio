/**
 * Negative / Edge-Case Parser Tests for DSL Extensions
 *
 * Covers: malformed SET, empty CLEAR, invalid TRANSFORM header,
 * empty WITH block, missing AS value, empty ON_RESULT,
 * and various syntax edge cases.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// Helper: wraps a step in a minimal agent DSL
function wrapStep(stepContent: string): string {
  return `
AGENT: NegativeTest
GOAL: "Negative test"

FLOW:
  start -> end

  start:
      REASONING: false
${stepContent}
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
}

// =============================================================================
// SET — NEGATIVE
// =============================================================================

describe('Parser negative: SET', () => {
  test('SET without equals sign should not create assignment', () => {
    const dsl = wrapStep('    SET: justAVariable');
    const result = parseAgentBasedABL(dsl);
    // Parser should not crash; the line doesn't match "var = expr" regex
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // The SET array is created but no assignment was pushed (regex didn't match)
    expect(step?.set).toEqual([]);
  });

  test('SET block with lines missing equals sign should skip them', () => {
    const dsl = `
AGENT: SetBadBlockTest
GOAL: "Test bad SET block"

FLOW:
  start -> end

  start:
      REASONING: false
    SET:
        REASONING: false
      validVar = 42
      this line has no equals
      another = true
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // Only the two valid lines should be parsed
    expect(step?.set).toHaveLength(2);
    expect(step?.set?.[0].variable).toBe('validVar');
    expect(step?.set?.[1].variable).toBe('another');
  });

  test('SET block with empty lines should stop at un-indented line', () => {
    const dsl = `
AGENT: SetEmptyBlockTest
GOAL: "Test empty SET block"

FLOW:
  start -> end

  start:
      REASONING: false
    SET:
        REASONING: false
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // SET array should exist but be empty
    expect(step?.set).toEqual([]);
    // THEN should still be parsed correctly
    expect(step?.then).toBe('end');
  });

  test('SET with expression containing equals sign', () => {
    // "result = status == 200" — regex ([\w.]+)\s*=\s*(.+) matches first =
    // variable = "result", expression = "status == 200"
    const dsl = wrapStep('    SET: result = status == 200');
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.set?.[0].variable).toBe('result');
    expect(step?.set?.[0].expression).toBe('status == 200');
  });
});

// =============================================================================
// CLEAR — NEGATIVE
// =============================================================================

describe('Parser negative: CLEAR', () => {
  test('CLEAR with empty value should produce empty array', () => {
    const dsl = `
AGENT: ClearEmptyTest
GOAL: "Test empty CLEAR"

FLOW:
  start -> end

  start:
      REASONING: false
    CLEAR:
        REASONING: false
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // split('').filter(Boolean) → empty array
    // But actually 'CLEAR:' with no value — depends on how the parser splits key:value
    // value would be empty string, ''.split(',').map(trim).filter(Boolean) = []
    expect(step?.clear).toEqual([]);
  });

  test('CLEAR with trailing commas should filter empty entries', () => {
    const dsl = wrapStep('    CLEAR: foo,, bar,,');
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // filter(Boolean) removes empty strings
    expect(step?.clear).toEqual(['foo', 'bar']);
  });

  test('CLEAR with whitespace-only entries should filter them', () => {
    const dsl = wrapStep('    CLEAR: foo,   , bar');
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.clear).toEqual(['foo', 'bar']);
  });
});

// =============================================================================
// TRANSFORM — NEGATIVE
// =============================================================================

describe('Parser negative: TRANSFORM', () => {
  test('TRANSFORM with invalid header (missing AS keyword) should not parse', () => {
    const dsl = `
AGENT: TransformBadHeaderTest
GOAL: "Test bad TRANSFORM header"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items INTO output
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // Regex doesn't match → transform is not set
    expect(step?.transform).toBeUndefined();
  });

  test('TRANSFORM with invalid header (missing INTO keyword) should not parse', () => {
    const dsl = `
AGENT: TransformNoIntoTest
GOAL: "Test TRANSFORM missing INTO"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items AS item
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.transform).toBeUndefined();
  });

  test('TRANSFORM with no sub-properties should parse header only', () => {
    const dsl = `
AGENT: TransformNoSubsTest
GOAL: "Test TRANSFORM no sub-properties"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: data AS item INTO result
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.transform).toBeDefined();
    expect(step?.transform?.source).toBe('data');
    expect(step?.transform?.itemVar).toBe('item');
    expect(step?.transform?.target).toBe('result');
    expect(step?.transform?.filter).toBeUndefined();
    expect(step?.transform?.map).toBeUndefined();
    expect(step?.transform?.sortBy).toBeUndefined();
    expect(step?.transform?.limit).toBeUndefined();
  });

  test('TRANSFORM with SORT_BY missing order defaults to asc', () => {
    const dsl = `
AGENT: TransformSortDefaultTest
GOAL: "Test SORT_BY default order"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items AS item INTO result
      SORT_BY: name
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.transform?.sortBy).toEqual({ field: 'name', order: 'asc' });
  });

  test('TRANSFORM with LIMIT non-numeric should parse as NaN', () => {
    const dsl = `
AGENT: TransformBadLimitTest
GOAL: "Test TRANSFORM bad LIMIT"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items AS item INTO result
      LIMIT: abc
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // parseInt('abc', 10) = NaN
    expect(step?.transform?.limit).toBeNaN();
  });

  test('TRANSFORM with unknown sub-property should skip it', () => {
    const dsl = `
AGENT: TransformUnknownSubTest
GOAL: "Test TRANSFORM unknown sub-property"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items AS item INTO result
      FILTER: item.active == true
      UNKNOWN_PROP: some value
      LIMIT: 10
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.transform?.filter).toBe('item.active == true');
    expect(step?.transform?.limit).toBe(10);
  });

  test('TRANSFORM MAP with empty block should produce empty object', () => {
    const dsl = `
AGENT: TransformEmptyMapTest
GOAL: "Test TRANSFORM empty MAP"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items AS item INTO result
      MAP:
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // MAP block parsed but no indented lines → empty object
    expect(step?.transform?.map).toEqual({});
  });
});

// =============================================================================
// CALL WITH/AS — NEGATIVE
// =============================================================================

describe('Parser negative: CALL WITH/AS', () => {
  test('CALL WITH empty block should produce empty callWith', () => {
    const dsl = `
AGENT: CallEmptyWithTest
GOAL: "Test empty WITH block"

TOOLS:
  do_something() -> object

FLOW:
  start -> end

  start:
      REASONING: false
    CALL: do_something
      WITH:
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.call).toBe('do_something');
    expect(step?.callWith).toEqual({});
  });

  test('CALL AS with empty value should leave callAs undefined', () => {
    const dsl = `
AGENT: CallEmptyAsTest
GOAL: "Test empty AS"

TOOLS:
  do_something() -> object

FLOW:
  start -> end

  start:
      REASONING: false
    CALL: do_something
      AS:
          REASONING: false
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.call).toBe('do_something');
    expect(step?.callAs).toBeUndefined();
  });

  test('CALL with WITH: having lines without colons should skip them', () => {
    const dsl = `
AGENT: CallWithBadLinesTest
GOAL: "Test WITH bad lines"

TOOLS:
  do_something(x: string) -> object

FLOW:
  start -> end

  start:
      REASONING: false
    CALL: do_something
      WITH:
        validKey: validValue
        this line has no colon
        anotherKey: anotherValue
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // Lines without colon are skipped by the indexOf(':') === -1 check
    // But wait — "this line has no colon" doesn't have a colon, so it's skipped
    // Actually "has" doesn't contain colon... let me check.
    // "this line has no colon" — no colon, so withColonIdx === -1, skipped
    expect(step?.callWith).toBeDefined();
    expect(step?.callWith?.['validKey']).toBe('validValue');
    expect(step?.callWith?.['anotherKey']).toBe('anotherValue');
    expect(Object.keys(step?.callWith || {}).length).toBe(2);
  });
});

// =============================================================================
// ON_RESULT — NEGATIVE
// =============================================================================

describe('Parser negative: ON_RESULT', () => {
  test('ON_RESULT with no branches should produce empty array', () => {
    const dsl = `
AGENT: OnResultEmptyTest
GOAL: "Test empty ON_RESULT"

TOOLS:
  check() -> object

FLOW:
  start -> check -> end

  start:
      REASONING: false
    RESPOND: "Start"
    THEN: check

  check:
      REASONING: false
    CALL: check
    ON_RESULT:
        REASONING: false
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['check'];
    // parseOnInput returns the parsed branches; empty block → empty array or no branches
    expect(step?.onResult).toBeDefined();
    expect(step?.onResult?.length).toBe(0);
  });

  test('ON_RESULT with only ELSE branch (no IF)', () => {
    const dsl = `
AGENT: OnResultElseOnlyTest
GOAL: "Test ON_RESULT ELSE only"

TOOLS:
  check() -> object

FLOW:
  start -> check -> end

  start:
      REASONING: false
    RESPOND: "Start"
    THEN: check

  check:
      REASONING: false
    CALL: check
    ON_RESULT:
        REASONING: false
      - ELSE:
        RESPOND: "Fallback"
        THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['check'];
    expect(step?.onResult).toHaveLength(1);
    expect(step?.onResult?.[0].condition).toBeUndefined();
    expect(step?.onResult?.[0].respond).toBe('Fallback');
    expect(step?.onResult?.[0].then).toBe('end');
  });
});

// =============================================================================
// COMBINED EDGE CASES
// =============================================================================

describe('Parser negative: combined edge cases', () => {
  test('step with SET + CLEAR + RESPOND should parse all properties', () => {
    const dsl = `
AGENT: MultiPropTest
GOAL: "Test multiple properties on one step"

FLOW:
  start -> end

  start:
      REASONING: false
    SET: counter = 0
    CLEAR: old_data
    RESPOND: "Initialized"
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.set).toHaveLength(1);
    expect(step?.clear).toEqual(['old_data']);
    expect(step?.respond).toBe('Initialized');
    expect(step?.then).toBe('end');
  });

  test('multiple SET lines in same step accumulate', () => {
    const dsl = `
AGENT: MultiSetTest
GOAL: "Test multiple inline SET"

FLOW:
  start -> end

  start:
      REASONING: false
    SET: a = 1
    SET: b = 2
    SET: c = ADD(a, b)
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    expect(step?.set).toHaveLength(3);
    expect(step?.set?.[0].variable).toBe('a');
    expect(step?.set?.[1].variable).toBe('b');
    expect(step?.set?.[2].variable).toBe('c');
  });

  test('TRANSFORM header with extra spaces is still parsed', () => {
    const dsl = `
AGENT: TransformSpacesTest
GOAL: "Test TRANSFORM with extra spaces"

FLOW:
  start -> end

  start:
      REASONING: false
    TRANSFORM: items   AS   item   INTO   result
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const step = result.document?.flow?.definitions['start'];
    // Regex uses \s+ which matches multiple spaces
    expect(step?.transform).toBeDefined();
    expect(step?.transform?.source).toBe('items');
    expect(step?.transform?.itemVar).toBe('item');
    expect(step?.transform?.target).toBe('result');
  });
});
