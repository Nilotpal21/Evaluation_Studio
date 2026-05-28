import { describe, expect, it } from 'vitest';
import { resolveProviderVerification } from '../../services/identity/provider-verification-policy.js';

describe('resolveProviderVerification', () => {
  it('defaults provider-verified identities to weak tier 1', () => {
    const result = resolveProviderVerification({ providerVerified: true });

    expect(result).toEqual({
      providerVerified: true,
      strength: 'weak',
      identityTier: 1,
    });
  });

  it('uses connection identityVerification.providerVerificationStrength when configured', () => {
    const result = resolveProviderVerification({
      providerVerified: true,
      connectionConfig: {
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });

    expect(result).toEqual({
      providerVerified: true,
      strength: 'strong',
      identityTier: 2,
    });
  });

  it('prefers connection config over metadata fallback', () => {
    const result = resolveProviderVerification({
      providerVerified: true,
      connectionConfig: { providerVerificationStrength: 'weak' },
      metadata: { providerVerificationStrength: 'strong' },
    });

    expect(result).toEqual({
      providerVerified: true,
      strength: 'weak',
      identityTier: 1,
    });
  });

  it('uses metadata fallback when no trusted config override is provided', () => {
    const result = resolveProviderVerification({
      providerVerified: true,
      metadata: { providerVerificationStrength: 'strong' },
    });

    expect(result).toEqual({
      providerVerified: true,
      strength: 'strong',
      identityTier: 2,
    });
  });

  it('ignores strong policy when the provider has not verified the artifact', () => {
    const result = resolveProviderVerification({
      providerVerified: false,
      connectionConfig: { providerVerificationStrength: 'strong' },
      metadata: { providerVerificationStrength: 'strong' },
    });

    expect(result).toEqual({
      providerVerified: false,
      strength: 'weak',
      identityTier: 0,
    });
  });
});
