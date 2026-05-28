const RUNTIME_OAUTH_CALLBACK_PATH_PREFIX = '/api/v1/oauth/callback';

export function buildRuntimeOAuthCallbackUri(baseUrl: string, provider: string): string {
  return `${baseUrl}${RUNTIME_OAUTH_CALLBACK_PATH_PREFIX}/${encodeURIComponent(provider)}`;
}

interface RuntimeOAuthBaseEnv {
  RUNTIME_PUBLIC_BASE_URL?: string;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * SDK/browser-facing OAuth callbacks must use an explicitly configured public Runtime URL.
 * We intentionally do not fall back to localhost or server.apiUrl here.
 */
export function resolveRuntimePublicOAuthBaseUrl(
  env: RuntimeOAuthBaseEnv = process.env,
): string | null {
  return normalizeBaseUrl(env.RUNTIME_PUBLIC_BASE_URL);
}
