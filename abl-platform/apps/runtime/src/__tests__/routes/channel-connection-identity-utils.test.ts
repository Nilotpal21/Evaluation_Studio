import { describe, expect, it } from 'vitest';
import {
  normalizeChannelConnectionIdentityVerificationConfig,
  parseChannelConnectionIdentityVerification,
} from '../../routes/channel-connection-identity-utils.js';

describe('channel connection identity verification utils', () => {
  it('parses weak as the default provider verification strength', () => {
    expect(parseChannelConnectionIdentityVerification(undefined)).toEqual({
      providerVerificationStrength: 'weak',
    });
  });

  it('parses nested config identity verification strength', () => {
    expect(
      parseChannelConnectionIdentityVerification({
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      }),
    ).toEqual({
      providerVerificationStrength: 'strong',
    });
  });

  it('normalizes explicit identityVerification into config.identityVerification', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
      config: {
        provider: 'meta',
      },
    });

    expect(result).toEqual({
      config: {
        provider: 'meta',
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });
  });

  it('merges explicit identityVerification into existing config on patch when no config payload is provided', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
      existingConfig: {
        provider: 'meta',
      },
    });

    expect(result).toEqual({
      config: {
        provider: 'meta',
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });
  });

  it('normalizes legacy config.providerVerificationStrength into the canonical nested shape', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {},
      config: {
        providerVerificationStrength: 'strong',
        provider: 'meta',
      },
    });

    expect(result).toEqual({
      config: {
        provider: 'meta',
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });
  });

  it('rejects invalid provider verification strengths', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {
        identityVerification: {
          providerVerificationStrength: 'trusted',
        },
      },
    });

    expect(result).toEqual({
      error: {
        code: 'INVALID_PROVIDER_VERIFICATION_STRENGTH',
        message: 'providerVerificationStrength must be one of: weak, strong',
      },
    });
  });

  it('rejects non-object config payloads', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {},
      config: 'not-an-object',
    });

    expect(result).toEqual({
      error: {
        code: 'INVALID_CONFIG',
        message: 'config must be an object',
      },
    });
  });

  it('rejects conflicting explicit and legacy provider verification strengths', () => {
    const result = normalizeChannelConnectionIdentityVerificationConfig({
      body: {
        identityVerification: {
          providerVerificationStrength: 'weak',
        },
      },
      config: {
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });

    expect(result).toEqual({
      error: {
        code: 'CONFLICTING_IDENTITY_VERIFICATION',
        message:
          'Do not provide conflicting providerVerificationStrength values in identityVerification and config',
      },
    });
  });
});
