/**
 * Agent Platform Module
 *
 * Complete platform for running agents across:
 * - Voice channels (low-latency, streaming)
 * - Digital channels (omni-channel, persistent)
 * - Workflow processes (HITL, durable)
 *
 * Includes:
 * - IR (Intermediate Representation) for framework-agnostic compilation
 * - Stores (Conversation, Trace, Audit, Agent Registry, Fact Store)
 * - Runtimes (Voice, Digital, Workflow)
 * - Constructs (Shared execution layer)
 */

// Core types (all foundational types)
export * from './core/index.js';

// IR schema and compiler
export * from './ir/index.js';

// Public contract metadata
export * from './contracts/index.js';

// Storage layer
export * from './stores/index.js';

// Construct execution layer
export * from './constructs/index.js';

// Distributed utilities (HLC, etc.)
export * from './distributed/index.js';

// Runtime engines - explicit exports to avoid conflicts
export {
  BaseRuntime,
  type BaseRuntimeConfig,
  type TenantContext,
  type BuildContextParams,
  TenantAccessError,
} from './runtimes/base-runtime.js';
export { VoiceRuntime, type VoiceRuntimeConfig } from './runtimes/voice-runtime.js';
export { DigitalRuntime, type DigitalRuntimeConfig } from './runtimes/digital-runtime.js';
export {
  WorkflowRuntime,
  type WorkflowRuntimeConfig,
  type Workflow,
  type HumanTask,
} from './runtimes/workflow-runtime.js';

// Security
export * from './security/index.js';

// NLU engine (explicit exports to avoid name conflicts with IR schema types)
export {
  NLUEngine,
  NLUContextBuilder,
  ModelRouter,
  NLUPluginPipeline,
  InMemoryMetricsCollector,
  IntentEmbeddingIndex,
  EntityEmbeddingIndex,
  createEmbeddingProvider,
  loadPromptTemplate,
  renderTemplate,
  getEmbeddedPrompts,
  detectIntentFallback,
  classifyCategoryFallback,
  extractEntitiesFallback,
  detectCorrectionFallback,
  detectLanguageFallback,
  detectLanguage,
  LanguageSessionCache,
  // New: utilities
  parseJSON,
  cosineSimilarity,
  // New: pipeline
  NLUTaskPipeline,
  // New: config
  buildNLUConfig,
  validateNLUConfig,
  // New: enterprise
  NLUResultCache,
  NLUCircuitBreaker,
  NLUTenantManager,
  NLUVersionTracker,
  TenantScopedMetrics,
  createPIIGuardHook,
  createAuditHook,
} from './nlu/index.js';

export type {
  NLUContext,
  ConversationTurn,
  ConversationPhase,
  DialogAct,
  NLUDefinition,
  IntentDefinition,
  CategoryDefinition,
  EntityDefinition,
  FewShotExample,
  NLUEngineConfig,
  NLUModelLayerConfig,
  LLMProvider,
  NLUTask,
  NLULayer,
  IntentResult,
  SubIntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  DigressionResult,
  LanguageResult,
  AnalysisResult,
  IntentCandidate,
  SubIntentCandidate,
  DigressionCandidate,
  EntityField,
  AnalyzeOptions,
  NLUPlugin,
  NLUPluginResult,
  NLUMetricsCollector,
  NLUPredictionEvent,
  NLUMetrics,
  EmbeddingProvider,
  PromptTemplate,
  // New: pipeline
  PipelineStep,
  PipelineHooks,
  // New: config
  NLUConfig,
  // New: enterprise
  NLUTenantContext,
  NLUAuditEvent,
  NLUAuditPort,
  NLUEncryptionPort,
  NLURateLimiterPort,
  NLUEnterprisePorts,
  NLUCacheStats,
} from './nlu/index.js';

// Structured logger
export { createLogger, setLogLevel, setLogHandler, redactSensitive } from './logger.js';
export type { LogLevel, LogEntry, Logger } from './logger.js';

// Constants
export * from './constants.js';

// Utilities
export * from './utils/index.js';

// Model Registry (explicit exports to avoid conflicts)
export {
  ModelRegistry,
  getModelRegistry,
  resetModelRegistry,
  type ModelInfo,
  type ModelCapabilities,
  type ModelPricing,
  type ModelLimits,
  type ModelPerformance,
  type TaskRequirements,
  type RoutingResult,
  type ModelFilter,
} from './model-registry/index.js';

// MCP (Model Context Protocol)
export {
  // Protocol types
  MCP_PROTOCOL_VERSION,
  MCPErrorCodes,
  type MCPMethod,
  type MCPTool,
  type MCPResource,
  type MCPPrompt,
  type MCPContent,
  type MCPTextContent,
  type MCPImageContent,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
  type ClientCapabilities,
  type ToolCallParams,
  type ToolCallResult,
  type ResourceReadResult,
  type PromptGetResult,
  // Client
  MCPClient,
  type MCPClientConfig,
  type MCPTransportType,
  // Server Manager
  MCPServerManager,
  getMCPServerManager,
  resetMCPServerManager,
  type MCPServerConfig,
  type MCPServerInfo,
  type MCPToolWithServer,
  type MCPResourceWithServer,
  type MCPPromptWithServer,
} from './mcp/index.js';
