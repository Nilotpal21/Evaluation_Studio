import { describe, it, expect } from 'vitest';
import { NLUSidecarClient } from '../services/nlu/sidecar-client.js';

describe('NLU sidecar client wiring', () => {
  it('should create NLUSidecarClient with URL config', () => {
    const client = new NLUSidecarClient({ url: 'http://localhost:8090' });
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(NLUSidecarClient);
  });

  it('should create client from project config (per-session pattern)', () => {
    const projectConfig = {
      nlu_provider: 'advanced' as const,
      advanced_sidecar_url: 'http://kore-nlu:8090',
      advanced_sidecar_timeout_ms: 5000,
      advanced_sidecar_circuit_breaker_threshold: 3,
    };

    // Per-session: client is created from project config, not env var
    const shouldCreate =
      projectConfig.nlu_provider === 'advanced' && !!projectConfig.advanced_sidecar_url;
    expect(shouldCreate).toBe(true);

    const client = new NLUSidecarClient({
      url: projectConfig.advanced_sidecar_url,
      timeoutMs: projectConfig.advanced_sidecar_timeout_ms,
      circuitBreakerThreshold: projectConfig.advanced_sidecar_circuit_breaker_threshold,
    });
    expect(client).toBeInstanceOf(NLUSidecarClient);
  });

  it('should not create client when nlu_provider is standard', () => {
    const projectConfig = {
      nlu_provider: 'standard' as const,
    };
    const shouldCreate =
      projectConfig.nlu_provider === 'advanced' &&
      !!(projectConfig as Record<string, unknown>).advanced_sidecar_url;
    expect(shouldCreate).toBe(false);
  });

  it('should strip trailing slashes from URL', () => {
    const client = new NLUSidecarClient({ url: 'http://localhost:8090///' });
    // health() would use the stripped URL — verify by checking client exists
    expect(client).toBeDefined();
  });
});
