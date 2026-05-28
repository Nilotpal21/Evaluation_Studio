/**
 * Response Sanitizer
 *
 * Strips sensitive data from API responses before returning to clients.
 * Used by withRouteHandler when sanitizeResponse config is provided.
 *
 * Delegates secret pattern matching and recursive scrubbing to the shared
 * `scrub-patterns` module in @abl/compiler — single source of truth for
 * what constitutes a secret.
 */

import {
  REDACTED,
  DEFAULT_SECRET_PATTERNS,
  SENSITIVE_HEADER_NAMES,
  scrubSecrets,
} from '@abl/compiler/platform/constructs/executors/scrub-patterns.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ResponseSanitizeConfig {
  /** Strip sensitive HTTP headers from response data (default: false) */
  redactHeaders?: boolean;
  /** Truncate response bodies larger than this (bytes). Default: 100KB */
  maxBodySize?: number;
  /** Additional regex patterns to scrub (merged with defaults) */
  redactPatterns?: RegExp[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_SIZE = 100_000; // 100KB
const TRUNCATION_PREVIEW_LENGTH = 1_000;

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Sanitize response data by redacting headers, truncating bodies, and scrubbing patterns.
 *
 * Delegates recursive secret scrubbing to shared `scrubSecrets()`, then applies
 * Studio-specific concerns (header redaction by key name, body truncation).
 */
export function sanitizeResponseData<T>(data: T, config: ResponseSanitizeConfig): T {
  if (data === null || data === undefined) return data;

  // Handle string values — apply pattern scrubbing + size truncation
  if (typeof data === 'string') {
    return sanitizeString(data, config) as T;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeResponseData(item, config)) as T;
  }

  // Handle objects
  if (typeof data === 'object') {
    return sanitizeObject(data as Record<string, unknown>, config) as T;
  }

  return data;
}

/**
 * Redact known sensitive headers from a headers object.
 * Returns a new object with sensitive values replaced by [REDACTED].
 */
export function redactSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      result[key] = REDACTED;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function sanitizeString(value: string, config: ResponseSanitizeConfig): string {
  // Build combined patterns: shared defaults + any custom patterns
  const patterns = config.redactPatterns
    ? [...DEFAULT_SECRET_PATTERNS, ...config.redactPatterns]
    : DEFAULT_SECRET_PATTERNS;

  // Delegate to shared scrubber
  let result = scrubSecrets(value, patterns) as string;

  // Truncate if too large
  const maxSize = config.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  if (result.length > maxSize) {
    return JSON.stringify({
      _truncated: true,
      byteSize: result.length,
      preview: result.slice(0, TRUNCATION_PREVIEW_LENGTH),
    });
  }

  return result;
}

function sanitizeObject(
  obj: Record<string, unknown>,
  config: ResponseSanitizeConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Redact sensitive header-like keys
    if (config.redactHeaders && SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      result[key] = REDACTED;
      continue;
    }

    // Recursively sanitize nested structures
    result[key] = sanitizeResponseData(value, config);
  }

  return result;
}
