/**
 * @abl/compiler
 *
 * Unified Agent ABL Compiler
 *
 * Compiles Agent ABL specifications into:
 * - Intermediate Representation (IR) - framework-agnostic compilation target
 * - TypeScript types and contracts for runtime execution
 */

// Export types
export type {
  IRCompilationOutput,
  AgentIR,
  SupervisorIR,
  VoiceConfigIR,
  RichContentIR,
  ActionSetIR,
  ActionElementIR,
  ActionHandlerIR,
  ActionHandlerActionIR,
  CarouselIR,
  CarouselCardIR,
} from './types.js';

// Export IR compiler directly
export {
  compileABLtoIR,
  autoGuardConstraint,
  extractVariableReferences,
  validateConstraintOperators,
  resolveConfigVariables,
  resolveEnvVariables,
} from './platform/ir/compiler.js';
export { mapProjectRuntimeConfigDocumentToIR } from './platform/ir/project-runtime-config.js';
export { compileBehaviorProfile } from './platform/ir/compile-behavior-profile.js';
export {
  collectAuthRequirements,
  mergeAuthRequirement,
  type CollectAuthRequirementsOptions,
  type AuthRequirementSource,
  type AuthRequirementSourceAgent,
  type AuthRequirementSourceTool,
  type MergeableAuthRequirement,
} from './platform/ir/auth-requirement-collector.js';

export type { CompilerOptions } from './platform/ir/compiler.js';
export {
  BUILTIN_FIELD_REFERENCE_VARS,
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  HANDOFF_ON_RETURN_ACTION_VALUES,
  HANDOFF_TIMEOUT_ACTION_VALUES,
  TOOL_SESSION_CONTEXT_PARAM_MAP,
  getAblContractRegistry,
  type ABLBuiltInFunctionCategoryDoc,
  type ABLBuiltInFunctionDoc,
  type ABLCompatibilityNoteDoc,
  type ABLContractRegistry,
  type ABLContractStability,
  type ABLConstructDoc,
  type ABLCoordinationActionDoc,
  type ABLHistoryStrategyDoc,
  type ABLLifecycleEventDoc,
  type ABLRuntimeSupport,
  type ABLStabilityTierDoc,
  type ABLSystemVariableDoc,
} from './platform/contracts/index.js';

// Validation exports
export { validateABL, validateIR } from './platform/ir/validate-ir.js';
export { validateCrossAgentRefs } from './platform/ir/validate-cross-agent.js';
export { validateFieldReferences } from './platform/ir/validate-field-refs.js';
export { validateInputMappings } from './platform/ir/validate-input-mappings.js';
export { validateRecallEvents } from './platform/ir/recall-validation.js';
export { VALIDATION_CODES } from './platform/ir/validation-types.js';
export type { ValidationDiagnostic } from './platform/ir/validation-types.js';

// Export platform module (runtimes, stores, IR)
export * as platform from './platform/index.js';

// Export construct shared types, evaluator, and pure functions (execution moved to runtime)
export {
  // Constraint executor and core function
  ConstraintExecutor,
  checkConstraintsCore,

  // Completion detector
  CompletionDetector,

  // Handoff executor
  HandoffExecutor,
  resolveAllowedHandoffTargets,
  normalizeHandoffTarget,
  normalizeConstraintHandoffTarget,
  collectHandoffTargetReferences,

  // Delegate executor
  DelegateExecutor,

  // Coordination config helpers
  parseTimeoutString,
  isValidTimeoutString,

  // Gather executor
  GatherExecutor,

  // Reasoning executor (compiler layer)
  CompilerReasoningExecutor,
  resolveReasoningZoneEmptyMessageGate,

  // Factory functions
  createInitialState,
  continueAction,
  respondAction,
  escalateAction,
  handoffAction,
  completeAction,
  blockAction,
  collectAction,

  // Evaluator
  evaluateConditionDetailed,
  interpolateMessage,
  interpolateRichTemplate,
  getNestedValue,
  setNestedValue,
} from './platform/constructs/index.js';

export type {
  // Core types
  ExecutionContext,
  ConstructResult,
  ConstructAction,
  AgentState,
  FlowState,
  ReasoningZoneEmptyMessageGateDecision,
  ReasoningZoneEmptyMessageGateInput,
  ReasoningZoneEmptyMessageGateMode,
  RuntimeType,
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

  // NLU engine interface (decoupled)
  NLUEngineInterface,

  // Evaluator detail types
  ConditionEvalDetail,

  // Constraint core types
  ConstraintCheckInfo,
  ConstraintOptions,
  CheckConstraintsCoreOptions,

  // Completion detector types
  CompletionCheckResult,
  CompletionCheckOptions,
  CompletionDetectionResult,

  // Handoff authority helpers
  HandoffTargetAuthority,
  HandoffTargetReference,

  // Reasoning executor types
  ReasoningConfig,
  ReasoningResult,
  ReasoningAction,
  ToolCallClassification,
  ToolExecutionCallback,
  ReasoningTraceCallback,
} from './platform/constructs/index.js';

// Export constants
export {
  TERMINAL_STEP,
  DEFAULT_FALLBACK_AGENT,
  DEFAULT_INTENT_CATEGORIES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_ESCALATION_TARGET,
  CONTEXT_SUMMARY_KEY,
  CONTEXT_STORED_PREFIX,
  CONTEXT_ERROR_KEY,
  CONTEXT_CORRECTION_KEY,
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
  SYSTEM_TOOL_FAN_OUT,
  SYSTEM_TOOL_SET_CONTEXT,
  SYSTEM_TOOL_RETURN_TO_PARENT,
  DEFAULT_MESSAGES,
  DEFAULT_CORRECTION_PATTERNS,
  CONFIG_VAR_PATTERN,
  MAX_CONFIG_VARIABLES_PER_PROJECT,
  MAX_CONFIG_VAR_VALUE_LENGTH,
  MAX_CONFIG_VAR_KEY_LENGTH,
  ESCALATION_FORMAT,
  SYSTEM_PROMPT_TEMPLATES,
  SYSTEM_TOOL_DESCRIPTIONS,
  ENTITY_EXTRACTION_PROMPT,
  FAN_OUT_MIN_TASKS,
  FAN_OUT_MAX_TASKS,
  ERROR_HANDLER_MAX_RETRIES,
  ERROR_HANDLER_MAX_BACKOFF_MS,
  DEFAULT_MAX_BACKTRACKS_PER_STEP,
  ESCALATION_REASON_MIN_LENGTH,
  ESCALATION_REASON_MAX_LENGTH,
  LIFECYCLE_PATTERNS,
  LEGACY_EVENT_ALIASES,
  DEFAULT_CONVERSATION_HISTORY_WINDOW,
  MAX_CONVERSATION_HISTORY_WINDOW,
} from './platform/constants.js';

// CEL evaluator and expression migration utilities
export { evaluateCel, evaluateCelCondition } from './platform/constructs/cel-evaluator.js';
export {
  evaluateConditionDual,
  resolveValueDual,
  evaluateConditionDetailedDual,
  celMetrics,
} from './platform/constructs/dual-evaluator.js';
export {
  isLegacyExpression,
  migrateExpression,
  normalizeExpression,
} from './platform/constructs/expression-migrator.js';
export { createAblCelEnvironment, ablCelEnvironment } from './platform/constructs/cel-functions.js';

// Export entity extraction utilities directly
export {
  extractEntitiesForFields,
  extractAllEntities,
  extractDates,
  extractNumbers,
  extractDestination,
  DEFAULT_DESTINATIONS,
} from './platform/utils/entity-extraction.js';

// Export security module
export {
  detectPII,
  redactPII,
  containsPII,
  PIIVault,
  maskValue,
} from './platform/security/index.js';

export type {
  PIIDetection,
  PIIDetectionResult,
  PIIType,
  PIIToken,
  PIIConsumer,
  TokenizeResult,
} from './platform/security/index.js';

// Guardrail pipeline and types
export { GuardrailPipelineImpl } from './platform/guardrails/pipeline.js';
export type {
  GuardrailContext,
  GuardrailPipelineResult,
  GuardrailViolation,
  PipelineMetrics,
} from './platform/guardrails/types.js';
export {
  createEmptyPipelineResult,
  isTerminalAction,
  addViolation,
} from './platform/guardrails/types.js';
export { Tier1Evaluator } from './platform/guardrails/tier1-evaluator.js';
export { Tier3Evaluator } from './platform/guardrails/tier3-evaluator.js';
export type { LLMEvalFunction } from './platform/guardrails/tier3-evaluator.js';
export {
  executeRedact,
  executeFix,
  executeFilter,
} from './platform/guardrails/action-executors.js';
export { applyActions } from './platform/guardrails/action-applier.js';
export { GuardrailProviderRegistry } from './platform/guardrails/provider-registry.js';
export type { ProviderRuntimeConfig } from './platform/guardrails/provider.js';
export type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from './platform/guardrails/provider.js';
export type {
  PipelinePolicy,
  GuardrailCachePort,
  CostCheckerPort,
  WebhookPort,
} from './platform/guardrails/pipeline.js';
export { CustomHTTPProvider } from './platform/guardrails/providers/custom-http.js';
export type { CustomHTTPProviderConfig } from './platform/guardrails/providers/custom-http.js';
export { OpenAIModerationProvider } from './platform/guardrails/providers/openai-moderation.js';
export type { OpenAIModerationProviderConfig } from './platform/guardrails/providers/openai-moderation.js';

// Export BaseRuntime and tenant types
export { BaseRuntime, TenantAccessError } from './platform/runtimes/base-runtime.js';

export type {
  BaseRuntimeConfig,
  TenantContext,
  BuildContextParams,
} from './platform/runtimes/base-runtime.js';

// Export NLU engine module
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
} from './platform/nlu/index.js';

export type {
  // NLU context
  NLUContext,
  ConversationTurn,
  ConversationPhase,
  DialogAct,

  // NLU definitions
  NLUDefinition,
  IntentDefinition,
  CategoryDefinition,
  EntityDefinition,
  FewShotExample,
  NLUModelConfig,
  NLUEvalConfig,
  NLUEmbeddingsConfig,

  // NLU configuration
  NLUEngineConfig,
  NLUModelLayerConfig,
  LLMProvider,
  NLUTask,
  NLULayer,

  // NLU results
  IntentResult,
  SubIntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  DigressionResult,
  LanguageResult,
  AnalysisResult,

  // NLU options
  IntentCandidate,
  SubIntentCandidate,
  DigressionCandidate,
  EntityField,
  AnalyzeOptions,

  // NLU plugins
  NLUPlugin,
  NLUPluginResult,

  // NLU metrics
  NLUMetricsCollector,
  NLUPredictionEvent,
  NLUMetrics,

  // Embeddings
  EmbeddingProvider,

  // Prompt
  PromptTemplate,

  // IR config
  NLUIRConfig,

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
} from './platform/nlu/index.js';

// Re-export platform types for convenience
export type {
  AgentIR as PlatformAgentIR,
  SupervisorIR as PlatformSupervisorIR,
  CompilationOutput,
  CompilationError,
  ToolDefinition,
  ToolParameter,
  GatherConfig,
  GatherField,
  GatherFieldSemantics,
  ValidationRule,
  HandoffConfig,
  ResolvedPassField,
  HistoryStrategy,
  HandoffReturnMapping,
  HandoffReturnHandler,
  ProjectCoordinationDefaults,
  RemoteAgentLocation,
  MemoryConfig as IRMemoryConfig,
  ConstraintConfig,
  Constraint,
  Guardrail,
  GuardrailKind,
  GuardrailTier,
  GuardrailAction,
  GuardrailActionType,
  SeverityLevel,
  FixStrategy,
  ConstraintAction,
  CoordinationConfig,
  ErrorHandlingConfig,
  FlowConfig,
  RuntimeHints,
  DeploymentHints,
  NLUIRConfig as PlatformNLUIRConfig,
  ExecutionConfig as IRExecutionConfig,
  OperationModelMap,
  HttpBindingIR,
  McpBindingIR,
  SandboxBindingIR,
  SearchAIBindingIR,
  WorkflowBindingIR,
  ToolAuthTypeIR,
  ConfigVariableResolution,
  BehaviorProfileIR,
  ResponseRulesIR,
  GatherProfileOverrides,
  FlowModificationsIR,
  FlowStepOverrideIR,
  AuthRequirementIR,
} from './platform/ir/schema.js';

// Tool binding executors
export {
  ToolBindingExecutor,
  createToolBindingExecutor,
} from './platform/constructs/executors/tool-binding-executor.js';
export type {
  ToolBindingExecutorConfig,
  ToolCallerContext,
  ToolSessionContext,
  NamespaceScopedSecretsFactory,
} from './platform/constructs/executors/tool-binding-executor.js';
export { HttpToolExecutor } from './platform/constructs/executors/http-tool-executor.js';
export { McpToolExecutor } from './platform/constructs/executors/mcp-tool-executor.js';
export type {
  McpClientProvider,
  McpClient,
} from './platform/constructs/executors/mcp-tool-executor.js';
export { SandboxToolExecutor } from './platform/constructs/executors/sandbox-tool-executor.js';
export type { SandboxRunner } from './platform/constructs/executors/sandbox-tool-executor.js';
export { GvisorSandboxRunner } from './platform/constructs/executors/gvisor-sandbox-runner.js';
export { NoOpSandboxRunner } from './platform/constructs/executors/noop-sandbox-runner.js';
export type {
  GvisorSandboxConfig,
  GvisorSessionContext,
  JwtSigner,
} from './platform/constructs/executors/gvisor-sandbox-runner.js';
export {
  NODEJS_RUNNER_HANDLER_TEMPLATE,
  NODEJS_MEMORY_MANAGER_TEMPLATE,
  NODEJS_MEMORY_MANAGER_FILENAME,
  PYTHON_RUNNER_HANDLER_TEMPLATE,
} from './platform/constructs/executors/lambda-handler-templates.js';
export { LambdaSandboxRunner } from './platform/constructs/executors/lambda-sandbox-runner.js';
export type {
  LambdaSandboxConfig,
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
  LambdaDeploymentStatus,
} from './platform/constructs/executors/lambda-sandbox-runner.js';
export { createSandboxRunner } from './platform/constructs/executors/sandbox-runner-factory.js';
export type { SandboxRunnerConfig } from './platform/constructs/executors/sandbox-runner-factory.js';
export { NoopSecretsProvider } from './platform/constructs/executors/secrets-provider.js';
export type { SecretsProvider } from './platform/constructs/executors/secrets-provider.js';
export { CircuitBreaker, RateLimiter } from './platform/constructs/executors/http-resilience.js';
export { ProxyResolver } from './platform/constructs/executors/proxy-resolver.js';
export type {
  ProxyConfig,
  OrgProxyConfigRecord,
  DecryptFn,
} from './platform/constructs/executors/proxy-resolver.js';
export {
  loggingMiddleware,
  timingMiddleware,
} from './platform/constructs/executors/builtin-middleware.js';
export {
  createAuditMiddleware,
  AuditSource,
} from './platform/constructs/executors/audit-middleware.js';
export type {
  ToolAuditLogger,
  ToolAuditEntry,
} from './platform/constructs/executors/audit-middleware.js';
export { createIdentityTierGateMiddleware } from './platform/constructs/executors/identity-tier-gate-middleware.js';
export {
  createSecretScrubberMiddleware,
  createSecretValidationMiddleware,
  SecretNotFoundError,
  HttpAuthType,
} from './platform/constructs/executors/sanitizer-middleware.js';
export {
  REDACTED,
  DEFAULT_SECRET_PATTERNS,
  SENSITIVE_HEADER_NAMES,
  scrubSecrets,
} from './platform/constructs/executors/scrub-patterns.js';
export type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './platform/constructs/executors/tool-middleware.js';
export { composeMiddleware } from './platform/constructs/executors/tool-middleware.js';
export {
  scrubToolCallData,
  scrubTraceEvent,
  redactEndpoint,
} from './platform/constructs/executors/trace-scrubber.js';

export { FlowExecutor } from './platform/constructs/executors/flow-executor.js';
export type {
  FlowStepResolution,
  FlowResolveOptions,
} from './platform/constructs/executors/flow-executor.js';

export type {
  Channel,
  Session,
  Message,
  Environment,
  AgentStatus,
  TraceContext,
  AuditLog,
} from './platform/core/types.js';
