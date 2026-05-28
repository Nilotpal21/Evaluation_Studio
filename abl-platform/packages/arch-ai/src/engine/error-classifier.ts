/**
 * Error classification for the v2 turn engine.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.7
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.1
 *
 * Two categories of failure in the turn loop, handled differently:
 *
 *   - ToolExecutionError — thrown from tool.execute or inferred (invalid args,
 *     malformed return, timeout). Fed back to the LLM as a synthetic tool
 *     result for self-correction. User sees nothing unless a hard limit hits.
 *
 *   - ModelProviderError — raised by the LLM client (rate limit, 5xx,
 *     context-length, timeout, auth). Handled by the engine. May abort the
 *     turn. Sanitized error surfaced to user per CLAUDE.md "User-Facing
 *     Runtime Error Sanitization" (no tenant IDs, model IDs, credential
 *     hints, or internal remediation text).
 *
 *   - BUILD per-agent compile failures — orthogonal; user-visible artifact
 *     state. Not classified here.
 */

import type { TurnEndReason } from '../types/turn-events.js';

// ─── Codes ───────────────────────────────────────────────────────────────

/** Tool-side failure codes — these become synthetic tool results. */
export const ToolErrorCode = {
  ARGS_INVALID: 'ARGS_INVALID',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_RESULT_MALFORMED: 'TOOL_RESULT_MALFORMED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  REPEAT_CALL_DETECTED: 'REPEAT_CALL_DETECTED',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
} as const;
export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

/** Model-provider failure codes — these may terminate the turn. */
export const ModelErrorCode = {
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  MODEL_BILLING: 'MODEL_BILLING',
  MODEL_CONTEXT_LENGTH: 'MODEL_CONTEXT_LENGTH',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_AUTH: 'MODEL_AUTH',
  MODEL_PROVIDER_5XX: 'MODEL_PROVIDER_5XX',
  MODEL_CONTENT_FILTER: 'MODEL_CONTENT_FILTER',
  MODEL_CONFIG_ERROR: 'MODEL_CONFIG_ERROR',
  MODEL_PROVIDER_UNKNOWN: 'MODEL_PROVIDER_UNKNOWN',
} as const;
export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

// ─── Classified result shape ─────────────────────────────────────────────

export interface ToolExecutionError {
  category: 'tool';
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

export interface ModelProviderError {
  category: 'model';
  code: ModelErrorCode;
  /** Retry policy derived from the error code. */
  retry: boolean;
  /** Zero-indexed attempts already made (incremented by caller before retry). */
  attempts?: number;
  maxAttempts: number;
  backoffMs: number;
  /** The TurnEndReason to emit if retries are exhausted or this is non-retryable. */
  reason: TurnEndReason;
  /** User-safe sanitized message. Never includes tenant/model/credential hints. */
  message: string;
}

// ─── Tool-side classification ────────────────────────────────────────────

/**
 * Classify a thrown / malformed tool result. Returns the synthetic result
 * that should be fed back to the LLM as the tool_call output.
 */
export function classifyToolError(err: unknown, context?: string): ToolExecutionError {
  if (err instanceof AbortError) {
    // Propagated abort — should be handled by the turn loop, not the invoker.
    return {
      category: 'tool',
      code: ToolErrorCode.TOOL_EXECUTION_FAILED,
      message: 'Operation was aborted.',
    };
  }

  if (err instanceof TimeoutError) {
    return {
      category: 'tool',
      code: ToolErrorCode.TOOL_TIMEOUT,
      message: context ? `Operation timed out: ${context}` : 'Operation timed out.',
    };
  }

  if (err instanceof ZodValidationError) {
    return {
      category: 'tool',
      code: ToolErrorCode.ARGS_INVALID,
      message: 'Operation arguments failed validation.',
      details: err.issues,
    };
  }

  if (err instanceof Error) {
    return {
      category: 'tool',
      code: ToolErrorCode.TOOL_EXECUTION_FAILED,
      message: err.message,
    };
  }

  return {
    category: 'tool',
    code: ToolErrorCode.TOOL_EXECUTION_FAILED,
    message: String(err),
  };
}

// ─── Model-side classification ───────────────────────────────────────────

/**
 * Classify an error from the LLM client. Returns a `ModelProviderError`
 * with retry policy + the TurnEndReason to emit if we give up.
 *
 * Error shape-detection is best-effort; different providers wrap errors
 * differently. We try to read common fields (status, code) and fall back
 * to a generic classification.
 */
export function classifyModelError(err: unknown): ModelProviderError {
  const shaped = asShapedError(err);

  // HTTP status-based classification
  const status = shaped.status;
  if (status === 429) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_RATE_LIMITED,
      retry: true,
      maxAttempts: 4,
      backoffMs: 1000,
      reason: 'model_provider_error',
      message:
        'Model provider rate limit reached for Arch. Retry after the provider window resets.',
    };
  }

  // Billing / quota exhaustion — non-retryable, user action required.
  // Providers return 400 or 402 with billing-related messages.
  if (isBillingError(status, shaped.message)) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_BILLING,
      retry: false,
      maxAttempts: 0,
      backoffMs: 0,
      reason: 'model_auth_error',
      message:
        'Model provider billing or quota check failed. Review the connected account and billing settings.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_AUTH,
      retry: false,
      maxAttempts: 0,
      backoffMs: 0,
      reason: 'model_auth_error',
      message: 'Model provider authentication failed for Arch. Check the provider connection.',
    };
  }

  if (isContentFilterError(shaped.code, shaped.message)) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_CONTENT_FILTER,
      retry: false,
      maxAttempts: 0,
      backoffMs: 0,
      reason: 'model_provider_error',
      message:
        'Model provider content filtering blocked the response. Adjust the request and retry.',
    };
  }

  // Model configuration errors — resolution failed, no model available, etc.
  // These carry user-facing messages that should be shown directly.
  if (shaped.code === 'MODEL_CONFIG_ERROR') {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_CONFIG_ERROR,
      retry: false,
      maxAttempts: 0,
      backoffMs: 0,
      reason: 'model_auth_error',
      message: 'Arch model configuration is incomplete or invalid. Check Arch model settings.',
    };
  }

  if (typeof status === 'number' && status >= 500 && status < 600) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_PROVIDER_5XX,
      retry: true,
      maxAttempts: 2,
      backoffMs: 1000,
      reason: 'model_provider_error',
      message: 'Model provider returned a temporary server error. Retry the Arch request.',
    };
  }

  // Message / code-based classification
  const lower = (shaped.message || '').toLowerCase();
  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    shaped.code === 'context_length_exceeded'
  ) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_CONTEXT_LENGTH,
      retry: true,
      maxAttempts: 1,
      backoffMs: 0,
      reason: 'model_context_length',
      message: 'The conversation history is too long. Please start a new session.',
    };
  }

  if (
    shaped.name === 'TimeoutError' ||
    shaped.name === 'AbortError' ||
    lower.includes('timeout') ||
    shaped.code === 'ETIMEDOUT'
  ) {
    return {
      category: 'model',
      code: ModelErrorCode.MODEL_TIMEOUT,
      retry: false,
      maxAttempts: 0,
      backoffMs: 0,
      reason: 'model_timeout',
      message: 'Model provider request timed out while Arch was generating a response.',
    };
  }

  return {
    category: 'model',
    code: ModelErrorCode.MODEL_PROVIDER_UNKNOWN,
    retry: true,
    maxAttempts: 2,
    backoffMs: 1000,
    reason: 'model_provider_error',
    message: buildSanitizedFallbackMessage(shaped.message),
  };
}

/** Compute backoff delay for retry attempt N (1-indexed), capped exponential. */
export function backoffDelayMs(baseMs: number, attempt: number): number {
  const delay = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, 30_000);
}

// ─── Sentinel error classes ──────────────────────────────────────────────

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(message = 'Operation timed out') {
    super(message);
  }
}

export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'Operation aborted') {
    super(message);
  }
}

export class ZodValidationError extends Error {
  override readonly name = 'ZodValidationError';
  readonly issues: unknown;
  constructor(issues: unknown, message = 'Validation failed') {
    super(message);
    this.issues = issues;
  }
}

// ─── Sanitization ───────────────────────────────────────────────────────

/**
 * Build a builder-visible fallback error message from the raw provider error.
 * Strips tenant IDs, API keys, and internal paths but preserves sanitized
 * provider diagnostics so agent builders can adjust model configuration.
 */
function buildSanitizedFallbackMessage(rawMessage: string | undefined): string {
  const fallback = 'Model provider returned an unexpected error while Arch was running.';
  if (!rawMessage || rawMessage.length === 0) return fallback;

  // Strip values that look like credentials, tenant IDs, or internal paths
  let sanitized = rawMessage
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/key-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/tenantId[=:]\s*\S+/gi, '')
    .replace(/\/[a-z]+\/src\/[^\s]+/gi, '[internal]');

  sanitized = sanitized.trim();
  if (sanitized.length === 0) return fallback;
  if (sanitized.length > 200) sanitized = sanitized.slice(0, 200) + '…';

  return `Model provider error while running Arch: ${sanitized}. Check Arch model settings.`;
}

// ─── Internal helpers ────────────────────────────────────────────────────

interface ShapedError {
  name?: string;
  message?: string;
  status?: number;
  code?: string | number;
}

function isBillingError(status: number | undefined, message: string | undefined): boolean {
  if (status === 402) return true;
  const lower = (message || '').toLowerCase();
  return (
    lower.includes('credit balance') ||
    lower.includes('insufficient credits') ||
    lower.includes('billing') ||
    lower.includes('purchase credits') ||
    lower.includes('exceeded your quota') ||
    lower.includes('quota exceeded') ||
    lower.includes('spending limit') ||
    lower.includes('payment required')
  );
}

function isContentFilterError(code: string | number | undefined, message: string | undefined) {
  const lower = (message || '').toLowerCase();
  return (
    code === 'content_filter' ||
    lower.includes('content_filter') ||
    lower.includes('content filter') ||
    lower.includes('content filtering') ||
    lower.includes('content management policy') ||
    lower.includes('responsibleaipolicyviolation')
  );
}

function asShapedError(err: unknown): ShapedError {
  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; statusCode?: number; code?: string };
    return {
      name: err.name,
      message: err.message,
      status: anyErr.status ?? anyErr.statusCode,
      code: anyErr.code,
    };
  }
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    return {
      name: typeof obj.name === 'string' ? obj.name : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
      status:
        typeof obj.status === 'number'
          ? obj.status
          : typeof obj.statusCode === 'number'
            ? obj.statusCode
            : undefined,
      code: typeof obj.code === 'string' || typeof obj.code === 'number' ? obj.code : undefined,
    };
  }
  return { message: String(err) };
}
