/**
 * SSRF Protection Utility
 *
 * Validates and fetches URLs with protection against Server-Side Request Forgery attacks.
 * Delegates URL validation, DNS resolution, DNS pinning, and redirect
 * validation to @agent-platform/shared-kernel, adding SearchAI-specific
 * response size and timeout limits.
 */

import { ValidationError } from '@agent-platform/shared-kernel';
import {
  assertUrlSafeForFetch,
  safeFetch,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('ssrf-protection');

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT = 10_000; // 10 seconds
const USER_AGENT = 'ABL-Platform-Scraper/1.0';

/** Convert unknown error to loggable Record */
function errorToData(error: unknown): Record<string, unknown> {
  return { error: error instanceof Error ? error.message : String(error) };
}

function toValidationError(error: unknown): ValidationError {
  if (error instanceof ValidationError) {
    return error;
  }
  return new ValidationError(error instanceof Error ? error.message : String(error));
}

/**
 * Validates and fetches content from a URL with SSRF protection.
 *
 * Uses the shared validateUrlForSSRF for protocol/IP checks, plus DNS
 * resolution for hostname-based URLs. Enforces size and timeout limits.
 *
 * @param url - URL to fetch
 * @returns Text content from the URL
 * @throws ValidationError if URL is blocked by SSRF protection or fetch fails
 */
export async function validateAndFetchURL(url: string): Promise<string> {
  try {
    const response = await safeFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!response.ok) {
      throw new ValidationError(
        `Failed to fetch URL: ${url}. HTTP ${response.status} ${response.statusText}`,
      );
    }

    // Check content length header
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new ValidationError(
        `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_SIZE} bytes)`,
      );
    }

    // Stream response with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ValidationError('Failed to read response body');
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        reader.cancel();
        throw new ValidationError(
          `Response exceeds size limit: ${totalSize} bytes (max ${MAX_RESPONSE_SIZE} bytes)`,
        );
      }

      chunks.push(value);
    }

    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(Buffer.concat(chunks));

    logger.info(`Successfully fetched URL: ${url} (${totalSize} bytes)`);
    return text;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new ValidationError(
        `Request timeout: URL took longer than ${FETCH_TIMEOUT}ms to respond`,
      );
    }

    logger.error(`Failed to fetch URL: ${url}`, errorToData(error));
    throw toValidationError(error);
  }
}

/**
 * Tests if a URL would be blocked by SSRF protection (without fetching).
 *
 * Uses the shared validateUrlForSSRF for protocol/IP checks, plus DNS
 * resolution for hostname-based URLs.
 *
 * @param url - URL to test
 * @returns Object with `allowed` boolean and optional `reason` string
 */
export async function isURLAllowed(url: string): Promise<{ allowed: boolean; reason?: string }> {
  try {
    await assertUrlSafeForFetch(url);
    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
