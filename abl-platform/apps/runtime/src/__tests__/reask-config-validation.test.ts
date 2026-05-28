/**
 * TDD lock tests for reask config validation — Slice 2 [ABLP-413]
 *
 * Validates that the compiler rejects max_reasks > 5 at compile time
 * and accepts valid values. Also tests edge cases like max_reasks: 0.
 */

import { describe, it, expect } from 'vitest';
import { validateGuardrails } from '@abl/compiler/platform/ir/guardrail-validator.js';
import type { Guardrail } from '@abl/compiler';

function makeOutputGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'output',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'reask', maxReasks: 2 },
    ...overrides,
  };
}

describe('reask config validation (compiler)', () => {
  it('should reject max_reasks: 6 with a clear error', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({ action: { type: 'reask', maxReasks: 6 } }),
    ]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(
      errors.some((e) => e.message.includes('maxReasks') || e.message.includes('max_reasks')),
    ).toBe(true);
  });

  it('should reject max_reasks: 100 with a clear error', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({ action: { type: 'reask', maxReasks: 100 } }),
    ]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should accept max_reasks: 5 without errors', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({ action: { type: 'reask', maxReasks: 5 } }),
    ]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('should accept max_reasks: 1 without errors', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({ action: { type: 'reask', maxReasks: 1 } }),
    ]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('should reject max_reasks: 0 (reask with 0 retries is nonsensical — use block instead)', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({ action: { type: 'reask', maxReasks: 0 } }),
    ]);

    // Either error or warning — 0 reasks means reask never fires
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it('should accept reask without explicit maxReasks (defaults to 2)', () => {
    const diagnostics = validateGuardrails([makeOutputGuardrail({ action: { type: 'reask' } })]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('should validate maxReasks in severityActions too', () => {
    const diagnostics = validateGuardrails([
      makeOutputGuardrail({
        action: { type: 'block' },
        severityActions: {
          high: { type: 'reask', maxReasks: 10 },
        },
      }),
    ]);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
