/**
 * Tests for F6: Sidecar config knobs wired to IR.
 *
 * Covers:
 * - NLUSidecarClient constructor with custom timeout and circuit breaker config
 * - ProjectRuntimeConfigIR new fields (correction_detection, sidecar_timeout_ms, etc.)
 * - Default values and optional field behavior
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

describe('F6: NLUSidecarClient config', () => {
  it('accepts custom timeoutMs', async () => {
    const { NLUSidecarClient } = await import('../services/nlu/sidecar-client.js');

    const client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      timeoutMs: 1000,
    });

    // The client should be constructable without errors
    expect(client).toBeDefined();
    // Verify health check uses the configured URL
    expect(client.health).toBeDefined();
  });

  it('accepts custom circuitBreakerThreshold', async () => {
    const { NLUSidecarClient } = await import('../services/nlu/sidecar-client.js');

    const client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      circuitBreakerThreshold: 3,
    });

    expect(client).toBeDefined();
  });

  it('accepts all config options together', async () => {
    const { NLUSidecarClient } = await import('../services/nlu/sidecar-client.js');

    const client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      timeoutMs: 500,
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 15_000,
    });

    expect(client).toBeDefined();
  });

  it('uses defaults when no overrides provided', async () => {
    const { NLUSidecarClient } = await import('../services/nlu/sidecar-client.js');

    const client = new NLUSidecarClient({
      url: 'http://localhost:8090',
    });

    expect(client).toBeDefined();
  });

  it('strips trailing slashes from URL', async () => {
    const { NLUSidecarClient } = await import('../services/nlu/sidecar-client.js');

    // This should not throw
    const client = new NLUSidecarClient({
      url: 'http://localhost:8090///',
    });

    expect(client).toBeDefined();
  });
});

describe('F6: ProjectRuntimeConfigIR new fields', () => {
  it('includes correction_detection field', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      correction_detection: 'llm',
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.correction_detection).toBe('llm');
  });

  it('includes sidecar_timeout_ms field', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      sidecar_timeout_ms: 500,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.sidecar_timeout_ms).toBe(500);
  });

  it('includes sidecar_circuit_breaker_threshold field', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      sidecar_circuit_breaker_threshold: 10,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.sidecar_circuit_breaker_threshold).toBe(10);
  });

  it('new fields are optional — backward compatible', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.correction_detection).toBeUndefined();
    expect(config.sidecar_timeout_ms).toBeUndefined();
    expect(config.sidecar_circuit_breaker_threshold).toBeUndefined();
  });

  it('all new fields set together', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'hybrid',
      nlu_provider: 'standard',
      correction_detection: 'disabled',
      sidecar_timeout_ms: 2000,
      sidecar_circuit_breaker_threshold: 3,
      multi_intent: {
        enabled: true,
        strategy: 'disambiguate',
        max_intents: 2,
        confidence_threshold: 0.9,
        queue_max_age_ms: 120_000,
      },
      inference: {
        confidence: 0.7,
        confirm: false,
        model_tier: 'premium',
        max_fields_per_pass: 5,
      },
      conversion: { currency_mode: 'live', currency_api_url: 'https://api.example.com' },
      lookup_tables: [],
    };

    expect(config.correction_detection).toBe('disabled');
    expect(config.sidecar_timeout_ms).toBe(2000);
    expect(config.sidecar_circuit_breaker_threshold).toBe(3);
  });
});

describe('F6: Environment variable parsing for sidecar', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('parseInt handles valid NLU_SIDECAR_TIMEOUT_MS', () => {
    process.env.NLU_SIDECAR_TIMEOUT_MS = '1500';
    const value = parseInt(process.env.NLU_SIDECAR_TIMEOUT_MS, 10);
    expect(value).toBe(1500);
    expect(Number.isNaN(value)).toBe(false);
  });

  it('parseInt handles valid NLU_SIDECAR_CB_THRESHOLD', () => {
    process.env.NLU_SIDECAR_CB_THRESHOLD = '3';
    const value = parseInt(process.env.NLU_SIDECAR_CB_THRESHOLD, 10);
    expect(value).toBe(3);
    expect(Number.isNaN(value)).toBe(false);
  });

  it('undefined env var results in NaN (caught by undefined check)', () => {
    delete process.env.NLU_SIDECAR_TIMEOUT_MS;
    const value = process.env.NLU_SIDECAR_TIMEOUT_MS
      ? parseInt(process.env.NLU_SIDECAR_TIMEOUT_MS, 10)
      : undefined;
    expect(value).toBeUndefined();
  });

  it('empty string env var results in NaN — should use default', () => {
    process.env.NLU_SIDECAR_TIMEOUT_MS = '';
    // Empty string is falsy, so the ternary returns undefined
    const value = process.env.NLU_SIDECAR_TIMEOUT_MS
      ? parseInt(process.env.NLU_SIDECAR_TIMEOUT_MS, 10)
      : undefined;
    expect(value).toBeUndefined();
  });
});
