/**
 * Cost Calculator Tests (RFC-003 Phase 2)
 *
 * Tests for accurate cost calculation across all AI providers.
 */

import { describe, test, expect } from 'vitest';
import { CostCalculator } from '../services/cost/cost-calculator.js';

// =============================================================================
// TESTS
// =============================================================================

describe('CostCalculator', () => {
  const calculator = new CostCalculator();

  // ─── Token Estimation ──────────────────────────────────────────────────────

  describe('Token Estimation', () => {
    test('estimates token count from text', () => {
      const text = 'Show me premium customers in San Francisco';
      const tokens = calculator.estimateTokenCount(text);

      // Expect: 6 words * 1.3 tokens/word + 0 punctuation = ~8 tokens
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });

    test('handles punctuation in token count', () => {
      const text = 'Hello, world! How are you?';
      const tokens = calculator.estimateTokenCount(text);

      // Expect: 5 words * 1.3 + 4 punctuation = ~11 tokens
      expect(tokens).toBeGreaterThan(8);
      expect(tokens).toBeLessThan(15);
    });

    test('handles empty string', () => {
      const tokens = calculator.estimateTokenCount('');
      expect(tokens).toBe(0);
    });

    test('handles single word', () => {
      const tokens = calculator.estimateTokenCount('hello');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(5);
    });
  });

  // ─── Embedding Cost Calculation ───────────────────────────────────────────

  describe('Embedding Cost Calculation', () => {
    test('calculates Voyage embedding cost', () => {
      const cost = calculator.calculateEmbeddingCost('voyage', 'voyage-3', 1_000_000);

      expect(cost.provider).toBe('voyage');
      expect(cost.model).toBe('voyage-3');
      expect(cost.inputTokens).toBe(1_000_000);
      expect(cost.costPerMillion).toBe(0.06);
      expect(cost.totalCost).toBeCloseTo(0.06, 4);
    });

    test('calculates OpenAI small embedding cost (cheapest)', () => {
      const cost = calculator.calculateEmbeddingCost('openai', 'text-embedding-3-small', 1_000_000);

      expect(cost.provider).toBe('openai');
      expect(cost.costPerMillion).toBe(0.02); // Cheapest option
      expect(cost.totalCost).toBeCloseTo(0.02, 4);
    });

    test('calculates OpenAI large embedding cost', () => {
      const cost = calculator.calculateEmbeddingCost('openai', 'text-embedding-3-large', 1_000_000);

      expect(cost.costPerMillion).toBe(0.13);
      expect(cost.totalCost).toBeCloseTo(0.13, 4);
    });

    test('calculates Cohere embedding cost', () => {
      const cost = calculator.calculateEmbeddingCost('cohere', 'embed-english-v3.0', 1_000_000);

      expect(cost.provider).toBe('cohere');
      expect(cost.costPerMillion).toBe(0.1);
      expect(cost.totalCost).toBeCloseTo(0.1, 4);
    });

    test('handles fractional token counts', () => {
      const cost = calculator.calculateEmbeddingCost('voyage', 'voyage-3', 500_000);

      expect(cost.inputTokens).toBe(500_000);
      expect(cost.totalCost).toBeCloseTo(0.03, 4); // Half of 1M tokens
    });

    test('handles small token counts', () => {
      const cost = calculator.calculateEmbeddingCost('voyage', 'voyage-3', 100);

      expect(cost.totalCost).toBeCloseTo(0.000006, 8); // 100 tokens / 1M * $0.06
    });

    test('uses default cost for unknown provider', () => {
      const cost = calculator.calculateEmbeddingCost('unknown', 'some-model', 1_000_000);

      expect(cost.provider).toBe('unknown');
      expect(cost.costPerMillion).toBe(0.1); // Default
      expect(cost.totalCost).toBeCloseTo(0.1, 4);
    });

    test('uses first model as default if model not found', () => {
      const cost = calculator.calculateEmbeddingCost('voyage', 'unknown-model', 1_000_000);

      expect(cost.provider).toBe('voyage');
      expect(cost.costPerMillion).toBe(0.06); // First model in voyage pricing
    });
  });

  // ─── Reranking Cost Calculation ───────────────────────────────────────────

  describe('Reranking Cost Calculation', () => {
    test('calculates Voyage reranking cost (cheapest)', () => {
      const cost = calculator.calculateRerankCost('voyage', 'rerank-1', 1000);

      expect(cost.provider).toBe('voyage');
      expect(cost.model).toBe('rerank-1');
      expect(cost.documentCount).toBe(1000);
      expect(cost.costPerThousand).toBe(0.5);
      expect(cost.totalCost).toBeCloseTo(0.5, 4);
    });

    test('calculates Voyage lite reranking cost', () => {
      const cost = calculator.calculateRerankCost('voyage', 'rerank-lite-1', 1000);

      expect(cost.costPerThousand).toBe(0.2); // Even cheaper
      expect(cost.totalCost).toBeCloseTo(0.2, 4);
    });

    test('calculates Cohere reranking cost (most expensive)', () => {
      const cost = calculator.calculateRerankCost('cohere', 'rerank-english-v3.0', 1000);

      expect(cost.provider).toBe('cohere');
      expect(cost.costPerThousand).toBe(2.0);
      expect(cost.totalCost).toBeCloseTo(2.0, 4);
    });

    test('calculates Jina reranking cost (mid-range)', () => {
      const cost = calculator.calculateRerankCost(
        'jina',
        'jina-reranker-v2-base-multilingual',
        1000,
      );

      expect(cost.provider).toBe('jina');
      expect(cost.costPerThousand).toBe(1.0);
      expect(cost.totalCost).toBeCloseTo(1.0, 4);
    });

    test('handles fractional document counts', () => {
      const cost = calculator.calculateRerankCost('voyage', 'rerank-1', 500);

      expect(cost.documentCount).toBe(500);
      expect(cost.totalCost).toBeCloseTo(0.25, 4); // Half of 1K docs
    });

    test('handles small document counts', () => {
      const cost = calculator.calculateRerankCost('voyage', 'rerank-1', 10);

      expect(cost.totalCost).toBeCloseTo(0.005, 4); // 10 docs / 1K * $0.50
    });

    test('uses default cost for unknown provider', () => {
      const cost = calculator.calculateRerankCost('unknown', 'some-model', 1000);

      expect(cost.provider).toBe('unknown');
      expect(cost.costPerThousand).toBe(1.0); // Default
      expect(cost.totalCost).toBeCloseTo(1.0, 4);
    });
  });

  // ─── Total Query Cost with Warnings ────────────────────────────────────────

  describe('Total Query Cost with Warnings', () => {
    test('calculates total cost for embedding + reranking', () => {
      const embedding = calculator.calculateEmbeddingCost('voyage', 'voyage-3', 100_000);
      const rerank = calculator.calculateRerankCost('voyage', 'rerank-1', 100);

      const breakdown = calculator.calculateQueryCost(embedding, rerank);

      expect(breakdown.embedding).toEqual(embedding);
      expect(breakdown.rerank).toEqual(rerank);
      expect(breakdown.totalCost).toBeCloseTo(embedding.totalCost + rerank.totalCost, 6);
      expect(breakdown.warnings).toBeInstanceOf(Array);
    });

    test('warns when query cost exceeds warning threshold', () => {
      const embedding = calculator.calculateEmbeddingCost('voyage', 'voyage-3', 50_000_000);
      const rerank = calculator.calculateRerankCost('cohere', 'rerank-english-v3.0', 5000);

      const breakdown = calculator.calculateQueryCost(embedding, rerank);

      // 50M tokens * $0.06/1M = $3.00 + 5K docs * $2.00/1K = $10.00 = $13.00 total
      expect(breakdown.totalCost).toBeGreaterThan(0.01); // Exceeds warning
      expect(breakdown.warnings.length).toBeGreaterThan(0);
      // Should have cost warnings
      expect(breakdown.warnings.some((w) => w.includes('WARNING') || w.includes('CRITICAL'))).toBe(
        true,
      );
    });

    test('critical alert when query cost exceeds critical threshold', () => {
      const embedding = calculator.calculateEmbeddingCost(
        'openai',
        'text-embedding-3-large',
        100_000_000,
      );
      const rerank = calculator.calculateRerankCost('cohere', 'rerank-english-v3.0', 10000);

      const breakdown = calculator.calculateQueryCost(embedding, rerank);

      expect(breakdown.totalCost).toBeGreaterThan(0.05); // Exceeds critical
      expect(breakdown.warnings.some((w) => w.includes('CRITICAL'))).toBe(true);
    });

    test('suggests Voyage optimization when using Cohere', () => {
      const rerank = calculator.calculateRerankCost('cohere', 'rerank-english-v3.0', 100);

      const breakdown = calculator.calculateQueryCost(undefined, rerank);

      expect(breakdown.warnings.some((w) => w.includes('Voyage'))).toBe(true);
      expect(breakdown.warnings.some((w) => w.includes('4x cost savings'))).toBe(true);
    });

    test('suggests OpenAI small optimization for expensive embedding', () => {
      const embedding = calculator.calculateEmbeddingCost(
        'openai',
        'text-embedding-3-large',
        100_000,
      );

      const breakdown = calculator.calculateQueryCost(embedding, undefined);

      expect(breakdown.warnings.some((w) => w.includes('text-embedding-3-small'))).toBe(true);
    });

    test('no warnings for low-cost queries', () => {
      const embedding = calculator.calculateEmbeddingCost('openai', 'text-embedding-3-small', 1000);
      const rerank = calculator.calculateRerankCost('voyage', 'rerank-lite-1', 10);

      const breakdown = calculator.calculateQueryCost(embedding, rerank);

      expect(breakdown.totalCost).toBeLessThan(0.01);
      expect(
        breakdown.warnings.filter((w) => w.includes('WARNING') || w.includes('CRITICAL')),
      ).toHaveLength(0);
    });
  });

  // ─── Pricing Lookups ───────────────────────────────────────────────────────

  describe('Pricing Lookups', () => {
    test('gets embedding pricing for specific model', () => {
      const pricing = calculator.getEmbeddingPricing('voyage', 'voyage-3');
      expect(pricing).toBe(0.06);
    });

    test('gets cheapest embedding pricing for provider', () => {
      const pricing = calculator.getEmbeddingPricing('openai');
      expect(pricing).toBe(0.02); // text-embedding-3-small is cheapest
    });

    test('returns null for unknown provider', () => {
      const pricing = calculator.getEmbeddingPricing('unknown');
      expect(pricing).toBeNull();
    });

    test('gets rerank pricing for specific model', () => {
      const pricing = calculator.getRerankPricing('voyage', 'rerank-1');
      expect(pricing).toBe(0.5);
    });

    test('gets cheapest rerank pricing for provider', () => {
      const pricing = calculator.getRerankPricing('voyage');
      expect(pricing).toBe(0.2); // rerank-lite-1 is cheapest
    });
  });

  // ─── Optimization Recommendations ──────────────────────────────────────────

  describe('Optimization Recommendations', () => {
    test('recommends switching to OpenAI small', () => {
      const embedding = calculator.calculateEmbeddingCost('cohere', 'embed-english-v3.0', 100_000);
      const breakdown = calculator.calculateQueryCost(embedding, undefined);

      const recommendations = calculator.getOptimizationRecommendations(breakdown);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations.some((r) => r.includes('OpenAI text-embedding-3-small'))).toBe(true);
      expect(recommendations.some((r) => r.includes('% cost savings'))).toBe(true);
    });

    test('recommends switching to Voyage lite for reranking', () => {
      const rerank = calculator.calculateRerankCost('cohere', 'rerank-english-v3.0', 100);
      const breakdown = calculator.calculateQueryCost(undefined, rerank);

      const recommendations = calculator.getOptimizationRecommendations(breakdown);

      expect(recommendations.some((r) => r.includes('Voyage rerank-lite-1'))).toBe(true);
    });

    test('recommends caching for expensive queries', () => {
      const embedding = calculator.calculateEmbeddingCost(
        'openai',
        'text-embedding-3-large',
        10_000_000,
      );
      const breakdown = calculator.calculateQueryCost(embedding, undefined);

      const recommendations = calculator.getOptimizationRecommendations(breakdown);

      expect(recommendations.some((r) => r.includes('caching'))).toBe(true);
    });

    test('no recommendations for optimal configuration', () => {
      const embedding = calculator.calculateEmbeddingCost('openai', 'text-embedding-3-small', 1000);
      const rerank = calculator.calculateRerankCost('voyage', 'rerank-lite-1', 10);
      const breakdown = calculator.calculateQueryCost(embedding, rerank);

      const recommendations = calculator.getOptimizationRecommendations(breakdown);

      expect(recommendations).toHaveLength(0);
    });
  });

  // ─── Threshold Checks ──────────────────────────────────────────────────────

  describe('Threshold Checks', () => {
    test('detects hourly cost warning', () => {
      const check = calculator.checkCostThresholds('hourly', 1.5);

      expect(check.exceeded).toBe(true);
      expect(check.level).toBe('warning');
      expect(check.message).toContain('WARNING');
      expect(check.message).toContain('hourly');
    });

    test('detects hourly cost critical', () => {
      const check = calculator.checkCostThresholds('hourly', 15.0);

      expect(check.exceeded).toBe(true);
      expect(check.level).toBe('critical');
      expect(check.message).toContain('CRITICAL');
    });

    test('detects daily cost warning', () => {
      const check = calculator.checkCostThresholds('daily', 25.0);

      expect(check.exceeded).toBe(true);
      expect(check.level).toBe('warning');
    });

    test('detects daily cost critical', () => {
      const check = calculator.checkCostThresholds('daily', 150.0);

      expect(check.exceeded).toBe(true);
      expect(check.level).toBe('critical');
    });

    test('no threshold exceeded for low costs', () => {
      const check = calculator.checkCostThresholds('hourly', 0.5);

      expect(check.exceeded).toBe(false);
      expect(check.level).toBeNull();
      expect(check.message).toBeUndefined();
    });
  });
});
