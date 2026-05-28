import { describe, it, expect } from 'vitest';
import { detectFormat } from '../detect-format.js';
import { getDiagnostics } from '../diagnostics.js';

describe('detectFormat non-string input', () => {
  it('falls back to legacy when source is not a string', () => {
    expect(detectFormat(null as unknown as string)).toBe('legacy');
    expect(detectFormat(undefined as unknown as string)).toBe('legacy');
    expect(detectFormat({} as unknown as string)).toBe('legacy');
  });
});

describe('getDiagnostics non-string input', () => {
  it('returns a single structured error instead of throwing on null', () => {
    const result = getDiagnostics(null as unknown as string);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toMatch(/non-string/);
    expect(result[0].message).toMatch(/null/);
  });

  it('returns a single structured error on undefined', () => {
    const result = getDiagnostics(undefined as unknown as string);
    expect(result[0].message).toMatch(/undefined/);
  });
});
