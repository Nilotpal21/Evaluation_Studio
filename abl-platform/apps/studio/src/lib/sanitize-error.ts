/**
 * Error sanitization utilities for customer-facing UI.
 *
 * Prevents leaking internal technical details (stack traces, DB errors,
 * file paths, network errors) to end users while preserving safe,
 * human-readable messages from the server.
 */

const TECHNICAL_PATTERNS = [
  // Stack traces & code references
  /at\s+\S+\s+\(/i,
  /\.(ts|js|tsx|jsx):\d+/,
  /node_modules\//,
  /\/src\//,
  /\/dist\//,
  /\.stack\s*=/,

  // Node/network errors
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /EPIPE/,
  /EAI_AGAIN/,
  /EHOSTUNREACH/,
  /socket hang up/i,
  /fetch failed/i,
  /Failed to fetch/i,

  // Database errors
  /P\d{4}/, // Prisma error codes
  /SQLITE_/,
  /MongoServerError/,
  /buffering timed out/i,
  /duplicate key/i,
  /unique constraint/i,
  /foreign key constraint/i,
  /relation ".*" does not exist/i,

  // Runtime internals
  /TypeError:/,
  /ReferenceError:/,
  /SyntaxError:/,
  /RangeError:/,
  /Cannot read propert/i,
  /is not a function/i,
  /undefined is not/i,
  /null is not/i,

  // Server internals
  /Internal Server Error/i,
  /INTERNAL_ERROR/,
  /unhandled/i,
  /segmentation fault/i,
  /non-JSON response/i,
  /not valid JSON/i,
];

const MAX_MESSAGE_LENGTH = 200;

function isTechnical(message: string): boolean {
  return TECHNICAL_PATTERNS.some((pattern) => pattern.test(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract all error messages from an error object.
 *
 * Supports:
 *  - AppError with `.messages` array (from API errors with multiple validation issues)
 *  - Standard Error `.message`
 *  - Plain strings
 *
 * Returns only safe, non-technical messages. Technical messages are replaced with fallback.
 */
export function sanitizeErrors(error: unknown, fallback: string): string[] {
  // AppError with messages array — extract individual messages
  if (error instanceof Error && 'messages' in error && Array.isArray((error as any).messages)) {
    const msgs = (error as any).messages as string[];
    const safe = msgs.filter((m) => m && m.length <= MAX_MESSAGE_LENGTH && !isTechnical(m));
    return safe.length > 0 ? safe : [fallback];
  }

  // Single message
  const single = sanitizeError(error, fallback);
  return [single];
}

/**
 * Sanitize an error from a catch block for display to the user.
 *
 * - If the error has multiple messages (AppError.messages), joins them.
 * - If the error contains technical patterns or is too long, returns the fallback.
 * - In development mode, logs the suppressed raw error to console.debug.
 */
export function sanitizeError(error: unknown, fallback: string): string {
  // AppError with messages array — join for single-string consumers
  if (error instanceof Error && 'messages' in error && Array.isArray((error as any).messages)) {
    const msgs = (error as any).messages as string[];
    const safe = msgs.filter((m) => m && m.length <= MAX_MESSAGE_LENGTH && !isTechnical(m));
    if (safe.length > 0) return safe.join('. ');
  }

  let raw: string;

  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === 'string') {
    raw = error;
  } else {
    return fallback;
  }

  if (!raw || raw.length > MAX_MESSAGE_LENGTH || isTechnical(raw)) {
    if (process.env.NODE_ENV === 'development') {
      console.debug('[sanitizeError] Suppressed raw error:', error);
    }
    return fallback;
  }

  return raw;
}

/**
 * Sanitize a server/WebSocket error message string for display to the user.
 *
 * - Undefined/empty messages return the fallback.
 * - Technical patterns or overly long messages return the fallback.
 * - Safe server messages (e.g. "Agent not found") pass through.
 */
export function sanitizeServerError(
  message: string | { message?: string; code?: string } | undefined | null,
  fallback: string,
): string {
  if (!message) return fallback;

  // Unwrap { message, code } shaped server error objects
  const raw: string =
    typeof message === 'object' ? (message as { message?: string }).message || fallback : message;

  if (!raw || raw.length > MAX_MESSAGE_LENGTH || isTechnical(raw)) {
    if (process.env.NODE_ENV === 'development') {
      console.debug('[sanitizeServerError] Suppressed raw message:', message);
    }
    return fallback;
  }

  return raw;
}

/**
 * Extract and sanitize the user-facing message from common server error envelopes.
 *
 * Supports:
 *  - { error: { code, message } }
 *  - { error: string }
 *  - { errors: [{ msg, code }] } / { errors: [{ message, code }] }
 *  - { message: string }
 */
export function extractErrorMessage(envelope: unknown, fallback: string): string {
  if (typeof envelope === 'string') {
    return sanitizeServerError(envelope, fallback);
  }

  if (!isRecord(envelope)) {
    return fallback;
  }

  const errors = envelope.errors;
  if (Array.isArray(errors)) {
    const firstString = errors.find((entry): entry is string => typeof entry === 'string');
    const firstError = errors.find(isRecord);
    const firstMessage =
      firstString ?? getString(firstError?.msg) ?? getString(firstError?.message);
    if (firstMessage) {
      return sanitizeServerError(firstMessage, fallback);
    }
  }

  const error = envelope.error;
  if (typeof error === 'string') {
    return sanitizeServerError(error, fallback);
  }

  if (isRecord(error)) {
    return sanitizeServerError(
      {
        message: getString(error.message),
        code: getString(error.code),
      },
      fallback,
    );
  }

  return sanitizeServerError(getString(envelope.message), fallback);
}
