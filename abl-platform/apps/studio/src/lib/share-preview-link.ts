const SHARE_TOKEN_HASH_KEY = 'share_token';
const SHARE_TOKEN_SESSION_STORAGE_KEY = 'sdk_share_preview_token';

export type ShareTokenSource = 'hash' | 'sessionStorage' | 'none';

function readHashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
}

export function buildSharePreviewUrl(
  baseUrl: string,
  token: string,
  pathname = '/preview',
): string {
  const url = new URL(pathname, baseUrl);
  const hashParams = readHashParams(url);
  hashParams.set(SHARE_TOKEN_HASH_KEY, token);
  url.hash = hashParams.toString();
  return url.toString();
}

export function extractShareTokenFromUrl(url: URL): {
  token: string | null;
  source: ShareTokenSource;
} {
  const hashParams = readHashParams(url);
  const hashToken = hashParams.get(SHARE_TOKEN_HASH_KEY)?.trim();
  if (hashToken) {
    return { token: hashToken, source: 'hash' };
  }

  return { token: null, source: 'none' };
}

export function stripShareTokenFromUrl(url: URL): string {
  const hashParams = readHashParams(url);
  hashParams.delete(SHARE_TOKEN_HASH_KEY);
  const nextHash = hashParams.toString();
  url.hash = nextHash ? nextHash : '';

  return url.toString();
}

export function consumeShareTokenFromBrowserLocation(): {
  token: string | null;
  source: ShareTokenSource;
} {
  if (typeof window === 'undefined') {
    return { token: null, source: 'none' };
  }

  const currentUrl = new URL(window.location.href);
  const extracted = extractShareTokenFromUrl(currentUrl);

  if (extracted.token) {
    try {
      window.sessionStorage.setItem(SHARE_TOKEN_SESSION_STORAGE_KEY, extracted.token);
    } catch {
      // Ignore sessionStorage failures and fall back to the in-memory return value.
    }

    const scrubbedUrl = stripShareTokenFromUrl(new URL(window.location.href));
    window.history.replaceState(window.history.state ?? null, '', scrubbedUrl);
    return extracted;
  }

  try {
    const storedToken = window.sessionStorage.getItem(SHARE_TOKEN_SESSION_STORAGE_KEY)?.trim();
    if (storedToken) {
      return { token: storedToken, source: 'sessionStorage' };
    }
  } catch {
    // Ignore sessionStorage access failures and return no token.
  }

  return { token: null, source: 'none' };
}

export function clearPersistedShareTokenFromBrowserSession(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.removeItem(SHARE_TOKEN_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures during best-effort scrubbing.
  }
}
