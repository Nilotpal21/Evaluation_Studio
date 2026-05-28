import { isLlmProviderAllowed } from '@agent-platform/shared-kernel/llm-provider-identity';

import type { ModelRecommendation, ScoredModel } from '../types';

export interface ModelRecommendationInput {
  agentRole: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  requiresToolCalling: boolean;
  requiresVision: boolean;
  requiresStructuredOutput: boolean;
  complexityTier: 'simple' | 'moderate' | 'complex';
  operations?: string[];
  /** B20: Compliance constraints (PCI-DSS, HIPAA, etc.) */
  constraints?: string[];
  /** B20: Channel requirements (voice, web, etc.) */
  channels?: string[];
  /** B20: Tenant-provisioned model IDs — restrict candidates to these */
  tenantModels?: string[];
  /** B20: Tenant LLM policy constraints */
  tenantPolicy?: { allowedProviders?: string[] };
}

// =============================================================================
// CURATED MODEL CATALOG
// =============================================================================

interface CatalogEntry {
  provider: string;
  model: string;
  costTier: 'low' | 'medium' | 'high';
  latencyTier: 'fast' | 'moderate' | 'slow';
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  complexityFit: ('simple' | 'moderate' | 'complex')[];
}

/**
 * Curated short-list derived from MODEL_REGISTRY. Using a curated list
 * instead of the full 147+ registry for predictability. Models here are
 * well-tested, broadly available, and cover all capability tiers.
 */
const MODEL_CATALOG: CatalogEntry[] = [
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    costTier: 'low',
    latencyTier: 'fast',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['simple'],
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    costTier: 'medium',
    latencyTier: 'fast',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['moderate', 'complex'],
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    costTier: 'low',
    latencyTier: 'fast',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['simple', 'moderate'],
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    costTier: 'medium',
    latencyTier: 'moderate',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['moderate', 'complex'],
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    costTier: 'low',
    latencyTier: 'fast',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['simple', 'moderate'],
  },
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    costTier: 'medium',
    latencyTier: 'moderate',
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    complexityFit: ['moderate', 'complex'],
  },
];

// Cost ratios relative to Anthropic Sonnet (baseline = 1.0)
const COST_RATIOS: Record<string, number> = {
  'claude-haiku-4-5-20251001': 0.08,
  'claude-sonnet-4-6': 1.0,
  'gpt-4o-mini': 0.1,
  'gpt-4o': 1.5,
  'gemini-2.5-flash': 0.07,
  'gemini-2.5-pro': 0.8,
};

// =============================================================================
// MAIN ENTRY
// =============================================================================

/**
 * Recommend model configuration based on agent requirements.
 * B20: Enhanced with registry-based scoring, tenant filtering,
 * fallback chains, and cost comparison.
 */
export function getModelRecommendation(input: ModelRecommendationInput): ModelRecommendation {
  let candidates = filterCandidates(input);

  const tenantFilterUnavailable =
    input.tenantModels !== undefined && input.tenantModels.length > 0 && candidates.length === 0;

  // If tenant filtering removed all candidates, fall back to full catalog
  if (candidates.length === 0) {
    candidates = filterByCapabilities(MODEL_CATALOG, input);
  }

  // If still empty (very unusual), use full catalog
  if (candidates.length === 0) {
    candidates = [...MODEL_CATALOG];
  }

  const scored = scoreCandidates(candidates, input);
  const primary = scored[0];
  const fallback = selectFallback(scored, primary);
  const executionConfig = selectExecutionConfig(input);
  const perOperation = selectPerOperationModels(input);
  const costComparison = computeCostComparison(primary);

  return {
    primary: toScoredModel(primary, selectPrimaryReason(input)),
    ...(fallback ? { fallback: toScoredModel(fallback, 'Fallback from different provider') } : {}),
    executionConfig,
    ...(Object.keys(perOperation).length > 0 ? { perOperation } : {}),
    ...(costComparison ? { costComparison } : {}),
    ...(tenantFilterUnavailable ? { tenantFilterUnavailable } : {}),
  };
}

// =============================================================================
// FILTERING
// =============================================================================

function filterCandidates(input: ModelRecommendationInput): CatalogEntry[] {
  let candidates = [...MODEL_CATALOG];

  // Filter by tenant-provisioned models
  if (input.tenantModels && input.tenantModels.length > 0) {
    candidates = candidates.filter((c) => input.tenantModels!.includes(c.model));
  }

  // Filter by tenant policy (allowed providers)
  const allowedProviders = input.tenantPolicy?.allowedProviders;
  if (allowedProviders && allowedProviders.length > 0) {
    candidates = candidates.filter((c) => isLlmProviderAllowed(allowedProviders, c.provider));
  }

  // Filter by capability requirements
  candidates = filterByCapabilities(candidates, input);

  return candidates;
}

function filterByCapabilities(
  candidates: CatalogEntry[],
  input: ModelRecommendationInput,
): CatalogEntry[] {
  let filtered = candidates;

  if (input.requiresVision) {
    filtered = filtered.filter((c) => c.supportsVision);
  }

  if (input.requiresToolCalling) {
    filtered = filtered.filter((c) => c.supportsTools);
  }

  // Voice channels need streaming
  if (input.channels?.includes('voice')) {
    filtered = filtered.filter((c) => c.supportsStreaming);
  }

  return filtered;
}

// =============================================================================
// SCORING
// =============================================================================

function scoreCandidates(
  candidates: CatalogEntry[],
  input: ModelRecommendationInput,
): CatalogEntry[] {
  return [...candidates].sort((a, b) => {
    const aScore = computeScore(a, input);
    const bScore = computeScore(b, input);
    return bScore - aScore; // Higher score first
  });
}

function computeScore(entry: CatalogEntry, input: ModelRecommendationInput): number {
  let score = 0;

  // Complexity fit (most important)
  if (entry.complexityFit.includes(input.complexityTier)) {
    score += 50;
  }

  // Cost efficiency — prefer cheaper models for simple tasks
  if (input.complexityTier === 'simple' && entry.costTier === 'low') {
    score += 30;
  } else if (input.complexityTier === 'complex' && entry.costTier !== 'low') {
    score += 20; // Complex tasks benefit from better models
  }

  // Capability match bonuses
  if (input.requiresToolCalling && entry.supportsTools) score += 10;
  if (input.requiresVision && entry.supportsVision) score += 10;

  // Latency preference for scripted agents
  if (input.executionMode === 'scripted' && entry.latencyTier === 'fast') {
    score += 15;
  }

  return score;
}

// =============================================================================
// FALLBACK SELECTION
// =============================================================================

function selectFallback(scored: CatalogEntry[], primary: CatalogEntry): CatalogEntry | null {
  // Pick the best candidate from a different provider
  const fallback = scored.find((c) => c.provider !== primary.provider && c !== primary);

  // If no different-provider fallback, pick next best from same provider
  if (!fallback) {
    return scored.find((c) => c !== primary) ?? null;
  }

  return fallback;
}

// =============================================================================
// COST COMPARISON
// =============================================================================

function computeCostComparison(primary: CatalogEntry): { relativeSavings: string } | undefined {
  const primaryCost = COST_RATIOS[primary.model] ?? 1.0;
  const sonnetCost = COST_RATIOS['claude-sonnet-4-6'] ?? 1.0;

  if (primaryCost < sonnetCost * 0.5) {
    const ratio = Math.round(sonnetCost / primaryCost);
    return { relativeSavings: `${ratio}x cheaper than Sonnet` };
  }

  if (primaryCost > sonnetCost * 1.2) {
    const pct = Math.round(((primaryCost - sonnetCost) / sonnetCost) * 100);
    return { relativeSavings: `${pct}% more than Sonnet` };
  }

  return undefined; // Similar cost, no comparison needed
}

// =============================================================================
// HELPERS
// =============================================================================

function toScoredModel(entry: CatalogEntry, reason: string): ScoredModel {
  return {
    provider: entry.provider,
    model: entry.model,
    reason,
    costTier: entry.costTier,
    latencyTier: entry.latencyTier,
  };
}

function selectPrimaryReason(input: ModelRecommendationInput): string {
  if (input.executionMode === 'scripted') {
    return 'Scripted agent — fast, cost-effective model is sufficient.';
  }
  if (input.complexityTier === 'complex') {
    if (input.requiresToolCalling) {
      return 'Complex agent with tool calling — strong reasoning + reliable tool use.';
    }
    return 'Complex reasoning requires strong language understanding.';
  }
  if (input.complexityTier === 'moderate') {
    return 'Moderate complexity — good balance of quality and cost.';
  }
  return 'Simple agent — fast and cost-effective.';
}

function selectExecutionConfig(input: ModelRecommendationInput): {
  temperature: number;
  maxTokens: number;
  compactionPolicy?: string;
} {
  if (input.executionMode === 'scripted') {
    return { temperature: 0.1, maxTokens: 2048 };
  }
  if (input.complexityTier === 'complex') {
    return { temperature: 0.5, maxTokens: 4096, compactionPolicy: 'sliding_window' };
  }
  if (input.complexityTier === 'moderate') {
    return { temperature: 0.5, maxTokens: 4096 };
  }
  return { temperature: 0.7, maxTokens: 2048 };
}

function selectPerOperationModels(input: ModelRecommendationInput): Record<string, ScoredModel> {
  const ops: Record<string, ScoredModel> = {};

  if (!input.operations || input.operations.length === 0) return ops;

  for (const op of input.operations) {
    if (op === 'extraction' && input.complexityTier !== 'simple') {
      maybeAssignOperationModel(input, ops, 'extraction', {
        provider: 'openai',
        model: 'gpt-4o-mini',
        reason: 'Data extraction is a focused task — a smaller model is faster and cheaper.',
        costTier: 'low',
        latencyTier: 'fast',
      });
    }
    if (op === 'summarization') {
      maybeAssignOperationModel(input, ops, 'summarization', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        reason: 'Summarization is well-handled by fast models.',
        costTier: 'low',
        latencyTier: 'fast',
      });
    }
    if (op === 'coordination' && input.complexityTier === 'complex') {
      maybeAssignOperationModel(input, ops, 'coordination', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        reason: 'Coordination across multiple agents requires strong reasoning.',
        costTier: 'medium',
        latencyTier: 'fast',
      });
    }
  }

  return ops;
}

function maybeAssignOperationModel(
  input: ModelRecommendationInput,
  ops: Record<string, ScoredModel>,
  operation: string,
  model: ScoredModel,
): void {
  if (isRecommendedModelAllowed(input, model)) {
    ops[operation] = model;
  }
}

function isRecommendedModelAllowed(
  input: ModelRecommendationInput,
  model: Pick<ScoredModel, 'provider' | 'model'>,
): boolean {
  if (
    input.tenantModels &&
    input.tenantModels.length > 0 &&
    !input.tenantModels.includes(model.model)
  ) {
    return false;
  }

  const allowedProviders = input.tenantPolicy?.allowedProviders;
  if (allowedProviders && allowedProviders.length > 0) {
    return isLlmProviderAllowed(allowedProviders, model.provider);
  }

  return true;
}
