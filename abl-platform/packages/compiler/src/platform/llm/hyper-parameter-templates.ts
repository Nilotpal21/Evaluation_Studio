/**
 * Hyper-Parameter Templates
 *
 * Reusable factory functions for creating common HyperParameter definitions.
 * These templates ensure consistency across MODEL_REGISTRY entries and reduce
 * duplication when adding new models.
 *
 * Usage:
 * ```typescript
 * hyperParameters: [
 *   createTemperatureParam(0, 1, 0.7),  // Anthropic range
 *   createMaxTokensParam(8192, 2048),
 *   createTopPParam(1.0),
 *   ...
 * ]
 * ```
 */

import type { HyperParameter } from './model-registry.js';

// =============================================================================
// CORE SAMPLING PARAMETERS
// =============================================================================

/**
 * Temperature parameter (controls randomness)
 * - Anthropic: 0-1
 * - OpenAI/Gemini: 0-2
 * - Mistral/Cohere: 0-1
 */
export const createTemperatureParam = (
  min: number = 0,
  max: number = 1,
  defaultValue: number = 0.7,
): HyperParameter => ({
  type: 'rangeSlider',
  name: 'temperature',
  unifiedParam: 'temperature',
  displayName: 'Temperature',
  min,
  max,
  step: 0.1,
  defaultValue,
  required: false,
  description: `Controls randomness in output (${min}: deterministic, ${max}: creative)`,
});

/**
 * Max output tokens parameter
 * @param max - Maximum tokens allowed by the model
 * @param defaultValue - Default value (typically 2048-4096)
 */
export const createMaxTokensParam = (max: number, defaultValue: number): HyperParameter => ({
  type: 'rangeSlider',
  name: 'maxTokens',
  unifiedParam: 'maxTokens',
  displayName: 'Max Output Tokens',
  min: 1,
  max,
  step: max > 10000 ? 512 : 256,
  defaultValue,
  required: false,
  description: `Maximum tokens in response (max: ${max})`,
});

/**
 * Top P (nucleus sampling) parameter
 * Range: 0-1 for all providers
 */
export const createTopPParam = (defaultValue: number = 1.0): HyperParameter => ({
  type: 'rangeSlider',
  name: 'topP',
  unifiedParam: 'topP',
  displayName: 'Top P',
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue,
  required: false,
  description: 'Nucleus sampling threshold (0: focused, 1: diverse)',
});

/**
 * Top K parameter (only for Google, Fireworks, Together AI)
 * @param max - Maximum K value (typically 40-100)
 * @param defaultValue - Default value (typically 40)
 */
export const createTopKParam = (max: number = 40, defaultValue: number = 40): HyperParameter => ({
  type: 'rangeSlider',
  name: 'topK',
  unifiedParam: 'topK',
  displayName: 'Top K',
  min: 1,
  max,
  step: 1,
  defaultValue,
  required: false,
  description: 'Number of top tokens to sample from',
});

/**
 * Frequency Penalty parameter (OpenAI, Groq, Fireworks, DeepSeek, xAI)
 * @param min - Minimum value (typically -2)
 * @param max - Maximum value (typically 2)
 */
export const createFrequencyPenaltyParam = (min: number = -2, max: number = 2): HyperParameter => ({
  type: 'rangeSlider',
  name: 'frequencyPenalty',
  unifiedParam: 'frequencyPenalty',
  displayName: 'Frequency Penalty',
  min,
  max,
  step: 0.1,
  defaultValue: 0,
  required: false,
  description: 'Penalize tokens based on frequency in output (-: encourage, +: discourage)',
});

/**
 * Presence Penalty parameter (OpenAI, Groq, Fireworks, DeepSeek, xAI)
 * @param min - Minimum value (typically -2)
 * @param max - Maximum value (typically 2)
 */
export const createPresencePenaltyParam = (min: number = -2, max: number = 2): HyperParameter => ({
  type: 'rangeSlider',
  name: 'presencePenalty',
  unifiedParam: 'presencePenalty',
  displayName: 'Presence Penalty',
  min,
  max,
  step: 0.1,
  defaultValue: 0,
  required: false,
  description: 'Penalize tokens based on presence in output (-: encourage, +: discourage)',
});

/**
 * Repetition Penalty parameter (Together AI)
 * Range: 0-2, default 1.0
 */
export const createRepetitionPenaltyParam = (): HyperParameter => ({
  type: 'rangeSlider',
  name: 'repetitionPenalty',
  unifiedParam: 'repetitionPenalty',
  displayName: 'Repetition Penalty',
  min: 0,
  max: 2,
  step: 0.1,
  defaultValue: 1.0,
  required: false,
  description: 'Penalize token repetition (1.0: no penalty, >1.0: discourage)',
});

/**
 * Seed parameter for deterministic outputs
 * Supported by: OpenAI, Anthropic, Mistral, Groq, xAI
 */
export const createSeedParam = (): HyperParameter => ({
  type: 'text',
  name: 'seed',
  unifiedParam: 'seed',
  displayName: 'Seed',
  required: false,
  placeholder: 'Random seed for reproducibility',
  description: 'Integer seed for deterministic outputs',
});

/**
 * Stop sequences parameter
 * Supported by most providers except Perplexity (without tools)
 */
export const createStopSequencesParam = (): HyperParameter => ({
  type: 'textArea',
  name: 'stop',
  unifiedParam: 'stop',
  displayName: 'Stop Sequences',
  required: false,
  placeholder: 'Comma-separated stop sequences',
  description: 'Stop generation when these sequences are encountered',
});

// =============================================================================
// REASONING PARAMETERS
// =============================================================================

/**
 * Reasoning Effort parameter (OpenAI o3/o4, Azure GPT-5.1, Groq)
 * @param levels - Effort levels (e.g., ['low', 'medium', 'high'])
 * @param defaultValue - Default effort level
 * @param includeNone - Include 'none' option (for Azure GPT-5.1)
 */
export const createReasoningEffortParam = (
  levels: string[] = ['low', 'medium', 'high'],
  defaultValue: string = 'medium',
  includeNone: boolean = false,
): HyperParameter => ({
  type: 'dropdown',
  name: 'reasoning_effort',
  unifiedParam: 'reasoning_effort',
  displayName: 'Reasoning Effort',
  valueMap: includeNone ? ['none', ...levels] : levels,
  defaultValue,
  required: false,
  description: 'Controls reasoning depth (low: faster, high: more thorough)',
});

/**
 * Thinking Budget parameter (Anthropic Claude 4.5/4.1)
 * Min: 1024 tokens
 * @param min - Minimum budget (default 1024)
 * @param max - Maximum budget (default 10000)
 * @param defaultValue - Default budget (default 2048)
 */
export const createThinkingBudgetParam = (
  min: number = 1024,
  max: number = 10000,
  defaultValue: number = 2048,
): HyperParameter => ({
  type: 'rangeSlider',
  name: 'budget_tokens',
  unifiedParam: 'thinking.budget_tokens',
  displayName: 'Thinking Budget (tokens)',
  min,
  max,
  step: 256,
  defaultValue,
  required: false,
  description: `Token budget for thinking process (minimum ${min})`,
});

/**
 * Thinking Section with toggle + budget (Anthropic Claude 4.5/4.1)
 * Wraps thinking toggle and budget_tokens in a collapsible section
 */
export const createThinkingSection = (
  budgetMin: number = 1024,
  budgetMax: number = 10000,
  budgetDefault: number = 2048,
): HyperParameter => ({
  type: 'section',
  name: 'thinking',
  unifiedParam: 'thinking',
  displayName: 'Extended Thinking',
  description: 'Enable extended thinking mode for complex reasoning',
  required: false,
  hyperParameters: [
    {
      type: 'toggle',
      name: 'enabled',
      unifiedParam: 'thinking.enabled',
      displayName: 'Enable Thinking',
      defaultValue: false,
      required: false,
      description: 'Activate extended thinking mode',
    },
    createThinkingBudgetParam(budgetMin, budgetMax, budgetDefault),
  ],
});

/**
 * Thinking Level parameter (Gemini 3 variants)
 * @param levels - Available levels (model-specific)
 * @param defaultValue - Default level
 *
 * Model variants:
 * - Gemini 3.1 Pro: ['low', 'medium', 'high']
 * - Gemini 3 Pro: ['low', 'high']
 * - Gemini 3 Flash: ['off', 'low', 'medium', 'high']
 */
export const createThinkingLevelParam = (
  levels: string[],
  defaultValue: string,
): HyperParameter => ({
  type: 'dropdown',
  name: 'thinkingLevel',
  unifiedParam: 'thinkingLevel',
  displayName: 'Thinking Level',
  valueMap: levels,
  defaultValue,
  required: false,
  description: 'Thinking depth for reasoning tasks',
});

/**
 * Thinking Budget parameter (Gemini 2.5)
 * Integer value, 0 = disabled
 */
export const createGeminiThinkingBudgetParam = (): HyperParameter => ({
  type: 'rangeSlider',
  name: 'thinkingBudget',
  unifiedParam: 'thinkingBudget',
  displayName: 'Thinking Budget (tokens)',
  min: 0,
  max: 10000,
  step: 100,
  defaultValue: 0,
  required: false,
  description: 'Token budget for thinking (0 = disabled)',
});

// =============================================================================
// PERPLEXITY-SPECIFIC PARAMETERS
// =============================================================================

/**
 * Search Domain Filter (Perplexity online models)
 * Array of domains to restrict search to
 */
export const createSearchDomainFilterParam = (): HyperParameter => ({
  type: 'textArea',
  name: 'search_domain_filter',
  unifiedParam: 'search_domain_filter',
  displayName: 'Search Domain Filter',
  required: false,
  placeholder: 'Comma-separated domains (e.g., github.com, stackoverflow.com)',
  description: 'Restrict web search to specific domains',
});

/**
 * Return Citations toggle (Perplexity online models)
 */
export const createReturnCitationsParam = (): HyperParameter => ({
  type: 'toggle',
  name: 'return_citations',
  unifiedParam: 'return_citations',
  displayName: 'Return Citations',
  defaultValue: true,
  required: false,
  description: 'Include source citations in the response',
});

/**
 * Return Images toggle (Perplexity online models)
 */
export const createReturnImagesParam = (): HyperParameter => ({
  type: 'toggle',
  name: 'return_images',
  unifiedParam: 'return_images',
  displayName: 'Return Images',
  defaultValue: false,
  required: false,
  description: 'Include relevant images in search results',
});

// =============================================================================
// STANDARD PARAMETER SETS
// =============================================================================

/**
 * Standard full parameter set (Anthropic, Mistral, Cohere)
 * Temperature: 0-1, includes penalties and stop sequences
 */
export const STANDARD_PARAMS_FULL = (
  maxTokens: number = 4096,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 1, 0.7),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createFrequencyPenaltyParam(-2, 2),
  createPresencePenaltyParam(-2, 2),
  createStopSequencesParam(),
  createSeedParam(),
];

/**
 * Restricted parameter set (OpenAI o1/o3/o4, DeepSeek reasoning models)
 * ONLY maxTokens and seed — no temperature, topP, penalties
 */
export const STANDARD_PARAMS_RESTRICTED = (maxTokens: number = 4096): HyperParameter[] => [
  createMaxTokensParam(maxTokens, Math.min(2048, maxTokens)),
  createSeedParam(),
];

/**
 * OpenAI full parameter set (GPT-4/4o/3.5)
 * Temperature: 0-2, includes penalties and stop sequences
 */
export const OPENAI_PARAMS_FULL = (
  maxTokens: number = 16384,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createFrequencyPenaltyParam(-2, 2),
  createPresencePenaltyParam(-2, 2),
  createStopSequencesParam(),
  createSeedParam(),
];

/**
 * Gemini full parameter set (Gemini 1.x, 2.x non-reasoning)
 * Temperature: 0-2 (default 1.0), includes topK
 */
export const GEMINI_PARAMS_FULL = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.95),
  createTopKParam(40, 40),
  createStopSequencesParam(),
];

/**
 * Groq parameter set (OpenAI-compatible)
 * Temperature: 0-2, includes penalties and seed
 */
export const GROQ_PARAMS_FULL = (
  maxTokens: number = 32768,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createFrequencyPenaltyParam(-2, 2),
  createPresencePenaltyParam(-2, 2),
  createStopSequencesParam(),
  createSeedParam(),
];

/**
 * Fireworks parameter set
 * Temperature: 0-2, includes topK and penalties
 */
export const FIREWORKS_PARAMS_FULL = (
  maxTokens: number = 16384,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createTopKParam(100, 50),
  createFrequencyPenaltyParam(-2, 2),
  createPresencePenaltyParam(-2, 2),
  createStopSequencesParam(),
];

/**
 * Together AI parameter set
 * Temperature: 0-2 (default 0.7), includes topK and repetition_penalty
 */
export const TOGETHER_AI_PARAMS_FULL = (
  maxTokens: number = 16384,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 0.7),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.7),
  createTopKParam(100, 50),
  createRepetitionPenaltyParam(),
  createStopSequencesParam(),
];

/**
 * Perplexity online model parameters
 * Includes web search parameters (search_domain_filter, return_citations, return_images)
 */
export const PERPLEXITY_ONLINE_PARAMS = (
  maxTokens: number = 127072,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 0.2),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.9),
  createTopKParam(2048, 0),
  createFrequencyPenaltyParam(1, 2),
  createPresencePenaltyParam(0, 2),
  createSearchDomainFilterParam(),
  createReturnCitationsParam(),
  createReturnImagesParam(),
];

/**
 * Perplexity chat model parameters (no web search)
 */
export const PERPLEXITY_CHAT_PARAMS = (
  maxTokens: number = 127072,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 0.2),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.9),
  createTopKParam(2048, 0),
  createFrequencyPenaltyParam(1, 2),
  createPresencePenaltyParam(0, 2),
];

/**
 * DeepSeek chat/coder model parameters
 * Temperature: 0-2, includes penalties
 */
export const DEEPSEEK_PARAMS_FULL = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createFrequencyPenaltyParam(-2, 2),
  createPresencePenaltyParam(-2, 2),
  createStopSequencesParam(),
];

/**
 * xAI (Grok) parameter set
 * Temperature: 0-2, frequency/presence penalty: 0-1 (different range!)
 */
export const XAI_PARAMS_FULL = (
  maxTokens: number = 131072,
  defaultTokens: number = 4096,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createFrequencyPenaltyParam(0, 1),
  createPresencePenaltyParam(0, 1),
  createStopSequencesParam(),
  createSeedParam(),
];

// =============================================================================
// REASONING MODEL PARAMETER SETS
// =============================================================================

/**
 * OpenAI o3/o4 reasoning models
 * Restricted parameters + reasoning_effort
 */
export const OPENAI_O3_O4_PARAMS = (maxTokens: number = 100000): HyperParameter[] => [
  createMaxTokensParam(maxTokens, Math.min(4096, maxTokens)),
  createReasoningEffortParam(['low', 'medium', 'high'], 'medium', false),
  createSeedParam(),
];

/**
 * OpenAI o1 reasoning models
 * Restricted parameters ONLY (no reasoning_effort)
 */
export const OPENAI_O1_PARAMS = (maxTokens: number = 100000): HyperParameter[] => [
  createMaxTokensParam(maxTokens, Math.min(4096, maxTokens)),
  createSeedParam(),
];

/**
 * Azure GPT-5.1 reasoning parameters
 * Includes reasoning_effort with 'none' option (explicit default)
 */
export const AZURE_GPT51_PARAMS = (maxTokens: number = 100000): HyperParameter[] => [
  createMaxTokensParam(maxTokens, Math.min(4096, maxTokens)),
  createReasoningEffortParam(['low', 'medium', 'high'], 'none', true),
  createSeedParam(),
];

/**
 * Claude 4.5/4.1 with thinking
 * Full parameters + thinking section
 */
export const CLAUDE_45_41_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 1, 0.7),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(1.0),
  createStopSequencesParam(),
  createSeedParam(),
  createThinkingSection(1024, 10000, 2048),
];

/**
 * Gemini 3.1 Pro with thinkingLevel
 */
export const GEMINI_31_PRO_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.95),
  createTopKParam(40, 40),
  createStopSequencesParam(),
  createThinkingLevelParam(['low', 'medium', 'high'], 'medium'),
];

/**
 * Gemini 3 Pro with thinkingLevel (subset)
 */
export const GEMINI_3_PRO_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.95),
  createTopKParam(40, 40),
  createStopSequencesParam(),
  createThinkingLevelParam(['low', 'high'], 'low'),
];

/**
 * Gemini 3 Flash with thinkingLevel (all 4 levels)
 */
export const GEMINI_3_FLASH_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.95),
  createTopKParam(40, 40),
  createStopSequencesParam(),
  createThinkingLevelParam(['off', 'low', 'medium', 'high'], 'low'),
];

/**
 * Gemini 2.5 with thinkingBudget
 */
export const GEMINI_25_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
): HyperParameter[] => [
  createTemperatureParam(0, 2, 1.0),
  createMaxTokensParam(maxTokens, defaultTokens),
  createTopPParam(0.95),
  createTopKParam(40, 40),
  createStopSequencesParam(),
  createGeminiThinkingBudgetParam(),
];

// =============================================================================
// AWS BEDROCK PARAMETERS
// =============================================================================

/**
 * Bedrock Guardrails Configuration Section
 * AWS-specific content moderation and safety controls
 */
export const createBedrockGuardrailsSection = (): HyperParameter => ({
  type: 'section',
  name: 'guardrailConfig',
  unifiedParam: 'guardrailConfig',
  displayName: 'Guardrails (AWS Bedrock)',
  description: 'AWS Bedrock guardrails for content moderation',
  required: false,
  hyperParameters: [
    {
      type: 'text',
      name: 'guardrailIdentifier',
      unifiedParam: 'guardrailConfig.guardrailIdentifier',
      displayName: 'Guardrail ID',
      required: false,
      placeholder: 'e.g., abc123xyz',
      description: 'Guardrail identifier from AWS Bedrock console',
    },
    {
      type: 'text',
      name: 'guardrailVersion',
      unifiedParam: 'guardrailConfig.guardrailVersion',
      displayName: 'Guardrail Version',
      required: false,
      placeholder: 'e.g., 1 or DRAFT',
      description: 'Version of the guardrail to use',
    },
    {
      type: 'toggle',
      name: 'trace',
      unifiedParam: 'guardrailConfig.trace',
      displayName: 'Enable Trace',
      defaultValue: false,
      required: false,
      description: 'Enable trace for guardrail execution',
    },
  ],
});

/**
 * Bedrock Reasoning Configuration (Claude 3.7/4 on Bedrock)
 * Uses budgetTokens with Bedrock-specific range (1024-64000)
 */
export const createBedrockReasoningConfig = (
  min: number = 1024,
  max: number = 64000,
  defaultValue: number = 2048,
): HyperParameter => ({
  type: 'section',
  name: 'reasoningConfig',
  unifiedParam: 'reasoningConfig',
  displayName: 'Reasoning Configuration',
  description: 'Bedrock-specific reasoning configuration',
  required: false,
  hyperParameters: [
    {
      type: 'rangeSlider',
      name: 'budgetTokens',
      unifiedParam: 'reasoningConfig.budgetTokens',
      displayName: 'Budget Tokens',
      min,
      max,
      step: 1024,
      defaultValue,
      required: false,
      description: `Token budget for thinking (Bedrock range: ${min}-${max})`,
    },
  ],
});

/**
 * Bedrock Claude parameters (Claude models on AWS Bedrock)
 * Includes standard Claude parameters + Bedrock-specific guardrails
 */
export const BEDROCK_CLAUDE_PARAMS = (
  maxTokens: number = 8192,
  defaultTokens: number = 2048,
  includeGuardrails: boolean = true,
): HyperParameter[] => {
  const params: HyperParameter[] = [
    createTemperatureParam(0, 1, 0.7),
    createMaxTokensParam(maxTokens, defaultTokens),
    createTopPParam(1.0),
    createStopSequencesParam(),
  ];

  if (includeGuardrails) {
    params.push(createBedrockGuardrailsSection());
  }

  return params;
};
