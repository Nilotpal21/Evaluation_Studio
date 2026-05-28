/**
 * MS Teams Bot Framework Auth Helpers
 *
 * Provides OAuth2 client-credentials token acquisition for Bot Framework APIs.
 * Tokens are cached per tenant + app to avoid cross-tenant credential collisions.
 */

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, TokenCacheEntry>();
const CACHE_SKEW_MS = 60_000;
const MAX_CACHE_SIZE = 500;

function cacheKey(tenantId: string, appId: string): string {
  return `${tenantId}:${appId}`;
}

export function clearBotFrameworkTokenCache(): void {
  TOKEN_CACHE.clear();
}

export async function getBotFrameworkToken(
  appId: string,
  clientSecret: string,
  tenantId: string,
): Promise<string> {
  const key = cacheKey(tenantId, appId);
  const cached = TOKEN_CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt - CACHE_SKEW_MS) {
    return cached.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: clientSecret,
      scope: 'https://api.botframework.com/.default',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to get Bot Framework token: ${resp.status}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  // Evict expired entries and enforce max cache size
  if (TOKEN_CACHE.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of TOKEN_CACHE) {
      if (now >= v.expiresAt) TOKEN_CACHE.delete(k);
    }
    // If still over limit after purging expired, delete oldest entries
    if (TOKEN_CACHE.size >= MAX_CACHE_SIZE) {
      const excess = TOKEN_CACHE.size - MAX_CACHE_SIZE + 1;
      const keys = TOKEN_CACHE.keys();
      for (let i = 0; i < excess; i++) {
        const oldest = keys.next().value;
        if (oldest) TOKEN_CACHE.delete(oldest);
      }
    }
  }

  TOKEN_CACHE.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
