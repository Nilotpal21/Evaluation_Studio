/**
 * Knowledge Graph Model Assessment
 *
 * Utilities to assess and rank LLM models for Knowledge Graph workloads.
 * Scores models based on capabilities like structured output, context window,
 * and provider-specific strengths.
 */

import type { ITenantModel } from '@agent-platform/database/models';

export interface ModelCapabilities {
  score: number; // 0.0-1.0
  reasoning: string;
}

export interface AssessedModel {
  id: string;
  displayName: string;
  provider: string | null;
  tier: string;
  capabilities: {
    knowledgeGraph: ModelCapabilities;
  };
}

export interface ModelRecommendation {
  modelId: string;
  reason: string;
}

/**
 * Assess a model's capabilities for Knowledge Graph workloads
 *
 * Scoring criteria:
 * - Claude Sonnet 4.x/Opus: 1.0 (best for structured output, entity extraction)
 * - GPT-4o: 0.95 (fast, reliable, good structured output)
 * - GPT-4 Turbo: 0.90 (reliable but slower)
 * - Claude 3.5 Sonnet: 0.95 (excellent for KG)
 * - Other models: based on capabilities
 */
export function assessKGCapabilities(model: ITenantModel): ModelCapabilities {
  const provider = model.provider?.toLowerCase() || '';
  const modelId = model.modelId?.toLowerCase() || '';
  const displayName = model.displayName?.toLowerCase() || '';

  // Anthropic Claude models (best for KG)
  if (provider === 'anthropic') {
    if (
      modelId.includes('opus-4') ||
      modelId.includes('sonnet-4') ||
      displayName.includes('opus 4') ||
      displayName.includes('sonnet 4')
    ) {
      return {
        score: 1.0,
        reasoning:
          'Claude 4.x excels at structured output, entity extraction, and complex reasoning - ideal for Knowledge Graph tasks',
      };
    }
    if (
      modelId.includes('sonnet-3-5') ||
      modelId.includes('claude-3-5-sonnet') ||
      displayName.includes('3.5 sonnet')
    ) {
      return {
        score: 0.95,
        reasoning:
          'Claude 3.5 Sonnet offers excellent structured output and reasoning capabilities for Knowledge Graph',
      };
    }
    if (modelId.includes('opus') || displayName.includes('opus')) {
      return {
        score: 0.92,
        reasoning:
          'Claude Opus provides strong reasoning capabilities for complex Knowledge Graph operations',
      };
    }
    if (modelId.includes('sonnet') || displayName.includes('sonnet')) {
      return {
        score: 0.88,
        reasoning: 'Claude Sonnet balances cost and quality for Knowledge Graph workloads',
      };
    }
  }

  // OpenAI GPT-4 models (fast and reliable)
  if (provider === 'openai') {
    if (modelId.includes('gpt-4o') || displayName.includes('gpt-4o')) {
      return {
        score: 0.95,
        reasoning:
          'GPT-4o provides fast, reliable performance with good structured output for Knowledge Graph',
      };
    }
    if (
      modelId.includes('gpt-4-turbo') ||
      modelId.includes('gpt-4-1106') ||
      displayName.includes('gpt-4 turbo')
    ) {
      return {
        score: 0.9,
        reasoning: 'GPT-4 Turbo offers reliable structured output but slower than GPT-4o',
      };
    }
    if (modelId.includes('gpt-4') || displayName.includes('gpt-4')) {
      return {
        score: 0.85,
        reasoning: 'GPT-4 provides good quality but consider newer models for better performance',
      };
    }
  }

  // Default for other models
  return {
    score: 0.7,
    reasoning:
      'Model may work for Knowledge Graph but not optimized for structured output and entity extraction',
  };
}

/**
 * Recommend the best model for Knowledge Graph from available models
 *
 * Prefers Claude 4.x/3.5 Sonnet or GPT-4o for optimal results.
 * Returns null if no models available.
 */
export function recommendModelForKG(assessedModels: AssessedModel[]): ModelRecommendation | null {
  if (assessedModels.length === 0) {
    return null;
  }

  // Sort by KG capability score (highest first)
  const sorted = [...assessedModels].sort(
    (a, b) => b.capabilities.knowledgeGraph.score - a.capabilities.knowledgeGraph.score,
  );

  const best = sorted[0];
  return {
    modelId: best.id,
    reason: `${best.displayName}: ${best.capabilities.knowledgeGraph.reasoning}`,
  };
}
