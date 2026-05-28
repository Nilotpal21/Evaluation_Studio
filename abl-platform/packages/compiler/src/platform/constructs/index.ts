/**
 * Constructs Module
 *
 * Shared construct execution layer for all runtimes.
 * Provides consistent execution of DSL constructs across Voice, Digital, and Workflow runtimes.
 */

// =============================================================================
// TYPES
// =============================================================================

export type {
  // Core types
  ExecutionContext,
  ConstructResult,
  ConstructAction,
  AgentState,
  RuntimeType,

  // Action types
  ContinueAction,
  RespondAction,
  EscalateAction,
  HandoffAction,
  DelegateAction,
  CompleteAction,
  RetryAction,
  BlockAction,
  CollectAction,

  // State types
  MemoryState,
  FlowState,
  ErrorState,
  RememberAction,

  // Store context
  StoreContext,
  ConstructExecutionConfig,

  // External dependencies
  LLMClient,
  ToolExecutor,
  ConstructAgentRegistry,

  // LLM Tool Use types
  LLMToolDefinition,
  LLMToolCall,
  LLMToolResult,
  LLMToolUseResult,

  // Helper types
  ExtractionResult,
  ExtractionProvenance,
  ConstraintCheckResult,
  ExtractionPattern,

  // Executor interface
  ConstructExecutorInterface,

  // NLU engine interface (decoupled)
  NLUEngineInterface,
} from './types.js';

// =============================================================================
// TYPE GUARDS AND FACTORIES
// =============================================================================

export {
  // Factory functions
  createInitialState,
  continueAction,
  respondAction,
  escalateAction,
  handoffAction,
  completeAction,
  blockAction,
  collectAction,
} from './types.js';

// =============================================================================
// EVALUATOR
// =============================================================================

export {
  evaluateConditionDetailed,
  getNestedValue,
  setNestedValue,
  interpolateMessage,
  interpolateWithFallback,
  interpolateRichTemplate,
  interpolateVoiceConfig,
} from './evaluator.js';

export type { ConditionEvalDetail } from './evaluator.js';

// CEL dual-evaluator re-exports (preferred over legacy evaluator)
export {
  evaluateConditionDual,
  resolveValueDual,
  evaluateConditionDetailedDual,
  celMetrics,
} from './dual-evaluator.js';

// =============================================================================
// CONSTRAINT CORE (pure function — used by runtime constraint-checker)
// =============================================================================

export { checkConstraintsCore, ConstraintExecutor } from './executors/constraint-executor.js';
export type {
  ConstraintCheckInfo,
  ConstraintOptions,
  CheckConstraintsCoreOptions,
} from './executors/constraint-executor.js';

export { CompletionDetector } from './executors/complete-executor.js';
export type {
  CompletionCheckResult,
  CompletionCheckOptions,
  CompletionDetectionResult,
} from './executors/complete-executor.js';

export { HandoffExecutor } from './executors/handoff-executor.js';
export type {
  HandoffThreadInfo,
  HandoffSessionInfo,
  HandoffInput,
  HandoffValidationResult,
} from './executors/handoff-executor.js';
export {
  resolveAllowedHandoffTargets,
  normalizeHandoffTarget,
  normalizeConstraintHandoffTarget,
  collectHandoffTargetReferences,
} from './executors/handoff-authority.js';
export type {
  HandoffTargetAuthority,
  HandoffTargetReference,
} from './executors/handoff-authority.js';

export { DelegateExecutor } from './executors/delegate-executor.js';
export type {
  DelegateThreadInfo,
  DelegateSessionInfo,
  DelegateInput,
  DelegateValidationResult,
  DelegateMappedInput,
  DelegateConfig as DelegateExecutorConfig,
} from './executors/delegate-executor.js';

export { FlowExecutor } from './executors/flow-executor.js';
export type { FlowStepResolution, FlowResolveOptions } from './executors/flow-executor.js';

export { parseTimeoutString, isValidTimeoutString } from './executors/timeout-utils.js';

export { ReasoningExecutor as CompilerReasoningExecutor } from './executors/reasoning-executor.js';
export type {
  ReasoningConfig,
  ReasoningResult,
  ReasoningAction,
  ToolCallClassification,
  ToolExecutionCallback,
  ReasoningTraceCallback,
} from './executors/reasoning-executor.js';
export { resolveReasoningZoneEmptyMessageGate } from './executors/reasoning-zone-empty-message-gate.js';
export type {
  ReasoningZoneEmptyMessageGateDecision,
  ReasoningZoneEmptyMessageGateInput,
  ReasoningZoneEmptyMessageGateMode,
} from './executors/reasoning-zone-empty-message-gate.js';

export { GatherExecutor } from './executors/gather-executor.js';
export type {
  GatherExecutorConfig,
  GatherExecutorField,
  GatherCompletenessResult,
  GatherValidationResult,
  GatherStepResult,
} from './executors/gather-executor.js';

// =============================================================================
// GROUNDING VALIDATOR (pure functions)
// =============================================================================

export { validateGrounding, checkFieldGrounding } from './executors/grounding-validator.js';
export type {
  FieldGroundingConfig,
  GroundingCheckResult,
  GroundingResult,
} from './executors/grounding-validator.js';

// =============================================================================
// TOOL BINDING EXECUTORS
// =============================================================================

export {
  ToolBindingExecutor,
  createToolBindingExecutor,
  validateToolInputs,
} from './executors/tool-binding-executor.js';
export type {
  ToolBindingExecutorConfig,
  ToolCallerContext,
  ToolSessionContext,
} from './executors/tool-binding-executor.js';

export { composeMiddleware } from './executors/tool-middleware.js';
export type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
  ToolMiddleware,
} from './executors/tool-middleware.js';

export { loggingMiddleware, timingMiddleware } from './executors/builtin-middleware.js';

export { HttpToolExecutor } from './executors/http-tool-executor.js';

export { McpToolExecutor } from './executors/mcp-tool-executor.js';
export type { McpClientProvider, McpClient } from './executors/mcp-tool-executor.js';

export { SandboxToolExecutor } from './executors/sandbox-tool-executor.js';
export type { SandboxRunner } from './executors/sandbox-tool-executor.js';

export { GvisorSandboxRunner } from './executors/gvisor-sandbox-runner.js';
export { NoOpSandboxRunner } from './executors/noop-sandbox-runner.js';
export type {
  GvisorSandboxConfig,
  GvisorSessionContext,
  JwtSigner,
} from './executors/gvisor-sandbox-runner.js';

export { NoopSecretsProvider } from './executors/secrets-provider.js';
export type { SecretsProvider } from './executors/secrets-provider.js';

export { CircuitBreaker, RateLimiter } from './executors/http-resilience.js';

export {
  type ICircuitBreaker,
  type IRateLimiter,
  type ResilienceFactory,
  createDefaultResilienceFactory,
} from './executors/resilience-interfaces.js';
export {
  type TokenCache,
  type TokenCacheEntry,
  InMemoryTokenCache,
} from './executors/shared-token-cache.js';

// Trace scrubbing
export { scrubToolCallData, scrubTraceEvent, redactEndpoint } from './executors/trace-scrubber.js';

// Audit middleware
export { createAuditMiddleware } from './executors/audit-middleware.js';
export type { ToolAuditLogger, ToolAuditEntry } from './executors/audit-middleware.js';

// Shared scrub patterns (reusable across runtime + Studio + trace)
export {
  REDACTED,
  DEFAULT_SECRET_PATTERNS,
  SENSITIVE_HEADER_NAMES,
  scrubSecrets,
} from './executors/scrub-patterns.js';

// Identity tier gate middleware
export { createIdentityTierGateMiddleware } from './executors/identity-tier-gate-middleware.js';

// Secret safety middleware
export {
  createSecretScrubberMiddleware,
  createSecretValidationMiddleware,
  SecretNotFoundError,
  HttpAuthType,
} from './executors/sanitizer-middleware.js';

// Result validation
export {
  resultValidationMiddleware,
  validateResult,
} from './executors/result-validation-middleware.js';
export type { ValidationMode, ValidationError } from './executors/result-validation-middleware.js';

// Proxy resolver
export { ProxyResolver } from './executors/proxy-resolver.js';
export type { ProxyConfig, OrgProxyConfigRecord, DecryptFn } from './executors/proxy-resolver.js';

// =============================================================================
// MODEL SELECTION
// =============================================================================

export {
  MODEL_CONFIGS,
  analyzeComplexity,
  calculateComplexityScore,
  selectModelTier,
  getModelConfig,
  selectModel,
  getExtractionModel,
  getValidationModel,
  getToolSelectionModel,
  getResponseModel,
  getReasoningModel,
  getCoordinationModel,
  getDefaultTestModel,
  getModelByTier,
} from './model-selector.js';

export type {
  ModelTier,
  ModelConfig,
  ComplexityIndicators,
  OperationType,
} from './model-selector.js';

// =============================================================================
// FLOW UTILITY FUNCTIONS (Pure Helpers)
// =============================================================================

export {
  detectIntent,
  detectCorrection,
  CORRECTION_FIELD_UNKNOWN,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from './utils.js';

// =============================================================================
// SEMANTIC EXTRACTION HINTS (Pure Function)
// =============================================================================

export { buildSemanticHint } from './semantic-hints.js';
export type { SemanticHintInput } from './semantic-hints.js';
