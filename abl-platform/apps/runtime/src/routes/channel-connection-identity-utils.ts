import type { ProviderVerificationStrength } from '../services/identity/provider-verification-policy.js';

export interface ChannelConnectionIdentityVerificationSettings {
  providerVerificationStrength: ProviderVerificationStrength;
}

interface IdentityVerificationConfigResolution {
  config?: Record<string, unknown>;
}

const VALID_PROVIDER_VERIFICATION_STRENGTHS: readonly ProviderVerificationStrength[] = [
  'weak',
  'strong',
];

function hasOwnProperty(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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

function resolveConfigProvidedStrength(
  config: unknown,
): { strength?: ProviderVerificationStrength } | { error: { code: string; message: string } } {
  if (!isRecord(config)) {
    return {};
  }

  if (hasOwnProperty(config, 'providerVerificationStrength')) {
    const topLevelStrength = parseProviderVerificationStrength(config.providerVerificationStrength);
    if (!topLevelStrength) {
      return {
        error: {
          code: 'INVALID_PROVIDER_VERIFICATION_STRENGTH',
          message:
            'providerVerificationStrength must be one of: ' +
            VALID_PROVIDER_VERIFICATION_STRENGTHS.join(', '),
        },
      };
    }

    return { strength: topLevelStrength };
  }

  if (!hasOwnProperty(config, 'identityVerification')) {
    return {};
  }

  const identityVerification = config.identityVerification;
  if (!isRecord(identityVerification)) {
    return {
      error: {
        code: 'INVALID_IDENTITY_VERIFICATION',
        message: 'config.identityVerification must be an object',
      },
    };
  }

  if (!hasOwnProperty(identityVerification, 'providerVerificationStrength')) {
    return {};
  }

  const nestedStrength = parseProviderVerificationStrength(
    identityVerification.providerVerificationStrength,
  );
  if (!nestedStrength) {
    return {
      error: {
        code: 'INVALID_PROVIDER_VERIFICATION_STRENGTH',
        message:
          'providerVerificationStrength must be one of: ' +
          VALID_PROVIDER_VERIFICATION_STRENGTHS.join(', '),
      },
    };
  }

  return { strength: nestedStrength };
}

export function parseChannelConnectionIdentityVerification(
  config: Record<string, unknown> | undefined,
): ChannelConnectionIdentityVerificationSettings {
  const topLevelStrength = parseProviderVerificationStrength(config?.providerVerificationStrength);
  const nestedIdentityVerification = config?.identityVerification;
  const nestedStrength = isRecord(nestedIdentityVerification)
    ? parseProviderVerificationStrength(nestedIdentityVerification.providerVerificationStrength)
    : undefined;

  return {
    providerVerificationStrength: topLevelStrength ?? nestedStrength ?? 'weak',
  };
}

export function normalizeChannelConnectionIdentityVerificationConfig(input: {
  body: Record<string, unknown>;
  config?: unknown;
  existingConfig?: Record<string, unknown>;
}): IdentityVerificationConfigResolution | { error: { code: string; message: string } } {
  if (input.config !== undefined && !isRecord(input.config)) {
    return {
      error: {
        code: 'INVALID_CONFIG',
        message: 'config must be an object',
      },
    };
  }

  if (hasOwnProperty(input.body, 'providerVerificationStrength')) {
    return {
      error: {
        code: 'INVALID_IDENTITY_VERIFICATION_FIELDS',
        message: 'Use identityVerification.providerVerificationStrength',
      },
    };
  }

  let requestedStrength: ProviderVerificationStrength | undefined;
  if (hasOwnProperty(input.body, 'identityVerification')) {
    const identityVerification = input.body.identityVerification;
    if (!isRecord(identityVerification)) {
      return {
        error: {
          code: 'INVALID_IDENTITY_VERIFICATION',
          message: 'identityVerification must be an object',
        },
      };
    }

    if (hasOwnProperty(identityVerification, 'providerVerificationStrength')) {
      requestedStrength = parseProviderVerificationStrength(
        identityVerification.providerVerificationStrength,
      );
      if (!requestedStrength) {
        return {
          error: {
            code: 'INVALID_PROVIDER_VERIFICATION_STRENGTH',
            message:
              'providerVerificationStrength must be one of: ' +
              VALID_PROVIDER_VERIFICATION_STRENGTHS.join(', '),
          },
        };
      }
    }
  }

  const configStrength = resolveConfigProvidedStrength(input.config);
  if ('error' in configStrength) {
    return configStrength;
  }

  if (
    requestedStrength &&
    configStrength.strength &&
    requestedStrength !== configStrength.strength
  ) {
    return {
      error: {
        code: 'CONFLICTING_IDENTITY_VERIFICATION',
        message:
          'Do not provide conflicting providerVerificationStrength values in identityVerification and config',
      },
    };
  }

  const normalizedStrength = requestedStrength ?? configStrength.strength;
  if (normalizedStrength === undefined) {
    return input.config ? { config: input.config } : {};
  }

  const baseConfig = isRecord(input.config)
    ? { ...input.config }
    : input.existingConfig
      ? { ...input.existingConfig }
      : {};
  delete baseConfig.providerVerificationStrength;

  const existingIdentityVerification = isRecord(baseConfig.identityVerification)
    ? { ...baseConfig.identityVerification }
    : {};

  baseConfig.identityVerification = {
    ...existingIdentityVerification,
    providerVerificationStrength: normalizedStrength,
  };

  return { config: baseConfig };
}
