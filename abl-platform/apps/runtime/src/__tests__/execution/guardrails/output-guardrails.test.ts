import { describe, it, expect, beforeEach } from 'vitest';
import type { Guardrail, PipelinePolicy } from '@abl/compiler';
import { checkOutputGuardrails } from '../../../services/execution/output-guardrails.js';
import { resetSharedRegistry } from '../../../services/guardrails/pipeline-factory.js';

function makeOutputGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'output-guard',
    description: 'test output guardrail',
    kind: 'output',
    priority: 1,
    tier: 'local',
    check: 'abl.contains_pii(output)',
    action: { type: 'block', message: 'PII detected in output' },
    ...overrides,
  };
}

describe('checkOutputGuardrails', () => {
  beforeEach(() => {
    resetSharedRegistry();
  });

  it('should pass when no text provided', async () => {
    const result = await checkOutputGuardrails('', [makeOutputGuardrail()], {});
    expect(result.passed).toBe(true);
  });

  it('should pass when no guardrails provided', async () => {
    const result = await checkOutputGuardrails('hello', undefined, {});
    expect(result.passed).toBe(true);
  });

  it('should pass when only input-kind guardrails exist', async () => {
    const inputGuardrail = makeOutputGuardrail({
      kind: 'input',
      check: 'true',
      action: { type: 'block', message: 'Should not fire' },
    });
    const result = await checkOutputGuardrails('hello', [inputGuardrail], {});
    // Pipeline filters by kind='output', so the input guardrail is skipped
    expect(result.passed).toBe(true);
  });

  it('should return passed=true for clean response', async () => {
    const result = await checkOutputGuardrails(
      'This is a clean response with no sensitive data',
      [makeOutputGuardrail()],
      {},
    );

    expect(result.passed).toBe(true);
    expect(result.text).toBe('This is a clean response with no sensitive data');
  });

  it('should return violation when output contains PII', async () => {
    const result = await checkOutputGuardrails(
      'My SSN is 123-45-6789',
      [makeOutputGuardrail()],
      {},
    );

    expect(result.passed).toBe(false);
    expect(result.violation).toBeDefined();
    expect(result.violation!.guardrailName).toBe('output-guard');
    expect(result.violation!.action).toBe('block');
    expect(result.violation!.message).toBe('PII detected in output');
  });

  it('should respect policy that disables a guardrail', async () => {
    const policy: PipelinePolicy = {
      disabledGuardrails: ['output-guard'],
      settings: { failMode: 'closed' },
    };

    // Text with PII, but the guardrail is disabled via policy
    const result = await checkOutputGuardrails(
      'My SSN is 123-45-6789',
      [makeOutputGuardrail()],
      {},
      policy,
    );

    expect(result.passed).toBe(true);
  });

  it('should include pipelineResult in returned value', async () => {
    const result = await checkOutputGuardrails(
      'This is a clean response',
      [makeOutputGuardrail()],
      {},
    );

    expect(result.pipelineResult).toBeDefined();
    expect(result.pipelineResult!.metrics).toBeDefined();
    expect(result.pipelineResult!.metrics.totalChecks).toBeGreaterThanOrEqual(1);
    expect(result.pipelineResult!.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
