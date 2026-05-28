/**
 * @agent-platform/arch-ai — surface-agnostic engine for AI-assisted agent design.
 * Current clean-room communication layer. See docs/superpowers/specs/2026-04-18-arch-v4-design.md.
 */

export const ARCH_AI_VERSION = '0.1.0';

export {
  DEFAULT_ARCH_MODEL_POLICY_DEFAULTS,
  normalizeArchModelPolicyDefaults,
  resolveDefaultArchModelPolicyDefaults,
  resolveArchExecutionModel,
  resolveArchModelClass,
  selectArchModelPolicyDefaults,
} from './model-policy.js';
export type {
  ArchAgentModelType,
  ArchModelClass,
  ArchModelPolicyCandidate,
  ArchModelPolicy,
  ArchModelPolicyDefaults,
  ResolveArchExecutionModelInput,
} from './model-policy.js';

export {
  getConstructAuthoringContract,
  renderConstructCompileHint,
  renderConstructExample,
  renderConstructFieldSummary,
  renderDefaultMemorySessionBlock,
  renderDefaultSupervisorCatchAllHandoff,
  renderDelegateMissingCompleteWarning,
  renderDelegateMissingGatherWarning,
  renderHandoffContextPassMissingMemoryWarning,
  renderKnownConstructsHint,
  renderMissingAgentDeclarationWarning,
  renderMissingConstructWarning,
  renderMissingMemoryWarning,
  renderMissingToolsWarning,
  renderPciMissingConstraintsWarning,
  renderSupervisorCatchAllHandoffWarning,
  renderSupervisorMissingHandoffWarning,
} from './knowledge/construct-contract.js';

export {
  getGuardrailAuthoringContract,
  renderDefaultContentSafetyGuardrail,
  renderDefaultContentSafetyInline,
  renderDefaultContentSafetySummary,
  renderGuardrailAuthoringGuidance,
  renderGuardrailCompileHint,
  renderMissingGuardrailsWarning,
} from './knowledge/guardrail-contract.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type {
  ArchPhase,
  ArchMode,
  SessionState,
  ArchSession,
  SessionMetadata,
  BuildProgress,
  BuildAgentStatus,
  BuildToolStatus,
  PendingWidgetPayload,
  ToolGenerationEntry,
  QualityIssue,
  PendingWidgetInteraction,
  PendingInteraction,
  StoredMessage,
  StoredToolCall,
  HistorySummarySpecSnapshot,
  HistorySummaryCapturedAnswer,
  HistorySummaryDecision,
  HistorySummaryToolOutcome,
  HistorySummaryOpenThread,
  HistorySummary,
  Specification,
  ConversationNote,
  ConversationNoteCategory,
  FileRef,
  ArchSSEEvent,
  CompletionMeta,
  MessageRequest,
  FileAttachment,
  SpecialistId,
  ToolName,
  ToolType,
  ToolDefinition,
  PhaseToolMap,
  ExecutionResult,
  ExecutionStatus,
  TopologyOutput,
  TopologyAgent,
  TopologyEdge,
  AgentSpec,
  BlueprintOutput,
  PageContext,
  PageContextEntity,
  SessionCheckpoint,
  PendingMutation,
  PendingPlan,
  PendingPlanAlternative,
  PendingPlanCitation,
  PendingPlanDependentsAnalysis,
  PendingPlanMutation,
  PendingPlanReference,
  PendingPlanRisk,
  PendingPlanSectionChange,
  PersistedValidation,
  ValidationIssue,
  ResumeCheckpoint,
  ResumePendingState,
  ResumeNextAction,
  ResumeArtifacts,
  ResumeInterruption,
  ResumeSnapshot,
  KBStatusCardEvent,
  UploadProgressCardEvent,
  SearchResultsCardEvent,
  KBHealthCardEvent,
  ConnectorStatusCardEvent,
  DocProcessingCardEvent,
  ExternalAgentCardEvent,
} from './types/index.js';

export {
  ARCH_PHASES,
  ARCH_MODES,
  SESSION_STATES,
  SPECIALIST_IDS,
  MESSAGE_LIMITS,
  InvalidTransitionError,
  ExitCriteriaNotMetError,
  SessionBusyError,
  SessionNotFoundError,
  SessionArchivedError,
  SessionAlreadyExistsError,
  LoopDetectedError,
  FileNotFoundError,
  FileTooLargeError,
  FileCorruptError,
  SessionFileQuotaError,
} from './types/index.js';

// Schemas (Zod)
export {
  SpecificationSchema,
  CompleteSpecificationSchema,
  ConversationNoteSchema,
  FileRefSchema,
  createDefaultSpecification,
  canExitInterview,
} from './types/specification.js';

export {
  CompletionMetaSchema,
  ArchSSEEventSchema,
  ActivityEventSchema,
  FileProcessedEventSchema,
  FileErrorEventSchema,
  FileContextChangeEventSchema,
  SuggestionCategorySchema,
  SuggestionSchema,
  DoneEventSchema,
  QualityFloorSchema,
  BuildAgentStartEventSchema,
  BuildAgentStageEventSchema,
  BuildAgentCompiledEventSchema,
  BuildAgentEnrichedEventSchema,
  BuildAgentErrorEventSchema,
  BuildAgentDiagnosticsEventSchema,
  KBStatusCardEventSchema,
  UploadProgressCardEventSchema,
  SearchResultsCardEventSchema,
  KBHealthCardEventSchema,
  ConnectorStatusCardEventSchema,
  DocProcessingCardEventSchema,
  ExternalAgentCardEventSchema,
} from './types/sse-events.js';

export {
  normalizeContent,
  extractContentBlocks,
  isArchContentBlockArray,
} from './types/content-blocks.js';
export {
  AUDIT_PAYLOAD_TOOL_INPUT_ALLOWLIST,
  buildRedactedToolInputPayload,
  redactAuditPayloadContent,
  shouldCaptureToolInputPayload,
} from './audit/payload-redactor.js';
export type { AuditPayloadRedactionOptions, AuditPayloadType } from './audit/payload-redactor.js';
export {
  getCatalogVersion,
  getCelGrammar,
  getConstructSpec,
  getCrossConstructMandatories,
  listAllConstructs,
  listCelFunctions,
  listFeasibilityChecks,
  listValidCombinations,
  lookupValidationCode,
} from './knowledge/spine.js';

export type { ArchContentBlock, ProviderContentBlock } from './types/content-blocks.js';

export { MessageRequestSchema, FileAttachmentSchema } from './types/message-request.js';

export { PageContextSchema, PageContextEntitySchema } from './types/page-context.js';

// One-shot dispatcher
export { decideNextEvent, MAX_DISPATCH_ITERATIONS } from './dispatcher.js';
export type { DispatchResult } from './dispatcher.js';

// Blueprint
export {
  TopologyEdgeSchema,
  TopologyOutputSchema,
  BlueprintOutputSchema,
  AgentSpecSchema,
  computeBuildOrder,
  validateBlueprintOutput,
} from './types/blueprint.js';

export {
  BlueprintAgentNameSchema,
  BlueprintExecutionModeSchema,
  BlueprintV2OutputSchema,
  BlueprintV2PerAgentSpecSchema,
  assertValidBlueprintV2Output,
  validateBlueprintV2Output,
  renderAgentDslFromBlueprint,
  renderBlueprintMarkdown,
  renderProjectFromBlueprint,
  BLUEPRINT_BATTLE_TEST_FIXTURES,
  BlueprintService,
  extractSourceArchitectureContractFromFiles,
  extractSourceArchitectureContractFromText,
  getSourceArchitectureContractFromMetadata,
  renderSourceArchitectureContractPrompt,
  synthesizeTopologyFromSourceContract,
  validateTopologyAgainstSourceContract,
} from './blueprint/index.js';
export type {
  BlueprintV2Output,
  BlueprintV2PerAgentSpec,
  BlueprintV2ValidationIssue,
  BlueprintRenderedAgent,
  BlueprintRenderedProject,
  BlueprintLookup,
  CreateBlueprintInput,
  BlueprintEditInput,
  SourceArchitectureContract,
  SourceContractAgent,
  SourceContractChannelRule,
  SourceContractConsentPolicy,
  SourceContractScenarioFixture,
  SourceContractTool,
  SourceContractWelcomeShape,
} from './blueprint/index.js';

// Tool filtering
export {
  PHASE_TOOL_MAP,
  IN_PROJECT_TOOLS,
  IN_PROJECT_SPECIALIST_TOOL_MAP,
  CLIENT_SIDE_TOOLS,
  isClientSideTool,
  getToolsForPhase,
  getToolsForInProject,
} from './types/tools.js';

// ─── Coordinator ──────────────────────────────────────────────────────────

export {
  PHASE_CONFIG,
  transitionPhase,
  getSpecialistForPhase,
  checkExitCriteria,
  getNextPhase,
  resolveMode,
  validateStateTransition,
  RESUMABLE_STATES,
  LISTABLE_STATES,
  ARCHIVABLE_STATES,
  classifyMutationScope,
  LoopDetector,
  routeByContent,
  synthesizeDefaultTopology,
  classifyTopologyPattern,
  synthesizePatternTopology,
  TOPOLOGY_PATTERN_VOCABULARY,
  TOPOLOGY_DECISION_TREE,
} from './coordinator/index.js';
export type {
  PhaseConfig,
  MutationScope,
  TopologyDiff,
  BuildGateQueueInput,
  NextGateDecision,
  TopologyPatternId,
  TopologyPatternDef,
} from './coordinator/index.js';
export { diffTopologyAgainstBuildState, pickNextGate } from './coordinator/index.js';

// ─── Session ──────────────────────────────────────────────────────────────
// NOTE: FileStoreService and createFileStoreService are NOT re-exported from
// the main barrel to prevent server-only deps (mongoose/async_hooks) from
// being bundled into client code. Import them directly:
//   import { FileStoreService, createFileStoreService } from '@agent-platform/arch-ai/session'
// or from the session barrel in server-side code.
export {
  SessionService,
  buildResumeSummary,
  buildResumeSnapshot,
  evaluateQualityFloorIssues,
  createCheckpoint,
  addCheckpoint,
  rollbackFromCheckpoint,
  ProjectMemoryService,
} from './session/index.js';
export type {
  ResumeSummary,
  SessionContext,
  ProjectMemoryEntry,
  AddMemoryParams,
} from './session/index.js';

// ─── Spec Document ────────────────────────────────────────────────────────

export {
  SpecDocumentService,
  ProjectScopeAccessRequiredError as SpecDocScopeError,
} from './spec-document/index.js';
export { renderMarkdown as renderSpecMarkdown } from './spec-document/index.js';
export type {
  IArchSpecDocument,
  DecisionEntry,
  AgentSummary,
  ToolSummary,
  GuardrailSummary,
} from './spec-document/index.js';
export {
  V1_EDITABLE_PATHS,
  SPEC_TO_SESSION_FIELD_MAP,
  validateEditablePath,
} from './spec-document/index.js';

// ─── Journal ──────────────────────────────────────────────────────────────

export { JournalService, ProjectScopeAccessRequiredError } from './journal/index.js';
export type {
  JournalEntry,
  JournalEntryType,
  JournalEntryStatus,
  JournalContent,
  DecisionContent,
  ConsultationContent,
  MutationContent,
  ValidationContent,
  AnalysisContent,
} from './journal/index.js';

// ─── Audit ────────────────────────────────────────────────────────────────

export { AuditLogEmitter } from './audit/index.js';
export type {
  AuditLogEmitterOpts,
  ArchAuditLogWriter,
  BufferedArchAuditLogEntry,
  AuditLogCategory,
  AuditLogSeverity,
  AuditLogTokens,
  AuditLogEntry,
  AuditEmitterContext,
} from './audit/index.js';
export { AUDIT_LOG_CATEGORIES, AUDIT_LOG_SEVERITIES } from './audit/index.js';

// ─── Prompts ──────────────────────────────────────────────────────────────

export {
  composeSystemPrompt,
  composeInProjectPrompt,
  formatContextSection,
  ABL_CONSTRUCT_EXPERT_SYNTAX,
  BUILD_NARRATION_PROMPT,
  renderBuildPhasePrompt,
} from './prompts/index.js';

// ─── Mock Server ──────────────────────────────────────────────────────────

export { extractAllTools, generateMockServerArtifacts } from './mock-server/index.js';
export type { ToolMeta, MockServerArtifacts } from './mock-server/index.js';

// ─── Executor ─────────────────────────────────────────────────────────────

export {
  executeSpecialistTurn,
  executeMultiTurn,
  resolveContentBlocks,
  buildFilePreamble,
  buildMultimodalMessages,
} from './executor/index.js';
export type {
  SSEEmitter,
  ToolExecuteFn,
  LLMStreamClient,
  LLMStreamChunk,
  ExecutorParams,
  ResumeParams,
  MultiTurnMessage,
  MultiTurnParams,
  MultiTurnResult,
  ContextCapabilities,
  SessionFileRecord,
  FilePreambleResult,
} from './executor/index.js';

// ─── Auth context ─────────────────────────────────────────────────────────

export type { AuthContext, ToolExecuteWithAuthFn } from './types/auth-context.js';

// ─── IN_PROJECT specialist types ─────────────────────────────────────────

export type { InProjectSpecialistId, AnySpecialistId } from './types/constants.js';
export { IN_PROJECT_SPECIALIST_IDS, ALL_SPECIALIST_IDS } from './types/constants.js';
export { IN_PROJECT_SPECIALIST_DISPLAY } from './types/in-project-specialists.js';
export type { ChainContext, Finding, RecommendedAction } from './types/chain-context.js';

// ─── Knowledge layer ──────────────────────────────────────────────────────

export {
  PLATFORM_LIMITS_CARD,
  selectKnowledgeCards,
  searchDocsGrouped,
} from './knowledge/index.js';
export type { CardSelection, DocSearchResult } from './knowledge/index.js';

// ─── Diagnostic engine ────────────────────────────────────────────────────

export {
  runDiagnostics,
  getRule,
  getAllRules,
  RULE_COUNT,
  getFixTemplate,
} from './diagnostics/index.js';
export type {
  DiagnosticReport,
  DiagnosticSection,
  DiagnosticOptions,
  Finding as DiagnosticFinding,
  FixSuggestion,
  DiagnosticSeverity,
  DiagnosticCategory,
  ArchitecturePattern,
  AntiPattern,
  ValidatorContext,
  RuleEntry,
} from './diagnostics/index.js';

// ─── System Agent ────────────────────────────────────────────────────────
export {
  ARCH_SYSTEM_AGENT_ID,
  SYSTEM_AGENT_PREFIX,
  ARCH_SYSTEM_AGENT_DEFINITION,
  isSystemAgent,
  getSystemAgentDefinitions,
  getSystemAgentDefinition,
} from './system-agent.js';
export type {
  ArchSystemAgentInput,
  ArchSystemAgentOutput,
  ArchSystemAgentResult,
  SystemAgentDefinition,
} from './system-agent.js';
export { runArchSystemAgentInProcess } from './system-agent-driver.js';
export type {
  ArchSystemAgentDriverContext,
  ArchSystemAgentDriverOptions,
  ArchSystemAgentDriverOutcome,
  ArchSystemAgentSpecInput,
  ArchSystemAgentTraceEvent,
} from './system-agent-driver.js';
export { configureProcessMessageDeps, processMessage } from './processors/process-message.js';
export type {
  ArchRequestTiming,
  ProcessMessageBuildResult,
  ProcessMessageDeps,
  ProcessMessageModelResolution,
} from './processors/process-message.js';

// ─── Generation pipeline ──────────────────────────────────────────────────
export {
  buildSkeleton,
  validatePreCompile,
  autoFixABL,
  processGeneratedABL,
} from './generation/index.js';
export type {
  AgentContext as ABLAgentContext,
  ABLValidationIssue,
  PipelineResult as ABLPipelineResult,
} from './generation/index.js';

// ─── Planning (architecture planner) ─────────────────────────────────────

export { computeArchitecturePlans } from './planning/index.js';
export {
  AgentConstructPlanSchema,
  ProjectConstructPlanSchema,
  deriveProjectConstructPlanFromBlueprint,
  validateAgentConstructPlan,
  validateProjectConstructPlan,
} from './planning/index.js';
export type {
  PlannerTopologyInput,
  AgentArchitecturePlan,
  AgentArchetype,
  HandoffHistoryHint,
  HandoffReturnContractHint,
  HandoffTargetPlan,
  HandoffPlan,
  GatherPlan,
  FlowPlan,
  AgentComplexityPlan,
  StructuralRequirement,
  BlockedPattern,
  ArchitecturePlanResult,
  AgentConstructPlan,
  ProjectConstructPlan,
  ConstructGatherItem,
  ConstructToolItem,
  ConstructToolCall,
  ConstructStateAssignment,
  ConstructFlowStep,
  ConstructHandoff,
  ConstructDelegate,
  ConstructEscalation,
  ConstructCompletion,
  UnsupportedConstructNote,
  ConstructValidationIssue,
  ConstructValidationResult,
  ConstructValidationSeverity,
} from './planning/index.js';

// ─── Reference analysis ─────────────────────────────────────────────────

export {
  findAgentRefs,
  findCelVarRefs,
  findGatherFieldRefs,
  findMemoryRefs,
  findToolConsumers,
} from './references/index.js';
export type {
  ProjectAgentReferenceSource,
  ProjectReference,
  ReferenceKind,
  ReferenceQueryResult,
} from './references/index.js';

// ─── Turn Events (turn-engine SSE types) ──────────────────────────────────

export type {
  TurnEvent,
  SessionSignal,
  FanOutEnvelope,
  TurnEndReason,
  ArtifactUpdate,
} from './types/turn-events.js';

export { TurnEventSchema, SessionSignalSchema, FanOutEnvelopeSchema } from './types/turn-events.js';

// ─── Session V2 types ─────────────────────────────────────────────────────

export type { StoredMessageV2, PendingInteractiveV2, ArchSessionV2 } from './types/session-v2.js';

export { SCHEMA_VERSION_V2 } from './types/session-v2.js';
