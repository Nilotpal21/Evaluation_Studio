// ─── Tool Resolution & Compilation ────────────────────────────────────
// NOTE: resolveToolImplementations is NOT exported here because it
// dynamically imports @agent-platform/database (Node-only).
// Server-side consumers should import from '@agent-platform/shared/tools/resolve'.
export type {
  ResolveToolImplInput,
  ResolveToolImplResult,
  ResolvedToolImpl,
  ToolDefinitionLocal,
  ToolParameterLocal,
  ToolHintsLocal,
  ToolSnapshotEntry,
  ResolutionTimings,
  ResolveToolImplDeps,
  ConnectorBindingIRLocal,
} from './resolve-tool-implementations.js';
// toToolDefinition is NOT re-exported here — it lives in resolve-tool-implementations
// which imports @agent-platform/database (Node-only). Server consumers import directly:
// import { toToolDefinition } from '@agent-platform/shared/tools/resolve-tool-implementations'

// ─── Shared DSL Parsing ─────────────────────────────────────────────
export {
  parseSignatureLine,
  parseDslProperties,
  extractPipeBlock,
  parseReturnTypeString,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseOptionalRuntimeNumber,
  parseDslParamMetadata,
  parseDslToolCompaction,
} from './dsl-property-parser.js';
export type {
  ParsedSignature,
  ToolReturnTypeLocal,
  HttpBindingIRLocal,
  SandboxBindingIRLocal,
  McpBindingIRLocal,
  WorkflowBindingLocal,
  RuntimeNumericValue,
  ToolAuthTypeIR,
  ParamMetadata,
  ToolCompactionConfigLocal,
} from './dsl-property-parser.js';

// ─── Validation ──────────────────────────────────────────────────────
export { validateToolDsl } from './project-tool-validator.js';
export type {
  ValidationResult,
  ValidateToolDslContext,
  ValidationDiagnostic as ProjectToolDiagnostic,
  DiagnosticSeverity,
} from './project-tool-validator.js';
export {
  PROJECT_TOOL_TYPES,
  isProjectToolType,
  prepareProjectToolDslForPersistence,
  rewriteToolDslSignatureName,
  validateProjectToolDslForPersistence,
  validateToolDslConsistency,
} from './project-tool-persistence.js';
export type {
  PreparedProjectToolDslPersistence,
  ProjectToolDslPersistenceInput,
  ProjectToolDslValidationResult,
  ProjectToolType,
} from './project-tool-persistence.js';

// ─── Workflow Tool Binding Validation (async DB cross-check) ────────
export { validateWorkflowToolBinding } from './validate-workflow-tool-binding.js';
export type {
  WorkflowValidationResult,
  WorkflowValidationErrorCode,
  WorkflowsRepo,
  WorkflowVersionsRepo,
  TriggerRegistrationsRepo,
  WorkflowDoc,
  WorkflowVersionDoc,
  TriggerRegistrationDoc,
  ValidateWorkflowBindingContext,
} from './validate-workflow-tool-binding.js';

// ─── SearchAI Tool Binding Validation (async DB cross-check) ────────
export { validateSearchAIToolBinding } from './validate-searchai-tool-binding.js';
export type {
  SearchAIValidationResult,
  SearchAIValidationErrorCode,
  SearchAIIndexesRepo,
  SearchAIIndexDoc,
  ValidateSearchAIBindingContext,
} from './validate-searchai-tool-binding.js';

// ─── DSL Serialization ──────────────────────────────────────────────
export { serializeToolFormToDsl } from './serialize-tool-form-to-dsl.js';
export { extractSignatureFromDsl } from './extract-signature.js';
export { normalizeHttpAuthConfig } from './http-auth-config-normalizer.js';
export type {
  HttpAuthConfigInput,
  NormalizeHttpAuthConfigOptions,
} from './http-auth-config-normalizer.js';

// ─── DSL Parsing (reverse of serialization) ─────────────────────────
export { parseDslToToolForm, parseDslNestedBlock } from './parse-dsl-to-tool-form.js';

// ─── HTTP Auth Helpers ───────────────────────────────────────────────
export {
  extractRequestedOAuthScopes,
  resolveAuthProfileRef,
} from './resolve-http-tool-auth-config.js';
export type {
  ConfigVarStoreLike,
  HttpToolAuthScopeCarrier,
} from './resolve-http-tool-auth-config.js';

// ─── Standalone Tool DSL Adapter ──────────────────────────────────────
export { convertStandaloneToolDSL, loadToolDSLsAsResolved } from './standalone-tool-adapter.js';

// ─── Test Input Generation ───────────────────────────────────────────
export { generateTestInputFromDsl } from './generate-test-input.js';

// ─── Runtime Metadata Identity ─────────────────────────────────────
export { computeToolRuntimeMetadataHash } from './runtime-metadata.js';
export type { ToolRuntimeMetadataHashInput } from './runtime-metadata.js';
