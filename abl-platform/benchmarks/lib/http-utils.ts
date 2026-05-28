/**
 * HTTP request wrapper with automatic retry on 429 (rate limit) responses.
 *
 * Uses exponential backoff with jitter to spread retry attempts.
 * Respects Retry-After header when present.
 */
import http, { type RefinedResponse, type ResponseType } from 'k6/http';
import { sleep } from 'k6';

/** Default configuration for rate-limit-aware HTTP requests */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;

interface RequestOptions {
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  timeout?: string;
}

interface RetryOptions {
  /** Max retry attempts on 429 (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 10000) */
  maxDelayMs?: number;
}

/**
 * Calculate backoff delay with jitter.
 * Uses decorrelated jitter: delay = min(cap, random(base, previous * 3))
 */
function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    // Respect server's Retry-After, but cap it
    return Math.min(retryAfterMs, capMs);
  }
  // Exponential backoff with full jitter
  const expDelay = baseMs * Math.pow(2, attempt);
  const jittered = Math.random() * Math.min(expDelay, capMs);
  return Math.max(baseMs, jittered);
}

/**
 * Extract retry-after value from response headers (in milliseconds).
 */
function getRetryAfterMs(res: RefinedResponse<ResponseType>): number | undefined {
  const retryAfter = res.headers['Retry-After'] || res.headers['retry-after'];
  if (!retryAfter) {
    // Also check X-RateLimit-Reset (unix epoch seconds)
    const resetEpoch = res.headers['X-RateLimit-Reset'] || res.headers['x-ratelimit-reset'];
    if (resetEpoch) {
      const resetMs = parseInt(resetEpoch, 10) * 1000 - Date.now();
      return resetMs > 0 ? resetMs : undefined;
    }
    return undefined;
  }
  // Retry-After can be seconds (integer) or HTTP-date
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  return undefined;
}

/**
 * Make a POST request with automatic 429 retry.
 */
export function postWithBackoff(
  url: string,
  body: string | null,
  options?: RequestOptions,
  retryOpts?: RetryOptions,
): RefinedResponse<ResponseType> {
  return requestWithBackoff('POST', url, body, options, retryOpts);
}

/**
 * Make a GET request with automatic 429 retry.
 */
export function getWithBackoff(
  url: string,
  options?: RequestOptions,
  retryOpts?: RetryOptions,
): RefinedResponse<ResponseType> {
  return requestWithBackoff('GET', url, null, options, retryOpts);
}

/**
 * Generic HTTP request with 429 backoff retry.
 */
export function requestWithBackoff(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: string | null,
  options?: RequestOptions,
  retryOpts?: RetryOptions,
): RefinedResponse<ResponseType> {
  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = retryOpts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = retryOpts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastRes: RefinedResponse<ResponseType>;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    switch (method) {
      case 'GET':
        lastRes = http.get(
          url,
          options ? { headers: options.headers, tags: options.tags } : undefined,
        );
        break;
      case 'POST':
        lastRes = http.post(url, body, options);
        break;
      case 'PUT':
        lastRes = http.put(url, body, options);
        break;
      case 'DELETE':
        lastRes = http.del(url, body, options);
        break;
    }

    // Not rate limited — return immediately
    if (lastRes!.status !== 429) {
      return lastRes!;
    }

    // Rate limited — backoff and retry (unless last attempt)
    if (attempt < maxRetries) {
      const retryAfterMs = getRetryAfterMs(lastRes!);
      const delayMs = backoffDelay(attempt, baseDelay, maxDelay, retryAfterMs);
      sleep(delayMs / 1000);
    }
  }

  // All retries exhausted — return the last 429 response
  return lastRes!;
}
