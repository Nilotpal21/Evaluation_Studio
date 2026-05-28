/**
 * Crawl Error Classifier & Sanitizer
 *
 * Pure functions for classifying crawl errors by type,
 * sanitizing error messages for safe display, and mapping
 * error types to i18n remediation keys.
 */

import type { CrawlErrorType } from '../types/crawl-error.js';

/**
 * Classify a crawl error based on status code and/or error message string.
 *
 * Priority: statusCode first (most reliable), then string matching.
 * Default: 'crawl_error' for unrecognized errors.
 */
export function classifyCrawlError(errorString: string, statusCode?: number): CrawlErrorType {
  // Status code takes priority — most reliable signal
  if (statusCode !== undefined && statusCode !== null) {
    if (statusCode >= 400 && statusCode < 500) {
      return 'http_4xx';
    }
    if (statusCode >= 500 && statusCode < 600) {
      return 'http_5xx';
    }
  }

  const lower = errorString.toLowerCase();

  // Timeout errors
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('esockettimedout')
  ) {
    return 'timeout';
  }

  // Connection errors
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('econnaborted') ||
    lower.includes('epipe')
  ) {
    return 'connection_error';
  }

  // Robots.txt blocked
  if (lower.includes('robots') || lower.includes('disallowed')) {
    return 'robots_blocked';
  }

  // Quality gate
  if (lower.includes('quality') || lower.includes('thin') || lower.includes('below threshold')) {
    return 'quality_gated';
  }

  // Content type filtered
  if (
    lower.includes('content type') ||
    lower.includes('not html') ||
    lower.includes('binary') ||
    lower.includes('filtered')
  ) {
    return 'content_filtered';
  }

  // SSRF protection
  if (
    lower.includes('ssrf') ||
    lower.includes('private') ||
    lower.includes('loopback') ||
    lower.includes('blocked ip')
  ) {
    return 'ssrf_blocked';
  }

  // Default
  return 'crawl_error';
}

/**
 * Internal IPs, hostnames, and infrastructure details to redact.
 */
const INTERNAL_IP_REGEX =
  /\b(127\.0\.0\.1|0\.0\.0\.0|localhost|::1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b/gi;

/**
 * Port numbers following an IP or hostname (e.g., :3005, :8080).
 */
const PORT_REGEX = /:\d{2,5}(?=\s|$|\/|,|;|\))/g;

/**
 * Stack traces — everything after first "    at ".
 */
const STACK_TRACE_REGEX = /\n\s+at .*/g;

/**
 * Internal hostnames (*.internal, *.local, *.svc.cluster.local).
 */
const INTERNAL_HOSTNAME_REGEX = /\b[\w.-]+\.(internal|local|svc\.cluster\.local)\b/gi;

/**
 * File paths that reveal server internals.
 */
const FILE_PATH_REGEX = /(?:\/(?:home|var|app|usr|tmp|opt|etc)\/[\w./-]+)|(?:[A-Z]:\\[\w.\\-]+)/gi;

/** Maximum sanitized message length. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Sanitize an error message for safe display to end users.
 *
 * - Replaces internal IPs and hostnames with [internal]
 * - Strips port numbers from connection errors
 * - Strips stack traces
 * - Strips internal file paths
 * - Truncates to 500 chars
 */
export function sanitizeErrorMessage(errorString: string): string {
  let sanitized = errorString;

  // Strip stack traces first (removes most of the noise)
  sanitized = sanitized.replace(STACK_TRACE_REGEX, '');

  // Replace internal IPs and hostnames
  sanitized = sanitized.replace(INTERNAL_IP_REGEX, '[internal]');
  sanitized = sanitized.replace(INTERNAL_HOSTNAME_REGEX, '[internal]');

  // Strip port numbers
  sanitized = sanitized.replace(PORT_REGEX, '');

  // Strip internal file paths
  sanitized = sanitized.replace(FILE_PATH_REGEX, '[path]');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Truncate
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.substring(0, MAX_MESSAGE_LENGTH - 3) + '...';
  }

  return sanitized;
}

/**
 * Map a CrawlErrorType to its i18n remediation key prefix.
 */
export function getRemediationKey(type: CrawlErrorType): string {
  return `search_ai.crawled_pages.remediation.${type}`;
}
