import type { IdentityTier } from '@agent-platform/shared-auth';

export type ProviderVerificationStrength = 'weak' | 'strong';

export interface ResolveProviderVerificationInput {
  providerVerified: boolean;
  connectionConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  configuredStrength?: ProviderVerificationStrength;
}

export interface ProviderVerificationResolution {
  providerVerified: boolean;
  strength: ProviderVerificationStrength;
  identityTier: IdentityTier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProviderVerificationStrength(
  value: unknown,
): ProviderVerificationStrength | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'weak' || normalized === 'strong') {
    return normalized;
  }

  return undefined;
}

function readStrengthFromConnectionConfig(
  config: Record<string, unknown> | undefined,
): ProviderVerificationStrength | undefined {
  if (!config) {
    return undefined;
  }

  const topLevelStrength = parseProviderVerificationStrength(config.providerVerificationStrength);
  if (topLevelStrength) {
    return topLevelStrength;
  }

  const identityVerification = config.identityVerification;
  if (!isRecord(identityVerification)) {
    return undefined;
  }

  return parseProviderVerificationStrength(identityVerification.providerVerificationStrength);
}

function readStrengthFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ProviderVerificationStrength | undefined {
  if (!metadata) {
    return undefined;
  }

  return parseProviderVerificationStrength(metadata.providerVerificationStrength);
}

export function resolveProviderVerification(
  input: ResolveProviderVerificationInput,
): ProviderVerificationResolution {
  if (!input.providerVerified) {
    return {
      providerVerified: false,
      strength: 'weak',
      identityTier: 0,
    };
  }

  const strength =
    input.configuredStrength ??
    readStrengthFromConnectionConfig(input.connectionConfig) ??
    readStrengthFromMetadata(input.metadata) ??
    'weak';

  return {
    providerVerified: true,
    strength,
    identityTier: strength === 'strong' ? 2 : 1,
  };
}
