import { describe, it, expect } from 'vitest';
import { AppError } from '@agent-platform/shared-kernel';
import { legacyCiphertextFormat, isLegacyCiphertextFormatError } from '../errors.js';

describe('legacyCiphertextFormat', () => {
  it('produces a 503 AppError tagged LEGACY_CIPHERTEXT_FORMAT', () => {
    const err = legacyCiphertextFormat();
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('LEGACY_CIPHERTEXT_FORMAT');
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('Expected DEK envelope.');
  });
});

describe('isLegacyCiphertextFormatError', () => {
  it('matches errors thrown by the factory', () => {
    expect(isLegacyCiphertextFormatError(legacyCiphertextFormat())).toBe(true);
  });

  it('does not match a generic Error with the same message', () => {
    expect(
      isLegacyCiphertextFormatError(
        new Error('Unsupported tenant ciphertext format. Expected DEK envelope.'),
      ),
    ).toBe(false);
  });

  it('does not match a different AppError code', () => {
    const other = new AppError('something else', { code: 'OTHER_CODE', statusCode: 400 });
    expect(isLegacyCiphertextFormatError(other)).toBe(false);
  });

  it('handles non-Error values safely', () => {
    expect(isLegacyCiphertextFormatError(null)).toBe(false);
    expect(isLegacyCiphertextFormatError(undefined)).toBe(false);
    expect(isLegacyCiphertextFormatError('string')).toBe(false);
    expect(isLegacyCiphertextFormatError({ code: 'LEGACY_CIPHERTEXT_FORMAT' })).toBe(false);
  });
});
