/**
 * Centralized error handling for Agent Platform.
 *
 * AppError is the base class for all application-level errors.
 * ErrorCodes provides machine-readable codes for programmatic matching.
 */

// =============================================================================
// BASE ERROR
// =============================================================================

export class AppError extends Error {
  /** Machine-readable error code for programmatic matching */
  public readonly code: string;
  /** HTTP status code hint for route handlers */
  public readonly statusCode: number;
  /** Individual error messages (for multi-field validation errors) */
  public readonly messages?: string[];

  constructor(
    message: string,
    opts: { code: string; statusCode?: number; cause?: unknown; messages?: string[] },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
    if (opts.cause !== undefined) {
      (this as any).cause = opts.cause;
    }
    if (opts.messages && opts.messages.length > 1) {
      this.messages = opts.messages;
    }
  }
}

/**
 * ValidationError - thrown when input validation fails
 * Automatically uses statusCode 400 and VALIDATION_ERROR code
 */
export class ValidationError extends AppError {
  constructor(message: string, opts?: { cause?: unknown; messages?: string[] }) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      cause: opts?.cause,
      messages: opts?.messages,
    });
  }
}

// =============================================================================
// ERROR CODES
// =============================================================================

export const ErrorCodes = {
  // ── Circuit Breaker ──────────────────────────────────────
  CIRCUIT_OPEN: { code: 'CIRCUIT_OPEN', statusCode: 503 },

  // ── Deployment Pipeline ──────────────────────────────────
  DEPLOYMENT_NOT_FOUND: { code: 'DEPLOYMENT_NOT_FOUND', statusCode: 404 },
  DEPLOYMENT_RETIRED: { code: 'DEPLOYMENT_RETIRED', statusCode: 410 },

  // ── Queue / Backpressure ─────────────────────────────────
  QUEUE_BACKPRESSURE: { code: 'QUEUE_BACKPRESSURE', statusCode: 429 },

  // ── Tenant Isolation ─────────────────────────────────────
  TENANT_ACCESS_DENIED: { code: 'TENANT_ACCESS_DENIED', statusCode: 403 },

  // ── Generic HTTP ─────────────────────────────────────────
  BAD_REQUEST: { code: 'BAD_REQUEST', statusCode: 400 },
  UNAUTHORIZED: { code: 'UNAUTHORIZED', statusCode: 401 },
  FORBIDDEN: { code: 'FORBIDDEN', statusCode: 403 },
  NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
  CONFLICT: { code: 'CONFLICT', statusCode: 409 },
  GONE: { code: 'GONE', statusCode: 410 },
  UNPROCESSABLE_ENTITY: { code: 'UNPROCESSABLE_ENTITY', statusCode: 422 },
  TOO_MANY_REQUESTS: { code: 'TOO_MANY_REQUESTS', statusCode: 429 },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', statusCode: 400 },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
  SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', statusCode: 503 },

  // ── Encryption ────────────────────────────────────────────
  // Returned when stored ciphertext predates the DEK envelope format and
  // cannot be decrypted by the current facade. Treated as a data-migration
  // signal, not a runtime fault — callers should log at warn level and route
  // the affected record to backfill rather than alerting.
  LEGACY_CIPHERTEXT_FORMAT: { code: 'LEGACY_CIPHERTEXT_FORMAT', statusCode: 503 },

  // ── LLM / Model ───────────────────────────────────────────
  CREDENTIAL_NOT_FOUND: { code: 'CREDENTIAL_NOT_FOUND', statusCode: 503 },
  CREDENTIAL_DECRYPTION: { code: 'CREDENTIAL_DECRYPTION', statusCode: 503 },
  MODEL_NOT_CONFIGURED: { code: 'MODEL_NOT_CONFIGURED', statusCode: 503 },
  MODEL_RATE_LIMITED: { code: 'MODEL_RATE_LIMITED', statusCode: 429 },
  MODEL_CONTEXT_EXCEEDED: { code: 'MODEL_CONTEXT_EXCEEDED', statusCode: 400 },
  MODEL_TIMEOUT: { code: 'MODEL_TIMEOUT', statusCode: 504 },
  MODEL_API_ERROR: { code: 'MODEL_API_ERROR', statusCode: 502 },
  MODEL_CONTENT_FILTERED: { code: 'MODEL_CONTENT_FILTERED', statusCode: 422 },

  // ── Execution ──────────────────────────────────────────────
  TOOL_BINDING_FAILED: { code: 'TOOL_BINDING_FAILED', statusCode: 503 },
  FLOW_STEP_ERROR: { code: 'FLOW_STEP_ERROR', statusCode: 500 },
  HANDOFF_TARGET_MISSING: { code: 'HANDOFF_TARGET_MISSING', statusCode: 400 },
  EXECUTION_TIMEOUT: { code: 'EXECUTION_TIMEOUT', statusCode: 504 },

  // ── NLU Sidecar ────────────────────────────────────────────
  // Returned when the Python NLU sidecar cannot be reached (DNS / TCP / refused
  // / network error). Distinct from TIMEOUT which is strictly AbortError.
  NLU_SIDECAR_UNAVAILABLE: { code: 'NLU_SIDECAR_UNAVAILABLE', statusCode: 503 },
  // The sidecar request was aborted because the client-side deadline expired.
  NLU_SIDECAR_TIMEOUT: { code: 'NLU_SIDECAR_TIMEOUT', statusCode: 504 },
  // The client-side circuit breaker tripped before the request went on the wire.
  NLU_SIDECAR_CIRCUIT_OPEN: { code: 'NLU_SIDECAR_CIRCUIT_OPEN', statusCode: 503 },
  // The sidecar answered but produced no match (200-OK empty entities or
  // `is_correction=false`). This is NOT an outage and must never trigger
  // operator-facing fallbacks that assume the sidecar is down.
  NLU_SIDECAR_NO_MATCH: { code: 'NLU_SIDECAR_NO_MATCH', statusCode: 200 },
  // The sidecar responded but the body could not be parsed / failed schema.
  NLU_SIDECAR_INVALID_RESPONSE: { code: 'NLU_SIDECAR_INVALID_RESPONSE', statusCode: 502 },
  // The sidecar answered a non-OK HTTP status (5xx / 4xx other than 501).
  NLU_SIDECAR_BAD_STATUS: { code: 'NLU_SIDECAR_BAD_STATUS', statusCode: 502 },
  // The sidecar explicitly reported 501 Not Implemented — the requested
  // adapter (entity / correction) has no ML backend wired on that deployment.
  NLU_SIDECAR_NOT_IMPLEMENTED: { code: 'NLU_SIDECAR_NOT_IMPLEMENTED', statusCode: 501 },
} as const;

export type ErrorCodeEntry = (typeof ErrorCodes)[keyof typeof ErrorCodes];
export type ErrorCode = ErrorCodeEntry['code'];

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/** Build a standard error response body: `{ success: false, error: { code, message } }` */
export function toErrorResponse(code: string, message: string) {
  return { success: false as const, error: { code, message } };
}

/**
 * Extract status code + body from an error.
 * If `err` is an `AppError`, uses its `statusCode` and `code`.
 * Otherwise defaults to 500 / INTERNAL_ERROR.
 */
export function errorToResponse(err: unknown): {
  statusCode: number;
  body: ReturnType<typeof toErrorResponse>;
} {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: toErrorResponse(err.code, err.message),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    statusCode: 500,
    body: toErrorResponse(ErrorCodes.INTERNAL_ERROR.code, message),
  };
}

// =============================================================================
// TAGGED RESULT (ok/err discriminator)
// =============================================================================

/**
 * Tagged Result union for functions that may fail with a structured error
 * rather than throwing or returning null.
 *
 * Distinct from `Result<T>` in `./types/repo-types.ts`, which uses a
 * `success` discriminator and a fixed `ErrorResult` shape. `TaggedResult`
 * is generic over the error type so callers can narrow on a specific tag
 * (e.g. `SidecarErrorKind`).
 */
export type TaggedResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Build an `ok` result. */
export function ok<T, E = never>(value: T): TaggedResult<T, E> {
  return { ok: true, value };
}

/** Build an `err` result. */
export function err<T = never, E = unknown>(error: E): TaggedResult<T, E> {
  return { ok: false, error };
}

// =============================================================================
// NLU SIDECAR ERROR ENVELOPE
// =============================================================================

/**
 * Discriminator for the ways an NLU sidecar call can fail to return a match.
 *
 * Outage kinds (`unavailable`, `timeout`, `circuit_open`) indicate that the
 * sidecar itself was not reached / did not respond. Non-outage kinds
 * (`no_match`, `invalid_response`, `not_implemented`, `bad_status`) indicate
 * that the sidecar answered but was unwilling or unable to produce a result.
 *
 * Callers that implement operator-visible fallbacks keyed on
 * `lexical_fallback='when_unavailable'` must gate on outage kinds only —
 * `no_match` in particular is a successful contract response, not an outage.
 */
export type SidecarErrorKind =
  | 'unavailable'
  | 'timeout'
  | 'circuit_open'
  | 'no_match'
  | 'invalid_response'
  | 'not_implemented'
  | 'bad_status';

/**
 * Structured error returned by `NLUSidecarClient`. Wired to `ErrorCodes`
 * so consumers can surface the code to traces / error responses without
 * re-mapping.
 */
export interface SidecarError {
  readonly kind: SidecarErrorKind;
  readonly code: string;
  readonly message: string;
  /** HTTP status if the sidecar responded with one, else undefined. */
  readonly httpStatus?: number;
  /** Underlying cause (network error, parse error, etc.), if any. */
  readonly cause?: unknown;
}

/** Maps a `SidecarErrorKind` to its canonical `ErrorCodes` entry. */
export function sidecarKindToErrorCode(kind: SidecarErrorKind): ErrorCodeEntry {
  switch (kind) {
    case 'unavailable':
      return ErrorCodes.NLU_SIDECAR_UNAVAILABLE;
    case 'timeout':
      return ErrorCodes.NLU_SIDECAR_TIMEOUT;
    case 'circuit_open':
      return ErrorCodes.NLU_SIDECAR_CIRCUIT_OPEN;
    case 'no_match':
      return ErrorCodes.NLU_SIDECAR_NO_MATCH;
    case 'invalid_response':
      return ErrorCodes.NLU_SIDECAR_INVALID_RESPONSE;
    case 'not_implemented':
      return ErrorCodes.NLU_SIDECAR_NOT_IMPLEMENTED;
    case 'bad_status':
      return ErrorCodes.NLU_SIDECAR_BAD_STATUS;
  }
}

/**
 * Build a `SidecarError` with its `code` populated from `ErrorCodes`.
 */
export function makeSidecarError(
  kind: SidecarErrorKind,
  opts: { message: string; httpStatus?: number; cause?: unknown },
): SidecarError {
  return {
    kind,
    code: sidecarKindToErrorCode(kind).code,
    message: opts.message,
    httpStatus: opts.httpStatus,
    cause: opts.cause,
  };
}

/** True for sidecar error kinds that represent an actual outage. */
export function isSidecarOutageKind(kind: SidecarErrorKind): boolean {
  return kind === 'unavailable' || kind === 'timeout' || kind === 'circuit_open';
}
