/**
 * SWR Configuration
 *
 * Shared fetcher and global config for SWR data fetching.
 * Uses apiFetch (auth headers + 401 retry) as the transport layer.
 */

import type { SWRConfiguration } from 'swr';
import { apiFetch } from './api-client';
import { sanitizeServerError } from './sanitize-error';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

/**
 * SWR fetcher that uses apiFetch (injects auth headers, retries on 401).
 * Throws on non-2xx responses so SWR treats them as errors.
 */
export async function swrFetcher<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  // Parse body safely — upstream may return non-JSON on errors
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON body — fail with a user-friendly message rather than
    // exposing the parse failure detail. Audit reference: Theme 14.
    if (!response.ok) {
      throw new AppError("Couldn't load data. Try again in a moment.", {
        ...ErrorCodes.INTERNAL_ERROR,
      });
    }
    throw new AppError("Couldn't load data. Try again in a moment.", {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }
  if (!response.ok) {
    // Support both { error: string | { message, code } } and { errors: [{ msg, code }] } formats
    const rawError = body.error;
    const errorsArray = Array.isArray(body.errors) ? body.errors : [];
    const errorMessage =
      errorsArray[0]?.msg ??
      (typeof rawError === 'string' ? rawError : (rawError?.message ?? 'Request failed'));
    // Preserve the server-supplied error code when present so callers can
    // branch on structured codes (e.g. CONNECTION_NOT_FOUND) without parsing
    // free-form messages.
    const serverCode: string | undefined =
      (typeof rawError === 'object' && rawError && typeof rawError.code === 'string'
        ? rawError.code
        : undefined) ?? errorsArray[0]?.code;
    throw new AppError(
      sanitizeServerError(errorMessage, "Couldn't load data. Try again in a moment."),
      {
        code: serverCode ?? ErrorCodes.INTERNAL_ERROR.code,
        statusCode: response.status,
      },
    );
  }
  return body;
}

/**
 * Global SWR defaults.
 * Components can override per-hook (e.g. refreshInterval for polling).
 */
export const swrConfig: SWRConfiguration = {
  fetcher: swrFetcher,
  dedupingInterval: 5000, // Dedup identical requests within 5s
  revalidateOnFocus: true, // Revalidate when tab gains focus
  errorRetryCount: 2, // Retry failed requests twice
  shouldRetryOnError: true,
  revalidateOnReconnect: true, // Revalidate on network reconnect
};
