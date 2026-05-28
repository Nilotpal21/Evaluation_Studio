import { describe, it, expect } from 'vitest';
import { Tier1Evaluator } from '../../platform/guardrails/tier1-evaluator';
import { Tier2Evaluator } from '../../platform/guardrails/tier2-evaluator';
import { Tier3Evaluator } from '../../platform/guardrails/tier3-evaluator';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import type { Guardrail } from '../../platform/ir/schema';

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'INVALID_CEL_EXPRESSION()',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('failMode threading', () => {
  describe('Tier 1 evaluator', () => {
    const evaluator = new Tier1Evaluator();

    it('should pass on CEL error with failMode=open (default)', async () => {
      const result = await evaluator.evaluate([makeGuardrail({ check: 'INVALID()' })], {});
      expect(result.passed).toBe(true);
      expect(result.metrics.passed).toBe(1);
    });

    it('should block on CEL error with failMode=closed', async () => {
      const result = await evaluator.evaluate(
        [makeGuardrail({ check: 'INVALID()' })],
        {},
        { failMode: 'closed' },
      );
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].message).toBe('Guardrail evaluation failed');
    });
  });

  describe('Tier 2 evaluator', () => {
    it('should block on provider error with failMode=closed', async () => {
      // Create evaluator with no registry — provider lookup will fail
      const evaluator = new Tier2Evaluator();
      const guard = makeGuardrail({
        tier: 'model',
        provider: 'nonexistent-provider',
        check: undefined,
      });
      const result = await evaluator.evaluate([guard], 'test content', undefined, {
        failMode: 'closed',
      });
      // Provider not registered + failMode=closed → blocked
      expect(result.metrics.passed).toBe(0);
      expect(result.violations).toHaveLength(1);
    });
  });

  describe('Tier 3 evaluator', () => {
    it('should skip with no LLM function and failMode=open', async () => {
      const evaluator = new Tier3Evaluator();
      const guard = makeGuardrail({ tier: 'llm', llmCheck: 'Check for safety' });
      const result = await evaluator.evaluate([guard], 'test content');
      // Should skip gracefully
      expect(result.violations).toHaveLength(0);
    });

    it('should block with no LLM function and failMode=closed', async () => {
      const evaluator = new Tier3Evaluator();
      const guard = makeGuardrail({ tier: 'llm', llmCheck: 'Check for safety' });
      const result = await evaluator.evaluate([guard], 'test content', undefined, {
        failMode: 'closed',
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].message).toBe('Guardrail evaluator unavailable');
    });

    it('should block on LLM call failure with failMode=closed', async () => {
      const failingLlm = async () => {
        throw new Error('LLM unavailable');
      };
      const evaluator = new Tier3Evaluator(failingLlm);
      const guard = makeGuardrail({ tier: 'llm', llmCheck: 'Check for safety' });
      const result = await evaluator.evaluate([guard], 'test content', undefined, {
        failMode: 'closed',
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
    });
  });

  describe('Pipeline failMode threading from policy', () => {
    it('should default to failMode=open when no policy provided', async () => {
      const pipeline = new GuardrailPipelineImpl();
      const guard = makeGuardrail({ check: 'INVALID()' });
      const result = await pipeline.execute([guard], 'test', 'input', {});
      expect(result.passed).toBe(true);
    });

    it('should thread failMode=closed from policy to evaluators', async () => {
      const pipeline = new GuardrailPipelineImpl();
      const guard = makeGuardrail({ check: 'INVALID()' });
      const result = await pipeline.execute([guard], 'test', 'input', {}, undefined, {
        settings: { failMode: 'closed' },
      });
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });
  });
});
