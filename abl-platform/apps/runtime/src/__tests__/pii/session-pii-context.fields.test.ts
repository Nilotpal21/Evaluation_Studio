/**
 * INT-7/INT-8: Foundation Stability Contract field-propagation parity.
 *
 * Pure-function tests against the exported `mapProjectPIIRedactionConfig`
 * (per LLD D-12). No module mocks — the four parallel session-pii-context
 * interfaces are now exported and consumed directly. Asserts:
 *
 *   INT-7: legacy documents (no new fields) resolve to documented
 *          defaults: tier='basic', latency_budget_ms=200,
 *          confidence_threshold=0.5, enabled_recognizer_packs=['core'].
 *   INT-8: explicit values round-trip unchanged.
 */

import { describe, test, expect } from 'vitest';
import {
  mapProjectPIIRedactionConfig,
  type ProjectPIIRedactionConfig,
  type RuntimePIIRedactionConfig,
} from '../../services/pii/session-pii-context.js';

describe('INT-7: legacy documents resolve to documented defaults', () => {
  test('undefined input — every default applied', () => {
    const out: RuntimePIIRedactionConfig = mapProjectPIIRedactionConfig(undefined);
    expect(out).toEqual({
      enabled: true,
      redactInput: true,
      redactOutput: false,
      tier: 'basic',
      latencyBudgetMs: 200,
      confidenceThreshold: 0.5,
      enabledRecognizerPacks: ['core'],
    });
  });

  test('legacy document (only enabled/redact_input/redact_output) — new fields default', () => {
    const legacy: ProjectPIIRedactionConfig = {
      enabled: true,
      redact_input: true,
      redact_output: true,
    };
    const out = mapProjectPIIRedactionConfig(legacy);
    expect(out.tier).toBe('basic');
    expect(out.latencyBudgetMs).toBe(200);
    expect(out.confidenceThreshold).toBe(0.5);
    expect(out.enabledRecognizerPacks).toEqual(['core']);
    // Legacy fields preserved
    expect(out.redactInput).toBe(true);
    expect(out.redactOutput).toBe(true);
  });

  test('explicit `false` for redact flags is preserved (not coerced to default)', () => {
    const out = mapProjectPIIRedactionConfig({
      enabled: false,
      redact_input: false,
      redact_output: false,
    });
    expect(out.enabled).toBe(false);
    expect(out.redactInput).toBe(false);
    expect(out.redactOutput).toBe(false);
  });
});

describe('INT-8: explicit values round-trip', () => {
  test('all four new fields propagate camelCase', () => {
    const raw: ProjectPIIRedactionConfig = {
      enabled: true,
      redact_input: true,
      redact_output: false,
      tier: 'standard',
      latency_budget_ms: 350,
      confidence_threshold: 0.75,
      enabled_recognizer_packs: ['core', 'eu', 'medical'],
    };
    expect(mapProjectPIIRedactionConfig(raw)).toEqual({
      enabled: true,
      redactInput: true,
      redactOutput: false,
      tier: 'standard',
      latencyBudgetMs: 350,
      confidenceThreshold: 0.75,
      enabledRecognizerPacks: ['core', 'eu', 'medical'],
    });
  });

  test('partial override — unspecified fields take defaults', () => {
    const out = mapProjectPIIRedactionConfig({
      enabled: true,
      tier: 'standard',
      enabled_recognizer_packs: ['core', 'us'],
    });
    expect(out.tier).toBe('standard');
    expect(out.enabledRecognizerPacks).toEqual(['core', 'us']);
    expect(out.latencyBudgetMs).toBe(200); // default
    expect(out.confidenceThreshold).toBe(0.5); // default
  });

  test('every PIITier value is accepted', () => {
    for (const tier of ['basic', 'standard', 'advanced', 'maximum'] as const) {
      const out = mapProjectPIIRedactionConfig({ tier });
      expect(out.tier).toBe(tier);
    }
  });
});
