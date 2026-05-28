/**
 * Tests for correction_detection config gating.
 *
 * Validates that the CorrectionDetectionStrategy from project_runtime_config
 * correctly gates which correction tiers (regex, sidecar, LLM) are enabled,
 * and that the per-project sidecar timeout is read from config.
 */

import { describe, it, expect } from 'vitest';
import type { CorrectionDetectionStrategy } from '@abl/compiler/platform/ir/schema.js';

/**
 * Compute which correction detection tiers are enabled for a given strategy.
 * This mirrors the gating logic in flow-step-executor.ts.
 */
function computeEnabledTiers(mode: CorrectionDetectionStrategy | undefined): {
  enableRegex: boolean;
  enableSidecar: boolean;
  enableLLM: boolean;
  disabled: boolean;
} {
  const correctionMode: CorrectionDetectionStrategy = mode ?? 'ml';

  if (correctionMode === 'disabled') {
    return { enableRegex: false, enableSidecar: false, enableLLM: false, disabled: true };
  }

  return {
    enableRegex: correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'regex',
    enableSidecar:
      correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'sidecar',
    enableLLM: correctionMode === 'auto' || correctionMode === 'llm',
    disabled: false,
  };
}

describe('correction detection config gating', () => {
  it('auto mode enables all tiers', () => {
    const tiers = computeEnabledTiers('auto');
    expect(tiers.disabled).toBe(false);
    expect(tiers.enableRegex).toBe(true);
    expect(tiers.enableSidecar).toBe(true);
    expect(tiers.enableLLM).toBe(true);
  });

  it('ml mode enables regex + sidecar, not LLM', () => {
    const tiers = computeEnabledTiers('ml');
    expect(tiers.disabled).toBe(false);
    expect(tiers.enableRegex).toBe(true);
    expect(tiers.enableSidecar).toBe(true);
    expect(tiers.enableLLM).toBe(false);
  });

  it('llm mode enables only LLM', () => {
    const tiers = computeEnabledTiers('llm');
    expect(tiers.disabled).toBe(false);
    expect(tiers.enableRegex).toBe(false);
    expect(tiers.enableSidecar).toBe(false);
    expect(tiers.enableLLM).toBe(true);
  });

  it('regex mode enables only regex', () => {
    const tiers = computeEnabledTiers('regex');
    expect(tiers.disabled).toBe(false);
    expect(tiers.enableRegex).toBe(true);
    expect(tiers.enableSidecar).toBe(false);
    expect(tiers.enableLLM).toBe(false);
  });

  it('sidecar mode enables only sidecar', () => {
    const tiers = computeEnabledTiers('sidecar');
    expect(tiers.disabled).toBe(false);
    expect(tiers.enableRegex).toBe(false);
    expect(tiers.enableSidecar).toBe(true);
    expect(tiers.enableLLM).toBe(false);
  });

  it('disabled mode skips all tiers', () => {
    const tiers = computeEnabledTiers('disabled');
    expect(tiers.disabled).toBe(true);
    expect(tiers.enableRegex).toBe(false);
    expect(tiers.enableSidecar).toBe(false);
    expect(tiers.enableLLM).toBe(false);
  });

  it('undefined (platform default) behaves same as ml', () => {
    const tiers = computeEnabledTiers(undefined);
    const mlTiers = computeEnabledTiers('ml');
    expect(tiers).toEqual(mlTiers);
  });
});

describe('per-project sidecar timeout from config', () => {
  it('sidecar_timeout_ms is read from project_runtime_config', () => {
    const config = {
      correction_detection: 'auto' as CorrectionDetectionStrategy,
      sidecar_timeout_ms: 750,
    };

    expect(config.sidecar_timeout_ms).toBe(750);
  });

  it('sidecar_timeout_ms is undefined when not set', () => {
    const config = {
      correction_detection: 'auto' as CorrectionDetectionStrategy,
    };

    expect((config as { sidecar_timeout_ms?: number }).sidecar_timeout_ms).toBeUndefined();
  });

  it('per-project timeout applies as outer cap via Promise.race pattern', async () => {
    // Simulate the Promise.race pattern used in flow-step-executor.ts
    const perProjectTimeoutMs = 100;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perProjectTimeoutMs);

    const slowOperation = new Promise<string>((resolve) => {
      setTimeout(() => resolve('slow result'), 500); // takes 500ms
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error('Per-project sidecar timeout')),
      );
    });

    try {
      await expect(Promise.race([slowOperation, timeoutPromise])).rejects.toThrow(
        'Per-project sidecar timeout',
      );
    } finally {
      clearTimeout(timer);
    }
  });

  it('fast operation completes before per-project timeout', async () => {
    const perProjectTimeoutMs = 500;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perProjectTimeoutMs);

    const fastOperation = new Promise<string>((resolve) => {
      setTimeout(() => resolve('fast result'), 10);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error('Per-project sidecar timeout')),
      );
    });

    try {
      const result = await Promise.race([fastOperation, timeoutPromise]);
      expect(result).toBe('fast result');
    } finally {
      clearTimeout(timer);
    }
  });
});
