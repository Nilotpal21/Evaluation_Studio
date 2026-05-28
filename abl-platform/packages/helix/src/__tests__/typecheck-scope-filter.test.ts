import { describe, expect, it } from 'vitest';

import {
  classifyTypecheckErrors,
  formatTypecheckScopeNote,
  parseTypecheckErrors,
} from '../pipeline/typecheck-scope-filter.js';

describe('parseTypecheckErrors', () => {
  it('parses the standard tsc `(line,col): error TSxxxx:` format', () => {
    const out = [
      'src/foo.ts(42,5): error TS2304: Cannot find name "baz".',
      "src/bar.ts(10,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    const errors = parseTypecheckErrors(out);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      file: 'src/foo.ts',
      line: 42,
      column: 5,
      code: '2304',
    });
    expect(errors[1]).toMatchObject({
      file: 'src/bar.ts',
      line: 10,
      column: 1,
      code: '2322',
    });
  });

  it('parses the alternate `file:line:col - error TSxxxx:` format', () => {
    const out =
      "apps/runtime/src/services/foo.ts:88:13 - error TS18046: 'err' is of type 'unknown'.";
    const errors = parseTypecheckErrors(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: 'apps/runtime/src/services/foo.ts',
      line: 88,
      column: 13,
      code: '18046',
    });
  });

  it('deduplicates identical errors that may appear from retries', () => {
    const out = [
      'src/foo.ts(1,1): error TS2304: Cannot find name "x".',
      'src/foo.ts(1,1): error TS2304: Cannot find name "x".',
    ].join('\n');
    expect(parseTypecheckErrors(out)).toHaveLength(1);
  });

  it('strips ANSI color codes before matching', () => {
    const out = '[31msrc/foo.ts(42,5): error TS2304: Cannot find name "baz".[0m';
    const errors = parseTypecheckErrors(out);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('src/foo.ts');
  });

  it('returns empty array for non-error output', () => {
    expect(parseTypecheckErrors('Build succeeded\nDone in 4.2s\n')).toEqual([]);
    expect(parseTypecheckErrors('')).toEqual([]);
  });
});

describe('classifyTypecheckErrors', () => {
  const inScopeError = {
    file: 'apps/runtime/src/services/agent-transfer/index.ts',
    line: 100,
    column: 5,
    code: '2304',
    message: 'Cannot find name x',
    raw: 'apps/runtime/src/services/agent-transfer/index.ts(100,5): error TS2304: Cannot find name x',
  };
  const outOfScopeError = {
    file: 'apps/runtime/src/channels/adapters/msteams-adapter.ts',
    line: 525,
    column: 27,
    code: '2532',
    message: 'Object is possibly undefined',
    raw: 'apps/runtime/src/channels/adapters/msteams-adapter.ts(525,27): error TS2532: Object is possibly undefined',
  };
  const auditScope = [
    'apps/runtime/src/services/agent-transfer/index.ts',
    'apps/runtime/src/services/agent-transfer/message-bridge.ts',
    'apps/runtime/src/routes/agent-transfer-sessions.ts',
  ];

  it('puts errors in matching scope files into inScopeErrors', () => {
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors([inScopeError], auditScope);
    expect(inScopeErrors).toHaveLength(1);
    expect(outOfScopeErrors).toHaveLength(0);
  });

  it('puts errors in unrelated files into outOfScopeErrors', () => {
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors(
      [outOfScopeError],
      auditScope,
    );
    expect(inScopeErrors).toHaveLength(0);
    expect(outOfScopeErrors).toHaveLength(1);
  });

  it('splits a mixed batch correctly', () => {
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors(
      [inScopeError, outOfScopeError],
      auditScope,
    );
    expect(inScopeErrors).toHaveLength(1);
    expect(outOfScopeErrors).toHaveLength(1);
    expect(inScopeErrors[0].file).toBe(inScopeError.file);
    expect(outOfScopeErrors[0].file).toBe(outOfScopeError.file);
  });

  it('treats directory-shape scope entries as descendant matchers', () => {
    const dirScope = ['apps/runtime/src/services/agent-transfer'];
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors(
      [inScopeError, outOfScopeError],
      dirScope,
    );
    expect(inScopeErrors).toHaveLength(1);
    expect(outOfScopeErrors).toHaveLength(1);
  });

  it('does not let a file-extension scope entry match unrelated nested paths', () => {
    const fileScope = ['apps/runtime/src/services/agent-transfer/index.ts'];
    const sibling = {
      ...outOfScopeError,
      file: 'apps/runtime/src/services/agent-transfer/index.ts.bak',
    };
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors([sibling], fileScope);
    expect(inScopeErrors).toHaveLength(0);
    expect(outOfScopeErrors).toHaveLength(1);
  });

  it('treats EVERY error as in-scope when scope is empty (fail-safe)', () => {
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors(
      [inScopeError, outOfScopeError],
      [],
    );
    expect(inScopeErrors).toHaveLength(2);
    expect(outOfScopeErrors).toHaveLength(0);
  });

  it('returns empty halves for empty input', () => {
    const { inScopeErrors, outOfScopeErrors } = classifyTypecheckErrors([], auditScope);
    expect(inScopeErrors).toEqual([]);
    expect(outOfScopeErrors).toEqual([]);
  });
});

describe('formatTypecheckScopeNote', () => {
  it('summarizes out-of-scope errors with first 8 verbatim and remainder count', () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i,
      column: 1,
      code: '2304',
      message: 'x',
      raw: `src/f${i}.ts(${i},1): error TS2304: Cannot find name x`,
    }));
    const note = formatTypecheckScopeNote({ inScopeErrors: [], outOfScopeErrors: errors });
    expect(note).toContain('typecheck: 12 pre-existing error(s) outside audit scope');
    expect(note).toContain('src/f0.ts(0,1)');
    expect(note).toContain('src/f7.ts(7,1)');
    expect(note).not.toContain('src/f8.ts');
    expect(note).toContain('…and 4 more');
  });
});

describe('end-to-end: classify a real msteams-style failure against an agent-transfer scope', () => {
  it('msteams-adapter pre-existing error is correctly classified as out-of-scope', () => {
    // Approximation of the actual output that blocked the live audit run.
    const tscOutput = [
      '> @agent-platform/runtime@1.0.0 build /repo/apps/runtime',
      '> tsc',
      "apps/runtime/src/channels/adapters/msteams-adapter.ts(525,27): error TS2532: Object is possibly 'undefined'.",
      'apps/runtime/src/channels/adapters/msteams-adapter.ts(601,12): error TS2345: Argument of type X is not assignable.',
    ].join('\n');
    const auditScope = [
      'apps/runtime/src/services/agent-transfer/index.ts',
      'apps/runtime/src/services/agent-transfer/message-bridge.ts',
      'apps/runtime/src/services/agent-transfer/transcript-persistence.ts',
      'apps/runtime/src/routes/agent-transfer-sessions.ts',
    ];

    const errors = parseTypecheckErrors(tscOutput);
    expect(errors).toHaveLength(2);
    const classification = classifyTypecheckErrors(errors, auditScope);
    expect(classification.inScopeErrors).toHaveLength(0);
    expect(classification.outOfScopeErrors).toHaveLength(2);
  });
});
