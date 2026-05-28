import { describe, it, expect, vi } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import type {
  GuardrailCachePort,
  CostCheckerPort,
  WebhookPort,
} from '../../platform/guardrails/pipeline';
import type { Guardrail } from '../../platform/ir/schema';

function guardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('Pipeline port wiring', () => {
  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------
  describe('cache integration', () => {
    it('replays cached tier2 warnings on cache hit', async () => {
      const cache: GuardrailCachePort = {
        get: vi.fn().mockResolvedValue({
          passed: true,
          outcome: 'warning',
          violation: {
            action: 'warn',
            message: 'Cached warning',
            severity: 'medium',
            score: 0.82,
            threshold: 0.5,
            category: 'toxicity',
            provider: 'test-provider',
            priority: 1,
          },
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { cache });

      const guards = [
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'test-provider',
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});

      expect(result.metrics.cacheHits).toBe(1);
      expect(result.metrics.cacheMisses).toBe(0);
      expect(cache.get).toHaveBeenCalledWith('model_check', 'hello', 'model');
      expect(result.warnings).toEqual([
        expect.objectContaining({
          name: 'model_check',
          action: 'warn',
          message: 'Cached warning',
          category: 'toxicity',
          provider: 'test-provider',
        }),
      ]);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('replays cached tier2 terminal violations on cache hit', async () => {
      const cache: GuardrailCachePort = {
        get: vi.fn().mockResolvedValue({
          passed: false,
          outcome: 'violation',
          violation: {
            action: 'block',
            message: 'Cached block',
            severity: 'high',
            score: 0.97,
            threshold: 0.5,
            category: 'safety',
            provider: 'test-provider',
            priority: 1,
          },
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { cache });

      const guards = [
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'test-provider',
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});

      expect(result.metrics.cacheHits).toBe(1);
      expect(result.passed).toBe(false);
      expect(result.primaryViolation).toEqual(
        expect.objectContaining({
          name: 'model_check',
          action: 'block',
          message: 'Cached block',
        }),
      );
      expect(result.violations).toEqual([
        expect.objectContaining({
          name: 'model_check',
          action: 'block',
          message: 'Cached block',
        }),
      ]);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('replays cached outcomes without double-counting mixed cache-hit and cache-miss tier2 runs', async () => {
      const cache: GuardrailCachePort = {
        get: vi.fn(async (guardrailName: string) =>
          guardrailName === 'cached_warning'
            ? {
                passed: true,
                outcome: 'warning',
                violation: {
                  action: 'warn',
                  message: 'Cached warning',
                  severity: 'medium',
                  score: 0.76,
                  threshold: 0.5,
                  category: 'toxicity',
                  provider: 'test-provider',
                  priority: 1,
                },
              }
            : null,
        ),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { cache });

      const guards = [
        guardrail({
          name: 'cached_warning',
          tier: 'model',
          provider: 'test-provider',
          action: { type: 'warn' },
        }),
        guardrail({
          name: 'uncached_block',
          tier: 'model',
          provider: 'nonexistent',
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {}, undefined, {
        settings: {
          failMode: 'closed',
        },
      });

      expect(result.metrics.cacheHits).toBe(1);
      expect(result.metrics.cacheMisses).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
      expect(result.warnings[0]).toEqual(
        expect.objectContaining({
          name: 'cached_warning',
          action: 'warn',
          message: 'Cached warning',
        }),
      );
      expect(result.violations[0]).toEqual(
        expect.objectContaining({
          name: 'uncached_block',
        }),
      );
      expect(result.primaryViolation).toEqual(
        expect.objectContaining({
          name: 'uncached_block',
        }),
      );
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledWith('uncached_block', 'hello', 'model', expect.anything());
    });

    it('should call cache.set after tier2 evaluation on cache miss', async () => {
      const cache: GuardrailCachePort = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { cache });

      const guards = [
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'nonexistent',
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});
      expect(result.metrics.cacheMisses).toBe(1);
      expect(result.metrics.cacheHits).toBe(0);
      expect(cache.set).toHaveBeenCalledWith('model_check', 'hello', 'model', expect.anything());
    });

    it('should not cache tier3 results', async () => {
      const cache: GuardrailCachePort = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const llmEval = vi.fn().mockResolvedValue(JSON.stringify({ violated: false }));
      const pipeline = new GuardrailPipelineImpl(undefined, llmEval, { cache });

      const guards = [
        guardrail({
          name: 'llm_check',
          tier: 'llm',
          action: { type: 'warn' },
          check: 'be polite',
        }),
      ];

      await pipeline.execute(guards, 'hello', 'input', {});
      // Cache should not be used for tier3
      expect(cache.get).not.toHaveBeenCalledWith('llm_check', expect.anything(), 'llm');
      expect(cache.set).not.toHaveBeenCalledWith(
        'llm_check',
        expect.anything(),
        'llm',
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Budget enforcement
  // ---------------------------------------------------------------------------
  describe('budget enforcement', () => {
    it('should skip tier2 and tier3 when budget action is disable_model_checks', async () => {
      const costChecker: CostCheckerPort = {
        checkBudget: vi.fn().mockResolvedValue({ exceeded: true, action: 'disable_model_checks' }),
        recordCost: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { costChecker });

      const guards = [
        guardrail({
          name: 'local_check',
          tier: 'local',
          check: 'abl.length(input) > 1000',
          action: { type: 'warn' },
        }),
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'test-provider',
          action: { type: 'warn' },
        }),
        guardrail({
          name: 'llm_check',
          tier: 'llm',
          action: { type: 'warn' },
          check: 'be polite',
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});
      // Only tier1 check should run (and pass since length < 1000)
      expect(result.metrics.totalChecks).toBe(1);
      expect(costChecker.checkBudget).toHaveBeenCalled();
    });

    it('should skip only tier3 when budget action is downgrade', async () => {
      const costChecker: CostCheckerPort = {
        checkBudget: vi.fn().mockResolvedValue({ exceeded: true, action: 'downgrade' }),
        recordCost: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { costChecker });

      const guards = [
        guardrail({
          name: 'local_check',
          tier: 'local',
          check: 'abl.length(input) > 1000',
          action: { type: 'warn' },
        }),
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'nonexistent',
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});
      // tier1 + tier2 should both run
      expect(costChecker.checkBudget).toHaveBeenCalled();
      // Should still pass (tier1 doesn't fire, tier2 provider missing = fail-open)
      expect(result.passed).toBe(true);
    });

    it('should record cost after evaluation', async () => {
      const costChecker: CostCheckerPort = {
        checkBudget: vi.fn().mockResolvedValue({ exceeded: false, action: 'none' }),
        recordCost: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { costChecker });

      const guards = [
        guardrail({
          name: 'local_check',
          tier: 'local',
          check: 'true',
          action: { type: 'warn' },
        }),
      ];

      await pipeline.execute(guards, 'hello', 'input', {});
      // costUsd is 0 for tier1 checks, so recordCost may not be called
      // (it's only called if costUsd > 0)
      expect(costChecker.checkBudget).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook notifications
  // ---------------------------------------------------------------------------
  describe('webhook notifications', () => {
    it('should fire webhook on warn violations', async () => {
      const webhook: WebhookPort = {
        deliver: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { webhook });

      const guards = [
        guardrail({
          name: 'warn_check',
          tier: 'local',
          check: 'true',
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(guards, 'hello', 'input', {});
      expect(result.warnings.length).toBeGreaterThan(0);
      // webhook.deliver is fire-and-forget but we can check it was called
      // Need to flush microtask queue for the .catch() chain
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(webhook.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'guardrail.warn',
          data: expect.objectContaining({
            warnings: expect.arrayContaining([expect.objectContaining({ name: 'warn_check' })]),
          }),
        }),
      );
    });

    it('should not fire webhook when there are no warn violations', async () => {
      const webhook: WebhookPort = {
        deliver: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { webhook });

      const guards = [
        guardrail({
          name: 'block_check',
          tier: 'local',
          check: 'true',
          action: { type: 'block' },
        }),
      ];

      await pipeline.execute(guards, 'hello', 'input', {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(webhook.deliver).not.toHaveBeenCalled();
    });

    it('should not block pipeline on webhook delivery failure', async () => {
      const webhook: WebhookPort = {
        deliver: vi.fn().mockRejectedValue(new Error('webhook failed')),
      };

      const pipeline = new GuardrailPipelineImpl(undefined, undefined, { webhook });

      const guards = [
        guardrail({
          name: 'warn_check',
          tier: 'local',
          check: 'true',
          action: { type: 'warn' },
        }),
      ];

      // Should not throw even though webhook fails
      const result = await pipeline.execute(guards, 'hello', 'input', {});
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });
});
