/**
 * Defensive-input regression coverage.
 *
 * The parser entry points are typed as (content: string), but in practice
 * callers can hand us a non-string when an upstream layer nulls a value
 * (e.g., the Mongoose encryption plugin's "Legacy encrypted document" path).
 * In that case the parser must surface a structured error instead of
 * crashing deeper with `e.trim is not a function` or similar.
 */
import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL, parseYamlABL, isYamlFormat } from '../parser/index.js';

describe('parseAgentBasedABL non-string input', () => {
  it('returns a structured parse error when content is null', () => {
    const result = parseAgentBasedABL(null as unknown as string);
    expect(result.document).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/non-string/);
    expect(result.errors[0].message).toMatch(/null/);
  });

  it('returns a structured parse error when content is undefined', () => {
    const result = parseAgentBasedABL(undefined as unknown as string);
    expect(result.document).toBeNull();
    expect(result.errors[0].message).toMatch(/undefined/);
  });

  it('returns a structured parse error when content is an object', () => {
    const result = parseAgentBasedABL({} as unknown as string);
    expect(result.document).toBeNull();
    expect(result.errors[0].message).toMatch(/object/);
  });
});

describe('parseYamlABL non-string input', () => {
  it('returns a structured parse error when content is null', () => {
    const result = parseYamlABL(null as unknown as string);
    expect(result.document).toBeNull();
    expect(result.errors[0].message).toMatch(/non-string/);
  });
});

describe('isYamlFormat non-string input', () => {
  it('treats non-string input as not-YAML rather than throwing', () => {
    expect(isYamlFormat(null as unknown as string)).toBe(false);
    expect(isYamlFormat(undefined as unknown as string)).toBe(false);
    expect(isYamlFormat({} as unknown as string)).toBe(false);
  });
});
