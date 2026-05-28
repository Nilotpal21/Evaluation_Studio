/**
 * Centralized fetch helpers for Studio client-side API calls.
 *
 * Injects Authorization and X-Tenant-Id headers from the auth store.
 * Automatically retries once on 401 after refreshing the token.
 */

import { useAuthStore } from '@/store/auth-store';
import { sanitizeServerError } from './sanitize-error';
import { refreshAccessToken, scheduleTokenRefresh } from '../api/auth';
import { AppError } from '@agent-platform/shared/errors';

/**
 * Direct SearchAI service URLs for local development.
 *
 * Local dev: env vars point to localhost services (absolute URLs, cross-origin).
 * Production: env vars are empty — rewrite produces relative URLs and the
 * NGINX ingress routes /api/indexes, /api/search, etc. to backend services.
 */
const SEARCH_AI_URL = process.env.NEXT_PUBLIC_SEARCH_AI_URL ?? '';
const SEARCH_AI_RUNTIME_URL = process.env.NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL ?? '';

let refreshPromise: Promise<boolean> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeErrorEntries(errors: unknown): Array<{ msg: string; code?: string }> {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors
    .map((entry) => {
      if (typeof entry === 'string') {
        return { msg: entry };
      }
      if (!isRecord(entry)) {
        return null;
      }

      const message =
        typeof entry.msg === 'string'
          ? entry.msg
          : typeof entry.message === 'string'
            ? entry.message
            : undefined;
      if (!message) {
        return null;
      }

      return {
        msg: message,
        ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
      };
    })
    .filter((entry): entry is { msg: string; code?: string } => entry !== null);
}

export function authHeaders(): HeadersInit {
  const { accessToken, tenantId } = useAuthStore.getState();
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return headers;
}

/**
 * Try to refresh the access token. Deduplicates concurrent refresh attempts.
 * Returns true if refresh succeeded.
 */
async function tryRefreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { setTokens } = useAuthStore.getState();

    try {
      const tokens = await refreshAccessToken();
      setTokens(tokens.accessToken);
      scheduleTokenRefresh(tokens.expiresIn);
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * Rewrite Studio proxy paths for SearchAI service routing.
 *
 * Production (env var empty): keeps the /api/search-ai/ prefix as a relative URL.
 *   The NGINX ingress matches the service prefix and rewrites it to /api/ before
 *   forwarding to the backend service. This gives each service a unique URL
 *   namespace — no path conflicts, one ingress rule per service.
 *
 * Local dev (env var set): strips the prefix and builds an absolute URL pointing
 *   directly at the backend service (which still serves routes under /api/).
 *
 * Fallback: stray direct fetch() calls that bypass apiFetch still work via
 *   Studio's /api/search-ai/* Next.js proxy routes (Studio catch-all in ingress).
 */
function rewriteSearchAiPath(path: string): { url: string; isDirect: boolean } {
  if (path.startsWith('/api/search-ai/')) {
    if (SEARCH_AI_URL) {
      // Local dev: strip service prefix — backend serves /api/* natively
      const servicePath = `/api/${path.slice('/api/search-ai/'.length)}`;
      return { url: `${SEARCH_AI_URL}${servicePath}`, isDirect: true };
    }
    // Production: keep prefix — NGINX ingress rewrites /api/search-ai/* → /api/*
    return { url: path, isDirect: false };
  }
  if (path.startsWith('/api/search-ai-runtime/')) {
    if (SEARCH_AI_RUNTIME_URL) {
      // Local dev: strip service prefix — backend serves /api/* natively
      const servicePath = `/api/${path.slice('/api/search-ai-runtime/'.length)}`;
      return { url: `${SEARCH_AI_RUNTIME_URL}${servicePath}`, isDirect: true };
    }
    // Production: keep prefix — NGINX ingress rewrites /api/search-ai-runtime/* → /api/*
    return { url: path, isDirect: false };
  }
  return { url: path, isDirect: false };
}

/**
 * Fetch with auth headers. Automatically retries once on 401 after refreshing the token.
 * When NEXT_PUBLIC_SEARCH_AI_URL / NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL are set,
 * SearchAI requests bypass the Studio proxy and go directly to the service.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { url, isDirect } = rewriteSearchAiPath(path);
  const credentials: RequestCredentials = isDirect ? 'include' : 'same-origin';

  const response = await fetch(url, {
    ...init,
    credentials,
    headers: { ...authHeaders(), ...init?.headers },
  });

  if (response.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return fetch(url, {
        ...init,
        credentials,
        headers: { ...authHeaders(), ...init?.headers },
      });
    }
  }

  // 403 with tenant context issues — a token refresh may resolve it
  // (e.g. user just completed onboarding and the JWT lacks tenantId)
  if (response.status === 403) {
    const cloned = response.clone();
    try {
      const body = await cloned.json();
      const message = body?.error?.message || body?.error || '';
      const isTenantIssue =
        typeof message === 'string' &&
        (message.includes('Tenant context') || message.includes('No tenant context'));
      if (isTenantIssue) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
          return fetch(url, {
            ...init,
            credentials,
            headers: { ...authHeaders(), ...init?.headers },
          });
        }
      }
    } catch {
      // Can't parse body — return original response
    }
  }

  return response;
}

/**
 * Parse a fetch Response, throwing a sanitized error on non-2xx status.
 */
export async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ errors: [{ msg: 'Request failed', code: 'INTERNAL_ERROR' }] }));

    // Parse errors arrays from both Studio envelopes and runtime compile failures.
    const errors = normalizeErrorEntries(body.errors);
    const firstError = errors[0];

    // Support both { errors: [{ msg, code }] } and { error: { code, message } } formats
    const nestedError = body.error && typeof body.error === 'object' ? body.error : undefined;
    const errorMessage =
      firstError?.msg ??
      nestedError?.message ??
      (typeof body.error === 'string' ? body.error : undefined) ??
      'Request failed';
    const errorCode =
      firstError?.code ?? nestedError?.code ?? body.code ?? `HTTP_${response.status}`;
    const messages = errors.length > 1 ? errors.map((e) => e.msg) : undefined;
    const cause =
      isRecord(body) && (Array.isArray(body.issues) || nestedError || Array.isArray(body.errors))
        ? {
            ...(nestedError
              ? {
                  error: {
                    code: nestedError?.code,
                    message: sanitizeServerError(nestedError?.message, 'Request failed'),
                  },
                }
              : {}),
            ...(Array.isArray(body.issues) ? { issues: body.issues } : {}),
            ...(Array.isArray(body.errors) ? { errors: body.errors } : {}),
          }
        : undefined;

    throw new AppError(sanitizeServerError(errorMessage, 'Request failed'), {
      code: errorCode,
      statusCode: response.status,
      cause,
      messages,
    });
  }
  return response.json();
}
