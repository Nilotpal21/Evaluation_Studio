import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { KMSHealthStatus, KMSProvider } from './types.js';

export interface KMSReadinessStatus extends KMSHealthStatus {
  cryptoVerified: boolean;
  cryptoProbeLatencyMs: number | null;
  checkedKeyId: string;
  healthLatencyMs: number;
}

/**
 * Validate both provider connectivity and the actual wrap/unwrap crypto path.
 * Health checks that only read key metadata are not enough for migration safety.
 */
export async function verifyProviderReadiness(
  provider: KMSProvider,
  keyId: string,
): Promise<KMSReadinessStatus> {
  const startedAt = Date.now();
  const health = await provider.healthCheck();

  if (!health.healthy) {
    return {
      healthy: false,
      providerType: provider.providerType,
      latencyMs: Date.now() - startedAt,
      message: health.message,
      cryptoVerified: false,
      cryptoProbeLatencyMs: null,
      checkedKeyId: keyId,
      healthLatencyMs: health.latencyMs,
    };
  }

  const probeStartedAt = Date.now();
  const plaintext = randomBytes(32);
  let unwrapped: Buffer | null = null;

  try {
    const wrapped = await provider.wrapKey(keyId, plaintext);
    unwrapped = await provider.unwrapKey(
      keyId,
      wrapped.ciphertext,
      wrapped.keyVersion,
      wrapped.keyVersionId,
    );

    const matches = unwrapped.length === plaintext.length && timingSafeEqual(unwrapped, plaintext);

    if (!matches) {
      return {
        healthy: false,
        providerType: provider.providerType,
        latencyMs: Date.now() - startedAt,
        message: 'Provider crypto probe failed: wrapped key material did not round-trip cleanly',
        cryptoVerified: false,
        cryptoProbeLatencyMs: Date.now() - probeStartedAt,
        checkedKeyId: keyId,
        healthLatencyMs: health.latencyMs,
      };
    }

    return {
      healthy: true,
      providerType: provider.providerType,
      latencyMs: Date.now() - startedAt,
      message: health.message,
      cryptoVerified: true,
      cryptoProbeLatencyMs: Date.now() - probeStartedAt,
      checkedKeyId: keyId,
      healthLatencyMs: health.latencyMs,
    };
  } catch (err) {
    return {
      healthy: false,
      providerType: provider.providerType,
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : String(err),
      cryptoVerified: false,
      cryptoProbeLatencyMs: Date.now() - probeStartedAt,
      checkedKeyId: keyId,
      healthLatencyMs: health.latencyMs,
    };
  } finally {
    plaintext.fill(0);
    unwrapped?.fill(0);
  }
}
