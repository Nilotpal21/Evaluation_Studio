import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const LEGACY_CIPHERTEXT_FORMAT_MESSAGE =
  'Unsupported tenant ciphertext format. Expected DEK envelope.';

export function legacyCiphertextFormat(): AppError {
  return new AppError(LEGACY_CIPHERTEXT_FORMAT_MESSAGE, {
    ...ErrorCodes.LEGACY_CIPHERTEXT_FORMAT,
  });
}

export function isLegacyCiphertextFormatError(err: unknown): boolean {
  return err instanceof AppError && err.code === ErrorCodes.LEGACY_CIPHERTEXT_FORMAT.code;
}

export function masterKeyMissing(): AppError {
  return new AppError('ENCRYPTION_MASTER_KEY must be a 32-byte hex string (64 characters)', {
    ...ErrorCodes.SERVICE_UNAVAILABLE,
  });
}

export function invalidFormat(detail?: string): AppError {
  return new AppError(detail ?? 'Invalid encrypted data format', { ...ErrorCodes.BAD_REQUEST });
}

export function contactSaltMissing(): AppError {
  return new AppError(
    'Cannot derive contact key: encryptionSalt is null (contact may have been GDPR-deleted)',
    { ...ErrorCodes.BAD_REQUEST },
  );
}

export function decompressionUnavailable(): AppError {
  return new AppError('ZSTD decompression not available (requires Node.js 22+)', {
    ...ErrorCodes.SERVICE_UNAVAILABLE,
  });
}
