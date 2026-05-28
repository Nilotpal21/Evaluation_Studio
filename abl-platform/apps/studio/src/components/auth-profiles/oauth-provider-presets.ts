/**
 * OAuth Provider Presets
 *
 * Detects well-known OAuth providers from the authorization URL and
 * suggests provider-specific defaults — primarily so that users creating
 * a Google OAuth 2.0 App profile automatically get `access_type=offline`
 * and `prompt=consent`, which Google requires to issue a refresh token.
 *
 * Why this matters: without `access_type=offline`, Google issues only a
 * short-lived access token and no refresh token. The runtime cannot
 * silently renew expired tokens, and every workflow run after expiry
 * fails with `AUTH_PROFILE_TOKEN_REQUIRED` until the admin manually
 * re-authorizes the profile. Auto-filling on detection eliminates this
 * footgun for the most common provider.
 *
 * Microsoft uses scope-based offline access (`offline_access` scope) and
 * therefore does not need extra `authorizationParams` — only a hint.
 *
 * GitHub and Slack issue refresh tokens by default (when configured for
 * refresh on the app side), so detection is informational only.
 */

export type OAuthProviderId = 'google' | 'microsoft' | 'github' | 'slack';

export interface OAuthProviderPreset {
  id: OAuthProviderId;
  label: string;
  /** Returns true when the supplied authorization URL matches this provider. */
  matches: (authorizationUrl: string) => boolean;
  /**
   * Authorization-URL params that should be auto-filled when this provider
   * is detected. Undefined means no auto-fill (provider is informational only).
   */
  authorizationParams?: Record<string, string>;
  /**
   * Optional human-readable note rendered alongside the detection badge.
   * Used to point users at scope-based offline access (Microsoft) or to
   * confirm what the auto-fill enables (Google).
   */
  detectionNote: string;
}

export const OAUTH_PROVIDER_PRESETS: readonly OAuthProviderPreset[] = [
  {
    id: 'google',
    label: 'Google',
    matches: (url) => /^https:\/\/accounts\.google\.com\//i.test(url.trim()),
    authorizationParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
    detectionNote:
      'Auto-filled access_type=offline and prompt=consent so Google issues a refresh token (required for silent token renewal).',
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    matches: (url) =>
      /^https:\/\/login\.microsoftonline\.com\//i.test(url.trim()) ||
      /^https:\/\/login\.live\.com\//i.test(url.trim()),
    detectionNote:
      'Microsoft uses scope-based offline access — add "offline_access" to the Scopes field above to receive a refresh token.',
  },
  {
    id: 'github',
    label: 'GitHub',
    matches: (url) => /^https:\/\/github\.com\/login\/oauth\/authorize/i.test(url.trim()),
    detectionNote:
      'GitHub apps issue refresh tokens automatically when "Token expiration" is enabled in the GitHub OAuth app settings.',
  },
  {
    id: 'slack',
    label: 'Slack',
    matches: (url) => /^https:\/\/slack\.com\/oauth\/(v2\/)?authorize/i.test(url.trim()),
    detectionNote:
      'Slack issues rotating refresh tokens automatically when token rotation is enabled on the app.',
  },
] as const;

/**
 * Detect a known OAuth provider from the authorization URL. Returns null if
 * the URL is empty, malformed, or does not match any known provider.
 */
export function detectOAuthProvider(
  authorizationUrl: string | undefined | null,
): OAuthProviderPreset | null {
  if (typeof authorizationUrl !== 'string') return null;
  const trimmed = authorizationUrl.trim();
  if (trimmed.length === 0) return null;
  for (const preset of OAUTH_PROVIDER_PRESETS) {
    if (preset.matches(trimmed)) return preset;
  }
  return null;
}
