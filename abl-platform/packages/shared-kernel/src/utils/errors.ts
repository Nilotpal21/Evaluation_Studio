/**
 * Error Handling Utilities
 *
 * Safe error extraction for unknown error types in catch blocks.
 * Structured tool execution errors with typed error codes.
 */

// ─── Tool Execution Error ──────────────────────────────────────────────────

/** Default tool timeout when no IR/config override exists */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default sandbox timeout fallback */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

/** OAuth2 client credentials token fetch timeout */
export const OAUTH_TOKEN_TIMEOUT_MS = 10_000;

/** MCP retry delay base (multiplied by attempt number) */
export const MCP_RETRY_DELAY_BASE_MS = 500;

export type ToolErrorCode =
  | 'TOOL_TIMEOUT'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_AUTH_FAILED'
  | 'TOOL_NETWORK_ERROR'
  | 'TOOL_HTTP_ERROR'
  | 'TOOL_RATE_LIMITED'
  | 'TOOL_CIRCUIT_OPEN'
  | 'TOOL_EXECUTION_ERROR'
  | 'TOOL_CODE_EXECUTION_DISABLED'
  | 'TOOL_INVALID_RESPONSE'
  | 'TOOL_SSRF_BLOCKED'
  | 'TOOL_SANDBOX_ERROR'
  | 'TOOL_SANDBOX_NOT_DEPLOYED'
  | 'TOOL_SANDBOX_DEPLOYING'
  | 'TOOL_SANDBOX_DEPLOY_FAILED'
  | 'TOOL_SANDBOX_UNHEALTHY'
  | 'TOOL_MCP_SERVER_UNAVAILABLE'
  | 'TOOL_SOAP_FAULT'
  | 'TOOL_RESPONSE_PARSE_FAILED';

/**
 * Structured error for tool execution failures.
 * Carries a typed error code, tool metadata, and retryability hint.
 * Used by all executors (HTTP, MCP, Sandbox) and propagated to the LLM via is_error.
 */
export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly toolName: string;
  readonly toolType?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly durationMs?: number;

  constructor(opts: {
    code: ToolErrorCode;
    message: string;
    toolName: string;
    toolType?: string;
    statusCode?: number;
    retryable?: boolean;
    durationMs?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'ToolExecutionError';
    if (opts.cause !== undefined) {
      (this as any).cause = opts.cause;
    }
    this.code = opts.code;
    this.toolName = opts.toolName;
    this.toolType = opts.toolType;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable ?? false;
    this.durationMs = opts.durationMs;
  }
}

// ─── Generic Error Utilities ───────────────────────────────────────────────

/**
 * Extract error message safely from unknown error type.
 * Handles Error instances, string errors, and unknown types.
 *
 * @param error - Unknown error value from catch block
 * @returns Error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Get error stack if available.
 *
 * @param error - Unknown error value from catch block
 * @returns Stack trace string or undefined
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return undefined;
}

/**
 * Convert unknown error to structured ErrorResult.
 * Includes stack trace in details if available.
 *
 * @param error - Unknown error value from catch block
 * @param code - Error code (default: 'UNKNOWN_ERROR')
 * @returns Structured error object
 */
export function toErrorResult(
  error: unknown,
  code = 'UNKNOWN_ERROR',
): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const message = getErrorMessage(error);
  const stack = getErrorStack(error);
  return {
    code,
    message,
    ...(stack && { details: { stack } }),
  };
}
