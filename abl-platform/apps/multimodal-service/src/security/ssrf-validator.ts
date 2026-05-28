/**
 * SSRF Validation for Attachment URLs
 *
 * Thin wrapper around @agent-platform/shared's validateUrlForSSRF,
 * tailored for attachment URL validation (WhatsApp media URLs, image_url blocks).
 *
 * Only allows http: and https: schemes (not ws:/wss: which the shared utility permits).
 */

import { validateUrlForSSRF } from '@agent-platform/shared';

// =============================================================================
// TYPES
// =============================================================================

export interface AttachmentUrlValidationResult {
  /** Whether the URL is safe to fetch */
  safe: boolean;
  /** Human-readable reason when blocked */
  reason?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Schemes allowed for attachment URLs (stricter than shared utility which also allows ws/wss) */
const ALLOWED_ATTACHMENT_SCHEMES = new Set(['http:', 'https:']);

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Validate a URL for safe fetching as an attachment source.
 *
 * Checks:
 * 1. URL is parseable
 * 2. Scheme is http: or https: only (no file:, ftp:, data:, javascript:, ws:, etc.)
 * 3. Hostname is not a private IP, localhost, or cloud metadata endpoint
 *    (delegated to @agent-platform/shared's validateUrlForSSRF)
 *
 * @param url - The URL to validate
 * @returns Structured result with `safe` flag and optional `reason`
 */
export function validateAttachmentUrl(url: string): AttachmentUrlValidationResult {
  // Empty or whitespace-only URLs are invalid
  if (!url || !url.trim()) {
    return { safe: false, reason: 'URL is empty' };
  }

  // Parse the URL to check the scheme before delegating to shared utility
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Only allow http and https for attachment fetching
  if (!ALLOWED_ATTACHMENT_SCHEMES.has(parsed.protocol)) {
    return {
      safe: false,
      reason: `Disallowed URL scheme: ${parsed.protocol} — only http: and https: are permitted for attachments`,
    };
  }

  // Delegate IP/hostname/metadata checks to the shared SSRF utility
  const ssrfResult = validateUrlForSSRF(url);
  if (!ssrfResult.safe) {
    return { safe: false, reason: ssrfResult.reason || 'Blocked by SSRF protection' };
  }

  return { safe: true };
}
