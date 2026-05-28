/**
 * Typed Step Error Codes & Utilities
 *
 * Replaces the generic 'STEP_FAILED' with typed error codes for workflow step failures.
 * Used in BaseStepContext.error.code (context.steps.<stepKey>.error) and step.failed events.
 */

export const StepErrorCode = {
  HTTP_ERROR: 'HTTP_ERROR',
  HTTP_TIMEOUT: 'HTTP_TIMEOUT',
  CONNECTOR_ERROR: 'CONNECTOR_ERROR',
  EXPRESSION_ERROR: 'EXPRESSION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AGENT_ERROR: 'AGENT_ERROR',
  TOOL_ERROR: 'TOOL_ERROR',
  SCRIPT_ERROR: 'SCRIPT_ERROR',
  STEP_TIMEOUT: 'STEP_TIMEOUT',
  STEP_FAILED: 'STEP_FAILED',
} as const;

export type StepErrorCode = (typeof StepErrorCode)[keyof typeof StepErrorCode];

/** Extended error structure for step failures */
export interface StepError {
  code: StepErrorCode;
  message: string;
  httpStatus?: number;
  responseBody?: unknown;
  request?: {
    url: string;
    method: string;
  };
}

/** Custom error class that carries typed error information */
export class WorkflowStepError extends Error {
  readonly code: StepErrorCode;
  readonly httpStatus?: number;
  readonly responseBody?: unknown;
  readonly request?: { url: string; method: string };

  constructor(
    code: StepErrorCode,
    message: string,
    details?: {
      httpStatus?: number;
      responseBody?: unknown;
      request?: { url: string; method: string };
    },
  ) {
    super(message);
    this.name = 'WorkflowStepError';
    this.code = code;
    this.httpStatus = details?.httpStatus;
    this.responseBody = details?.responseBody;
    this.request = details?.request;
  }
}

/** Extract a StepError from a caught error */
export function extractStepError(err: unknown): StepError {
  if (err instanceof WorkflowStepError) {
    return {
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
      responseBody: err.responseBody,
      request: err.request,
    };
  }

  // Include err.cause detail — Node fetch wraps the real error (DNS, SSL, etc.)
  // in a generic "fetch failed" with the actual reason in .cause.
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.cause) {
    const causeMsg = err.cause instanceof Error ? err.cause.message : String(err.cause);
    if (causeMsg && causeMsg !== message) {
      message = `${message}: ${causeMsg}`;
    }
  }

  // Check for abort/timeout errors (from AbortSignal.timeout)
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: StepErrorCode.HTTP_TIMEOUT, message: `Request timed out: ${message}` };
  }

  // Check for legacy httpResult attachment (backwards compat with existing error patterns)
  const httpResult = (err as Record<string, unknown>)?.httpResult as
    | { statusCode?: number; body?: unknown }
    | undefined;
  if (httpResult) {
    return {
      code: StepErrorCode.HTTP_ERROR,
      message,
      httpStatus: httpResult.statusCode,
      responseBody: httpResult.body,
    };
  }

  return { code: StepErrorCode.STEP_FAILED, message };
}
