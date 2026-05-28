/**
 * Tests for NLU provider config in project-runtime-config route.
 *
 * Validates:
 *  - PLATFORM_DEFAULTS includes nlu_provider: 'standard'
 *  - extractionConfigSchema validates nlu_provider enum
 *  - extractionConfigSchema validates advanced_sidecar_url as URL
 */

import { describe, it, expect } from 'vitest';

describe('project runtime config API — nlu_provider', () => {
  it('should include nlu_provider: standard in platform defaults', async () => {
    const { PLATFORM_DEFAULTS } = await import('../routes/project-runtime-config.js');
    expect(PLATFORM_DEFAULTS.extraction.nlu_provider).toBe('standard');
  });

  it('should validate nlu_provider as standard or advanced', async () => {
    const { extractionConfigSchema } = await import('../routes/project-runtime-config.js');
    const valid = extractionConfigSchema.safeParse({ nlu_provider: 'advanced' });
    expect(valid.success).toBe(true);

    const invalid = extractionConfigSchema.safeParse({ nlu_provider: 'premium' });
    expect(invalid.success).toBe(false);
  });

  it('should validate advanced_sidecar_url as url when provided', async () => {
    const { extractionConfigSchema } = await import('../routes/project-runtime-config.js');
    const valid = extractionConfigSchema.safeParse({
      nlu_provider: 'advanced',
      advanced_sidecar_url: 'http://kore-nlu:8090',
    });
    expect(valid.success).toBe(true);

    const invalid = extractionConfigSchema.safeParse({
      nlu_provider: 'advanced',
      advanced_sidecar_url: 'not-a-url',
    });
    expect(invalid.success).toBe(false);
  });

  it('should include advanced_sidecar_timeout_ms default', async () => {
    const { PLATFORM_DEFAULTS } = await import('../routes/project-runtime-config.js');
    expect(PLATFORM_DEFAULTS.extraction.advanced_sidecar_timeout_ms).toBe(3000);
  });

  it('should include advanced_sidecar_circuit_breaker_threshold default', async () => {
    const { PLATFORM_DEFAULTS } = await import('../routes/project-runtime-config.js');
    expect(PLATFORM_DEFAULTS.extraction.advanced_sidecar_circuit_breaker_threshold).toBe(5);
  });

  it('should validate advanced_sidecar_timeout_ms range', async () => {
    const { extractionConfigSchema } = await import('../routes/project-runtime-config.js');

    const tooLow = extractionConfigSchema.safeParse({ advanced_sidecar_timeout_ms: 50 });
    expect(tooLow.success).toBe(false);

    const tooHigh = extractionConfigSchema.safeParse({ advanced_sidecar_timeout_ms: 50000 });
    expect(tooHigh.success).toBe(false);

    const valid = extractionConfigSchema.safeParse({ advanced_sidecar_timeout_ms: 5000 });
    expect(valid.success).toBe(true);
  });

  it('should validate advanced_sidecar_circuit_breaker_threshold range', async () => {
    const { extractionConfigSchema } = await import('../routes/project-runtime-config.js');

    const tooLow = extractionConfigSchema.safeParse({
      advanced_sidecar_circuit_breaker_threshold: 0,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = extractionConfigSchema.safeParse({
      advanced_sidecar_circuit_breaker_threshold: 200,
    });
    expect(tooHigh.success).toBe(false);

    const valid = extractionConfigSchema.safeParse({
      advanced_sidecar_circuit_breaker_threshold: 10,
    });
    expect(valid.success).toBe(true);
  });
});
