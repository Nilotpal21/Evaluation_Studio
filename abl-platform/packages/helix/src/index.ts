/**
 * HELIX — Harness for Engineering Loops and Intelligent eXecution
 *
 * Orchestrates multi-model AI pipelines for holistic feature development.
 * Uses Codex for deep code analysis and implementation, Claude for
 * architecture, review, and orchestration.
 *
 * @example
 * ```typescript
 * import { PipelineEngine, SessionManager, selectPipeline } from '@agent-platform/helix';
 *
 * const config = { workDir: process.cwd(), ... };
 * const reporter = new TerminalProgressReporter();
 * const sessionManager = new SessionManager(config);
 * const engine = new PipelineEngine(config, reporter);
 *
 * const workItem = { type: 'feature-audit', title: 'Channel Parity', ... };
 * const pipeline = selectPipeline(workItem.type);
 * const session = await sessionManager.create(workItem, pipeline);
 * await engine.run(session, pipeline);
 * ```
 */

// Core types
export type {
  AnalysisStageOutput,
  AutonomyPolicyConfig,
  AutonomyEvidenceSignal,
  BootstrapFallbackReason,
  BootstrapMeta,
  BootstrapScopeInferenceMethod,
  EmbeddingRecord,
  EmbeddingRecordKind,
  EmbeddingRecordMetadata,
  EmbeddingShardLayout,
  EmbeddingShardPaths,
  HelixEmbeddingProviderConfig,
  HelixMcpServerDefinition,
  HelixStageModelPolicy,
  HelixConfig,
  IndexRebuildResult,
  ChecklistCategory,
  ChecklistItem,
  CheckpointType,
  CommitRecord,
  Decision,
  DecisionClassification,
  EntryCondition,
  EntryConditionType,
  ExecutorResult,
  ExitCriterion,
  ExitCriterionType,
  ExportContract,
  FileContract,
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingStatus,
  FileReference,
  ImpactAnalysis,
  JournalEntry,
  JournalEntryType,
  LegacyPathPlan,
  ManifestCompletenessHint,
  ManifestCompletenessReport,
  ModelAssignment,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  ModuleTrustProfile,
  OracleAssessmentVerdict,
  OracleDefinition,
  OracleFindingAssessmentRecord,
  OracleId,
  OracleReviewStageOutput,
  ReproductionStageOutput,
  OracleVote,
  PipelineTemplate,
  PromptCodeMapDirectorySummary,
  PromptCodeMapDirectorySummaryEntry,
  PromptCodeMapFile,
  PromptCodeMapRepoIndexTelemetry,
  PromptCodeMapSnapshot,
  PromptContextDocument,
  PromptContextSnapshot,
  ProgressEvent,
  ProgressEventType,
  ProgressReporter,
  QualityCheck,
  QualityGateConfig,
  QualityGateCheckResult,
  QualityGateResult,
  RetrievalEmbeddingSource,
  RetrievalTelemetry,
  ReviewFinding,
  ReviewResult,
  Session,
  SessionState,
  Slice,
  SliceAutonomyState,
  SliceBulkReviewStatus,
  SliceChecklist,
  SliceConfidenceLevel,
  SlicePlanRecord,
  SliceReviewDisposition,
  SlicePlanStageOutput,
  SliceManifest,
  SliceStatus,
  StageDefinition,
  StageOutputSchemaConfig,
  StageOutputSchemaId,
  StageResult,
  StageResultStatus,
  StageType,
  ShardManifest,
  StructuredDecisionRecord,
  StructuredFindingRecord,
  StructuredLegacyPathRecord,
  StreamEvent,
  TestLock,
  TestRequirement,
  TimeoutEvent,
  TimeoutScope,
  VerificationBootstrapBaseline,
  VerificationBootstrapRecord,
  VerificationBootstrapTrustLevel,
  WorkItem,
  WorkItemType,
  WorkspaceExecutionContext,
  WorkspaceExecutionMode,
} from './types.js';

// Pipeline engine
export { PipelineEngine } from './pipeline/pipeline-engine.js';
export { buildCanaryDeepScanPrompt, createCanaryPipeline } from './pipeline/canary-pipeline.js';
export {
  assessSliceAutonomy,
  formatDeferredBulkReviewQueue,
  formatSliceAutonomySummary,
  getDeferredBulkReviewSlices,
  resolveAutonomyPolicy,
} from './pipeline/autonomy-policy.js';
export { buildPromptContext } from './pipeline/prompt-context.js';
export { runQualityGate } from './pipeline/quality-gate.js';
export { buildStagePrompt, buildSlicePrompt } from './pipeline/stage-runner.js';
export {
  formatReadinessSummary,
  generateReadinessReport,
  loadReadinessContracts,
  runHelixDoctor,
} from './readiness/doctor.js';
export { buildRuntimeReadinessPolicy } from './readiness/runtime-policy.js';
export {
  buildDefaultEmbeddingProviderConfig,
  buildDefaultHelixMcpServers,
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDING_REQUEST_BUDGET,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_HELIX_EMBEDDINGS_ENABLED,
  DEFAULT_STAGE_MODEL_POLICY,
  isHelixEmbeddingsEnabled,
  mergeMcpServers,
  mergeStageModelPolicy,
} from './runtime-config.js';
export {
  buildEmbeddingShardManifest,
  buildEmbeddingShardPaths,
  emptyIndexRebuildResult,
  getEmbeddingShardPathsForSession,
  HELIX_EMBEDDING_CACHE_ROOT,
  HELIX_EMBEDDING_DIMENSIONS,
  HELIX_EMBEDDING_MODEL_ID,
  HELIX_EMBEDDING_MODEL_KEY,
  HELIX_EMBEDDING_SHARD_LAYOUT,
  resolveEmbeddingShardBasePath,
} from './intelligence/embedding-config.js';
export type {
  HelixAutonomyRecommendation,
  HelixCoverageSignal,
  HelixDoctorChecklistItem,
  HelixDoctorCommandResult,
  HelixDoctorEnvironmentReport,
  HelixDoctorModuleReport,
  HelixDoctorOptions,
  HelixDoctorReport,
  HelixDoctorRunResult,
  HelixDoctorServiceReport,
  HelixDoctorSeverity,
  HelixDoctorStatus,
  HelixModuleVerificationPolicy,
  HelixReadinessContracts,
  HelixReadinessLevel,
  HelixRepoContract,
  HelixVerificationContract,
  HelixVerificationSuite,
} from './readiness/doctor.js';
export type { HelixRuntimeReadinessPolicy } from './readiness/runtime-policy.js';

// Pipeline templates
export {
  holisticAuditPipeline,
  bugFixPipeline,
  focusedChangePipeline,
  selectPipeline,
  selectPipelineForWorkItem,
  listPipelines,
  registerPipeline,
} from './pipeline/templates/index.js';

// Session management
export { SessionManager } from './session/session-manager.js';
export { HelixControlPlaneService } from './mcp/control-plane-service.js';
export type {
  HelixControlPlaneServiceOptions,
  HelixSessionSummary,
  ListSessionsOptions,
  SliceGateResultSummary,
} from './mcp/control-plane-service.js';
export { HelixControlPlaneMcpServer } from './mcp/server.js';
export type { HelixControlPlaneMcpServerOptions } from './mcp/server.js';

// Model routing
export { ModelRouter } from './models/model-router.js';
export { ClaudeSdkExecutor } from './models/claude-sdk-executor.js';
export { CodexCliExecutor, resolveCodexBinaryPath } from './models/codex-cli-executor.js';

// Oracle constellation
export { OracleConstellation, applyOracleDecisionOutcome } from './oracles/oracle-constellation.js';
export type { OracleAnalysisResult } from './oracles/oracle-constellation.js';

// UI
export { CanaryProgressReporter } from './ui/canary-progress-reporter.js';
export { CompositeReporter } from './ui/composite-reporter.js';
export { FileProgressLogger } from './ui/file-progress-logger.js';
export { TerminalProgressReporter } from './ui/progress-reporter.js';

// Interactive session
export { InputClassifier, buildClassifierSystemPrompt } from './interactive/input-classifier.js';
export type { InputClassifierOptions, LlmClassifyFn } from './interactive/input-classifier.js';
export { createLlmInputClassifier } from './interactive/input-classifier.js';
export { InteractiveReporter } from './interactive/interactive-reporter.js';
export type { InteractiveTerminalDelegate } from './interactive/interactive-reporter.js';
export { LiveContext } from './interactive/live-context.js';
export { SessionRepl } from './interactive/session-repl.js';
export type { SessionReplOptions } from './interactive/session-repl.js';
export type {
  ClassifiedInput,
  InteractiveIntent,
  LiveContextEntry,
  PipelineControlCommand,
  PipelinePauseResult,
  PipelineResumeResult,
  PipelineStatus,
} from './interactive/types.js';

// Cross-cutting concerns registry
export {
  concernsApplyingTo,
  concernsForFile,
  globToRegExp,
  loadConcernsRegistry,
  normalizePath,
  scopeMatches,
} from './concerns/index.js';
export type {
  AstDetector,
  Concern,
  ConcernAcceptance,
  ConcernDetector,
  ConcernDetectorBase,
  ConcernDetectorKind,
  ConcernEnforcement,
  ConcernLoadError,
  ConcernLoadResult,
  ConcernReferences,
  ConcernScope,
  ConcernSeverity,
  ConcernStageHook,
  ConcernStageType,
  ConcernsLoaderOptions,
  ConcernsRegistry,
  GrepDetector,
  ImpactedTestDetector,
  ModelReviewDetector,
  ModelReviewOutputSchema,
  RouteDetector,
  SchemaDetector,
  ScriptDetector,
  SymbolRefDetector,
} from './concerns/index.js';

// Integrations
export {
  buildAdfDescription,
  createTicket,
  enrichTicketFromSession,
  findOrCreateTicket,
  searchAssignedIssues,
  searchRelevantTickets,
  updateTicket,
} from './integrations/jira-client.js';
export {
  buildJiraAssigneeWorkflowPlan,
  buildJiraIssueModelTriagePayload,
  buildJiraIssueModelTriagePrompt,
  buildSimpleIssueHelixCommand,
  parseJiraIssueModelDecisions,
  renderJiraAssigneeWorkflowReport,
  triageJiraIssue,
} from './integrations/jira-assignee-workflow.js';
export type {
  AdfDocument,
  CreateTicketParams,
  DescriptionSection,
  JiraAssignedIssue,
  JiraIssue,
  SearchAssignedIssuesOptions,
  UpdateTicketParams,
} from './integrations/jira-client.js';
export type {
  JiraAssigneeWorkflowOptions,
  JiraAssigneeWorkflowPlan,
  JiraIssueComplexity,
  JiraIssueModelDecision,
  JiraIssueModelPromptRecord,
  JiraIssueModelTriagePayload,
  JiraIssueStateBucket,
  JiraIssueTriage,
  JiraIssueWorkflowAction,
} from './integrations/jira-assignee-workflow.js';
