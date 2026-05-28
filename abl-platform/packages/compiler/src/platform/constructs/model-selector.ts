/**
 * Model Selector
 *
 * Intelligently selects between Haiku (fast, simple tasks) and Sonnet (complex reasoning)
 * based on task complexity indicators.
 */

import type { AgentIR } from '../ir/schema.js';
import type { AgentState } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface ModelConfig {
  /** Model ID for the tier */
  modelId: string;
  /** Max tokens for this tier */
  maxTokens: number;
  /** Typical latency category */
  latency: 'fast' | 'medium' | 'slow';
  /** Cost tier (1 = cheapest) */
  costTier: number;
}

export interface ComplexityIndicators {
  /** Number of tools available */
  toolCount: number;
  /** Number of gathered fields */
  gatherFieldCount: number;
  /** Number of constraints */
  constraintCount: number;
  /** Whether multi-agent coordination is involved */
  hasCoordination: boolean;
  /** Whether flow mode is used */
  isScriptedMode: boolean;
  /** Number of conversation turns so far */
  conversationLength: number;
  /** Type of operation being performed */
  operationType: OperationType;
}

export type OperationType =
  | 'extraction' // Simple data extraction from user input
  | 'validation' // Checking constraints/conditions
  | 'tool_selection' // Deciding which tool to call
  | 'response_gen' // Generating natural language response
  | 'reasoning' // Complex multi-step reasoning
  | 'coordination'; // Agent handoff/delegation decisions

// =============================================================================
// MODEL CONFIGURATIONS
// =============================================================================

export const MODEL_CONFIGS: Record<ModelTier, ModelConfig> = {
  haiku: {
    modelId: 'claude-haiku-4-5-20251001',
    maxTokens: 256, // Reduced for faster responses
    latency: 'fast',
    costTier: 1,
  },
  sonnet: {
    modelId: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
    latency: 'medium',
    costTier: 2,
  },
  opus: {
    modelId: 'claude-opus-4-7',
    maxTokens: 4096,
    latency: 'slow',
    costTier: 3,
  },
};

// =============================================================================
// COMPLEXITY ANALYSIS
// =============================================================================

/**
 * Analyze complexity indicators from agent IR and current state
 */
export function analyzeComplexity(
  agentIR: AgentIR,
  state: AgentState,
  operationType: OperationType,
): ComplexityIndicators {
  return {
    toolCount: agentIR.tools?.length || 0,
    gatherFieldCount: agentIR.gather?.fields?.length || 0,
    constraintCount:
      (agentIR.constraints?.guardrails?.length || 0) +
      (agentIR.constraints?.constraints?.length || 0),
    hasCoordination:
      (agentIR.coordination?.delegates?.length || 0) > 0 ||
      (agentIR.coordination?.handoffs?.length || 0) > 0 ||
      agentIR.coordination?.escalation !== undefined,
    isScriptedMode: !!agentIR.flow,
    conversationLength: state.flowState?.stepHistory?.length || 0,
    operationType,
  };
}

/**
 * Configurable weights for complexity scoring
 */
export interface ComplexityWeights {
  /** Max points for tool count (0-25) */
  tool_none: number;
  tool_low: number;
  tool_medium: number;
  tool_high: number;
  tool_low_threshold: number;
  tool_medium_threshold: number;

  /** Max points for gather fields (0-15) */
  gather_low: number;
  gather_medium: number;
  gather_high: number;
  gather_low_threshold: number;
  gather_medium_threshold: number;

  /** Max points for constraints (0-15) */
  constraint_low: number;
  constraint_medium: number;
  constraint_high: number;
  constraint_low_threshold: number;
  constraint_medium_threshold: number;

  /** Points for coordination (0-20) */
  coordination: number;

  /** Points by operation type (0-25) */
  op_extraction: number;
  op_validation: number;
  op_tool_selection: number;
  op_response_gen: number;
  op_reasoning: number;
  op_coordination: number;
}

export const DEFAULT_COMPLEXITY_WEIGHTS: ComplexityWeights = {
  tool_none: 0,
  tool_low: 10,
  tool_medium: 15,
  tool_high: 25,
  tool_low_threshold: 2,
  tool_medium_threshold: 5,

  gather_low: 5,
  gather_medium: 10,
  gather_high: 15,
  gather_low_threshold: 3,
  gather_medium_threshold: 6,

  constraint_low: 5,
  constraint_medium: 10,
  constraint_high: 15,
  constraint_low_threshold: 2,
  constraint_medium_threshold: 5,

  coordination: 20,

  op_extraction: 5,
  op_validation: 10,
  op_tool_selection: 15,
  op_response_gen: 10,
  op_reasoning: 20,
  op_coordination: 25,
};

/**
 * Calculate a complexity score (0-100)
 */
export function calculateComplexityScore(
  indicators: ComplexityIndicators,
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
): number {
  let score = 0;

  // Tool complexity
  if (indicators.toolCount === 0) score += weights.tool_none;
  else if (indicators.toolCount <= weights.tool_low_threshold) score += weights.tool_low;
  else if (indicators.toolCount <= weights.tool_medium_threshold) score += weights.tool_medium;
  else score += weights.tool_high;

  // Gather complexity
  if (indicators.gatherFieldCount <= weights.gather_low_threshold) score += weights.gather_low;
  else if (indicators.gatherFieldCount <= weights.gather_medium_threshold)
    score += weights.gather_medium;
  else score += weights.gather_high;

  // Constraint complexity
  if (indicators.constraintCount <= weights.constraint_low_threshold)
    score += weights.constraint_low;
  else if (indicators.constraintCount <= weights.constraint_medium_threshold)
    score += weights.constraint_medium;
  else score += weights.constraint_high;

  // Coordination complexity
  if (indicators.hasCoordination) score += weights.coordination;

  // Operation type complexity
  switch (indicators.operationType) {
    case 'extraction':
      score += weights.op_extraction;
      break;
    case 'validation':
      score += weights.op_validation;
      break;
    case 'tool_selection':
      score += weights.op_tool_selection;
      break;
    case 'response_gen':
      score += weights.op_response_gen;
      break;
    case 'reasoning':
      score += weights.op_reasoning;
      break;
    case 'coordination':
      score += weights.op_coordination;
      break;
  }

  return Math.min(100, score);
}

// =============================================================================
// MODEL SELECTION
// =============================================================================

/**
 * Select the appropriate model tier based on complexity
 */
export function selectModelTier(
  indicators: ComplexityIndicators,
  preferences?: {
    preferSpeed?: boolean;
    preferAccuracy?: boolean;
    maxCostTier?: number;
  },
): ModelTier {
  const score = calculateComplexityScore(indicators);
  const { preferSpeed, preferAccuracy, maxCostTier } = preferences || {};

  // Determine base tier from complexity score
  let tier: ModelTier;
  if (score <= 30) {
    tier = 'haiku';
  } else if (score <= 60) {
    tier = 'sonnet';
  } else {
    tier = 'opus';
  }

  // Apply preferences
  if (preferSpeed && tier !== 'haiku') {
    // Downgrade for speed (but not for very complex tasks)
    if (score <= 50) tier = 'haiku';
    else if (score <= 75) tier = 'sonnet';
  }

  if (preferAccuracy && tier !== 'opus') {
    // Upgrade for accuracy
    if (tier === 'haiku') tier = 'sonnet';
    else tier = 'opus';
  }

  // Apply cost constraints
  if (maxCostTier !== undefined) {
    const config = MODEL_CONFIGS[tier];
    if (config.costTier > maxCostTier) {
      // Downgrade to meet cost constraint
      if (maxCostTier >= 2) tier = 'sonnet';
      else tier = 'haiku';
    }
  }

  return tier;
}

/**
 * Get model configuration for a tier
 */
export function getModelConfig(tier: ModelTier): ModelConfig {
  return MODEL_CONFIGS[tier];
}

/**
 * Select model based on agent IR and operation
 */
export function selectModel(
  agentIR: AgentIR,
  state: AgentState,
  operationType: OperationType,
  preferences?: {
    preferSpeed?: boolean;
    preferAccuracy?: boolean;
    maxCostTier?: number;
  },
): { tier: ModelTier; config: ModelConfig; complexityScore: number } {
  const indicators = analyzeComplexity(agentIR, state, operationType);
  const complexityScore = calculateComplexityScore(indicators);
  const tier = selectModelTier(indicators, preferences);
  const config = getModelConfig(tier);

  return { tier, config, complexityScore };
}

// =============================================================================
// CONVENIENCE FUNCTIONS FOR COMMON OPERATIONS
// =============================================================================

/**
 * Get model for extraction operations (typically Haiku)
 */
export function getExtractionModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'extraction', { preferSpeed: true }).config;
}

/**
 * Get model for validation operations (typically Haiku)
 */
export function getValidationModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'validation', { preferSpeed: true }).config;
}

/**
 * Get model for tool selection (Haiku or Sonnet based on tool count)
 */
export function getToolSelectionModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'tool_selection').config;
}

/**
 * Get model for response generation (typically Haiku)
 */
export function getResponseModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'response_gen', { preferSpeed: true }).config;
}

/**
 * Get model for complex reasoning (Sonnet or Opus)
 */
export function getReasoningModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'reasoning', { preferAccuracy: true }).config;
}

/**
 * Get model for coordination decisions (Sonnet or Opus)
 */
export function getCoordinationModel(agentIR: AgentIR, state: AgentState): ModelConfig {
  return selectModel(agentIR, state, 'coordination', { preferAccuracy: true }).config;
}

// =============================================================================
// DEFAULT MODEL HELPER
// =============================================================================

/**
 * Get the default model for tests (Haiku for speed/cost)
 */
export function getDefaultTestModel(): ModelConfig {
  return MODEL_CONFIGS.haiku;
}

/**
 * Get model by explicit tier name
 */
export function getModelByTier(tier: ModelTier): ModelConfig {
  return MODEL_CONFIGS[tier];
}
