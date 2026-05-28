// packages/shared/src/__tests__/encryption/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  masterKeyMissing,
  invalidFormat,
  contactSaltMissing,
  decompressionUnavailable,
} from '../../encryption/errors.js';

describe('encryption error factories', () => {
  it('masterKeyMissing returns AppError with SERVICE_UNAVAILABLE', () => {
    const err = masterKeyMissing();
    expect(err.message).toContain('ENCRYPTION_MASTER_KEY');
    expect(err.statusCode).toBe(503);
  });

  it('invalidFormat returns AppError with BAD_REQUEST (no detail)', () => {
    const err = invalidFormat();
    expect(err.message).toBe('Invalid encrypted data format');
    expect(err.statusCode).toBe(400);
  });

  it('invalidFormat returns AppError with custom detail', () => {
    const err = invalidFormat('custom detail');
    expect(err.message).toBe('custom detail');
    expect(err.statusCode).toBe(400);
  });

  it('contactSaltMissing returns AppError with BAD_REQUEST', () => {
    const err = contactSaltMissing();
    expect(err.message).toContain('encryptionSalt is null');
    expect(err.statusCode).toBe(400);
  });

  it('decompressionUnavailable returns AppError with SERVICE_UNAVAILABLE', () => {
    const err = decompressionUnavailable();
    expect(err.message).toContain('ZSTD decompression not available');
    expect(err.statusCode).toBe(503);
  });
});
