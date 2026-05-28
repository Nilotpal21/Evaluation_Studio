import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  InvalidTranscriptIdError,
  TRANSCRIPT_ID_PATTERN,
  resolveTranscriptPath,
} from '../routes/transcripts-path.js';

const BASE = '/tmp/transcripts-test';

describe('TRANSCRIPT_ID_PATTERN', () => {
  it('accepts alphanumeric, dash, and underscore', () => {
    expect(TRANSCRIPT_ID_PATTERN.test('abc')).toBe(true);
    expect(TRANSCRIPT_ID_PATTERN.test('abc-123')).toBe(true);
    expect(TRANSCRIPT_ID_PATTERN.test('a_b_c')).toBe(true);
    expect(TRANSCRIPT_ID_PATTERN.test('UUIDLIKE_aBc-123')).toBe(true);
  });

  it('rejects empty, dots, slashes, spaces, and special chars', () => {
    for (const bad of ['', '.', '..', '../foo', 'a/b', 'a\\b', 'a b', 'a.b', 'a:b', 'a;b', '@x']) {
      expect(TRANSCRIPT_ID_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('resolveTranscriptPath', () => {
  it('returns an absolute path inside the base directory for valid ids', () => {
    const out = resolveTranscriptPath('abc-123', BASE);
    expect(out).toBe(path.resolve(BASE, 'abc-123.json'));
    expect(out.startsWith(path.resolve(BASE) + path.sep)).toBe(true);
  });

  it('rejects classic path traversal sequences', () => {
    for (const bad of ['..', '../etc/passwd', '../../etc/passwd', '..\\windows', '../']) {
      expect(() => resolveTranscriptPath(bad, BASE)).toThrow(InvalidTranscriptIdError);
    }
  });

  it('rejects URL-encoded traversal (the regex never decodes — these are literal characters)', () => {
    for (const bad of ['%2e%2e%2f', '%2E%2E', '..%2f']) {
      expect(() => resolveTranscriptPath(bad, BASE)).toThrow(InvalidTranscriptIdError);
    }
  });

  it('rejects ids with embedded path separators or whitespace', () => {
    for (const bad of ['foo/bar', 'foo\\bar', 'foo bar', 'foo\tbar', 'foo\nbar']) {
      expect(() => resolveTranscriptPath(bad, BASE)).toThrow(InvalidTranscriptIdError);
    }
  });

  it('rejects ids that contain dots even without traversal intent', () => {
    expect(() => resolveTranscriptPath('foo.bar', BASE)).toThrow(InvalidTranscriptIdError);
    expect(() => resolveTranscriptPath('.hidden', BASE)).toThrow(InvalidTranscriptIdError);
  });

  it('rejects empty and non-string inputs', () => {
    expect(() => resolveTranscriptPath('', BASE)).toThrow(InvalidTranscriptIdError);
    // @ts-expect-error — explicitly testing runtime guard
    expect(() => resolveTranscriptPath(undefined, BASE)).toThrow(InvalidTranscriptIdError);
    // @ts-expect-error — explicitly testing runtime guard
    expect(() => resolveTranscriptPath(null, BASE)).toThrow(InvalidTranscriptIdError);
    // @ts-expect-error — explicitly testing runtime guard
    expect(() => resolveTranscriptPath(42, BASE)).toThrow(InvalidTranscriptIdError);
  });

  it('exposes a stable error code on InvalidTranscriptIdError', () => {
    try {
      resolveTranscriptPath('../../etc/passwd', BASE);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTranscriptIdError);
      expect((e as InvalidTranscriptIdError).code).toBe('INVALID_TRANSCRIPT_ID');
    }
  });
});
