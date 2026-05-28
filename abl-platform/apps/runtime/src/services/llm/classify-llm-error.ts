/**
 * LLM Error Classifier
 *
 * Inspects errors from the Vercel AI SDK (which wraps Anthropic, OpenAI, etc.)
 * and wraps them in AppError with:
 *   - The correct ErrorCode (MODEL_RATE_LIMITED, MODEL_API_ERROR, etc.)
 *   - A user-facing message prefixed with "AI Model Error:" so the user
 *     understands the error is from the upstream LLM provider, not the platform.
 *
 * Provider messages are preserved only when they are already safe to show.
 * Provider-specific internals are replaced with a sanitized message and an
 * internal diagnostic that operators can surface in Studio or traces.
 */

import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { toUserSafeModelResolutionConfigurationError } from './model-resolution-errors.js';

// Patterns for classifying the root cause from the provider error message
const CONTEXT_EXCEEDED_PATTERNS = [
  'context length',
  'context_length_exceeded',
  'max_tokens',
  'maximum context',
  'too many tokens',
  'token limit',
  'input is too long',
];

const CONTENT_FILTER_PATTERNS = [
  'content_filter',
  'content filter',
  'content_policy_violation',
  'content management policy',
  "azure openai's content",
  'responsibleaipolicyviolation',
  'safety system',
  'blocked by',
  'output blocked',
  'flagged',
];

const AUTH_PATTERNS = [
  'invalid api key',
  'invalid x-api-key',
  'incorrect api key',
  'authentication',
  'unauthorized',
  'permission denied',
  'invalid_api_key',
  'invalid_auth',
  'accessdeniedexception',
];

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'usage limit',
  'usage_limit',
  'quota',
  'too many requests',
  'overloaded',
  'capacity',
  'regain access',
  'spending limit',
];

const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'aborted', 'deadline exceeded', 'ETIMEDOUT'];

/** Structured content-filter category data extracted from the provider response. */
export interface ContentFilterCategory {
  category: string;
  severity?: string;
  filtered?: boolean;
  detected?: boolean;
}

export interface LlmErrorDiagnostic {
  code: string;
  provider?: string;
  customerMessage: string;
  operatorHint: string;
  recommendedAction: string;
  /** Structured filter categories when the provider returned content-filter data (e.g. Azure). */
  contentFilterCategories?: ContentFilterCategory[];
}

export interface LlmOperatorDiagnostic {
  category: 'llm';
  severity: 'error';
  code: string;
  message: string;
  customerMessage: string;
  operatorHint: string;
  recommendedAction: string;
  provider?: string;
  bannerEligible: true;
  /** Structured filter categories when the provider returned content-filter data (e.g. Azure). */
  contentFilterCategories?: ContentFilterCategory[];
}

const errorDiagnostics = new WeakMap<AppError, LlmErrorDiagnostic>();

/**
 * Classify an error thrown by the Vercel AI SDK during an LLM call.
 *
 * Returns an AppError with a contextual, user-facing message and the
 * appropriate ErrorCode. The original error is preserved as `cause`.
 */
export function classifyLlmError(err: unknown): AppError {
  const configurationError = toUserSafeModelResolutionConfigurationError(err);
  if (configurationError) {
    return configurationError;
  }

  const status = (err as { status?: number }).status;
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  const lowerMessage = message.toLowerCase();

  // ── OpenAI Responses reasoning/function-call adjacency ───────────────────
  // OpenAI rejects Responses history when a function_call item is replayed
  // without its paired reasoning item. Keep the channel message sanitized and
  // attach the actionable detail as an operator-only diagnostic.
  if (
    lowerMessage.includes('function_call') &&
    lowerMessage.includes('required') &&
    lowerMessage.includes('reasoning') &&
    (lowerMessage.includes('rs_') || lowerMessage.includes('reasoning item'))
  ) {
    return withLlmErrorDiagnostic(
      new AppError(
        'AI Model Error: The model provider rejected the conversation history. Please try again.',
        {
          ...ErrorCodes.MODEL_API_ERROR,
          cause: err,
        },
      ),
      {
        code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
        provider: 'openai',
        customerMessage:
          'AI Model Error: The model provider rejected the conversation history. Please try again.',
        operatorHint:
          'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
        recommendedAction:
          'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
      },
    );
  }

  // ── Bedrock IRSA / credential resolution failure ─────────────────────────
  // Intercept before the generic fallback so raw SDK text (package names, IAM role ARNs,
  // the __iam_role__ sentinel, or the "could not load credentials" chain message) never
  // reaches the user.  These errors originate from two paths:
  //   Path A: @aws-sdk/credential-providers not installed → "Bedrock ambient credentials require ..."
  //   Path B: Running outside AWS / IRSA misconfigured → "Could not load credentials from any providers"
  if (
    matchesAny(lowerMessage, [
      'could not load credentials from any providers',
      'credential-providers',
      '__iam_role__',
      'bedrock ambient credentials require',
    ])
  ) {
    return new AppError(
      'AI Model Error: AWS Bedrock credential resolution failed. ' +
        'Ensure the platform is running in AWS with an IAM role attached ' +
        'and IRSA is configured correctly.',
      { ...ErrorCodes.CREDENTIAL_NOT_FOUND, cause: err },
    );
  }

  // ── Bedrock ThrottlingException — intercept before generic rate-limit branch
  // to prevent raw AWS error message (which may contain model ARN + region) from leaking
  if (matchesAny(lowerMessage, ['throttlingexception'])) {
    return new AppError('AI Model Error: AWS Bedrock rate limit exceeded — retry after a moment.', {
      ...ErrorCodes.MODEL_RATE_LIMITED,
      cause: err,
    });
  }

  // ── Direct code-based content-filter check ──────────────────────
  // Provider's normalized code is the most authoritative signal — catches
  // Azure/OpenAI content-filter errors regardless of how the SDK formats
  // the message text. Must run before the generic rate-limit/status branches
  // to prevent false classification of 400-status content-filter responses.
  if (code === 'content_filter' || code === 'content_filter_response') {
    const categories = extractContentFilterCategories(err);
    return withLlmErrorDiagnostic(
      new AppError(
        `AI Model Error: The response was blocked by the provider's content safety filter.`,
        { ...ErrorCodes.MODEL_CONTENT_FILTERED, cause: err },
      ),
      {
        code: 'CONTENT_FILTER_CODE_MATCH',
        customerMessage: `AI Model Error: The response was blocked by the provider's content safety filter.`,
        operatorHint: `Provider returned error code '${code}' indicating content-filter violation.`,
        recommendedAction:
          'Review the input for content that may trigger the provider content safety policy.',
        ...(categories ? { contentFilterCategories: categories } : {}),
      },
    );
  }

  // ── Rate limit / billing / quota (429 or message-based) ──────────
  if (status === 429 || matchesAny(lowerMessage, RATE_LIMIT_PATTERNS)) {
    return new AppError(`AI Model Error: ${message}`, {
      ...ErrorCodes.MODEL_RATE_LIMITED,
      cause: err,
    });
  }

  // ── Authentication / authorization (401, 403) ────────────────────
  if (status === 401 || status === 403 || matchesAny(lowerMessage, AUTH_PATTERNS)) {
    return new AppError(
      `AI Model Error: The model credentials are invalid or expired. Please contact your administrator.`,
      {
        ...ErrorCodes.CREDENTIAL_NOT_FOUND,
        cause: err,
      },
    );
  }

  // ── Bedrock ValidationException (400) ────────────────────────────
  if (matchesAny(lowerMessage, ['validationexception', 'malformed input request'])) {
    return new AppError(
      'AI Model Error: The Bedrock request was rejected. Verify the model ID and region configuration.',
      {
        ...ErrorCodes.MODEL_API_ERROR,
        cause: err,
      },
    );
  }

  // ── Bedrock ResourceNotFoundException ────────────────────────────
  // Restricted to AWS-specific exception names to avoid mis-classifying
  // generic 404s from other providers (OpenAI, Anthropic, custom) as Bedrock.
  if (
    matchesAny(lowerMessage, [
      'resourcenotfoundexception', // AWS-specific exception class name
      'invocation model not found', // Bedrock-specific phrase
    ])
  ) {
    return new AppError(
      'AI Model Error: The Bedrock model is not available in the configured region. ' +
        'Verify that the model ID is supported in your AWS region.',
      {
        ...ErrorCodes.MODEL_API_ERROR,
        cause: err,
      },
    );
  }

  // ── Context length exceeded (400 with context patterns) ──────────
  if (matchesAny(lowerMessage, CONTEXT_EXCEEDED_PATTERNS)) {
    return new AppError(
      `AI Model Error: The conversation exceeded the model's context window. Please start a new session or shorten the conversation.`,
      {
        ...ErrorCodes.MODEL_CONTEXT_EXCEEDED,
        cause: err,
      },
    );
  }

  // ── Content filter (422 or message-based) ────────────────────────
  if (status === 422 || matchesAny(lowerMessage, CONTENT_FILTER_PATTERNS)) {
    const categories = extractContentFilterCategories(err);
    const cfError = new AppError(
      `AI Model Error: The response was blocked by the provider's content safety filter.`,
      {
        ...ErrorCodes.MODEL_CONTENT_FILTERED,
        cause: err,
      },
    );
    if (categories) {
      return withLlmErrorDiagnostic(cfError, {
        code: 'CONTENT_FILTER_PATTERN_MATCH',
        customerMessage: `AI Model Error: The response was blocked by the provider's content safety filter.`,
        operatorHint: 'Content-filter detected via message pattern or HTTP 422 status.',
        recommendedAction:
          'Review the input for content that may trigger the provider content safety policy.',
        contentFilterCategories: categories,
      });
    }
    return cfError;
  }

  // ── Timeout / abort ──────────────────────────────────────────────
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT' || matchesAny(lowerMessage, TIMEOUT_PATTERNS)) {
    return new AppError(
      `AI Model Error: The request to the AI provider timed out. Please try again.`,
      {
        ...ErrorCodes.MODEL_TIMEOUT,
        cause: err,
      },
    );
  }

  // ── Bedrock ServiceUnavailableException (503) ────────────────────
  if (matchesAny(lowerMessage, ['serviceunavailableexception'])) {
    return new AppError('AI Model Error: AWS Bedrock service temporarily unavailable.', {
      ...ErrorCodes.MODEL_API_ERROR,
      cause: err,
    });
  }

  // ── Server errors from the provider (5xx) ────────────────────────
  if (status && status >= 500) {
    return new AppError(
      `AI Model Error: The AI provider returned a server error. Please try again.`,
      {
        ...ErrorCodes.MODEL_API_ERROR,
        cause: err,
      },
    );
  }

  // ── Fallback: unrecognized error ─────────────────────────────────
  return new AppError(`AI Model Error: ${message}`, {
    ...ErrorCodes.MODEL_API_ERROR,
    cause: err,
  });
}

/**
 * Check if an error is a classified LLM AppError (produced by classifyLlmError).
 */
export function isLlmError(err: unknown): err is AppError {
  if (!(err instanceof AppError)) return false;
  const llmCodes: Set<string> = new Set([
    ErrorCodes.MODEL_RATE_LIMITED.code,
    ErrorCodes.MODEL_API_ERROR.code,
    ErrorCodes.MODEL_TIMEOUT.code,
    ErrorCodes.MODEL_CONTENT_FILTERED.code,
    ErrorCodes.MODEL_CONTEXT_EXCEEDED.code,
    ErrorCodes.CREDENTIAL_NOT_FOUND.code,
    ErrorCodes.CREDENTIAL_DECRYPTION.code,
    ErrorCodes.MODEL_NOT_CONFIGURED.code,
  ]);
  return llmCodes.has(err.code);
}

export function getLlmErrorDiagnostic(err: unknown): LlmErrorDiagnostic | undefined {
  if (!(err instanceof AppError)) {
    return undefined;
  }
  return errorDiagnostics.get(err);
}

export function getLlmOperatorDiagnostic(err: unknown): LlmOperatorDiagnostic | undefined {
  const diagnostic = getLlmErrorDiagnostic(err);
  if (!diagnostic) {
    return undefined;
  }

  return {
    category: 'llm',
    severity: 'error',
    code: diagnostic.code,
    message: diagnostic.operatorHint,
    customerMessage: diagnostic.customerMessage,
    operatorHint: diagnostic.operatorHint,
    recommendedAction: diagnostic.recommendedAction,
    ...(diagnostic.provider ? { provider: diagnostic.provider } : {}),
    bannerEligible: true,
    ...(diagnostic.contentFilterCategories
      ? { contentFilterCategories: diagnostic.contentFilterCategories }
      : {}),
  };
}

/**
 * Map a classified LLM AppError to the subtype string used by agent on_error
 * handlers (e.g. `subtype: content_filter`). Returns undefined for non-LLM
 * errors or codes that do not carry a meaningful subtype.
 *
 * Exported so reasoning-executor and tests share the canonical mapping
 * rather than each maintaining an independent copy.
 */
export function deriveLlmErrorSubtype(err: unknown): string | undefined {
  if (!(err instanceof AppError)) return undefined;
  switch (err.code) {
    case ErrorCodes.MODEL_CONTENT_FILTERED.code:
      return 'content_filter';
    case ErrorCodes.MODEL_RATE_LIMITED.code:
      return 'rate_limited';
    case ErrorCodes.MODEL_TIMEOUT.code:
      return 'timeout';
    case ErrorCodes.MODEL_CONTEXT_EXCEEDED.code:
      return 'context_exceeded';
    case ErrorCodes.MODEL_API_ERROR.code:
      return 'api_error';
    case ErrorCodes.CREDENTIAL_NOT_FOUND.code:
      return 'credential_not_found';
    default:
      return undefined;
  }
}

/**
 * Build a MODEL_CONTENT_FILTERED AppError with an operator diagnostic
 * attached. Use this for output-side content filter (stop-reason path)
 * so getLlmOperatorDiagnostic returns structured data for trace events.
 */
export function buildContentFilterAppError(stopReason: string): AppError {
  return withLlmErrorDiagnostic(
    new AppError(
      `AI Model Error: The response was blocked by the provider's content safety filter.`,
      {
        ...ErrorCodes.MODEL_CONTENT_FILTERED,
      },
    ),
    {
      code: 'CONTENT_FILTER_STOP_REASON',
      customerMessage: `AI Model Error: The response was blocked by the provider's content safety filter.`,
      operatorHint: `Provider returned finish_reason '${stopReason}' indicating output-side content-filter.`,
      recommendedAction:
        'Review the input for content that may trigger the provider content safety policy.',
    },
  );
}

function withLlmErrorDiagnostic(error: AppError, diagnostic: LlmErrorDiagnostic): AppError {
  errorDiagnostics.set(error, diagnostic);
  return error;
}

/**
 * Extract structured content-filter categories from the provider error body.
 *
 * Azure OpenAI returns `error.innererror.content_filter_result` with per-category
 * severity/detected/filtered flags. Some SDK versions expose the raw response as
 * `err.responseBody` (JSON string) while others surface it as `err.data` (object).
 */
export function extractContentFilterCategories(err: unknown): ContentFilterCategory[] | undefined {
  const raw =
    (err as { responseBody?: unknown })?.responseBody ?? (err as { data?: unknown })?.data;

  let body: unknown;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return undefined;
    }
  } else {
    body = raw;
  }

  const filterResult =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (body as any)?.error?.innererror?.content_filter_result ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (body as any)?.error?.content_filter_result;
  if (!filterResult || typeof filterResult !== 'object') return undefined;

  const out: ContentFilterCategory[] = [];
  for (const [category, value] of Object.entries(filterResult)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out.push({
      category,
      ...(typeof v.severity === 'string' ? { severity: v.severity } : {}),
      ...(typeof v.filtered === 'boolean' ? { filtered: v.filtered } : {}),
      ...(typeof v.detected === 'boolean' ? { detected: v.detected } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}
