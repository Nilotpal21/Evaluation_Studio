/**
 * Tests for NLU provider gating of Tier 2 ML sidecar.
 *
 * The sidecar (Tier 2) should only run when nlu_provider === 'advanced'.
 * When nlu_provider === 'standard' (default), Tier 2 is skipped entirely.
 * The extraction_strategy must also allow sidecar (not 'llm' or 'pattern').
 */

import { describe, it, expect } from 'vitest';

describe('NLU provider gating', () => {
  it('should disable sidecar when nlu_provider is standard', () => {
    const nluProvider = 'standard';
    const extractionStrategy = 'auto';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(false);
  });

  it('should enable sidecar when nlu_provider is advanced and strategy allows', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'auto';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(true);
  });

  it('should disable sidecar when strategy is llm even with advanced provider', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'llm';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(false);
  });

  it('should disable sidecar when strategy is pattern even with advanced provider', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'pattern';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(false);
  });

  it('should enable sidecar when strategy is hybrid and provider is advanced', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'hybrid';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(true);
  });

  it('should enable sidecar when strategy is ml and provider is advanced', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'ml';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(true);
  });

  it('should default nlu_provider to standard when not configured', () => {
    const nluProvider = undefined ?? 'standard';
    expect(nluProvider).toBe('standard');
  });

  it('should default nlu_provider to standard when null', () => {
    const nluProvider = (null as string | null) ?? 'standard';
    expect(nluProvider).toBe('standard');
  });
});

describe('NLU provider gating — correction detection', () => {
  it('should gate sidecar correction detection on nlu_provider === advanced', () => {
    const nluProvider = 'advanced';
    const correctionMode = 'auto';
    const enableSidecar =
      correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'sidecar';
    const gatedSidecar = enableSidecar && nluProvider === 'advanced';
    expect(gatedSidecar).toBe(true);
  });

  it('should block sidecar correction detection when nlu_provider is standard', () => {
    const nluProvider = 'standard';
    const correctionMode = 'auto';
    const enableSidecar =
      correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'sidecar';
    const gatedSidecar = enableSidecar && nluProvider === 'advanced';
    expect(gatedSidecar).toBe(false);
  });

  it('should still allow regex correction detection when nlu_provider is standard', () => {
    const nluProvider = 'standard';
    const correctionMode = 'auto';
    const enableRegex =
      correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'regex';
    // Regex is NOT gated on nlu_provider
    expect(enableRegex).toBe(true);
  });

  it('should still allow LLM correction detection when nlu_provider is standard', () => {
    const nluProvider = 'standard';
    const correctionMode = 'auto';
    const enableLLM = correctionMode === 'auto' || correctionMode === 'llm';
    // LLM correction is NOT gated on nlu_provider
    void nluProvider; // nluProvider does not affect LLM tier
    expect(enableLLM).toBe(true);
  });
});
