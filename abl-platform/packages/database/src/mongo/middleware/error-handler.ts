/**
 * MongoDB Error Classification & Handling
 *
 * Classifies raw MongoDB/Mongoose errors into application-level error codes
 * with structured logging context.
 */

// ─── Error Codes ──────────────────────────────────────────────────────────

export enum MongoErrorCode {
  DUPLICATE_KEY = 'DUPLICATE_KEY',
  VALIDATION = 'VALIDATION',
  TIMEOUT = 'TIMEOUT',
  NETWORK = 'NETWORK',
  WRITE_CONFLICT = 'WRITE_CONFLICT',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  SHARD_KEY_VIOLATION = 'SHARD_KEY_VIOLATION',
  DOCUMENT_TOO_LARGE = 'DOCUMENT_TOO_LARGE',
  UNKNOWN = 'UNKNOWN',
}

// ─── Application Error ───────────────────────────────────────────────────

export class MongoAppError extends Error {
  readonly code: MongoErrorCode;
  readonly collection: string;
  readonly operation: string;
  readonly duration: number;
  readonly retryable: boolean;
  readonly originalError: Error;

  constructor(params: {
    code: MongoErrorCode;
    message: string;
    collection: string;
    operation: string;
    duration: number;
    retryable: boolean;
    originalError: Error;
  }) {
    super(params.message);
    this.name = 'MongoAppError';
    this.code = params.code;
    this.collection = params.collection;
    this.operation = params.operation;
    this.duration = params.duration;
    this.retryable = params.retryable;
    this.originalError = params.originalError;
  }
}

// ─── Error Classification ────────────────────────────────────────────────

const RETRYABLE_CODES = new Set([
  MongoErrorCode.TIMEOUT,
  MongoErrorCode.NETWORK,
  MongoErrorCode.WRITE_CONFLICT,
]);

/**
 * Classify a raw error into a MongoErrorCode.
 */
export function classifyError(error: unknown): {
  code: MongoErrorCode;
  retryable: boolean;
} {
  if (!(error instanceof Error)) {
    return { code: MongoErrorCode.UNKNOWN, retryable: false };
  }

  const message = error.message || '';
  const name = error.name || '';
  const errCode = (error as any).code;

  // E11000 duplicate key
  if (errCode === 11000 || message.includes('E11000')) {
    return { code: MongoErrorCode.DUPLICATE_KEY, retryable: false };
  }

  // Mongoose ValidationError
  if (name === 'ValidationError') {
    return { code: MongoErrorCode.VALIDATION, retryable: false };
  }

  // Timeout errors
  if (
    name === 'MongoServerSelectionError' ||
    message.includes('serverSelectionTimeout') ||
    message.includes('socketTimeout') ||
    message.includes('timed out') ||
    message.includes('ETIMEDOUT')
  ) {
    return { code: MongoErrorCode.TIMEOUT, retryable: true };
  }

  // Network errors
  if (
    name === 'MongoNetworkError' ||
    name === 'MongoNetworkTimeoutError' ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('EPIPE') ||
    message.includes('connection closed') ||
    message.includes('topology was destroyed')
  ) {
    return { code: MongoErrorCode.NETWORK, retryable: true };
  }

  // Write conflict (transaction contention)
  if (errCode === 112 || message.includes('WriteConflict')) {
    return { code: MongoErrorCode.WRITE_CONFLICT, retryable: true };
  }

  // Auth errors (codes 13, 18)
  if (
    errCode === 13 ||
    errCode === 18 ||
    message.includes('not authorized') ||
    message.includes('Authentication failed')
  ) {
    return { code: MongoErrorCode.UNAUTHORIZED, retryable: false };
  }

  // Shard key violation
  if (message.includes('shard key') || message.includes('ShardKeyNotFound')) {
    return { code: MongoErrorCode.SHARD_KEY_VIOLATION, retryable: false };
  }

  // Document too large (>16MB)
  if (
    errCode === 10334 ||
    message.includes('BSONObj size') ||
    message.includes('object size') ||
    message.includes('exceeds maximum')
  ) {
    return { code: MongoErrorCode.DOCUMENT_TOO_LARGE, retryable: false };
  }

  return { code: MongoErrorCode.UNKNOWN, retryable: false };
}

/**
 * Wrap a raw error into a MongoAppError with full context.
 */
export function wrapError(
  error: unknown,
  collection: string,
  operation: string,
  duration: number,
): MongoAppError {
  const rawError = error instanceof Error ? error : new Error(String(error));
  const { code, retryable } = classifyError(rawError);

  return new MongoAppError({
    code,
    message: `[${code}] ${collection}.${operation}: ${rawError.message}`,
    collection,
    operation,
    duration,
    retryable,
    originalError: rawError,
  });
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof MongoAppError) {
    return error.retryable;
  }
  const { retryable } = classifyError(error);
  return retryable;
}
