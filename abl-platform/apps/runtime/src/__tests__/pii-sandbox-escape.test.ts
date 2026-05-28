/**
 * PII Validator Sandbox Security Tests (CRIT-7)
 *
 * Verifies that buildSandboxedValidator only accepts valid regex patterns
 * and never executes arbitrary JS. The security fix replaces node:vm with
 * regex-only validation, so even if a JS expression parses as regex,
 * it will never be evaluated as code.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

vi.mock('../repos/pii-pattern-repo.js', () => ({
  findBuiltinOverride: vi.fn(),
  upsertBuiltinOverride: vi.fn(),
  findEnabled: vi.fn().mockResolvedValue([]),
}));

import { buildSandboxedValidator } from '../services/pii/pattern-loader.js';

describe('PII validator sandbox security', () => {
  it('rejects invalid regex syntax (unbalanced brackets)', () => {
    expect(() => buildSandboxedValidator('[unclosed')).toThrow(
      'Invalid validator expression: must be a valid regex pattern',
    );
  });

  it('rejects catastrophic backtracking patterns', () => {
    expect(() => buildSandboxedValidator('(a+)+$')).toThrow(
      'Validator regex rejected: potential catastrophic backtracking',
    );
    expect(() => buildSandboxedValidator('(.*)*')).toThrow(
      'Validator regex rejected: potential catastrophic backtracking',
    );
    expect(() => buildSandboxedValidator('(.+)+')).toThrow(
      'Validator regex rejected: potential catastrophic backtracking',
    );
  });

  it('treats JS expressions as harmless regex patterns — no code execution', () => {
    // JS expressions that happen to be valid regex are treated as regex
    // patterns, NOT executed as code. This is the security guarantee.
    // If the old vm.Script approach were still used, this would execute process.env.
    const validator = buildSandboxedValidator('process');
    // As a regex, it simply matches the literal string "process" in the input.
    expect(validator('has process in it')).toBe(true);
    expect(validator('safe text')).toBe(false);
  });

  it('accepts valid regex validator', () => {
    const validator = buildSandboxedValidator('^[A-Z]{2}\\d{6}$');
    expect(validator('AB123456')).toBe(true);
    expect(validator('invalid')).toBe(false);
  });

  it('accepts simple digit regex', () => {
    const validator = buildSandboxedValidator('^\\d{10,}$');
    expect(validator('1234567890')).toBe(true);
    expect(validator('12345')).toBe(false);
  });
});
