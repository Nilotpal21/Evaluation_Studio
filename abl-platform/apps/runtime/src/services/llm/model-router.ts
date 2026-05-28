/**
 * Model Router Utilities
 *
 * Standalone functions for model capability lookup, cost calculation,
 * and tier mapping between compiler (haiku/sonnet/opus) and platform
 * (fast/balanced/powerful) tiers.
 *
 * The ModelRouter class was removed — getCredential/selectModel were dead code
 * with a broken decrypt-scope bug. Only getModelCapabilities() and calculateCost()
 * were actually used (by chat.ts), so they're now standalone exports.
 */

// =============================================================================
// TYPES
// =============================================================================

export type ModelTier = 'fast' | 'balanced' | 'powerful';

/** Model metadata — keyed by modelId in KNOWN_MODEL_CAPABILITIES. */
export interface ModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

// Known model capabilities (fallback if not in database)
const KNOWN_MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  'anthropic/claude-opus-4': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 200000,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
  },
  'anthropic/claude-sonnet-4': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 200000,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  'anthropic/claude-haiku-4-5': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 200000,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
  },
  'openai/gpt-4o': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 128000,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
  },
  'openai/gpt-4o-mini': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 128000,
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
  },
  'google/gemini-2.5-pro': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 1048576,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.01,
  },
  'google/gemini-2.0-flash': {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 1048576,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
  },
  'groq/mixtral-8x7b': {
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 32000,
    inputCostPer1k: 0.00027,
    outputCostPer1k: 0.00027,
  },
  'groq/llama-3.1-70b': {
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 131072,
    inputCostPer1k: 0.00059,
    outputCostPer1k: 0.00079,
  },
};

// =============================================================================
// STANDALONE FUNCTIONS
// =============================================================================

/**
 * Get capabilities for a model ID.
 * Uses KNOWN_MODEL_CAPABILITIES, falls back to sensible defaults.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const known = KNOWN_MODEL_CAPABILITIES[resolveModelKey(modelId) ?? modelId];

  return {
    supportsTools: known?.supportsTools ?? true,
    supportsVision: known?.supportsVision ?? false,
    supportsStreaming: known?.supportsStreaming ?? true,
    contextWindow: known?.contextWindow ?? 128000,
    inputCostPer1k: known?.inputCostPer1k ?? 0.001,
    outputCostPer1k: known?.outputCostPer1k ?? 0.002,
  };
}

/**
 * Calculate estimated cost for token usage.
 */
export function calculateCost(
  inputCostPer1k: number,
  outputCostPer1k: number,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputCost = inputCostPer1k * (inputTokens / 1000);
  const outputCost = outputCostPer1k * (outputTokens / 1000);
  return inputCost + outputCost;
}

// =============================================================================
// TIER MAPPING UTILITIES
// =============================================================================

type CompilerModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * Map compiler tier (haiku/sonnet/opus) to platform tier (fast/balanced/powerful)
 */
export function mapCompilerTierToPlatform(compilerTier: CompilerModelTier): ModelTier {
  switch (compilerTier) {
    case 'haiku':
      return 'fast';
    case 'sonnet':
      return 'balanced';
    case 'opus':
      return 'powerful';
    default:
      return 'balanced';
  }
}

/**
 * Map platform tier to compiler tier
 */
export function mapPlatformTierToCompiler(platformTier: ModelTier): CompilerModelTier {
  switch (platformTier) {
    case 'fast':
      return 'haiku';
    case 'balanced':
      return 'sonnet';
    case 'powerful':
      return 'opus';
    default:
      return 'sonnet';
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Resolve a raw model ID (which may lack a provider prefix or carry a date
 * version suffix like "-20250929") to a key in KNOWN_MODEL_CAPABILITIES.
 *
 * Resolution order:
 *  1. Exact match
 *  2. Common provider prefixes prepended (e.g. "anthropic/" + modelId)
 *  3. Date-version suffix stripped, then repeat 1-2
 *  4. Prefix match against stored base families (e.g. "claude-sonnet-4-5"
 *     matches the stored key "anthropic/claude-sonnet-4")
 */
function resolveModelKey(modelId: string): string | undefined {
  if (modelId in KNOWN_MODEL_CAPABILITIES) return modelId;

  const PROVIDER_PREFIXES = ['anthropic/', 'openai/', 'google/', 'groq/'] as const;

  for (const prefix of PROVIDER_PREFIXES) {
    if (prefix + modelId in KNOWN_MODEL_CAPABILITIES) return prefix + modelId;
  }

  // Strip date-version suffix (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5")
  const stripped = modelId.replace(/-\d{8}$/, '');
  if (stripped !== modelId) {
    if (stripped in KNOWN_MODEL_CAPABILITIES) return stripped;
    for (const prefix of PROVIDER_PREFIXES) {
      if (prefix + stripped in KNOWN_MODEL_CAPABILITIES) return prefix + stripped;
    }
  }

  // Prefix match: "claude-sonnet-4-5" starts with base "claude-sonnet-4" in table
  const base = stripped || modelId;
  for (const key of Object.keys(KNOWN_MODEL_CAPABILITIES)) {
    const keyBase = key.includes('/') ? key.split('/')[1] : key;
    if (base.startsWith(keyBase)) return key;
  }

  return undefined;
}

export function hasKnownPricing(modelId: string): boolean {
  return resolveModelKey(modelId) !== undefined;
}

export { KNOWN_MODEL_CAPABILITIES };
