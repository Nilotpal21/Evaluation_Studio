/**
 * Model Capabilities Registry
 *
 * Derives capability data from the single source of truth in model-registry.ts.
 * Used to determine which features (reasoning, thinking, vision, tools) a model
 * supports, and to apply provider-specific parameter transformations.
 */

import type { ReasoningEffort } from './types.js';
import { MODEL_REGISTRY as MAIN_REGISTRY } from './model-registry.js';
import type { HyperParameter, ModelRegistryEntry } from './model-registry.js';

// Re-export for consumers
export type { HyperParameter, ModelRegistryEntry } from './model-registry.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ModelCapabilities {
  /** Provider name */
  provider:
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'azure'
    | 'bedrock'
    | 'cohere'
    | 'groq'
    | 'ultravox';
  /** Maximum output tokens the model supports */
  maxOutputTokens: number;
  /** Input context window size (tokens) */
  contextWindow: number;
  /** Supports function/tool calling */
  supportsTools: boolean;
  /** Supports parallel tool calls */
  supportsParallelToolCalls: boolean;
  /** Supports streaming */
  supportsStreaming: boolean;
  /** Supports vision (image input) */
  supportsVision: boolean;
  /** Supports structured output / JSON mode */
  supportsStructuredOutput: boolean;

  // --- Reasoning capabilities ---

  /** Model uses reasoning (o-series, GPT-5) — uses max_completion_tokens instead of max_tokens */
  isReasoningModel: boolean;
  /** Supports reasoning_effort parameter */
  supportsReasoningEffort: boolean;
  /** Supports extended thinking (Anthropic Claude) */
  supportsThinking: boolean;
  /** Supports thinking budget (Gemini 2.5) */
  supportsThinkingBudget: boolean;

  // --- Parameter restrictions ---

  /** Temperature is not supported (e.g. o1 series) */
  temperatureDisabled: boolean;
  /** topP is not supported */
  topPDisabled: boolean;
}

// =============================================================================
// CAPABILITIES DERIVED FROM MAIN REGISTRY
// =============================================================================

/**
 * Default capabilities for unknown models — conservative assumptions.
 */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  provider: 'openai',
  maxOutputTokens: 4096,
  contextWindow: 128_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsStreaming: true,
  supportsVision: false,
  supportsStructuredOutput: false,
  isReasoningModel: false,
  supportsReasoningEffort: false,
  supportsThinking: false,
  supportsThinkingBudget: false,
  temperatureDisabled: false,
  topPDisabled: false,
};

/**
 * Build capabilities lookup from the single model registry.
 * Each entry is Partial<ModelCapabilities>, merged with DEFAULT_CAPABILITIES at lookup time.
 */
const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {};
for (const [modelId, entry] of Object.entries(MAIN_REGISTRY)) {
  MODEL_CAPABILITIES[modelId] = {
    provider: entry.provider as ModelCapabilities['provider'],
    maxOutputTokens: entry.maxOutputTokens,
    contextWindow: entry.contextWindow,
    supportsTools: entry.supportsTools,
    supportsParallelToolCalls: entry.supportsParallelToolCalls,
    supportsVision: entry.capabilities.includes('imageToText'),
    supportsStreaming: entry.supportsStreaming ?? true,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    ...(entry.isReasoningModel && { isReasoningModel: true }),
    ...(entry.supportsReasoningEffort && { supportsReasoningEffort: true }),
    ...(entry.supportsThinking && { supportsThinking: true }),
    ...(entry.supportsThinkingBudget && { supportsThinkingBudget: true }),
    ...(entry.temperatureDisabled && { temperatureDisabled: true }),
    ...(entry.topPDisabled && { topPDisabled: true }),
  };
}

// Build prefix-match patterns for model families (avoids listing every date variant)
const FAMILY_PATTERNS: Array<{ prefix: string; capabilities: Partial<ModelCapabilities> }> = [
  // OpenAI o-series
  { prefix: 'o1-', capabilities: MODEL_CAPABILITIES['o1']! },
  { prefix: 'o3-', capabilities: MODEL_CAPABILITIES['o3']! },
  { prefix: 'o4-mini', capabilities: MODEL_CAPABILITIES['o4-mini']! },
  // OpenAI GPT-5 family
  { prefix: 'gpt-5', capabilities: MODEL_CAPABILITIES['gpt-5']! },
  // Anthropic Claude family patterns (longest prefix first for correct matching)
  { prefix: 'claude-opus-4-7', capabilities: MODEL_CAPABILITIES['claude-opus-4-7']! },
  { prefix: 'claude-opus-4-6', capabilities: MODEL_CAPABILITIES['claude-opus-4-6-20260204']! },
  { prefix: 'claude-sonnet-4-6', capabilities: MODEL_CAPABILITIES['claude-sonnet-4-6-20260217']! },
  { prefix: 'claude-sonnet-4-5', capabilities: MODEL_CAPABILITIES['claude-sonnet-4-5-20250929']! },
  { prefix: 'claude-opus-4-5', capabilities: MODEL_CAPABILITIES['claude-opus-4-5-20251101']! },
  { prefix: 'claude-opus-4-1', capabilities: MODEL_CAPABILITIES['claude-opus-4-1-20250805']! },
  { prefix: 'claude-opus-4', capabilities: MODEL_CAPABILITIES['claude-opus-4-20250514']! },
  { prefix: 'claude-sonnet-4', capabilities: MODEL_CAPABILITIES['claude-sonnet-4-20250514']! },
  { prefix: 'claude-haiku-4-5', capabilities: MODEL_CAPABILITIES['claude-haiku-4-5-20251001']! },
  { prefix: 'claude-3-5-haiku', capabilities: MODEL_CAPABILITIES['claude-3-5-haiku-20241022']! },
  // Gemini family
  { prefix: 'gemini-2.5-flash', capabilities: MODEL_CAPABILITIES['gemini-2.5-flash']! },
  { prefix: 'gemini-2.5-pro', capabilities: MODEL_CAPABILITIES['gemini-2.5-pro']! },
  { prefix: 'gemini-2.0-flash', capabilities: MODEL_CAPABILITIES['gemini-2.0-flash']! },
  { prefix: 'gemini-3-pro', capabilities: MODEL_CAPABILITIES['gemini-3-pro-preview']! },
  { prefix: 'gemini-3-flash', capabilities: MODEL_CAPABILITIES['gemini-3-flash-preview']! },
];

// =============================================================================
// PUBLIC API
// =============================================================================

function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}

const REGISTRY_PROVIDERS = new Set(
  Object.values(MAIN_REGISTRY).map((entry) => entry.provider.toLowerCase()),
);

function normalizeProviderHint(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case 'gemini':
      return 'google';
    case 'vertex':
    case 'vertex_ai':
      return 'google_vertex';
    case 'together':
      return 'togetherai';
    default:
      return normalized;
  }
}

const PLATFORM_MODEL_PROVIDER_PREFIXES = new Set([
  'anthropic',
  'azure',
  'bedrock',
  'cohere',
  'custom',
  'deepseek',
  'fireworks',
  'gemini',
  'google',
  'google_vertex',
  'groq',
  'litellm',
  'meta',
  'microsoft',
  'microsoft_foundry_anthropic',
  'mistral',
  'mock',
  'openai',
  'openrouter',
  'perplexity',
  'qwen',
  'together',
  'togetherai',
  'ultravox',
  'vertex',
  'vertex_ai',
  'xai',
]);

export function getPlatformModelProviderPrefix(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return null;
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  const providerPrefix = trimmed.slice(0, slashIndex).trim().toLowerCase();
  return PLATFORM_MODEL_PROVIDER_PREFIXES.has(providerPrefix) ? providerPrefix : null;
}

export function stripLeadingPlatformModelProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const providerPrefix = getPlatformModelProviderPrefix(trimmed);
  if (!providerPrefix) {
    return trimmed;
  }

  return trimmed.slice(trimmed.indexOf('/') + 1).trim();
}

export function inferModelProviderFromId(modelId: string | null | undefined): string | null {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) {
    return null;
  }

  const platformProviderPrefix = getPlatformModelProviderPrefix(trimmedModelId);
  if (platformProviderPrefix) {
    return platformProviderPrefix;
  }

  const registryProvider = getModelRegistryEntry(trimmedModelId)?.provider;
  if (registryProvider) {
    return registryProvider;
  }

  const lower = trimmedModelId.toLowerCase();
  if (lower.startsWith('claude') || lower.startsWith('anthropic')) return 'anthropic';
  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  )
    return 'openai';
  if (lower.startsWith('gemini')) return 'google';
  if (lower.startsWith('command-r') || lower.startsWith('command-') || lower.startsWith('c4ai-aya'))
    return 'cohere';
  if (lower.startsWith('mistral') || lower.startsWith('mixtral') || lower.startsWith('codestral'))
    return 'mistral';
  if (lower.startsWith('llama') || lower.startsWith('meta-llama')) return 'meta';
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('grok')) return 'xai';
  if (lower.startsWith('pplx') || lower.startsWith('sonar')) return 'perplexity';
  if (lower.startsWith('amazon') || lower.startsWith('titan')) return 'amazon';
  if (lower.startsWith('jamba') || lower.startsWith('ai21')) return 'ai21';
  if (lower.startsWith('nemotron') || lower.startsWith('nvidia')) return 'nvidia';
  if (lower.startsWith('phi-') || lower.startsWith('microsoft')) return 'microsoft';
  if (lower.startsWith('qwen')) return 'qwen';
  if (lower.startsWith('mock')) return 'mock';

  return null;
}

function extractProviderHint(modelId: string): string | null {
  const parts = modelId
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const candidate = normalizeProviderHint(parts[index]!);
    if (REGISTRY_PROVIDERS.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function stripProviderHintPrefix(modelId: string, providerHint: string): string {
  const parts = modelId
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (normalizeProviderHint(parts[index]!) === providerHint) {
      return parts.slice(index + 1).join('/');
    }
  }

  return stripProviderPrefix(modelId);
}

function registryEntryMatchesProvider(key: string, providerHint: string): boolean {
  return MAIN_REGISTRY[key]?.provider.toLowerCase() === providerHint;
}

function exactRegistryKey(candidate: string): string | null {
  if (MAIN_REGISTRY[candidate]) {
    return candidate;
  }

  const normalizedCandidate = candidate.toLowerCase();
  return (
    Object.keys(MAIN_REGISTRY).find((key) => key.toLowerCase() === normalizedCandidate) ?? null
  );
}

function exactProviderRegistryKey(candidate: string, providerHint: string): string | null {
  const exact = MAIN_REGISTRY[candidate];
  if (exact && exact.provider.toLowerCase() === providerHint) {
    return candidate;
  }

  const normalizedCandidate = candidate.toLowerCase();
  return (
    Object.keys(MAIN_REGISTRY).find(
      (key) =>
        key.toLowerCase() === normalizedCandidate &&
        registryEntryMatchesProvider(key, providerHint),
    ) ?? null
  );
}

function findProviderSpecificRegistryKey(modelId: string): string | null {
  const trimmed = modelId.trim();
  const providerHint = extractProviderHint(trimmed);
  if (!providerHint) {
    return null;
  }

  const bareModel = stripProviderHintPrefix(trimmed, providerHint);
  return (
    exactProviderRegistryKey(trimmed, providerHint) ??
    exactProviderRegistryKey(bareModel, providerHint) ??
    exactProviderRegistryKey(`${providerHint}/${bareModel}`, providerHint)
  );
}

/**
 * Look up capabilities for a model by its ID.
 * Strips provider prefix ("anthropic/claude-3-sonnet" → "claude-3-sonnet")
 * and tries exact match first, then prefix-based family match, then defaults.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const providerSpecificKey = findProviderSpecificRegistryKey(modelId);
  if (providerSpecificKey) {
    return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[providerSpecificKey] };
  }

  const exactRegistryMatch = exactRegistryKey(modelId.trim());
  if (exactRegistryMatch) {
    return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[exactRegistryMatch] };
  }

  // Strip provider prefix if present
  const hasProviderPrefix = modelId.includes('/');
  const bareModel = stripProviderPrefix(modelId);
  const normalizedBareModel = bareModel.toLowerCase();

  // 1. Exact match
  const normalizedExact = MODEL_CAPABILITIES[normalizedBareModel];
  if (hasProviderPrefix && normalizedExact) {
    return { ...DEFAULT_CAPABILITIES, ...normalizedExact };
  }
  const exact = MODEL_CAPABILITIES[bareModel];
  if (exact) {
    return { ...DEFAULT_CAPABILITIES, ...exact };
  }
  if (normalizedExact) {
    return { ...DEFAULT_CAPABILITIES, ...normalizedExact };
  }

  // 2. Prefix/family match (longest prefix wins — patterns are ordered by specificity)
  for (const { prefix, capabilities } of FAMILY_PATTERNS) {
    if (normalizedBareModel.startsWith(prefix)) {
      return { ...DEFAULT_CAPABILITIES, ...capabilities };
    }
  }

  // 3. Infer provider from model name for basic defaults
  if (normalizedBareModel.startsWith('claude')) {
    return { ...DEFAULT_CAPABILITIES, provider: 'anthropic', supportsVision: true };
  }
  if (normalizedBareModel.startsWith('gpt-4')) {
    return { ...DEFAULT_CAPABILITIES, provider: 'openai', supportsVision: true };
  }
  if (normalizedBareModel.startsWith('gemini')) {
    return { ...DEFAULT_CAPABILITIES, provider: 'google', supportsVision: true };
  }

  return { ...DEFAULT_CAPABILITIES };
}

/**
 * Check if a model is a reasoning model that uses max_completion_tokens
 * instead of max_tokens.
 */
export function isReasoningModel(modelId: string): boolean {
  return getModelCapabilities(modelId).isReasoningModel;
}

/**
 * Check if a model supports extended thinking (Anthropic).
 */
export function supportsThinking(modelId: string): boolean {
  return getModelCapabilities(modelId).supportsThinking;
}

/**
 * Check if a model supports the reasoning_effort parameter (GPT-5).
 */
export function supportsReasoningEffort(modelId: string): boolean {
  return getModelCapabilities(modelId).supportsReasoningEffort;
}

/**
 * Get the maximum output tokens for a model.
 */
export function getMaxOutputTokens(modelId: string): number {
  return getModelCapabilities(modelId).maxOutputTokens;
}

/**
 * Get the context window size for a model.
 */
export function getContextWindow(modelId: string): number {
  return getModelCapabilities(modelId).contextWindow;
}

function isDateSuffixedAlias(baseModel: string, registryKey: string): boolean {
  if (!registryKey.startsWith(`${baseModel}-`)) {
    return false;
  }

  const suffix = registryKey.slice(baseModel.length + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^\d{8}$/.test(suffix);
}

/**
 * Get the full registry entry for a model (hyperParameters, capabilities, etc.)
 * from the main model registry.
 *
 * Returns null if the model is not in the registry.
 */
export function getModelRegistryKey(modelId: string): string | null {
  const providerSpecificKey = findProviderSpecificRegistryKey(modelId);
  if (providerSpecificKey) {
    return providerSpecificKey;
  }

  const exactRegistryMatch = exactRegistryKey(modelId.trim());
  if (exactRegistryMatch) {
    return exactRegistryMatch;
  }

  const hasProviderPrefix = modelId.includes('/');
  const bareModel = stripProviderPrefix(modelId);
  const normalizedBareModel = bareModel.toLowerCase();

  // Exact match
  if (hasProviderPrefix && MAIN_REGISTRY[normalizedBareModel]) {
    return normalizedBareModel;
  }
  if (MAIN_REGISTRY[bareModel]) {
    return bareModel;
  }
  if (MAIN_REGISTRY[normalizedBareModel]) {
    return normalizedBareModel;
  }

  const registryKeys = Object.keys(MAIN_REGISTRY);

  // Prefix match — find the longest registered base model that matches the input
  // (e.g. "gpt-4o-2024-08-06" matches "gpt-4o").
  let bestMatch: string | null = null;
  let bestLen = 0;
  for (const key of registryKeys) {
    if (normalizedBareModel.startsWith(key.toLowerCase()) && key.length > bestLen) {
      bestMatch = key;
      bestLen = key.length;
    }
  }

  if (bestMatch) {
    return bestMatch;
  }

  // Reverse alias match — allow a bare family ID to resolve to a single dated variant
  // without turning arbitrary partial prefixes like "gpt-4" into a registry hit.
  const reverseDateAliases = registryKeys.filter((key) =>
    isDateSuffixedAlias(normalizedBareModel, key.toLowerCase()),
  );
  if (reverseDateAliases.length === 1) {
    return reverseDateAliases[0]!;
  }

  return null;
}

export function getModelRegistryEntry(modelId: string): ModelRegistryEntry | null {
  const key = getModelRegistryKey(modelId);
  return key ? MAIN_REGISTRY[key] : null;
}

function hasParameterIdentity(param: HyperParameter, names: readonly string[]): boolean {
  return names.includes(param.name) || names.includes(param.unifiedParam);
}

function filterHyperParameterTree(
  parameters: HyperParameter[],
  capabilities: ModelCapabilities,
): HyperParameter[] {
  return parameters.flatMap((param) => {
    if (capabilities.temperatureDisabled && hasParameterIdentity(param, ['temperature'])) {
      return [];
    }
    if (capabilities.topPDisabled && hasParameterIdentity(param, ['topP', 'top_p'])) {
      return [];
    }
    if (
      !capabilities.supportsReasoningEffort &&
      hasParameterIdentity(param, ['reasoningEffort', 'reasoning_effort', 'effort'])
    ) {
      return [];
    }

    const isThinkingParam =
      param.name === 'thinking' ||
      param.unifiedParam === 'thinking' ||
      param.unifiedParam.startsWith('thinking.') ||
      hasParameterIdentity(param, [
        'enableThinking',
        'enable_thinking',
        'thinking.enabled',
        'thinkingBudget',
        'thinking_budget',
        'budget_tokens',
        'budgetTokens',
        'thinking.budget_tokens',
      ]);
    if (!capabilities.supportsThinking && !capabilities.supportsThinkingBudget && isThinkingParam) {
      return [];
    }

    const options = param.options
      ? filterHyperParameterTree(param.options, capabilities)
      : undefined;
    const hyperParameters = param.hyperParameters
      ? filterHyperParameterTree(param.hyperParameters, capabilities)
      : undefined;

    if (
      (param.type === 'radioButton' && options?.length === 0) ||
      (param.type === 'section' && hyperParameters?.length === 0)
    ) {
      return [];
    }

    return [
      {
        ...param,
        ...(options ? { options } : {}),
        ...(hyperParameters ? { hyperParameters } : {}),
      },
    ];
  });
}

/**
 * Get hyperparameters for a model from the registry.
 * Returns an empty array for unknown models.
 */
export function getHyperParameters(modelId: string): HyperParameter[] {
  const entry = getModelRegistryEntry(modelId);
  if (!entry) return [];
  return filterHyperParameterTree(entry.hyperParameters, getModelCapabilities(modelId));
}
