import type { KMSProviderType, KMSProviderAuthMethod } from '../../hooks/useKMS';

/**
 * Human-readable provider display names.
 * "local" maps to "Platform Managed" — not developer jargon.
 */
export function humanizeProvider(providerType: KMSProviderType | string | undefined): string {
  switch (providerType) {
    case 'aws-kms':
      return 'AWS KMS';
    case 'azure-keyvault':
      return 'Azure Key Vault';
    case 'azure-managed-hsm':
      return 'Azure Managed HSM';
    case 'gcp-cloud-kms':
      return 'Google Cloud KMS';
    case 'external':
      return 'External KMS';
    case 'local':
      return 'Platform Managed';
    default:
      return providerType || '--';
  }
}

export function providerVariant(providerType: string | undefined): 'default' | 'accent' | 'info' {
  switch (providerType) {
    case 'local':
      return 'default';
    case 'external':
      return 'info';
    default:
      return 'accent';
  }
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '--';
  }
  return new Date(value).toLocaleString();
}

export function getSupportedAuthMethods(providerType: string): KMSProviderAuthMethod[] {
  switch (providerType) {
    case 'aws-kms':
      return ['default-credentials', 'service-account', 'api-key'];
    case 'azure-keyvault':
    case 'azure-managed-hsm':
      return ['default-credentials', 'managed-identity', 'service-account'];
    case 'gcp-cloud-kms':
      return ['default-credentials', 'service-account'];
    case 'external':
      return ['api-key', 'mtls', 'oauth2', 'hmac-sha256'];
    default:
      return [];
  }
}

export function parseAuthConfig(raw: string): {
  parsed: Record<string, unknown> | null;
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { parsed: null, error: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { parsed: null, error: 'Auth config must be a JSON object' };
    }
    return { parsed, error: null };
  } catch {
    return { parsed: null, error: 'Invalid JSON' };
  }
}

/** Format large numbers compactly: 1073741824 → "1B", 1000000 → "1M". */
export function compactNumber(n: number): string {
  if (n >= 1_000_000_000) {
    const v = n / 1_000_000_000;
    return Number.isInteger(v) ? `${v}B` : `${v.toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return Number.isInteger(v) ? `${v}K` : `${v.toFixed(1)}K`;
  }
  return String(n);
}
