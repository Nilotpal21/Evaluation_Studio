import { describe, expect, it } from 'vitest';

/**
 * The escapeShellArg helper for `helix review-branch` lives inline in cli.ts
 * (not exported). To keep the safety regex testable without restructuring
 * cli.ts, this test ports the same regex and asserts on the input shapes
 * the runtime helper accepts/rejects. If the cli.ts regex changes, update
 * this constant in the same commit.
 */
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/~^@{}-]+$/;

function isSafeRef(value: string): boolean {
  return SAFE_REF_PATTERN.test(value);
}

describe('helix review-branch ref safety', () => {
  it('accepts plain branch names', () => {
    expect(isSafeRef('main')).toBe(true);
    expect(isSafeRef('develop')).toBe(true);
    expect(isSafeRef('feature/new-thing')).toBe(true);
    expect(isSafeRef('release-1.2.3')).toBe(true);
  });

  it('accepts git ref grammar (HEAD~N, HEAD^, refs/heads/x, HEAD@{1})', () => {
    expect(isSafeRef('HEAD~1')).toBe(true);
    expect(isSafeRef('HEAD~5')).toBe(true);
    expect(isSafeRef('HEAD^')).toBe(true);
    expect(isSafeRef('HEAD^^')).toBe(true);
    expect(isSafeRef('refs/heads/main')).toBe(true);
    expect(isSafeRef('HEAD@{1}')).toBe(true);
    expect(isSafeRef('origin/main')).toBe(true);
  });

  it('rejects shell metacharacters (semicolon, backtick, $)', () => {
    expect(isSafeRef('main; rm -rf /')).toBe(false);
    expect(isSafeRef('main`whoami`')).toBe(false);
    expect(isSafeRef('main$(whoami)')).toBe(false);
    expect(isSafeRef('$(echo evil)')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isSafeRef('main HEAD')).toBe(false);
    expect(isSafeRef(' main')).toBe(false);
    expect(isSafeRef('main\n')).toBe(false);
    expect(isSafeRef('main\t')).toBe(false);
  });

  it('rejects pipes, redirects, ampersands', () => {
    expect(isSafeRef('main|cat')).toBe(false);
    expect(isSafeRef('main>file')).toBe(false);
    expect(isSafeRef('main&background')).toBe(false);
  });

  it('rejects quotes and parens', () => {
    expect(isSafeRef('main"injection')).toBe(false);
    expect(isSafeRef("main'injection")).toBe(false);
    expect(isSafeRef('main(arg)')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isSafeRef('')).toBe(false);
  });
});
