/**
 * Model Registry
 *
 * Dynamic model catalog with intelligent routing.
 * Features:
 * - Multiple provider support
 * - GALE integration for enterprise models
 * - Intelligent routing (cost, latency, capability)
 * - Fallback chains
 * - Usage tracking and rate limiting
 */

import type { LLMProviderType, ModelTier } from '../llm/types.js';
import { createLogger } from '../logger.js';
import {
  areLlmProvidersPolicyEquivalent,
  canonicalizeLlmProviderName,
} from '@agent-platform/shared-kernel/llm-provider-identity';

const log = createLogger('model-registry');

// =============================================================================
// AUDIT
// =============================================================================

/**
 * Audit event emitted by model registry operations.
 */
export interface ModelRegistryAuditEvent {
  operation: 'register' | 'remove' | 'route' | 'fallback';
  modelId?: string;
  tenantId?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export type ModelRegistryAuditHook = (event: ModelRegistryAuditEvent) => void | Promise<void>;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Model capabilities
 */
export interface ModelCapabilities {
  /** Supports streaming responses */
  streaming: boolean;

  /** Supports tool/function calling */
  tools: boolean;

  /** Supports vision/image input */
  vision: boolean;

  /** Supports structured output (JSON mode) */
  structuredOutput: boolean;

  /** Maximum context window (tokens) */
  maxContextTokens: number;

  /** Maximum output tokens */
  maxOutputTokens: number;

  /** Supports parallel tool calls */
  parallelToolCalls: boolean;

  /** Supports system message caching */
  promptCaching: boolean;
}

/**
 * Model pricing (per 1M tokens)
 */
export interface ModelPricing {
  /** Input token price (USD per 1M) */
  inputPer1M: number;

  /** Output token price (USD per 1M) */
  outputPer1M: number;

  /** Cached input price (if supported) */
  cachedInputPer1M?: number;
}

/**
 * Model rate limits
 */
export interface ModelLimits {
  /** Requests per minute */
  requestsPerMinute: number;

  /** Tokens per minute */
  tokensPerMinute: number;

  /** Tokens per day (if applicable) */
  tokensPerDay?: number;
}

/**
 * Model performance metrics
 */
export interface ModelPerformance {
  /** Average latency to first token (ms) */
  avgLatencyMs: number;

  /** Average tokens per second */
  avgTokensPerSecond: number;

  /** Reliability score (0-1) */
  reliability: number;
}

/**
 * Full model information
 */
export interface ModelInfo {
  /** Unique model ID */
  id: string;

  /** Provider */
  provider: LLMProviderType;

  /** Display name */
  name: string;

  /** Model family (e.g., 'claude-3', 'gpt-4') */
  family: string;

  /** Model tier */
  tier: ModelTier;

  /** Capabilities */
  capabilities: ModelCapabilities;

  /** Pricing */
  pricing: ModelPricing;

  /** Rate limits */
  limits: ModelLimits;

  /** Performance metrics */
  performance?: ModelPerformance;

  /** Deprecation date (if applicable) */
  deprecatedAt?: Date;

  /** Replacement model ID */
  replacementId?: string;

  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Task requirements for routing
 */
export interface TaskRequirements {
  /** Minimum capabilities required */
  capabilities?: Partial<ModelCapabilities>;

  /** Preferred tier */
  preferredTier?: ModelTier;

  /** Maximum cost per 1M tokens (input + output) */
  maxCostPer1M?: number;

  /** Maximum latency (ms) */
  maxLatencyMs?: number;

  /** Preferred providers */
  preferredProviders?: LLMProviderType[];

  /** Excluded providers */
  excludedProviders?: LLMProviderType[];

  /** Estimated input tokens */
  estimatedInputTokens?: number;

  /** Estimated output tokens */
  estimatedOutputTokens?: number;

  /** Tenant ID for scoped models */
  tenantId?: string;
}

/**
 * Routing result
 */
export interface RoutingResult {
  /** Selected model */
  model: ModelInfo;

  /** Reason for selection */
  reason: string;

  /** Fallback models (in order) */
  fallbacks: ModelInfo[];

  /** Estimated cost */
  estimatedCost?: number;
}

/**
 * Model filter
 */
export interface ModelFilter {
  provider?: LLMProviderType;
  tier?: ModelTier;
  family?: string;
  capabilities?: Partial<ModelCapabilities>;
  tenantId?: string;
  includeDeprecated?: boolean;
}

// =============================================================================
// MODEL REGISTRY
// =============================================================================

export class ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();
  private tenantModels: Map<string, Map<string, ModelInfo>> = new Map();
  private defaultFallbacks: Map<LLMProviderType, string[]> = new Map();
  private auditHook?: ModelRegistryAuditHook;

  constructor(auditHook?: ModelRegistryAuditHook) {
    this.auditHook = auditHook;
    this.initializeDefaultModels();
    this.initializeDefaultFallbacks();
  }

  // ===========================================================================
  // MODEL MANAGEMENT
  // ===========================================================================

  /**
   * Register a model
   */
  registerModel(model: ModelInfo, tenantId?: string): void {
    if (tenantId) {
      let tenantMap = this.tenantModels.get(tenantId);
      if (!tenantMap) {
        tenantMap = new Map();
        this.tenantModels.set(tenantId, tenantMap);
      }
      tenantMap.set(model.id, model);
    } else {
      this.models.set(model.id, model);
    }
    this.emitAudit({ operation: 'register', modelId: model.id, tenantId, timestamp: new Date() });
    log.debug('Model registered', { modelId: model.id, tenantId });
  }

  /**
   * Get a model by ID
   */
  getModel(id: string, tenantId?: string): ModelInfo | null {
    // Check tenant-specific models first
    if (tenantId) {
      const tenantModel = this.tenantModels.get(tenantId)?.get(id);
      if (tenantModel) return tenantModel;
    }

    // Fall back to global models
    return this.models.get(id) || null;
  }

  /**
   * List models matching filter
   */
  listModels(filter?: ModelFilter): ModelInfo[] {
    let results: ModelInfo[] = [];

    // Add global models
    for (const model of this.models.values()) {
      if (this.matchesFilter(model, filter)) {
        results.push(model);
      }
    }

    // Add tenant-specific models
    if (filter?.tenantId) {
      const tenantMap = this.tenantModels.get(filter.tenantId);
      if (tenantMap) {
        for (const model of tenantMap.values()) {
          if (this.matchesFilter(model, filter)) {
            results.push(model);
          }
        }
      }
    }

    // Filter deprecated unless requested
    if (!filter?.includeDeprecated) {
      results = results.filter((m) => !m.deprecatedAt);
    }

    return results;
  }

  /**
   * Remove a model
   */
  removeModel(id: string, tenantId?: string): boolean {
    let removed: boolean;
    if (tenantId) {
      removed = this.tenantModels.get(tenantId)?.delete(id) ?? false;
    } else {
      removed = this.models.delete(id);
    }
    if (removed) {
      this.emitAudit({ operation: 'remove', modelId: id, tenantId, timestamp: new Date() });
    }
    return removed;
  }

  // ===========================================================================
  // INTELLIGENT ROUTING
  // ===========================================================================

  /**
   * Get the best model for a task
   */
  getModelForTask(requirements: TaskRequirements): RoutingResult {
    const candidates = this.getCandidates(requirements);

    if (candidates.length === 0) {
      throw new Error('No models match the specified requirements');
    }

    // Score and rank candidates
    const scored = candidates.map((model) => ({
      model,
      score: this.scoreModel(model, requirements),
    }));

    scored.sort((a, b) => b.score - a.score);

    const selected = scored[0].model;
    const fallbacks = scored.slice(1, 4).map((s) => s.model);

    // Calculate estimated cost
    let estimatedCost: number | undefined;
    if (requirements.estimatedInputTokens || requirements.estimatedOutputTokens) {
      const inputTokens = requirements.estimatedInputTokens || 0;
      const outputTokens = requirements.estimatedOutputTokens || 0;
      estimatedCost =
        (inputTokens * selected.pricing.inputPer1M) / 1_000_000 +
        (outputTokens * selected.pricing.outputPer1M) / 1_000_000;
    }

    const reason = this.getSelectionReason(selected, requirements);

    this.emitAudit({
      operation: 'route',
      modelId: selected.id,
      tenantId: requirements.tenantId,
      timestamp: new Date(),
      metadata: {
        reason,
        candidateCount: candidates.length,
        fallbackIds: fallbacks.map((f) => f.id),
        estimatedCost,
      },
    });

    return {
      model: selected,
      reason,
      fallbacks,
      estimatedCost,
    };
  }

  /**
   * Get fallback chain for a model
   */
  getFallbackChain(modelId: string, tenantId?: string): ModelInfo[] {
    const model = this.getModel(modelId, tenantId);
    if (!model) return [];

    // Get provider-specific fallbacks
    const providerFallbacks =
      this.defaultFallbacks.get(model.provider) ||
      this.defaultFallbacks.get(canonicalizeLlmProviderName(model.provider) as LLMProviderType) ||
      [];

    const chain: ModelInfo[] = [];
    for (const fallbackId of providerFallbacks) {
      if (fallbackId !== modelId) {
        const fallback = this.getModel(fallbackId, tenantId);
        if (fallback) chain.push(fallback);
      }
    }

    // Add cross-provider fallbacks for same tier
    for (const [otherId, otherModel] of this.models) {
      if (
        otherId !== modelId &&
        otherModel.tier === model.tier &&
        !areLlmProvidersPolicyEquivalent(otherModel.provider, model.provider) &&
        !chain.find((m) => m.id === otherId)
      ) {
        chain.push(otherModel);
      }
    }

    return chain.slice(0, 3);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private getCandidates(requirements: TaskRequirements): ModelInfo[] {
    const filter: ModelFilter = {
      tenantId: requirements.tenantId,
    };

    let candidates = this.listModels(filter);

    // Filter by capabilities
    if (requirements.capabilities) {
      candidates = candidates.filter((m) => this.hasCapabilities(m, requirements.capabilities!));
    }

    // Filter by preferred providers
    if (requirements.preferredProviders?.length) {
      const preferred = candidates.filter((m) =>
        requirements.preferredProviders!.some((provider) =>
          areLlmProvidersPolicyEquivalent(provider, m.provider),
        ),
      );
      if (preferred.length > 0) {
        candidates = preferred;
      }
    }

    // Filter by excluded providers
    if (requirements.excludedProviders?.length) {
      candidates = candidates.filter(
        (m) =>
          !requirements.excludedProviders!.some((provider) =>
            areLlmProvidersPolicyEquivalent(provider, m.provider),
          ),
      );
    }

    // Filter by cost
    if (requirements.maxCostPer1M !== undefined) {
      candidates = candidates.filter(
        (m) => m.pricing.inputPer1M + m.pricing.outputPer1M <= requirements.maxCostPer1M!,
      );
    }

    // Filter by latency
    if (requirements.maxLatencyMs !== undefined) {
      candidates = candidates.filter(
        (m) => !m.performance || m.performance.avgLatencyMs <= requirements.maxLatencyMs!,
      );
    }

    return candidates;
  }

  private scoreModel(model: ModelInfo, requirements: TaskRequirements): number {
    let score = 0;

    // Tier preference (higher = better)
    const tierScores: Record<ModelTier, number> = { fast: 1, balanced: 2, powerful: 3 };
    const preferredTierScore = tierScores[requirements.preferredTier || 'balanced'];
    const modelTierScore = tierScores[model.tier];

    // Exact tier match is best
    if (model.tier === requirements.preferredTier) {
      score += 30;
    } else {
      // Penalize for tier mismatch
      score -= Math.abs(modelTierScore - preferredTierScore) * 10;
    }

    // Cost efficiency (lower cost = higher score)
    const totalCost = model.pricing.inputPer1M + model.pricing.outputPer1M;
    score += Math.max(0, 20 - totalCost / 5);

    // Performance (lower latency = higher score)
    if (model.performance) {
      score += Math.max(0, 10 - model.performance.avgLatencyMs / 100);
      score += model.performance.reliability * 10;
    }

    // Capability bonuses
    if (model.capabilities.promptCaching) score += 5;
    if (model.capabilities.parallelToolCalls) score += 3;
    if (model.capabilities.structuredOutput) score += 2;

    // Context window bonus for large inputs
    if (requirements.estimatedInputTokens) {
      if (model.capabilities.maxContextTokens >= requirements.estimatedInputTokens) {
        score += 10;
      }
    }

    return score;
  }

  private hasCapabilities(model: ModelInfo, required: Partial<ModelCapabilities>): boolean {
    for (const [key, value] of Object.entries(required)) {
      const modelValue = model.capabilities[key as keyof ModelCapabilities];

      if (typeof value === 'boolean' && value && !modelValue) {
        return false;
      }

      if (typeof value === 'number' && (modelValue as number) < value) {
        return false;
      }
    }
    return true;
  }

  private matchesFilter(model: ModelInfo, filter?: ModelFilter): boolean {
    if (!filter) return true;

    if (filter.provider && !areLlmProvidersPolicyEquivalent(filter.provider, model.provider)) {
      return false;
    }
    if (filter.tier && model.tier !== filter.tier) return false;
    if (filter.family && model.family !== filter.family) return false;
    if (filter.capabilities && !this.hasCapabilities(model, filter.capabilities)) return false;

    return true;
  }

  private getSelectionReason(model: ModelInfo, requirements: TaskRequirements): string {
    const reasons: string[] = [];

    if (model.tier === requirements.preferredTier) {
      reasons.push(`matches preferred tier (${model.tier})`);
    }

    if (requirements.capabilities?.tools && model.capabilities.tools) {
      reasons.push('supports tool calling');
    }

    if (requirements.capabilities?.streaming && model.capabilities.streaming) {
      reasons.push('supports streaming');
    }

    const cost = model.pricing.inputPer1M + model.pricing.outputPer1M;
    if (requirements.maxCostPer1M && cost <= requirements.maxCostPer1M) {
      reasons.push(`within cost budget ($${cost.toFixed(2)}/1M)`);
    }

    if (reasons.length === 0) {
      reasons.push('best available option');
    }

    return reasons.join(', ');
  }

  // ===========================================================================
  // DEFAULT MODELS
  // ===========================================================================

  private initializeDefaultModels(): void {
    // Anthropic models
    this.registerModel({
      id: 'claude-opus-4-7',
      provider: 'anthropic',
      name: 'Claude Opus 4.7',
      family: 'claude-4',
      tier: 'powerful',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 1_000_000,
        maxOutputTokens: 128_000,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 5,
        outputPer1M: 25,
        cachedInputPer1M: 0.5,
      },
      limits: {
        requestsPerMinute: 1000,
        tokensPerMinute: 400000,
      },
      performance: {
        avgLatencyMs: 800,
        avgTokensPerSecond: 50,
        reliability: 0.995,
      },
    });

    this.registerModel({
      id: 'claude-opus-4-20250514',
      provider: 'anthropic',
      name: 'Claude Opus 4',
      family: 'claude-4',
      tier: 'powerful',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 200000,
        maxOutputTokens: 32000,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 15,
        outputPer1M: 75,
        cachedInputPer1M: 1.5,
      },
      limits: {
        requestsPerMinute: 1000,
        tokensPerMinute: 400000,
      },
      performance: {
        avgLatencyMs: 800,
        avgTokensPerSecond: 50,
        reliability: 0.995,
      },
    });

    this.registerModel({
      id: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      name: 'Claude Sonnet 4',
      family: 'claude-4',
      tier: 'balanced',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 200000,
        maxOutputTokens: 64000,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 3,
        outputPer1M: 15,
        cachedInputPer1M: 0.3,
      },
      limits: {
        requestsPerMinute: 2000,
        tokensPerMinute: 800000,
      },
      performance: {
        avgLatencyMs: 400,
        avgTokensPerSecond: 80,
        reliability: 0.998,
      },
    });

    this.registerModel({
      id: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      name: 'Claude Haiku 4.5',
      family: 'claude-4.5',
      tier: 'fast',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 0.8,
        outputPer1M: 4,
        cachedInputPer1M: 0.08,
      },
      limits: {
        requestsPerMinute: 4000,
        tokensPerMinute: 1600000,
      },
      performance: {
        avgLatencyMs: 150,
        avgTokensPerSecond: 150,
        reliability: 0.999,
      },
    });

    // Legacy — retired Feb 2026, kept for backward compat
    this.registerModel({
      id: 'claude-3-5-haiku-20241022',
      provider: 'anthropic',
      name: 'Claude 3.5 Haiku (retired)',
      family: 'claude-3.5',
      tier: 'fast',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 1,
        outputPer1M: 5,
        cachedInputPer1M: 0.1,
      },
      limits: {
        requestsPerMinute: 4000,
        tokensPerMinute: 1600000,
      },
      performance: {
        avgLatencyMs: 150,
        avgTokensPerSecond: 150,
        reliability: 0.999,
      },
    });

    // OpenAI models
    this.registerModel({
      id: 'gpt-4o',
      provider: 'openai',
      name: 'GPT-4o',
      family: 'gpt-4o',
      tier: 'balanced',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
        parallelToolCalls: true,
        promptCaching: false,
      },
      pricing: {
        inputPer1M: 2.5,
        outputPer1M: 10,
      },
      limits: {
        requestsPerMinute: 5000,
        tokensPerMinute: 800000,
      },
      performance: {
        avgLatencyMs: 350,
        avgTokensPerSecond: 90,
        reliability: 0.997,
      },
    });

    this.registerModel({
      id: 'gpt-4o-mini',
      provider: 'openai',
      name: 'GPT-4o Mini',
      family: 'gpt-4o',
      tier: 'fast',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
        parallelToolCalls: true,
        promptCaching: false,
      },
      pricing: {
        inputPer1M: 0.15,
        outputPer1M: 0.6,
      },
      limits: {
        requestsPerMinute: 10000,
        tokensPerMinute: 2000000,
      },
      performance: {
        avgLatencyMs: 100,
        avgTokensPerSecond: 200,
        reliability: 0.999,
      },
    });

    // Google models
    this.registerModel({
      id: 'gemini-2.5-pro',
      provider: 'gemini',
      name: 'Gemini 2.5 Pro',
      family: 'gemini-2.5',
      tier: 'powerful',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 2000000,
        maxOutputTokens: 65536,
        parallelToolCalls: true,
        promptCaching: true,
      },
      pricing: {
        inputPer1M: 1.25,
        outputPer1M: 10,
      },
      limits: {
        requestsPerMinute: 1000,
        tokensPerMinute: 4000000,
      },
      performance: {
        avgLatencyMs: 500,
        avgTokensPerSecond: 100,
        reliability: 0.995,
      },
    });

    this.registerModel({
      id: 'gemini-2.0-flash',
      provider: 'gemini',
      name: 'Gemini 2.0 Flash',
      family: 'gemini-2.0',
      tier: 'fast',
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true,
        maxContextTokens: 1000000,
        maxOutputTokens: 8192,
        parallelToolCalls: true,
        promptCaching: false,
      },
      pricing: {
        inputPer1M: 0.075,
        outputPer1M: 0.3,
      },
      limits: {
        requestsPerMinute: 2000,
        tokensPerMinute: 4000000,
      },
      performance: {
        avgLatencyMs: 80,
        avgTokensPerSecond: 250,
        reliability: 0.998,
      },
    });
  }

  private emitAudit(event: ModelRegistryAuditEvent): void {
    if (this.auditHook) {
      Promise.resolve(this.auditHook(event)).catch((err) =>
        log.warn('Model registry audit hook failed', {
          operation: event.operation,
          modelId: event.modelId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private initializeDefaultFallbacks(): void {
    this.defaultFallbacks.set('anthropic', [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-7',
    ]);

    this.defaultFallbacks.set('openai', ['gpt-4o', 'gpt-4o-mini']);

    const geminiFallbacks = ['gemini-2.5-pro', 'gemini-2.0-flash'];
    this.defaultFallbacks.set('google', geminiFallbacks);
    this.defaultFallbacks.set('gemini', geminiFallbacks);
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let defaultRegistry: ModelRegistry | null = null;

/**
 * Get the default model registry
 */
export function getModelRegistry(auditHook?: ModelRegistryAuditHook): ModelRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ModelRegistry(auditHook);
  }
  return defaultRegistry;
}

/**
 * Reset the default registry (for testing)
 */
export function resetModelRegistry(): void {
  defaultRegistry = null;
}
