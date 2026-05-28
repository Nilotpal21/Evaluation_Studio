import { describe, expect, it } from 'vitest';

import { distill } from '../intelligence/distill.js';

describe('distill — typecheck', () => {
  it('returns "passed" signal when no TS errors are present', () => {
    const result = distill('Compiling with tsc...\nDone in 4.2s\n', 'typecheck');
    expect(result.signal).toBe('pass');
    expect(result.summary).toBe('typecheck: passed');
  });

  it('extracts file:line: error TSxxxx lines and counts them', () => {
    const output = [
      'Compiling...',
      "src/foo.ts(42,5): error TS2304: Cannot find name 'baz'.",
      "src/bar.ts(10,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      'Done.',
    ].join('\n');
    const result = distill(output, 'typecheck');
    expect(result.signal).toBe('fail');
    expect(result.summary).toContain('typecheck: 2 errors');
    expect(result.summary).toContain("src/foo.ts(42,5): error TS2304: Cannot find name 'baz'.");
    expect(result.summary).toContain('src/bar.ts(10,1): error TS2322');
  });

  it('truncates when there are very many errors and reports remainder', () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `src/f${i}.ts(${i},1): error TS2304: Cannot find name 'x${i}'.`,
    );
    const result = distill(lines.join('\n'), 'typecheck');
    expect(result.signal).toBe('fail');
    expect(result.summary).toMatch(/typecheck: 100 errors/);
    expect(result.summary).toMatch(/…and \d+ more/);
  });
});

describe('distill — test (vitest)', () => {
  it('returns pass signal when output reports passing tests and no failures', () => {
    const output = [
      ' ✓ src/foo.test.ts (3)',
      'Test Files  1 passed (1)',
      'Tests  3 passed (3)',
    ].join('\n');
    const result = distill(output, 'test');
    expect(result.signal).toBe('pass');
    expect(result.summary).toMatch(/passed/);
  });

  it('extracts failed test name + first assertion + file:line', () => {
    const output = [
      'RUN v1.0',
      ' ❯ src/foo.test.ts (1 test | 1 failed)',
      '   × should add two numbers correctly',
      'AssertionError: expected 2 to equal 3',
      ' ❯ src/foo.test.ts:42:23',
      'Tests  1 failed (1)',
    ].join('\n');
    const result = distill(output, 'test');
    expect(result.signal).toBe('fail');
    expect(result.summary).toContain('tests: 1 failed');
    expect(result.summary).toContain('should add two numbers correctly');
    expect(result.summary).toContain('AssertionError: expected 2 to equal 3');
    expect(result.summary).toContain('src/foo.test.ts:42:23');
  });

  it('caps failure blocks at 12 and notes remainder', () => {
    const failures = Array.from({ length: 20 }, (_, i) =>
      [
        `   × test number ${i}`,
        'AssertionError: expected x to equal y',
        ` ❯ src/test${i}.test.ts:${i}:5`,
      ].join('\n'),
    );
    const output = ['RUN v1.0', ...failures, 'Tests  20 failed (20)'].join('\n');
    const result = distill(output, 'test');
    expect(result.signal).toBe('fail');
    expect(result.summary).toContain('tests: 20 failed');
    expect(result.summary).toMatch(/…and 8 more failed tests/);
  });
});

describe('distill — lint', () => {
  it('passes when no eslint problems and no prettier warns', () => {
    const result = distill('Linting...\nAll files pass.\n', 'lint');
    expect(result.signal).toBe('pass');
    expect(result.summary).toBe('lint: passed');
  });

  it('extracts eslint problems with file:line:col, severity, rule', () => {
    const output = [
      '/repo/src/foo.ts',
      "  42:5  error  'baz' is not defined  no-undef",
      '  10:3  warning  Unused variable  no-unused-vars',
      '✖ 2 problems (1 error, 1 warning)',
    ].join('\n');
    const result = distill(output, 'lint');
    expect(result.signal).toBe('fail');
    expect(result.summary).toContain('eslint: 2 problems');
    expect(result.summary).toContain("/repo/src/foo.ts:42:5 error 'baz' is not defined (no-undef)");
    expect(result.summary).toContain(
      '/repo/src/foo.ts:10:3 warning Unused variable (no-unused-vars)',
    );
  });

  it('extracts prettier unformatted file list', () => {
    const output = [
      'Checking formatting...',
      '[warn] foo.ts',
      '[warn] bar.ts',
      '[warn] Code style issues found in 2 files. Run Prettier to fix.',
    ].join('\n');
    const result = distill(output, 'lint');
    expect(result.signal).toBe('fail');
    expect(result.summary).toContain('prettier: 2 unformatted files');
    expect(result.summary).toContain('foo.ts');
    expect(result.summary).toContain('bar.ts');
  });
});

describe('distill — signal-preservation guard', () => {
  it('falls back to head+tail slice when failure marker is absent', () => {
    const output = 'Some unrelated noise\n'.repeat(100) + 'failed\n' + 'tail\n'.repeat(100);
    const result = distill(output, 'generic');
    expect(result.signal).toBe('fail');
    expect(result.summary).toMatch(/failed|tail/);
  });

  it('clips at maxBytes and notes the clip', () => {
    const lines = Array.from(
      { length: 500 },
      (_, i) => `src/f${i}.ts(${i},1): error TS2304: Cannot find name 'x${i}'.`,
    );
    const result = distill(lines.join('\n'), 'typecheck', { maxBytes: 2_000 });
    expect(result.distilledBytes).toBeLessThanOrEqual(2_000);
    expect(result.summary).toMatch(/clipped at 2000 bytes/);
  });
});

describe('distill — generic fallback', () => {
  it('reports unknown signal for trivial passing output', () => {
    const result = distill('hello world', 'generic');
    expect(result.signal).toBe('unknown');
  });

  it('reports fail signal when output contains an error word', () => {
    const result = distill('Process exited with exit code 1\nstack trace below', 'generic');
    expect(result.signal).toBe('fail');
  });

  it('returns "(no output)" for empty input', () => {
    const result = distill('', 'generic');
    expect(result.summary).toBe('(no output)');
    expect(result.originalBytes).toBe(0);
  });
});

describe('distill — efficiency', () => {
  it('reduces typical vitest failure output by >70%', () => {
    const noise = 'Vitest banner line\n'.repeat(50);
    const fail = [
      ' ❯ src/foo.test.ts (5 tests | 1 failed)',
      '   × should compute sum correctly',
      'AssertionError: expected 5 to equal 6',
      ' ❯ src/foo.test.ts:42:23',
      'Tests  1 failed | 4 passed (5)',
    ].join('\n');
    const output = noise + fail + '\n' + noise;
    const result = distill(output, 'test');
    const reduction = 1 - result.distilledBytes / result.originalBytes;
    expect(reduction).toBeGreaterThan(0.7);
    expect(result.summary).toContain('should compute sum correctly');
    expect(result.summary).toContain('AssertionError: expected 5 to equal 6');
  });
});
