/**
 * Cost Calculator Service (RFC-003 Phase 2)
 *
 * Accurate cost calculation for all AI operations:
 * - Embedding providers (Voyage, OpenAI, Cohere)
 * - Reranking providers (Voyage, Cohere, Jina)
 * - Token-based pricing
 * - Cost warnings and limits
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmbeddingCostDetails {
  provider: string;
  model: string;
  inputTokens: number;
  costPerMillion: number;
  totalCost: number;
}

export interface RerankCostDetails {
  provider: string;
  model: string;
  documentCount: number;
  costPerThousand: number;
  totalCost: number;
}

export interface QueryCostBreakdown {
  embedding?: EmbeddingCostDetails;
  rerank?: RerankCostDetails;
  totalCost: number;
  warnings: string[];
}

// ─── Pricing Tables ─────────────────────────────────────────────────────────

/**
 * Embedding provider pricing (USD per 1M tokens)
 * Updated: 2026-02-23
 */
const EMBEDDING_PRICING: Record<string, Record<string, number>> = {
  voyage: {
    'voyage-3': 0.06, // $0.06 per 1M tokens
    'voyage-3-lite': 0.06,
    'voyage-finance-2': 0.06,
    'voyage-law-2': 0.06,
    'voyage-code-2': 0.06,
    'voyage-2': 0.1, // Legacy model
  },
  openai: {
    'text-embedding-3-small': 0.02, // $0.02 per 1M tokens (cheapest)
    'text-embedding-3-large': 0.13,
    'text-embedding-ada-002': 0.1, // Legacy
  },
  cohere: {
    'embed-english-v3.0': 0.1,
    'embed-multilingual-v3.0': 0.1,
    'embed-english-light-v3.0': 0.1,
    'embed-multilingual-light-v3.0': 0.1,
  },
};

/**
 * Reranking provider pricing (USD per 1K documents)
 * Updated: 2026-02-23
 */
const RERANK_PRICING: Record<string, Record<string, number>> = {
  voyage: {
    'rerank-1': 0.5, // $0.50 per 1K documents (cheapest)
    'rerank-lite-1': 0.2,
  },
  cohere: {
    'rerank-english-v3.0': 2.0, // $2.00 per 1K documents
    'rerank-multilingual-v3.0': 2.0,
    'rerank-english-v2.0': 2.0, // Legacy
  },
  jina: {
    'jina-reranker-v2-base-multilingual': 1.0, // $1.00 per 1K documents
    'jina-reranker-v1-base-en': 1.0,
  },
};

/**
 * Cost thresholds for warnings (USD)
 */
const COST_THRESHOLDS = {
  perQuery: {
    warning: 0.01, // Warn if single query > $0.01
    critical: 0.05, // Critical if single query > $0.05
  },
  hourly: {
    warning: 1.0, // Warn if hourly costs > $1.00
    critical: 10.0, // Critical if hourly costs > $10.00
  },
  daily: {
    warning: 20.0, // Warn if daily costs > $20.00
    critical: 100.0, // Critical if daily costs > $100.00
  },
};

// ─── Cost Calculator ────────────────────────────────────────────────────────

export class CostCalculator {
  /**
   * Calculate embedding cost based on token count and provider.
   */
  calculateEmbeddingCost(
    provider: string,
    model: string,
    inputTokens: number,
  ): EmbeddingCostDetails {
    const normalizedProvider = provider.toLowerCase();
    const providerPricing = EMBEDDING_PRICING[normalizedProvider];

    if (!providerPricing) {
      // Unknown provider - use conservative estimate
      return {
        provider,
        model,
        inputTokens,
        costPerMillion: 0.1, // Default to $0.10 per 1M tokens
        totalCost: (inputTokens / 1_000_000) * 0.1,
      };
    }

    const costPerMillion =
      providerPricing[model] ?? providerPricing[Object.keys(providerPricing)[0]];

    return {
      provider,
      model,
      inputTokens,
      costPerMillion,
      totalCost: (inputTokens / 1_000_000) * costPerMillion,
    };
  }

  /**
   * Calculate reranking cost based on document count and provider.
   */
  calculateRerankCost(provider: string, model: string, documentCount: number): RerankCostDetails {
    const normalizedProvider = provider.toLowerCase();
    const providerPricing = RERANK_PRICING[normalizedProvider];

    if (!providerPricing) {
      // Unknown provider - use conservative estimate
      return {
        provider,
        model,
        documentCount,
        costPerThousand: 1.0, // Default to $1.00 per 1K docs
        totalCost: (documentCount / 1000) * 1.0,
      };
    }

    const costPerThousand =
      providerPricing[model] ?? providerPricing[Object.keys(providerPricing)[0]];

    return {
      provider,
      model,
      documentCount,
      costPerThousand,
      totalCost: (documentCount / 1000) * costPerThousand,
    };
  }

  /**
   * Calculate total query cost with warnings.
   */
  calculateQueryCost(
    embeddingDetails?: EmbeddingCostDetails,
    rerankDetails?: RerankCostDetails,
  ): QueryCostBreakdown {
    const totalCost = (embeddingDetails?.totalCost ?? 0) + (rerankDetails?.totalCost ?? 0);
    const warnings: string[] = [];

    // Check per-query cost thresholds
    if (totalCost >= COST_THRESHOLDS.perQuery.critical) {
      warnings.push(
        `CRITICAL: Query cost ($${totalCost.toFixed(4)}) exceeds critical threshold ($${COST_THRESHOLDS.perQuery.critical})`,
      );
    } else if (totalCost >= COST_THRESHOLDS.perQuery.warning) {
      warnings.push(
        `WARNING: Query cost ($${totalCost.toFixed(4)}) exceeds warning threshold ($${COST_THRESHOLDS.perQuery.warning})`,
      );
    }

    // Suggest cost optimizations
    if (rerankDetails && rerankDetails.provider === 'cohere') {
      warnings.push(
        `OPTIMIZATION: Consider using Voyage reranker ($0.50/1K) instead of Cohere ($2.00/1K) for 4x cost savings`,
      );
    }

    if (
      embeddingDetails &&
      embeddingDetails.provider === 'openai' &&
      embeddingDetails.model !== 'text-embedding-3-small'
    ) {
      warnings.push(
        `OPTIMIZATION: Consider using OpenAI text-embedding-3-small ($0.02/1M) for lower cost`,
      );
    }

    return {
      embedding: embeddingDetails,
      rerank: rerankDetails,
      totalCost,
      warnings,
    };
  }

  /**
   * Estimate token count from text (rough approximation).
   * More accurate than character count, but less accurate than actual tokenization.
   *
   * Rule of thumb: ~1 token per 4 characters for English text.
   */
  estimateTokenCount(text: string): number {
    // Simple heuristic: words + punctuation
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    const punctuation = (text.match(/[.,!?;:()]/g) || []).length;

    // Average: 1.3 tokens per word + 1 token per punctuation
    return Math.ceil(words * 1.3 + punctuation);
  }

  /**
   * Get pricing information for a specific provider/model.
   */
  getEmbeddingPricing(provider: string, model?: string): number | null {
    const providerPricing = EMBEDDING_PRICING[provider.toLowerCase()];
    if (!providerPricing) return null;

    if (model) {
      return providerPricing[model] ?? null;
    }

    // Return cheapest model for provider
    return Math.min(...Object.values(providerPricing));
  }

  /**
   * Get pricing information for a reranking provider/model.
   */
  getRerankPricing(provider: string, model?: string): number | null {
    const providerPricing = RERANK_PRICING[provider.toLowerCase()];
    if (!providerPricing) return null;

    if (model) {
      return providerPricing[model] ?? null;
    }

    // Return cheapest model for provider
    return Math.min(...Object.values(providerPricing));
  }

  /**
   * Get cost recommendations for optimization.
   */
  getOptimizationRecommendations(breakdown: QueryCostBreakdown): string[] {
    const recommendations: string[] = [];

    // Embedding recommendations
    if (breakdown.embedding) {
      const { provider, model, costPerMillion } = breakdown.embedding;

      // Check if OpenAI small is cheaper
      const openaiSmallCost = EMBEDDING_PRICING.openai['text-embedding-3-small'];
      if (costPerMillion > openaiSmallCost) {
        const savings = ((costPerMillion - openaiSmallCost) / costPerMillion) * 100;
        recommendations.push(
          `Switch to OpenAI text-embedding-3-small for ${savings.toFixed(0)}% cost savings on embeddings`,
        );
      }
    }

    // Reranking recommendations
    if (breakdown.rerank) {
      const { provider, costPerThousand } = breakdown.rerank;

      // Check if Voyage rerank-lite-1 is cheaper
      const voyageLiteCost = RERANK_PRICING.voyage['rerank-lite-1'];
      if (costPerThousand > voyageLiteCost) {
        const savings = ((costPerThousand - voyageLiteCost) / costPerThousand) * 100;
        recommendations.push(
          `Switch to Voyage rerank-lite-1 for ${savings.toFixed(0)}% cost savings on reranking`,
        );
      }
    }

    // General optimization
    if (breakdown.totalCost > COST_THRESHOLDS.perQuery.warning) {
      recommendations.push(
        `Consider reducing topK or implementing client-side result caching to reduce API costs`,
      );
    }

    return recommendations;
  }

  /**
   * Check if aggregate costs exceed thresholds.
   */
  checkCostThresholds(
    period: 'hourly' | 'daily',
    totalCost: number,
  ): { exceeded: boolean; level: 'warning' | 'critical' | null; message?: string } {
    const thresholds = COST_THRESHOLDS[period];

    if (totalCost >= thresholds.critical) {
      return {
        exceeded: true,
        level: 'critical',
        message: `CRITICAL: ${period} costs ($${totalCost.toFixed(2)}) exceed critical threshold ($${thresholds.critical})`,
      };
    }

    if (totalCost >= thresholds.warning) {
      return {
        exceeded: true,
        level: 'warning',
        message: `WARNING: ${period} costs ($${totalCost.toFixed(2)}) exceed warning threshold ($${thresholds.warning})`,
      };
    }

    return { exceeded: false, level: null };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

export const costCalculator = new CostCalculator();
