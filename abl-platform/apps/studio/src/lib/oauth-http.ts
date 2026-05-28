/**
 * Minimal HTTPS helper for OAuth token exchange and profile fetches.
 *
 * Uses shared-kernel safeFetch instead of the global `fetch` so OAuth provider
 * calls get DNS-pinning SSRF protection and manually validated redirects.
 */

import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import { OAUTH_HTTP_TIMEOUT_MS } from '@/lib/auth-constants';

interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

export function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  assertHttpsUrl(url);
  return requestOAuthUrl(url, {
    method: 'POST',
    headers: {
      'Content-Length': String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  });
}

export function httpsGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  assertHttpsUrl(url);
  return requestOAuthUrl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  });
}

async function requestOAuthUrl(url: string, init: RequestInit): Promise<HttpResponse> {
  const response = await safeFetch(url, init);
  return {
    status: response.status,
    ok: response.ok,
    body: await response.text(),
  };
}

function assertHttpsUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('OAuth URL must use HTTPS');
  }
}
