/**
 * Fetch Utilities
 */

/** Error codes for classified fetch errors */
export type FetchErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION_REFUSED'
  | 'DNS_LOOKUP_FAILED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

/**
 * A fetch error with a classified error code and the URL that was requested.
 */
export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly url: string;

  constructor(message: string, code: FetchErrorCode, url: string, cause?: unknown) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.url = url;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Classify a raw fetch error into a FetchError with a machine-readable code.
 */
export function classifyFetchError(error: unknown, url: string): FetchError {
  if (error instanceof FetchError) return error;

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new FetchError(`Request timed out: ${url}`, 'TIMEOUT', url, error);
  }

  if (error instanceof TypeError) {
    // Node's fetch wraps system errors as TypeError with a cause
    const cause = (error as { cause?: { code?: string } }).cause;
    const causeCode = cause?.code;

    if (causeCode === 'ECONNREFUSED') {
      return new FetchError(`Connection refused: ${url}`, 'CONNECTION_REFUSED', url, error);
    }
    if (causeCode === 'ENOTFOUND') {
      return new FetchError(`DNS lookup failed: ${url}`, 'DNS_LOOKUP_FAILED', url, error);
    }

    // Also check the message for these codes (some environments embed them differently)
    const msg = error.message;
    if (msg.includes('ECONNREFUSED')) {
      return new FetchError(`Connection refused: ${url}`, 'CONNECTION_REFUSED', url, error);
    }
    if (msg.includes('ENOTFOUND')) {
      return new FetchError(`DNS lookup failed: ${url}`, 'DNS_LOOKUP_FAILED', url, error);
    }

    return new FetchError(`Network error: ${url} — ${msg}`, 'NETWORK_ERROR', url, error);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new FetchError(`Fetch failed: ${url} — ${message}`, 'UNKNOWN', url, error);
}

/**
 * Fetch with an automatic AbortController timeout.
 * Cleans up the timer on success or failure.
 * Throws FetchError with classified error code on failure.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw classifyFetchError(error, url);
  } finally {
    clearTimeout(timer);
  }
}
