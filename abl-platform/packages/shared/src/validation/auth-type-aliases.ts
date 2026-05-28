/**
 * Legacy inline-tool auth aliases kept for backward-compatible reads.
 *
 * Sunset note:
 * - Alias writes are supported only for staged rollout compatibility.
 * - Canonical names are the forward contract.
 */
export const AUTH_TYPE_ALIASES = {
  oauth2_client: 'oauth2_client_credentials',
  oauth2_user: 'oauth2_token',
  custom: 'custom_header',
} as const;

export type AuthTypeAlias = keyof typeof AUTH_TYPE_ALIASES;

export function normalizeAuthType(input: string): string {
  const normalized = input.trim();
  return AUTH_TYPE_ALIASES[normalized as AuthTypeAlias] ?? normalized;
}
