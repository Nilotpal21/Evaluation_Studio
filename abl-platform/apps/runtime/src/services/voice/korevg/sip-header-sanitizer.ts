/**
 * SIP Header Sanitizer
 *
 * Prevents SIP header injection by validating and sanitizing
 * custom SIP headers before they are included in Jambonz verbs.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('sip-header-sanitizer');

/** Headers allowed in outbound SIP messages */
const ALLOWED_SIP_HEADERS = new Set([
  'x-custom-data',
  'x-session-id',
  'x-tenant-id',
  'x-agent-id',
  'x-contact-id',
  'x-project-id',
  'x-correlation-id',
  'x-request-id',
  'user-to-user',
  'x-transfer-reason',
]);

const MAX_HEADER_VALUE_LENGTH = 256;
const MAX_HEADERS_COUNT = 10;

/**
 * Sanitize SIP headers to prevent header injection attacks.
 *
 * - Strips CR/LF characters (prevents header injection)
 * - Enforces value length limit (256 chars)
 * - Limits total header count (10)
 * - Filters to allowlisted header names
 *
 * Returns a new sanitized headers object, or undefined if no valid headers remain.
 */
export function sanitizeSipHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;

  const sanitized: Record<string, string> = {};
  let count = 0;

  for (const [name, value] of Object.entries(headers)) {
    if (count >= MAX_HEADERS_COUNT) {
      log.warn('SIP header count limit exceeded, remaining headers dropped', {
        total: Object.keys(headers).length,
        max: MAX_HEADERS_COUNT,
      });
      break;
    }

    const normalizedName = name.toLowerCase().trim();

    // Allowlist filter
    if (!ALLOWED_SIP_HEADERS.has(normalizedName)) {
      log.warn('SIP header blocked by allowlist', { header: normalizedName });
      continue;
    }

    // Strip CR/LF/NUL to prevent header injection
    const sanitizedValue = String(value).replace(/[\r\n\0]/g, '');

    // Enforce value length limit
    const truncatedValue =
      sanitizedValue.length > MAX_HEADER_VALUE_LENGTH
        ? sanitizedValue.slice(0, MAX_HEADER_VALUE_LENGTH)
        : sanitizedValue;

    if (truncatedValue.length !== String(value).length) {
      log.warn('SIP header value sanitized', {
        header: normalizedName,
        originalLength: String(value).length,
        sanitizedLength: truncatedValue.length,
      });
    }

    sanitized[normalizedName] = truncatedValue;
    count++;
  }

  return count > 0 ? sanitized : undefined;
}
