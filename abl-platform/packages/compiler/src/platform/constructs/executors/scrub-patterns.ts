/**
 * Shared Secret Scrub Patterns
 *
 * Single source of truth for regex patterns used to detect and redact secrets
 * in tool results, API responses, and trace data.
 *
 * Used by:
 * - sanitizer-middleware.ts (runtime tool results)
 * - Studio response-sanitizer.ts (API response bodies)
 * - trace-scrubber.ts (trace/audit data)
 */

/** Replacement string used when a secret pattern is matched. */
export const REDACTED = '[REDACTED]';

/**
 * Default regex patterns for detecting secrets in string values.
 *
 * Order matters — more specific patterns should come first to avoid
 * partial matches from broader patterns.
 */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private keys (full block)
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // AWS-style access key IDs (AKIA...)
  /AKIA[A-Z0-9]{16}/g,
  // Platform-specific keys (abl_xxx with 20+ chars)
  /abl_[a-zA-Z0-9]{20,}/g,
  // OpenAI-style keys (sk-...)
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Stripe-style publishable/secret keys (pk_live_..., pk_test_..., sk_live_..., sk_test_...)
  /\b(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  // GitHub personal access tokens (ghp_...)
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  // GitHub OAuth tokens (gho_...)
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  // Generic API keys / tokens / secrets / passwords (16+ char values after key-like prefix)
  /(?:api[_-]?key|token|secret|password|authorization)['":\s=]*[A-Za-z0-9\-._~+/]{16,}/gi,
] as const;

/**
 * HTTP headers that contain sensitive authentication/session data.
 * Used for header redaction in both runtime and Studio contexts.
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'www-authenticate',
  'x-csrf-token',
  'x-session-token',
]);

/**
 * Recursively scrub secret patterns from a value.
 *
 * Walks objects and arrays, applying regex replacement on string leaves.
 * Non-string primitives (number, boolean, null, undefined) pass through unchanged.
 *
 * @param value - Any JSON-serializable value
 * @param patterns - Regex patterns to match and replace with REDACTED
 * @returns A new value with secrets replaced
 */
export function scrubSecrets(
  value: unknown,
  patterns: readonly RegExp[] = DEFAULT_SECRET_PATTERNS,
): unknown {
  if (typeof value === 'string') {
    let scrubbed = value;
    for (const pattern of patterns) {
      pattern.lastIndex = 0; // Reset for global regexes
      scrubbed = scrubbed.replace(pattern, REDACTED);
    }
    return scrubbed;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item, patterns));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = scrubSecrets(val, patterns);
    }
    return result;
  }

  return value;
}
