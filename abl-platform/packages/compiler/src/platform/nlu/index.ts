/**
 * NLU Engine - Public Exports
 *
 * Modular, contextual, multi-lingual NLU engine for the ABL runtime.
 */

// Core engine
export { NLUEngine } from './engine.js';
export type { EmbeddingIntentIndex } from './engine.js';

// Context builder
export { NLUContextBuilder } from './context-builder.js';

// Model routing
export { ModelRouter } from './model-router.js';

// Fallback layer
export {
  detectIntentFallback,
  classifyCategoryFallback,
  extractEntitiesFallback,
  detectCorrectionFallback,
  detectLanguageFallback,
} from './fallbacks.js';

// Language utilities
export {
  detectLanguage,
  LanguageSessionCache,
  getDateFormat,
  getDecimalSeparator,
  filterExamplesByLanguage,
} from './language.js';

// Metrics
export { InMemoryMetricsCollector } from './metrics.js';

// Plugins
export { NLUPluginPipeline } from './plugins.js';

// Prompt loading
export { loadPromptTemplate, renderTemplate, getEmbeddedPrompts } from './prompt-loader.js';

// Shared utilities
export { parseJSON, cosineSimilarity } from './utils.js';

// Pipeline
export { NLUTaskPipeline } from './pipeline.js';
export type { PipelineStep, PipelineHooks } from './pipeline.js';

// Task modules
export {
  createIntentSteps,
  DEFAULT_INTENT_RESULT,
  buildTemplateVars,
  createEntitySteps,
  DEFAULT_ENTITY_RESULT,
  createCategorySteps,
  DEFAULT_CATEGORY_RESULT,
  createCorrectionSteps,
  DEFAULT_CORRECTION_RESULT,
  detectDigression,
  DEFAULT_DIGRESSION_RESULT,
  detectSubIntent,
  detectLanguageFromContext,
  analyzeInputCombined,
} from './tasks/index.js';
export type { CombinedAnalyzerDeps } from './tasks/index.js';

// Configuration
export { buildNLUConfig, validateNLUConfig } from './config.js';
export type { NLUConfig } from './config.js';

// Enterprise
export {
  createPIIGuardHook,
  NLUResultCache,
  NLUCircuitBreaker,
  createAuditHook,
  NLUTenantManager,
  NLUVersionTracker,
} from './enterprise/index.js';
export type {
  NLUTenantContext,
  NLUAuditEvent,
  NLUAuditPort,
  NLUEncryptionPort,
  NLURateLimitResult,
  NLURateLimiterPort,
  NLUEnterprisePorts,
  NLUCacheStats,
} from './enterprise/index.js';

// Tenant-scoped metrics
export { TenantScopedMetrics } from './metrics.js';

// Embeddings
export { IntentEmbeddingIndex } from './embeddings/intent-index.js';
export { EntityEmbeddingIndex } from './embeddings/entity-index.js';
export { createEmbeddingProvider } from './embeddings/provider.js';

// Types (re-export everything)
export type {
  // Context
  NLUContext,
  ConversationTurn,
  ConversationPhase,
  DialogAct,

  // Definitions
  NLUDefinition,
  IntentDefinition,
  CategoryDefinition,
  EntityDefinition,
  FewShotExample,
  NLUModelConfig,
  NLUEvalConfig,
  NLUEmbeddingsConfig,

  // Configuration
  NLUEngineConfig,
  NLUModelLayerConfig,
  LLMProvider,
  NLUTask,
  NLULayer,

  // Results
  IntentResult,
  SubIntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  DigressionResult,
  LanguageResult,
  AnalysisResult,

  // Options
  IntentCandidate,
  SubIntentCandidate,
  DigressionCandidate,
  EntityField,
  AnalyzeOptions,

  // Plugins
  NLUPlugin,
  NLUPluginResult,

  // Metrics
  NLUMetricsCollector,
  NLUPredictionEvent,
  NLUMetrics,

  // Embeddings
  EmbeddingProvider,

  // Prompt
  PromptTemplate,

  // IR
  NLUIRConfig,
} from './types.js';
