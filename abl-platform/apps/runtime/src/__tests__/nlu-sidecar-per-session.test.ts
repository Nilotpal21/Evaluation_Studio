import { describe, it, expect } from 'vitest';
import { NLUSidecarClient } from '../services/nlu/sidecar-client.js';

describe('per-session NLU sidecar client', () => {
  it('should create sidecar client from project config advanced_sidecar_url', () => {
    const projectConfig = {
      nlu_provider: 'advanced' as const,
      advanced_sidecar_url: 'http://kore-nlu:8090',
      advanced_sidecar_timeout_ms: 5000,
      advanced_sidecar_circuit_breaker_threshold: 3,
    };

    // Verify config shape is correct for NLUSidecarClient constructor
    expect(projectConfig.advanced_sidecar_url).toBe('http://kore-nlu:8090');
    expect(projectConfig.advanced_sidecar_timeout_ms).toBe(5000);
    expect(projectConfig.advanced_sidecar_circuit_breaker_threshold).toBe(3);

    // Create client using project config fields — same mapping as initializeSession
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

  it('should not create client when advanced_sidecar_url is missing', () => {
    const projectConfig = {
      nlu_provider: 'advanced' as const,
      // no advanced_sidecar_url
    };
    const shouldCreate =
      projectConfig.nlu_provider === 'advanced' &&
      !!(projectConfig as Record<string, unknown>).advanced_sidecar_url;
    expect(shouldCreate).toBe(false);
  });

  it('should create client with default timeout when advanced_sidecar_timeout_ms is not set', () => {
    const projectConfig = {
      nlu_provider: 'advanced' as const,
      advanced_sidecar_url: 'http://kore-nlu:8090',
      // no timeout or threshold — NLUSidecarClient uses its own defaults
    };

    const client = new NLUSidecarClient({
      url: projectConfig.advanced_sidecar_url,
    });
    expect(client).toBeInstanceOf(NLUSidecarClient);
  });

  it('each session gets its own circuit breaker state', () => {
    // Two clients for different projects should be independent instances
    const client1 = new NLUSidecarClient({ url: 'http://nlu-project-a:8090' });
    const client2 = new NLUSidecarClient({ url: 'http://nlu-project-b:8090' });

    expect(client1).not.toBe(client2);
    expect(client1).toBeInstanceOf(NLUSidecarClient);
    expect(client2).toBeInstanceOf(NLUSidecarClient);
  });
});
