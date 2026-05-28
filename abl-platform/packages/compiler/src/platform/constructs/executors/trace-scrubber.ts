/**
 * Trace Scrubber
 *
 * Redacts sensitive data from trace events to prevent secrets
 * and PII from leaking into observability systems.
 *
 * Uses shared patterns from scrub-patterns.ts (single source of truth)
 * plus key-name-aware redaction and PII detection.
 */

import { redactPII } from '../../security/pii-detector.js';
import type { PIIRecognizerRegistry } from '../../security/pii-recognizer-registry.js';
import { isPIIBypassFixEnabled } from '../../security/_pii-bypass-fix.js';
import { DEFAULT_SECRET_PATTERNS, SENSITIVE_HEADER_NAMES, REDACTED } from './scrub-patterns.js';

export interface TraceScrubberOptions {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

/**
 * Key names whose string values should always be redacted regardless of content.
 * Compile-time constant — 22 fixed entries, no runtime growth.
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'secret_key',
  'secretkey',
  'api_key',
  'apikey',
  'api_secret',
  'apisecret',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'credential',
  'credentials',
  'private_key',
  'privatekey',
  'client_secret',
  'clientsecret',
  'authorization',
  'auth_token',
  'authtoken',
]);

/**
 * Deep-clone and redact sensitive data from tool call input/output.
 * Redacts:
 * - Values matching shared secret patterns (Bearer, API keys, key prefixes)
 * - Values matching {{secrets.*}} placeholders
 * - Header values for sensitive header names
 * - Values for secret key names (password, token, api_key, etc.)
 * - PII detected by the PII detector
 */
export function scrubToolCallData(
  data: Record<string, unknown>,
  options?: TraceScrubberOptions,
): Record<string, unknown> {
  return scrubValue(data, undefined, options) as Record<string, unknown>;
}

/**
 * Alias for scrubToolCallData — used at the trace-emitter level for universal
 * event scrubbing. Same implementation, semantically distinct call site.
 */
export function scrubTraceEvent(
  data: Record<string, unknown>,
  options?: TraceScrubberOptions,
): Record<string, unknown> {
  return scrubToolCallData(data, options);
}

/**
 * Redact query parameters from a URL (they may contain API keys).
 * Returns the URL with query string stripped.
 */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search) {
      return `${parsed.origin}${parsed.pathname}?[QUERY_REDACTED]`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function scrubValue(value: unknown, key?: string, options?: TraceScrubberOptions): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubString(value, key, options);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(item, String(i), options));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrubValue(v, k, options);
    }
    return result;
  }

  return value;
}

function scrubString(value: string, key?: string, options?: TraceScrubberOptions): string {
  // Check if the key name indicates a sensitive header
  if (key && SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
    return REDACTED;
  }

  // Check if the key name indicates a secret field (password, token, api_key, etc.)
  if (key && SECRET_KEY_NAMES.has(key.toLowerCase())) {
    return REDACTED;
  }

  // Check if the value matches known secret patterns (Bearer, API keys, key prefixes, etc.)
  for (const pattern of DEFAULT_SECRET_PATTERNS) {
    pattern.lastIndex = 0; // Reset for global regexes
    if (pattern.test(value)) {
      // For global patterns, replace all matches rather than returning full REDACTED
      pattern.lastIndex = 0;
      value = value.replace(pattern, REDACTED);
    }
  }

  // Run PII detection and redaction. When the operator pod-level kill switch
  // PII_BYPASS_FIX_ENABLED=false is set, skip PII detection entirely (pre-fix
  // behavior at this surface, modulo PII_PATTERNS which the LLD removed).
  if (!isPIIBypassFixEnabled()) {
    return value;
  }
  return redactPII(value, options?.piiRecognizerRegistry);
}
