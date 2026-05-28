/**
 * External KMS Endpoint Validator
 *
 * Validates an external KMS endpoint before saving its configuration.
 * Checks:
 *   1. HTTPS enforcement
 *   2. Health endpoint reachable
 *   3. Round-trip wrap/unwrap test with ephemeral key material
 *   4. Latency within acceptable threshold
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import {
  ExternalKMSProvider,
  type ExternalKMSProviderConfig,
} from '@agent-platform/database/kms/providers/external';

const log = createLogger('external-kms-validator');

// =============================================================================
// TYPES
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  latencyMs?: number;
}

export interface ValidationOptions {
  /** Max acceptable latency for wrap+unwrap round-trip (default: 2000ms) */
  maxLatencyMs?: number;
  /** Whether to perform the wrap/unwrap round-trip test (default: true) */
  roundTripTest?: boolean;
  /** Key ID to use for the round-trip test */
  testKeyId?: string;
}

const DEFAULT_MAX_LATENCY_MS = 2000;

// =============================================================================
// VALIDATOR
// =============================================================================

/**
 * Validate an external KMS endpoint configuration.
 * Returns a structured result with errors and warnings.
 */
export async function validateExternalKMSEndpoint(
  config: ExternalKMSProviderConfig,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;

  // 1. HTTPS enforcement
  if (!config.endpoint.startsWith('https://')) {
    errors.push('Endpoint must use HTTPS (TLS 1.2+)');
    return { valid: false, errors, warnings };
  }

  // 2. Construct provider and validate config
  let provider: ExternalKMSProvider;
  try {
    provider = new ExternalKMSProvider(config);
    await provider.initialize();
  } catch (err) {
    errors.push(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings };
  }

  // 3. Health check
  try {
    const health = await provider.healthCheck();
    if (!health.healthy) {
      errors.push(`Health check failed: ${health.message ?? 'unknown'}`);
    }
  } catch (err) {
    errors.push(`Health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings };
  }

  // 4. Round-trip wrap/unwrap test
  let latencyMs: number | undefined;
  if (options.roundTripTest !== false && options.testKeyId) {
    try {
      const testKey = randomBytes(32);
      const start = performance.now();

      const wrapped = await provider.wrapKey(options.testKeyId, testKey);
      const unwrapped = await provider.unwrapKey(options.testKeyId, wrapped.ciphertext);

      latencyMs = Math.round(performance.now() - start);

      // Verify round-trip correctness
      if (!testKey.equals(unwrapped)) {
        errors.push('Round-trip test failed: unwrapped key does not match original');
      }

      // Latency check
      if (latencyMs > maxLatencyMs) {
        warnings.push(`Round-trip latency ${latencyMs}ms exceeds threshold ${maxLatencyMs}ms`);
      }

      // Zero-fill test material
      testKey.fill(0);
      unwrapped.fill(0);
    } catch (err) {
      errors.push(`Round-trip test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Cleanup
  try {
    await provider.shutdown();
  } catch {
    // Ignore shutdown errors
  }

  const valid = errors.length === 0;
  if (valid) {
    log.info('External KMS endpoint validation passed', {
      endpoint: config.endpoint,
      authMethod: config.authMethod,
      latencyMs,
    });
  } else {
    log.warn('External KMS endpoint validation failed', {
      endpoint: config.endpoint,
      errors,
    });
  }

  return { valid, errors, warnings, latencyMs };
}
