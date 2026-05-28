/**
 * Tool Error Classifier — ABLP-412 (Bruce feedback 2.4).
 *
 * Maps arbitrary tool-call errors into fixed-enum subtypes so ON_ERROR
 * handlers with `subtypes: [...]` can match reliably. Keeps raw error
 * messages out of the subtype (user-facing safety) — subtype is always
 * drawn from a closed set.
 *
 * Resolution order:
 *   1. ToolExecutionError code (authoritative — producer classified it)
 *   2. Message pattern match (fallback for generic Error / string)
 *
 * Returns `{ subtype: undefined }` when no pattern matches so the caller
 * falls through to type=tool_error handler matching.
 */

import { ToolExecutionError, type ToolErrorCode } from '@agent-platform/shared-kernel';

export type ToolErrorSubtype = 'rate_limit' | 'auth_failure' | 'network_error' | 'tool_timeout';

export interface ToolErrorClassification {
  subtype?: ToolErrorSubtype;
  retryable: boolean;
}

const CODE_TO_SUBTYPE: Record<string, { subtype: ToolErrorSubtype; retryable: boolean }> = {
  TOOL_RATE_LIMITED: { subtype: 'rate_limit', retryable: true },
  TOOL_AUTH_FAILED: { subtype: 'auth_failure', retryable: false },
  TOOL_NETWORK_ERROR: { subtype: 'network_error', retryable: true },
  TOOL_TIMEOUT: { subtype: 'tool_timeout', retryable: true },
};

const PATTERNS: Array<{
  re: RegExp;
  subtype: ToolErrorSubtype;
  retryable: boolean;
}> = [
  { re: /rate[\s\-]?limit|\b429\b|too many requests/i, subtype: 'rate_limit', retryable: true },
  {
    re: /timeout|ETIMEDOUT/i,
    subtype: 'tool_timeout',
    retryable: true,
  },
  { re: /\b401\b|\b403\b|unauthorized|forbidden/i, subtype: 'auth_failure', retryable: false },
  {
    re: /ECONNRESET|ECONNREFUSED|ENETUNREACH|EPIPE|socket hang up|network\s*(?:error|failure|unreachable)|upstream unreachable|\b50[023]\b|bad gateway|service unavailable|internal server error/i,
    subtype: 'network_error',
    retryable: true,
  },
];

function normalizeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err == null) return '';
  try {
    return String(err);
  } catch {
    return '';
  }
}

export function classifyToolError(error: unknown): ToolErrorClassification {
  if (error instanceof ToolExecutionError) {
    const codeMatch = CODE_TO_SUBTYPE[error.code as ToolErrorCode];
    if (codeMatch) {
      return { subtype: codeMatch.subtype, retryable: codeMatch.retryable };
    }
  }

  const msg = normalizeMessage(error);
  if (!msg) {
    return { subtype: undefined, retryable: false };
  }

  for (const { re, subtype, retryable } of PATTERNS) {
    if (re.test(msg)) {
      return { subtype, retryable };
    }
  }

  return { subtype: undefined, retryable: false };
}
