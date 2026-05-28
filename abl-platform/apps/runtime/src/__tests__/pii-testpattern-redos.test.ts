/**
 * PII testPattern — ReDoS Prevention Tests (CRIT-8)
 *
 * Verifies that testPattern uses buildSandboxedValidator for the validate
 * parameter, preventing ReDoS via catastrophic backtracking patterns.
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

vi.mock('../../repos/pii-pattern-repo.js', () => ({
  findBuiltinOverride: vi.fn(),
  upsertBuiltinOverride: vi.fn(),
  findEnabled: vi.fn().mockResolvedValue([]),
}));

import { testPattern } from '../services/pii/pattern-service.js';

describe('testPattern — ReDoS prevention', () => {
  it('rejects validator with catastrophic backtracking (does not hang)', () => {
    // (a+)+$ is a classic ReDoS pattern. With buildSandboxedValidator,
    // it should be rejected and filtering skipped (not hang the process).
    const result = testPattern('\\d+', '12345', '(a+)+$');
    expect(result.detections).toBeDefined();
    // The validator is rejected, so no filtering occurs — all detections remain
    expect(result.detections.length).toBe(1);
  });

  it('completes within timeout for benign validator', () => {
    const start = Date.now();
    const result = testPattern('\\d+', '12345', '^\\d+$');
    expect(Date.now() - start).toBeLessThan(100);
    expect(result.detections.length).toBe(1);
  });

  it('filters detections using a valid regex validator', () => {
    // Regex that matches any word, validator that requires at least 5 chars
    const result = testPattern('\\w+', 'hi there world', '^\\w{5,}$');
    // 'hi' (2 chars), 'there' (5 chars), 'world' (5 chars)
    // Only 'there' and 'world' pass the validator
    expect(result.detections.length).toBe(2);
    expect(result.detections.map((d) => d.match)).toEqual(['there', 'world']);
  });

  it('skips filtering when validator is invalid regex', () => {
    const result = testPattern('\\d+', '12345', '[unclosed');
    // Invalid validator regex — filtering is skipped, all detections remain
    expect(result.detections.length).toBe(1);
  });
});
