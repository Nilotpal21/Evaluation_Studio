/**
 * @agent-platform/shared-kernel
 *
 * Pure types, constants, errors, and utilities.
 * Zero database or infrastructure dependencies.
 */

// ─── Core Errors ────────────────────────────────────────────────────────
export {
  AppError,
  ValidationError,
  ErrorCodes,
  toErrorResponse,
  errorToResponse,
  ok,
  err,
  sidecarKindToErrorCode,
  makeSidecarError,
  isSidecarOutageKind,
  type ErrorCode,
  type ErrorCodeEntry,
  type TaggedResult,
  type SidecarError,
  type SidecarErrorKind,
} from './errors.js';

// ─── ID Generation ──────────────────────────────────────────────────────
export { generateId, prefixedId, ids, otelTraceId, otelSpanId } from './id.js';

// ─── Slug & Naming ──────────────────────────────────────────────────────
export { slugify, AGENT_NAME_PATTERN, AGENT_NAME_MAX_LENGTH, validateAgentName } from './slug.js';
export { buildProjectAgentPath } from './project-agent-path.js';

// ─── Types ──────────────────────────────────────────────────────────────
export * from './types/index.js';
export * from './types/auth-context.js';
export type { Normalized } from './types/normalize.js';
export type { McpAuthConfig, McpAuthType } from './types/mcp-auth.js';
export { MCP_AUTH_TYPES } from './types/mcp-auth.js';
export type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
  NormalizedEnvironmentVariable,
} from './types/security.js';
export type { PaginatedResponse, ErrorResult, Result } from './types/repo-types.js';
export type {
  ResponseMessageMetadata,
  ResponseProvenance,
  ResponseProvenanceAccumulator,
  ResponseProvenanceKind,
} from './response-provenance.js';
export {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  classifyLlmTraceVisibility,
  classifyLlmTraceForDisclosure,
  createResponseProvenanceAccumulator,
  extractLlmTraceMetrics,
} from './response-provenance.js';

// ─── Error Handling Utilities ───────────────────────────────────────────
export {
  getErrorMessage,
  getErrorStack,
  toErrorResult,
  ToolExecutionError,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  OAUTH_TOKEN_TIMEOUT_MS,
  MCP_RETRY_DELAY_BASE_MS,
} from './utils/errors.js';
export type { ToolErrorCode } from './utils/errors.js';

// ─── Generic Utilities ──────────────────────────────────────────────────
export { safeJsonParse, isRecord } from './utils/type-guards.js';
export { normalizeDocument } from './utils/normalize.js';
export { computeSourceHash } from './utils/hash.js';
export { compareSemverDesc } from './utils/semver-compare.js';
export {
  normalizeHttpAuthConfig,
  type HttpAuthConfigInput,
  type NormalizeHttpAuthConfigOptions,
} from './utils/http-auth-config-normalizer.js';

// ─── Security ──────────────────────────────────────────────────────────
export { assertUrlSafeForSSRF } from './security/ssrf-validator.js';
// NOTE: safeFetch / SSRFError / SafeFetchOptions / SafeFetchResolution live at
// the dedicated subpath `@agent-platform/shared-kernel/security/safe-fetch`
// because they import `node:dns/promises`, `node:http`, `node:https` at module
// top level. Re-exporting them from this root barrel pulls those modules into
// every consumer's bundle — including Studio's client bundle, which breaks
// Turbopack codegen ("the chunking context (unknown) does not support
// external modules"). Server-side callers must import from the subpath.

// ─── Gather Interrupt Traces ───────────────────────────────────────────
export {
  GATHER_INTERRUPT_CANDIDATE_SURFACE_KINDS,
  GATHER_INTERRUPT_DETECTION_MODES,
  GATHER_INTERRUPT_LEXICAL_MATCH_TYPES,
  GATHER_INTERRUPT_POLICY_VALUES,
  isGatherInterruptTrace,
} from './gather-interrupt-trace.js';
export type {
  GatherInterruptCandidateSurface,
  GatherInterruptCandidateSurfaceKind,
  GatherInterruptDetectionMode,
  GatherInterruptLexicalMatchType,
  GatherInterruptPolicyApplied,
  GatherInterruptTrace,
} from './gather-interrupt-trace.js';

// ─── Classifier Sidecar Contract ──────────────────────────────────────
export {
  CLASSIFIER_SIDECAR_CONTRACT_SCHEMA,
  CLASSIFIER_SIDECAR_REQUEST_FIXTURE,
  CLASSIFIER_SIDECAR_RESPONSE_FIXTURE,
  CLASSIFIER_SIDECAR_TASKS,
  isClassifierSidecarCandidate,
  isClassifierSidecarRequest,
  isClassifierSidecarResponse,
  isClassifierSidecarSelectedMatch,
  isClassifierSidecarTopKEntry,
} from './classifier-sidecar-contract.js';
export type {
  ClassifierSidecarCandidate,
  ClassifierSidecarRequest,
  ClassifierSidecarResponse,
  ClassifierSidecarSelectedMatch,
  ClassifierSidecarTask,
  ClassifierSidecarTopKEntry,
} from './classifier-sidecar-contract.js';

// ─── Constants ─────────────────────────────────────────────────────────
export { PLAN_FEATURES } from './constants/plan-features.js';
export {
  ALL_TRACE_EVENT_TYPES,
  ATTACHMENT_TRACE_EVENT_TYPES,
  CHANNEL_TRACE_EVENT_TYPES,
  CORE_TRACE_EVENT_TYPES,
  DELEGATION_TRACE_EVENT_TYPES,
  DSL_TRACE_EVENT_TYPES,
  ENGINE_TRACE_EVENT_TYPES,
  ERROR_HANDLER_TRACE_EVENT_TYPES,
  EXTRACTION_TRACE_EVENT_TYPES,
  FAN_OUT_TRACE_EVENT_TYPES,
  FLOW_TRACE_EVENT_TYPES,
  GUARDRAIL_TRACE_EVENT_TYPES,
  MEMORY_TRACE_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  SESSION_TRACE_EVENT_TYPES,
  SPAN_TRACE_EVENT_TYPES,
  STATUS_TRACE_EVENT_TYPES,
  SUSPENSION_TRACE_EVENT_TYPES,
  TOOL_TRACE_EVENT_TYPES,
  TRACE_EVENT_GROUPS,
  TRACE_EVENT_REGISTRY,
  VOICE_TRACE_EVENT_TYPES,
  A2A_TRACE_EVENT_TYPES,
  AGENT_TRACE_EVENT_TYPES,
  AGENT_ASSIST_TRACE_EVENT_TYPES,
} from './constants/trace-event-registry.js';
export type {
  A2ATraceEventType,
  AgentTraceEventType,
  AttachmentTraceEventType,
  ChannelTraceEventType,
  CoreTraceEventType,
  DelegationTraceEventType,
  DSLTraceEventType,
  EngineTraceEventType,
  ErrorHandlerTraceEventType,
  ExtractionTraceEventType,
  FanOutTraceEventType,
  FlowTraceEventType,
  GuardrailTraceEventType,
  MemoryTraceEventType,
  RuntimeEventType,
  SessionTraceEventType,
  SpanTraceEventType,
  StatusTraceEventType,
  SuspensionTraceEventType,
  ToolTraceEventType,
  TraceEventDomain,
  TraceEventRegistryEntry,
  VoiceTraceEventType,
  AgentAssistTraceEventType,
} from './constants/trace-event-registry.js';

// ─── Propagation Audit Fixtures ───────────────────────────────────────
export {
  ASSISTANT_OUTPUT_GOLDEN_FIXTURE,
  ATTACHMENT_MEDIA_GOLDEN_FIXTURE,
  CHANNEL_CAPABILITY_GOLDEN_FIXTURE,
  GUARDRAIL_OUTPUT_GOLDEN_FIXTURE,
  LOCALE_AUTH_MEMORY_GOLDEN_FIXTURE,
  PROPAGATION_CONTRACT_VERSIONS,
  PROPAGATION_FIXTURE_MANIFEST,
  PROPAGATION_GOLDEN_FIXTURES,
  TOOL_CONTRACT_GOLDEN_FIXTURE,
} from './propagation-fixtures.js';
export type {
  PropagationFixtureFamily,
  PropagationFixtureManifestEntry,
} from './propagation-fixtures.js';

// ─── Cache ────────────────────────────────────────────────────────────
export { LRUTTLCache, type LRUTTLCacheOptions } from './cache/index.js';

// ─── Model Pricing ─────────────────────────────────────────────────────
export { MODEL_PRICING, DEFAULT_PRICING, estimateCost } from './model-pricing.js';
export type { ModelPricing } from './model-pricing.js';

// ─── Model Routing ─────────────────────────────────────────────────────
export {
  DEFAULT_OPERATION_TIERS,
  MODEL_ROUTING_OPERATIONS,
  MODEL_ROUTING_TIERS,
  TEXT_MODEL_ROUTING_TIERS,
  formatOperationTierOverrideError,
  getDefaultOperationTier,
  isModelRoutingOperation,
  isModelRoutingTier,
  isTextModelRoutingTier,
  normalizeOperationTierOverrides,
} from './model-routing.js';
export type {
  ModelRoutingOperation,
  ModelRoutingTier,
  OperationTierOverrideValidationResult,
  OperationTierOverrides,
  TextModelRoutingTier,
} from './model-routing.js';

// ─── LLM Provider Identity ─────────────────────────────────────────────
export {
  DEFAULT_LLM_ALLOWED_PROVIDERS,
  LLM_PROVIDER_IDENTITIES,
  areLlmProvidersPolicyEquivalent,
  canonicalizeLlmProviderName,
  getLlmProviderPolicyAliases,
  isLegacyDefaultLlmAllowedProviders,
  isLlmProviderAllowed,
  mergeDefaultLlmAllowedProviders,
  normalizeLlmProviderName,
} from './llm-provider-identity.js';
export type { DefaultLlmAllowedProvider, LlmProviderIdentity } from './llm-provider-identity.js';

// ─── LLM Trace Cost Attribution + Rollup ──────────────────────────────
// Two separate classifiers:
//   - classifyLlmTraceVisibility / classifyLlmTraceForDisclosure (narrow,
//     above, from response-provenance.js) — drives AI-disclosure metadata.
//     DO NOT widen without explicit product / compliance sign-off.
//   - classifyLlmTraceForCostAttribution (wide, here) — drives cost
//     attribution only. Used by rollupAgentTokenCost.
export {
  classifyLlmTraceForCostAttribution,
  rollupAgentTokenCost,
} from './llm-trace-classifier.js';
export type {
  LlmTraceVisibility,
  TokenCostRollup,
  TraceEventForCostRollup,
} from './llm-trace-classifier.js';
