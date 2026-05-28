/**
 * HELIX — Harness for Engineering Loops and Intelligent eXecution
 *
 * Core type definitions for the pipeline orchestrator, model routing,
 * oracle constellation, session management, and progress reporting.
 */

// ─── Work Items ──────────────────────────────────────────────────

export type WorkItemType =
  | 'feature-audit' // Holistic audit of existing feature: find gaps, fix, regress
  | 'bug-fix' // Targeted bug fix with regression
  | 'enhancement' // Add capability to existing feature
  | 'new-feature' // Build from scratch (full SDLC)
  | 'drift-audit'; // Deterministic cross-cutting concern scan — no LLM, no fix

export interface WorkItem {
  id: string;
  type: WorkItemType;
  title: string;
  description: string;
  scope: string[]; // affected packages/areas (e.g., ['apps/runtime', 'packages/execution'])
  jiraKey?: string;
  featureSpec?: string; // path to existing feature spec if any
  testSpec?: string; // path to existing test spec if any
  hldSpec?: string; // path to existing HLD spec if any
  lldPlan?: string; // path to existing LLD / implementation plan if any
  targetBranch: string; // branch to work on (default: current)
  createdAt: string; // ISO timestamp
}

// ─── Sessions ────────────────────────────────────────────────────

export type WorkspaceExecutionMode = 'in-place' | 'git-worktree';

export interface WorkspaceExecutionContext {
  mode: WorkspaceExecutionMode;
  sourceWorkDir?: string;
  worktreeDir?: string;
  baseHeadSha?: string;
  baseBranch?: string;
  requestedPath?: string;
  autoCreated?: boolean;
  bootstrapCommand?: string;
  createdAt?: string;
}

export type SessionState =
  | 'initializing'
  | 'scanning'
  | 'analyzing'
  | 'planning'
  | 'awaiting-approval' // waiting for user to approve plan
  | 'executing'
  | 'reviewing'
  | 'awaiting-input' // waiting for user to answer AMBIGUOUS question
  | 'committing'
  | 'completed'
  | 'failed'
  | 'paused'; // user interrupted, can resume

export interface SessionHeartbeat {
  at: string;
  eventType: ProgressEventType;
  stage?: string;
  message: string;
}

export interface PlanArtifact {
  output: string; // full plan markdown, parse target for slice-plan schema
  costUsd?: number; // cost for this single call
  engine: ModelEngine; // 'claude-code' | 'openai-api' | 'codex-cli'
  model: string; // model ID as reported by the executor
  capturedAt: string; // ISO timestamp
  durationMs: number;
  turnsUsed: number;
  soloPass?: boolean; // true iff sibling planner failed and this artifact flowed through Codex alone
}

/**
 * Telemetry record describing how a Session's WorkItem was assembled at
 * `helix audit ABLP-XX` time. Set once at session create; never mutated.
 *
 * Lives on `Session`, not on `WorkItem` — the WorkItem represents the work to
 * do, not how the work was assembled. See feature-spec helix-work-item-bootstrap §9.
 */
export type BootstrapScopeInferenceMethod = 'deterministic' | 'explicit' | 'empty';

export type BootstrapFallbackReason =
  | 'credentials-missing'
  | 'auth-failed'
  | 'not-found'
  | 'network-error';

export interface BootstrapMeta {
  jiraKey?: string;
  jiraFetchSuccess: boolean;
  jiraFetchLatencyMs?: number;
  scopeInferenceMethod: BootstrapScopeInferenceMethod;
  inferredScope: string[];
  fallbackReason?: BootstrapFallbackReason;
  /** Structured acceptance criteria extracted from the Jira issue description. */
  acceptanceCriteria?: string[];
}

export type RetrievalEmbeddingSource = 'bge-m3' | 'fallback-slug';

export interface RetrievalTelemetry {
  queriedAt: string;
  topNReturned: number;
  latencyMs: number;
  fallback: boolean;
  embeddingSource: RetrievalEmbeddingSource;
  candidateCount?: number;
  includedCount?: number;
  contextInclusionRate?: number;
  repeatFindingPreventionCount?: number;
}

export type EmbeddingRecordKind = 'finding' | 'decision';
export type EmbeddingShardLayout = 'per-session';

export interface EmbeddingRecordMetadata {
  severity?: FindingSeverity;
  category?: FindingCategory;
  classification?: DecisionClassification;
  stage?: StageType;
  files: string[];
  package?: string;
  featureSlug: string;
  sessionId: string;
  /**
   * Project discriminator required for cross-session retrieval isolation.
   * Derived from the Jira key when available, or the work-item title slug.
   * EmbeddingStore.query() mandates a matching projectId filter so records
   * from other projects are never returned.
   */
  projectId?: string;
  createdAt: string;
}

export interface EmbeddingRecord {
  id: string;
  kind: EmbeddingRecordKind;
  contentHash: string;
  model: string;
  dimensions: number;
  vector: number[];
  metadata: EmbeddingRecordMetadata;
}

export interface EmbeddingShardPaths {
  modelKey: string;
  basePath: string;
  findingsShardPath: string;
  decisionsShardPath: string;
  consolidatedFindingsPath: string;
  consolidatedDecisionsPath: string;
}

export interface ShardManifest {
  version: 1;
  model: string;
  dimensions: number;
  layout: EmbeddingShardLayout;
  basePath: string;
  generatedAt: string;
  shards: EmbeddingShardPaths[];
  consolidated: {
    findingsPath: string;
    decisionsPath: string;
  };
}

export interface IndexRebuildResult {
  dryRun: boolean;
  filesScanned: number;
  findingsWritten: number;
  decisionsWritten: number;
  rowsSkipped: number;
  shardsCompacted: number;
  durationMs: number;
  manifest?: ShardManifest;
}

export interface HelixEmbeddingProviderConfig {
  kind: 'bge-m3-local';
  enabled: boolean;
  modelId: string;
  modelKey: string;
  dimensions: number;
  baseUrl: string;
  authToken?: string;
  timeoutMs: number;
  maxBatchSize: number;
  requestBudget: number;
  shardBasePath: string;
  shardLayout: EmbeddingShardLayout;
}

export interface Session {
  id: string;
  workItem: WorkItem;
  pipelineName: string;
  pipelineVersion: string;
  pipelineSnapshot?: PipelineTemplate;
  promptContext?: PromptContextSnapshot;
  verificationBootstrap?: VerificationBootstrapRecord;
  planReviewState?: PlanReviewState;
  checkpointApprovals?: CheckpointApprovalRecord[];
  oracleCheckpoints?: OracleCheckpointRecord[];
  harnessDefects?: HarnessDefectRecord[];
  failureAdvisories?: FailureAdvisoryRecord[];
  pendingFailureAdvisory?: FailureAdvisoryRecord;
  workspaceContext?: WorkspaceExecutionContext;
  replayContext?: ReplayExecutionContext;
  workspaceBaseline?: WorkspaceGitSnapshot;
  bootstrapMeta?: BootstrapMeta;
  embeddingShardPaths?: EmbeddingShardPaths;
  state: SessionState;
  currentStageIndex: number;
  currentSliceIndex: number;
  totalSlices: number;
  slices: Slice[];
  findings: Finding[];
  decisions: Decision[];
  commits: CommitRecord[];
  journal: JournalEntry[];
  stageHistory: StageResult[];
  jiraTickets?: JiraTicketLedgerEntry[]; // drift-sync adapter append-only ledger
  heartbeat?: SessionHeartbeat;
  costByProvider?: Record<string, { totalUsd: number; callCount: number }>;
  duelingPlanState?: {
    planA?: PlanArtifact;
    planB?: PlanArtifact;
    planC?: PlanArtifact;
    divergenceNotes?: string;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

/**
 * Append-only record of a single drift-sync outcome for one (package, concern)
 * batch. Persisted on the session so daemon/CLI reruns can tell what was
 * already mapped to JIRA without re-querying.
 */
export interface JiraTicketLedgerEntry {
  readonly driftKey: string;
  readonly packageName: string;
  readonly concernId: string;
  readonly action: 'created' | 'updated' | 'skipped';
  readonly ticketKey?: string; // present for created/updated; absent for skipped unless a ticket was matched
  readonly existingStatus?: string; // JIRA status at sync time (for skipped/updated rows)
  readonly findingIds: readonly string[]; // Finding ids in this batch at sync time
  readonly reason: string; // one-line explanation (e.g., "closed ticket not reopened")
  readonly syncedAt: string; // ISO timestamp
}

export interface WorkspaceGitSnapshot {
  workDir: string;
  headSha?: string;
  branch?: string;
  capturedAt: string;
}

export type VerificationBootstrapTrustLevel = 'clean-worktree' | 'dirty-worktree';

export interface VerificationBootstrapBaseline {
  criterionType: 'typecheck';
  command: string;
  passed: boolean;
  signatures: string[];
  outputExcerpt?: string;
}

export interface VerificationBootstrapRecord {
  version: 1;
  generatedAt: string;
  trustLevel: VerificationBootstrapTrustLevel;
  scopeEntries: string[];
  scopedPackageDirs: string[];
  dirtyWorkspaceFiles: string[];
  cleanedPaths: string[];
  builtPackages: string[];
  notes: string[];
  typecheckBaseline?: VerificationBootstrapBaseline;
}

export interface WorkspaceBaselineDrift {
  baselineWorkDir: string;
  baselineHeadSha: string;
  baselineBranch?: string;
  invocationWorkDir: string;
  invocationHeadSha: string;
  invocationBranch?: string;
  sessionWorkDir: string;
  sessionHeadSha?: string;
  detectedAt: string;
}

// ─── Pipeline & Stages ───────────────────────────────────────────

export interface PipelineTemplate {
  name: string;
  description: string;
  applicableTo: WorkItemType[];
  stages: StageDefinition[];
}

export type StageType =
  | 'bootstrap' // Prepare verification substrate and capture baseline repo noise
  | 'deep-scan' // Codex reads codebase deeply, finds gaps
  | 'oracle-analysis' // Multiple Claude oracles analyze findings
  | 'plan-generation' // Create sliced plan from findings
  | 'manifest-compilation' // Enrich slices with typed repo-backed manifests
  | 'user-checkpoint' // Present plan/findings, get approval
  | 'implementation' // Codex implements a slice
  | 'testing' // Write/run tests for the slice
  | 'review' // Claude reviews implementation
  | 'bulk-review' // deferred aggregate review of autonomously committed slices
  | 'commit-checkpoint' // Commit the slice, checkpoint
  | 'regression' // Run full regression suite
  | 'doc-sync' // Update docs, agents.md, SDLC logs
  | 'reproduce' // For bug-fix: reproduce the bug
  | 'root-cause' // For bug-fix: identify root cause
  | 'concerns-audit' // Deterministic scan over .helix/concerns registry — no LLM
  | 'custom'; // User-defined stage with custom executor

export type StageExecutionRole =
  | 'bootstrap'
  | 'explore'
  | 'plan'
  | 'implement'
  | 'review'
  | 'verify'
  | 'synthesize';

export interface StageDefinition {
  name: string;
  type: StageType;
  role?: StageExecutionRole;
  description: string;
  model: ModelAssignment;
  respectStageModelSelection?: boolean;
  outputSchema?: StageOutputSchemaConfig;
  tools?: string[]; // tools available to the model
  prompt?: string; // stage-specific prompt template
  promptFile?: string; // path to prompt .md file
  qualityGate?: QualityGateConfig;
  canLoop: boolean;
  maxLoopIterations: number;
  parallel?: boolean; // run substages in parallel
  substages?: StageDefinition[];
  checkpoint?: CheckpointType;
  timeoutMs?: number;
  budgetUsd?: number;
}

export type StageOutputSchemaId =
  | 'analysis-report'
  | 'failure-advisory'
  | 'impact-analysis'
  | 'oracle-review'
  | 'plan-c-with-divergence'
  | 'plan-review'
  | 'reproduction-report'
  | 'slice-plan'
  | 'workspace-reconcile';

export interface StageOutputSchemaConfig {
  id: StageOutputSchemaId;
  strict?: boolean;
}

export type CheckpointType =
  | 'user-approval' // pause and wait for user to approve
  | 'user-review' // show results, user can modify or approve
  | 'auto'; // proceed automatically

export interface QualityGateConfig {
  name: string;
  checks: QualityCheck[];
  passThreshold: number; // 0-1, percentage of checks that must pass
  failAction: 'loop' | 'stop' | 'warn';
  timeoutMs?: number; // reserved execution budget for the gate within a stage iteration
}

export interface QualityCheck {
  name: string;
  type:
    | 'typecheck'
    | 'test'
    | 'lint'
    | 'custom-script'
    | 'model-review'
    | 'analysis-report-clear'
    | 'modified-test'
    | 'scenario-evidence'
    | 'replay-target-coverage';
  command?: string; // for script-based checks
  model?: ModelAssignment; // for model-review checks
  prompt?: string; // additional review guidance for model-review checks
  tools?: string[]; // allowed tools for model-review checks
  reviewOutputSchema?: StageOutputSchemaConfig;
}

// ─── Model Routing ───────────────────────────────────────────────

export type ModelEngine =
  | 'claude-code' // Claude Code via Agent SDK (query())
  | 'codex-cli' // OpenAI Codex via CLI (child process)
  | 'claude-api' // Direct Claude API for fast operations
  | 'openai-api'; // OpenAI API (for second opinions)

export interface ModelAssignment {
  primary: ModelSpec;
  fallback?: ModelSpec;
  layered?: ModelSpec[]; // models that review/refine the primary's output
}

export interface ExecutorEfficiencyBudget {
  targetTurns: number;
  explorationTurns: number;
  hardTurnCap?: number;
  shellWarnFloor?: number;
  shellAbortFloor?: number;
  abortExploratoryToolUseAfterTargetTurns?: boolean;
  zeroTurnShellAbortFloor?: number;
  zeroTurnElapsedAbortMs?: number;
  disableToolUse?: boolean;
  forbiddenShellPatterns?: string[];
  allowScopedShellInspection?: boolean;
  scopedShellInspectionCountLimit?: number;
  abortScopedShellInspectionAfterLimit?: boolean;
  scopedToolInspectionCountLimit?: number;
  abortScopedToolInspectionAfterLimit?: boolean;
  summary?: string;
}

export interface ModelSpec {
  engine: ModelEngine;
  model?: string; // e.g., 'opus', 'sonnet', 'codex-mini-latest'
  effort?: 'low' | 'medium' | 'high' | 'extra-high';
  maxTurns?: number;
  stallThresholdMs?: number;
  maxBudgetUsd?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  systemPrompt?: string;
  systemPromptFile?: string;
  env?: Record<string, string>;
  efficiencyBudget?: ExecutorEfficiencyBudget;
}

export interface StageModelPolicyRule {
  preferredEngine?: ModelEngine;
  defaultPrimary?: ModelSpec;
}

export interface HelixStageModelPolicy {
  stages?: Partial<Record<StageType, StageModelPolicyRule>>;
  roles?: Partial<Record<StageExecutionRole, StageModelPolicyRule>>;
  architectureReview?: StageModelPolicyRule;
  modelReview?: StageModelPolicyRule;
}

export interface HelixMcpServerDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ─── Model Executor Interface ────────────────────────────────────

export interface ExecutorResult {
  output: string;
  model: string;
  engine: ModelEngine;
  turnsUsed: number;
  durationMs: number;
  costUsd?: number;
  error?: string;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface StreamEvent {
  type: 'progress' | 'output' | 'tool-use' | 'error' | 'complete';
  timestamp: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ModelExecutor {
  engine: ModelEngine;
  setWorkspaceContext?(workspaceContext?: WorkspaceExecutionContext): void;
  execute(
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult>;
  isAvailable(): Promise<boolean>;
}

export interface PromptContextDocument {
  path: string;
  title: string;
  excerpt: string;
}

export interface PromptCodeMapFile {
  path: string;
  exports: string[];
  exportSignatures?: Record<string, string>;
  dependents: string[];
  dependentCount?: number;
  isTestFile: boolean;
  lineCount?: number;
}

export interface PromptCodeMapDirectorySummaryEntry {
  directory: string;
  fileCount: number;
}

export interface PromptCodeMapDirectorySummary {
  entries: PromptCodeMapDirectorySummaryEntry[];
  omittedDirectoryCount?: number;
  omittedFileCount?: number;
}

export interface PromptCodeMapRepoIndexTelemetry {
  cacheStatus: 'hit' | 'miss' | 'skipped';
  diffHash?: string;
  scopedFileCount: number;
  loadDurationMs: number;
}

export interface PromptCodeMapSnapshot {
  scope: string[];
  totalSourceFiles: number;
  totalTestFiles: number;
  keyFiles: PromptCodeMapFile[];
  allFiles?: string[];
  directorySummary?: PromptCodeMapDirectorySummary;
  repoIndex?: PromptCodeMapRepoIndexTelemetry;
}

export interface PromptContextSnapshot {
  builtAt: string;
  buildDurationMs?: number;
  instructionDocs: PromptContextDocument[];
  featureSpecDoc?: PromptContextDocument;
  testSpecDoc?: PromptContextDocument;
  hldSpecDoc?: PromptContextDocument;
  lldPlanDoc?: PromptContextDocument;
  priorFindingsDoc?: PromptContextDocument;
  priorDecisionsDoc?: PromptContextDocument;
  retrievalTelemetry?: RetrievalTelemetry;
  codeMap?: PromptCodeMapSnapshot;
  /** Bootstrap metadata from Jira ticket resolution — surfaced in deep-scan and planning prompts. */
  bootstrapMeta?: BootstrapMeta;
}

export interface StructuredFindingRecord {
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  files: string[];
}

export interface StructuredDecisionRecord {
  classification: DecisionClassification;
  question: string;
  context: string | null;
  answer: string | null;
}

export interface AnalysisStageOutput {
  summary: string;
  findings: StructuredFindingRecord[];
  decisions: StructuredDecisionRecord[];
}

export type PlanReviewFindingDisposition = 'blocking' | 'advisory';

export interface PlanReviewFindingRecord extends StructuredFindingRecord {
  disposition: PlanReviewFindingDisposition;
}

export type PlanReviewSliceVerdict = 'approved' | 'revise';

export interface PlanReviewSliceAssessmentRecord {
  sliceNumber: number;
  verdict: PlanReviewSliceVerdict;
  rationale: string;
  requiredTestAmendments: string[];
}

export interface DeferredFindingRecord {
  findingId: string;
  reason: string;
}

export interface PlanReviewStageOutput {
  summary: string;
  findings: PlanReviewFindingRecord[];
  sliceAssessments: PlanReviewSliceAssessmentRecord[];
  deferredFindings: DeferredFindingRecord[];
  decisions: StructuredDecisionRecord[];
}

export interface ReproductionStageOutput {
  summary: string;
  testFile: string;
  reproductionSteps: string[];
  findings: StructuredFindingRecord[];
  decisions: StructuredDecisionRecord[];
}

export interface StructuredLegacyPathRecord {
  path: string;
  reason: string;
}

export interface SlicePlanRecord {
  title: string;
  description: string;
  findings: string[];
  files: string[];
  tests: string[];
  dependencies: number[];
  legacyPaths: StructuredLegacyPathRecord[];
}

export interface SlicePlanStageOutput {
  summary: string;
  slices: SlicePlanRecord[];
}

export interface PlanReviewApprovedSlice {
  sliceNumber: number;
  slice: SlicePlanRecord;
}

export interface PlanReviewSliceRevision {
  sliceNumber: number;
  title: string;
  rationale: string;
  requiredTestAmendments: string[];
}

export interface PlanReviewState {
  summary: string;
  approvedSlices: PlanReviewApprovedSlice[];
  slicesToRevise: PlanReviewSliceRevision[];
  deferredFindings: DeferredFindingRecord[];
  blockingFindings: PlanReviewFindingRecord[];
  advisoryFindings: PlanReviewFindingRecord[];
  carriedForwardAt: string;
}

export interface CheckpointApprovalRecord {
  stageName: string;
  artifactHash: string;
  message: string;
  approvedAt: string;
}

export interface OracleCheckpointRecord {
  stageName: string;
  oracleId: string;
  oracleName: string;
  findingsHash: string;
  review: OracleReviewStageOutput;
  capturedAt: string;
}

export interface HarnessDefectRecord {
  id: string;
  kind: 'quality-gate' | 'oracle';
  stageName: string;
  actor: string;
  signature: string;
  occurrences: number;
  sample: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ImpactAnalysisStageOutput {
  dependentFiles: string[];
  affectedTests: string[];
  riskLevel: 'low' | 'medium' | 'high';
  notes: string;
}

export type OracleAssessmentVerdict = 'confirm' | 'challenge' | 'reprioritize';

export type FindingHorizon = 'immediate' | 'next' | 'near-term' | 'long-term';

export interface OracleFindingAssessmentRecord {
  findingId: string;
  verdict: OracleAssessmentVerdict;
  rationale: string;
  severity: FindingSeverity | null;
  horizon?: FindingHorizon | null;
}

export interface OracleReviewStageOutput {
  summary: string;
  assessments: OracleFindingAssessmentRecord[];
  newFindings: StructuredFindingRecord[];
  decisions: StructuredDecisionRecord[];
}

export type WorkspaceReconcileDisposition = 'ignore' | 'block';

export interface WorkspaceReconcileAssessmentRecord {
  file: string;
  disposition: WorkspaceReconcileDisposition;
  rationale: string;
}

export interface WorkspaceReconcileStageOutput {
  summary: string;
  assessments: WorkspaceReconcileAssessmentRecord[];
}

export type FailureAdvisoryCategory =
  | 'timeout'
  | 'quality-gate'
  | 'structured-output'
  | 'workspace-scope'
  | 'model-error'
  | 'loop-limit'
  | 'unknown';

export type FailureAdvisoryRecommendedAction =
  | 'retry-stage'
  | 'synthesize-stage'
  | 'switch-model'
  | 'continue-immediate-only'
  | 'promote-stage'
  | 'pause-and-resume';

export interface FailureAdvisoryBudgetRecommendation {
  rationale: string;
  targetTurns?: number;
  explorationTurns?: number;
  shellWarnFloor?: number;
  shellAbortFloor?: number;
}

export interface FailureAdvisoryStageOutput {
  summary: string;
  suspectedCause: string;
  recommendedAction: FailureAdvisoryRecommendedAction;
  promptGuidance: string | null;
  operatorActions: string[];
  budgetRecommendation?: FailureAdvisoryBudgetRecommendation | null;
}

export interface FailureAdvisoryRecord extends FailureAdvisoryStageOutput {
  id: string;
  stageName: string;
  stageType: StageType;
  failureCategory: FailureAdvisoryCategory;
  failureSignature: string;
  retryCount: number;
  sourceError: string;
  generatedAt: string;
  evidenceDigest?: string[];
}

// ─── Findings ────────────────────────────────────────────────────

export type FindingCategory =
  | 'redundancy' // duplicate code paths, repeated logic
  | 'wiring-gap' // component designed but not connected
  | 'inconsistency' // different behavior across integration points
  | 'bug' // logic error, type error, runtime error
  | 'missing-test' // untested path, no E2E, mock-heavy test
  | 'missing-doc' // undocumented behavior, stale docs
  | 'security' // auth gap, isolation violation, injection risk
  | 'performance' // unbounded collection, missing pagination, N+1
  | 'isolation' // tenant/project/user isolation violation
  | 'dead-code' // unreachable code, unused exports
  | 'stale-dependency' // outdated framework, deprecated API
  | 'concern-drift'; // cross-cutting concern violation detected by .helix/concerns registry

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingStatus = 'open' | 'planned' | 'in-progress' | 'fixed' | 'deferred' | 'wont-fix';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  status: FindingStatus;
  horizon?: FindingHorizon;
  title: string;
  description: string;
  files: FileReference[];
  suggestedFix?: string;
  deferredReason?: string;
  discoveredBy: string; // which stage/oracle found it
  source?: FindingSource; // provenance for registry-sourced findings (drift audit)
  jiraKey?: string; // JIRA ticket that tracks this finding (set by drift-sync adapter)
  assignedSlice?: number; // which milestone slice will fix it
  fixedInCommit?: string; // SHA of the commit that fixed it
  createdAt: string;
  updatedAt: string;
}

/**
 * Structured provenance for findings emitted by the concerns-audit runner.
 * Lets downstream consumers (drift-audit JIRA adapter, daemon) group findings
 * by concern without parsing the human-readable `title` field.
 */
export interface FindingSource {
  readonly concernId: string;
  readonly concernTitle: string;
  readonly detectorId: string;
}

export interface FileReference {
  path: string;
  lines?: [number, number]; // start, end line numbers
  snippet?: string;
}

// ─── Decisions & Oracles ─────────────────────────────────────────

export type DecisionClassification =
  | 'ANSWERED' // Answered by reading existing docs/code
  | 'INFERRED' // Reasonable inference from context
  | 'DECIDED' // Oracle consensus — no user input needed
  | 'AMBIGUOUS'; // Oracles disagree — needs user input

export interface Decision {
  id: string;
  question: string;
  context: string; // what prompted this question
  classification: DecisionClassification;
  answer?: string;
  oracleVotes: OracleVote[];
  resolvedBy?: 'oracle-consensus' | 'user';
  resolvedAt?: string;
  stage: string;
}

export interface OracleVote {
  oracleId: string;
  oracleName: string;
  answer: string;
  confidence: number; // 0-1
  reasoning: string;
  sources: string[]; // files/docs the oracle referenced
}

export type OracleId = string;

export interface OracleDefinition {
  id: OracleId;
  name: string;
  description: string;
  model: ModelSpec;
  promptFile: string; // path to oracle system prompt
  reviewInstructions?: string;
  respectConfiguredLimits?: boolean;
  focusAreas: string[]; // what this oracle looks at
  tools?: string[];
}

// ─── Slices (Milestones) ─────────────────────────────────────────

export type SliceStatus = 'pending' | 'in-progress' | 'locked' | 'committed' | 'failed';

export interface ArchitectureReviewHistoryEntry {
  approved: boolean;
  findingsCount: number;
  timestamp: string;
}

export interface Slice {
  index: number;
  title: string;
  description: string;
  status: SliceStatus;
  findings: string[]; // finding IDs addressed in this slice
  dependencies: number[]; // slice indices that must complete first
  manifest: SliceManifest; // explicit typed contract
  testLock: TestLock; // tests that lock this slice
  impactAnalysis: ImpactAnalysis;
  legacyPaths: LegacyPathPlan[];
  exitCriteria: ExitCriterion[];
  commit?: CommitRecord;
  review?: ReviewResult;
  /**
   * Append-only history of architecture-review verdicts on this slice.
   * Used to detect review-oscillation patterns (blocked → blocked → approved)
   * that signal an over-strict reviewer rather than a real defect.
   */
  archReviewHistory?: ArchitectureReviewHistoryEntry[];
  autonomy?: SliceAutonomyState;
  implementationCheckpoint?: ImplementationCheckpoint;
  verificationCheckpoint?: SliceVerificationCheckpoint;
  proofPacket?: SliceProofPacket;
}

export interface ImplementationCheckpoint {
  output: string;
  diffHash?: string;
  capturedAt: string;
  recoveryContext?: string;
  failedCriteriaSummary?: string;
}

export interface SliceVerificationCriterionCheckpoint {
  criterionId: string;
  criterionType: ExitCriterionType;
  reuseKey?: string;
  detail?: string;
  qualityGate?: QualityGateResult;
  review?: ReviewResult;
  capturedAt: string;
}

export interface SliceVerificationCheckpoint {
  diffHash: string;
  capturedAt: string;
  criteria: SliceVerificationCriterionCheckpoint[];
}

export interface SliceProofCriterion {
  criterionId: string;
  criterionType: ExitCriterionType;
  passed: boolean;
  detail?: string;
  cached: boolean;
}

export interface SliceProofPacket {
  version: 1;
  proofHash: string;
  manifestHash: string;
  sliceNumber: number;
  title: string;
  status: SliceStatus;
  findingIds: string[];
  findings: Array<{
    id: string;
    title: string;
    severity: FindingSeverity;
    status: FindingStatus;
  }>;
  artifacts: {
    implementationDiffHash?: string;
    verificationDiffHash?: string;
    implementationCapturedAt?: string;
    verificationCapturedAt?: string;
  };
  files: {
    direct: string[];
    dependents: string[];
    affectedTests: string[];
    requiredTests: string[];
    regressionSuite: string[];
  };
  criteria: SliceProofCriterion[];
  review?: {
    approved: boolean;
    reviewer: string;
    findingCount: number;
    timestamp: string;
  };
  commit?: {
    sha: string;
    message: string;
    timestamp: string;
  };
  implementationOutputExcerpt?: string;
  generatedAt: string;
}

// ─── Slice Manifest (typed contract) ────────────────────────────

/**
 * Explicit declaration of what a slice WILL do.
 * Generated during planning, verified during execution.
 * Nothing implicit — every file, export, and dependency is declared.
 */
export interface SliceManifest {
  /** What must be true before this slice can start */
  entryConditions: EntryCondition[];
  /** Explicit file change declarations */
  fileContracts: FileContract[];
  /** Exports this slice adds or modifies (wiring contract) */
  exportContracts: ExportContract[];
  /** Deterministic preflight hints that surface likely missing consumers/tests before implementation */
  completeness?: ManifestCompletenessReport;
}

export type EntryConditionType =
  | 'slice-committed'
  | 'file-exists'
  | 'export-available'
  | 'test-passes';

export interface EntryCondition {
  id: string;
  type: EntryConditionType;
  description: string;
  /** Reference: slice index, file path, export name, or test path */
  reference: string;
  met: boolean;
}

export interface FileContract {
  path: string;
  action: 'create' | 'modify' | 'delete';
  reason: string;
  /** For create/modify: exports this file must provide after the change */
  expectedExports?: string[];
  /** Files that import from this file (populated during impact analysis) */
  dependents?: string[];
}

export interface ExportContract {
  /** File that provides the export */
  sourceFile: string;
  /** Name of the exported symbol */
  exportName: string;
  /** Files that will consume this export */
  consumers: string[];
  /** Whether the export existed before this slice */
  isNew: boolean;
}

export interface ManifestCompletenessHint {
  path: string;
  kind: 'consumer' | 'barrel' | 'test';
  suggestedAction: 'review' | 'modify' | 'promote-test';
  reason: string;
}

export interface ManifestCompletenessReport {
  summary: string;
  hints: ManifestCompletenessHint[];
}

// ─── Test Lock ──────────────────────────────────────────────────

/**
 * Tests that "lock" a slice's correctness.
 * A slice cannot be committed until the lock is engaged.
 * Previous slice locks become regression gates for future slices.
 */
export interface TestLock {
  /** Tests that MUST exist and pass for this slice to commit */
  requiredTests: TestRequirement[];
  /** Test files from previous slices that must still pass (regression) */
  regressionSuite: string[];
  /** Whether all required tests + regression pass */
  locked: boolean;
  /** Timestamp when lock was engaged */
  lockedAt?: string;
}

export interface TestRequirement {
  /** Path to the test file */
  testFile: string;
  /** Human-readable description of what this test verifies */
  description: string;
  /** Current state of this test requirement */
  status: 'pending' | 'written' | 'passing' | 'failing';
  /** Finding IDs this test covers — proves the fix works */
  coversFindings: string[];
  /** Whether this test existed before or was written by this slice */
  isNew: boolean;
}

// ─── Exit Criteria ──────────────────────────────────────────────

export type ExitCriterionType =
  | 'typecheck' // tsc --noEmit passes
  | 'lint' // prettier check passes
  | 'test-lock' // all required tests + regression pass
  | 'workspace-scope-clean' // workspace reconcile produced no out-of-scope changes
  | 'architecture-reviewed' // blocking architecture review passes
  | 'impact-reviewed' // dependent files checked for breakage
  | 'no-new-findings' // model review found no new issues
  | 'exports-wired' // all export contracts have consumers
  | 'custom';

export interface ExitCriterion {
  id: string;
  type: ExitCriterionType;
  description: string;
  command?: string; // for custom checks
  passed: boolean;
  detail?: string;
}

// ─── Impact Analysis ────────────────────────────────────────────

export interface ImpactAnalysis {
  directFiles: string[]; // files modified in this slice
  dependentFiles: string[]; // files that import/depend on modified files
  affectedTests: string[]; // test files covering modified paths
  riskLevel: 'low' | 'medium' | 'high';
  notes: string;
}

// ─── Legacy Path Plan ───────────────────────────────────────────

export interface LegacyPathPlan {
  path: string; // file or code path to be removed
  reason: string; // why it's legacy/redundant
  removableAfter: number; // slice index after which it can be removed
  status: 'identified' | 'scheduled' | 'removed';
}

// ─── Checklist (derived view of manifest + test lock + exit criteria)

export interface SliceChecklist {
  items: ChecklistItem[];
}

export type ChecklistCategory =
  | 'entry' // entry conditions met
  | 'implementation' // file contracts fulfilled
  | 'architecture' // blocking architecture review
  | 'test-lock' // tests written and passing
  | 'verification' // typecheck + lint
  | 'regression' // previous slice tests still pass
  | 'impact' // dependent files reviewed
  | 'cleanup'; // legacy paths identified

export interface ChecklistItem {
  id: string;
  label: string;
  category: ChecklistCategory;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface ReviewResult {
  approved: boolean;
  reviewer: string; // model that reviewed
  findings: ReviewFinding[];
  timestamp: string;
}

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export type SliceReviewDisposition = 'manual-checkpoint' | 'deferred-bulk-review';

export type SliceBulkReviewStatus = 'not-required' | 'queued' | 'approved' | 'blocked';

export type SliceConfidenceLevel = 'low' | 'medium' | 'high';

export type AutonomyEvidenceSignal =
  | 'required-tests'
  | 'passing-required-tests'
  | 'regression-suite'
  | 'affected-tests'
  | 'e2e';

export interface ModuleTrustProfile {
  name: string;
  pathPatterns: string[];
  confidenceBoost?: number;
  maxAutoCommitRisk?: ImpactAnalysis['riskLevel'];
  requiredSignals?: AutonomyEvidenceSignal[];
  notes?: string;
}

export interface SliceAutonomyState {
  disposition: SliceReviewDisposition;
  riskLevel: ImpactAnalysis['riskLevel'];
  riskScore: number;
  reasons: string[];
  confidenceLevel: SliceConfidenceLevel;
  confidenceScore: number;
  confidenceReasons: string[];
  matchedTrustProfiles: string[];
  bulkReviewStatus: SliceBulkReviewStatus;
  assessedAt: string;
}

// ─── Commits ─────────────────────────────────────────────────────

export interface CommitRecord {
  sha: string;
  message: string;
  jiraKey: string;
  sliceIndex: number;
  files: string[];
  timestamp: string;
}

// ─── Journal ─────────────────────────────────────────────────────

export type JournalEntryType =
  | 'stage-start'
  | 'stage-complete'
  | 'finding'
  | 'decision'
  | 'oracle-vote'
  | 'slice-start'
  | 'slice-complete'
  | 'commit'
  | 'review'
  | 'quality-gate'
  | 'error'
  | 'user-input'
  | 'progress';

export interface JournalEntry {
  timestamp: string;
  type: JournalEntryType;
  stage: string;
  message: string;
  details?: Record<string, unknown>;
}

// ─── Stage Execution ─────────────────────────────────────────────

export type TimeoutScope = 'stage' | 'model' | 'quality-gate';

export interface TimeoutEvent {
  scope: TimeoutScope;
  actor: string;
  message: string;
  recordedAt: string;
  timeoutMs?: number;
  elapsedMs?: number;
  details?: Record<string, unknown>;
}

export interface QualityGateCheckResult {
  name: string;
  passed: boolean;
  command?: string;
  output?: string;
  /**
   * Distilled view of `output` produced by the deterministic regex distillers
   * in `intelligence/distill.ts`. Populated only on failure and only when the
   * check kind has a distiller (typecheck/test/lint). Other check types fall
   * back to the raw `output` field. Used by next-iteration feedback assembly
   * to keep the assertion error rather than the boilerplate preamble.
   */
  distilledSummary?: string;
  durationMs?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  modelReview?: ModelReviewCheckSummary;
}

export interface QualityGateResult {
  name: string;
  passed: boolean;
  feedback: string;
  checks: QualityGateCheckResult[];
  durationMs: number;
  timeoutMs?: number;
  timedOut?: boolean;
}

export type ModelReviewCheckSummary =
  | {
      schemaId: 'analysis-report';
      approved: boolean;
      findings: StructuredFindingRecord[];
      unresolvedDecisions: StructuredDecisionRecord[];
      summary: string;
    }
  | {
      schemaId: 'plan-review';
      approved: boolean;
      blockingFindings: PlanReviewFindingRecord[];
      advisoryFindings: PlanReviewFindingRecord[];
      sliceAssessments: PlanReviewSliceAssessmentRecord[];
      deferredFindings: DeferredFindingRecord[];
      unresolvedDecisions: StructuredDecisionRecord[];
      summary: string;
    };

export type StageResultStatus = 'passed' | 'failed' | 'skipped' | 'looped';

export interface StageResult {
  stageName: string;
  stageType: StageType;
  status: StageResultStatus;
  output: string;
  findings: Finding[];
  decisions: Decision[];
  durationMs: number;
  iterations: number; // how many times this stage looped
  model: string;
  costUsd?: number;
  error?: string;
  qualityGate?: QualityGateResult;
  timeoutEvents?: TimeoutEvent[];
  executionSummary?: StageExecutionSummary;
  retrieval?: RetrievalTelemetry;
}

export interface StageExecutionSummary {
  progressEvents: number;
  outputEvents: number;
  toolUseEvents: number;
  errorEvents: number;
  shellCommandEvents: number;
  recentMessages: string[];
}

// ─── Progress Reporting ──────────────────────────────────────────

export type ProgressEventType =
  | 'session-start'
  | 'stage-enter'
  | 'stage-progress'
  | 'stage-exit'
  | 'finding-new'
  | 'decision-needed'
  | 'decision-resolved'
  | 'slice-start'
  | 'slice-complete'
  | 'commit'
  | 'quality-gate-result'
  | 'oracle-vote'
  | 'model-stream' // streaming output from model
  | 'error'
  | 'session-complete';

export interface ProgressEvent {
  type: ProgressEventType;
  timestamp: string;
  stage?: string;
  slice?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckpointOptions {
  /**
   * When true, the reporter MUST prompt the operator interactively even
   * if `--auto-approve` was passed. Used when Helix encounters an unusual
   * state (review oscillation, failure-advisor on a passing slice, etc.)
   * that warrants human review beyond what auto-approve was authorized
   * to cover.
   */
  forceInteractive?: boolean;
}

export interface ProgressReporter {
  emit(event: ProgressEvent): void;
  onQuestion(decision: Decision): Promise<string>; // interactive question
  onCheckpoint(message: string, data?: unknown, options?: CheckpointOptions): Promise<boolean>; // approve/reject
}

// ─── Configuration ───────────────────────────────────────────────

export interface ReplayExecutionContext {
  changedFiles?: string[];
  historicalFileHints?: Record<string, string[]>;
  avoidPaths?: string[];
  tags?: string[];
}

export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface HelixConfig {
  workDir: string; // project root
  invocationDir?: string; // directory where the HELIX command was launched
  workspaceContext?: WorkspaceExecutionContext;
  replayContext?: ReplayExecutionContext;
  initialLiveContext?: string[]; // guidance injected into the first pending stage prompt
  sessionDir: string; // .helix/sessions/
  journalDir: string; // docs/sdlc-logs/<feature>/ or .helix/canary-journal/<feature>/
  defaultModel: ModelSpec;
  codexPath: string; // path to codex CLI binary
  claudePath: string; // path to claude CLI binary
  stageModelPolicy?: HelixStageModelPolicy; // config-driven routing preferences per stage/review surface
  mcpServers?: Record<string, HelixMcpServerDefinition>; // MCP servers injected into Codex/Claude runs
  claudeSettingSources?: ClaudeSettingSource[]; // Claude SDK settings sources to load
  allowModelFallbacks?: boolean; // permit runtime fallback after a primary model failure
  maxConcurrentOracles: number;
  maxSliceRetries: number;
  autoCommit: boolean; // commit slices automatically
  autoApprove: boolean; // auto-approve checkpoints and answer model questions conservatively
  progressHeartbeatMs?: number; // internal throttle for live session heartbeat persistence
  autonomy?: AutonomyPolicyConfig;
  budgetLimitUsd: number; // total budget for entire session
  verbose: boolean;
  useOpenAiArchitectureOracle?: boolean; // default false
  enableDuelingPlanners?: boolean; // default false
  openaiModel?: string; // default 'gpt-5'
  embeddingProvider?: HelixEmbeddingProviderConfig; // default disabled
}

export interface AutonomyPolicyConfig {
  mode?: 'manual' | 'thresholded';
  autoCommitMaxRisk?: ImpactAnalysis['riskLevel'];
  deferBulkReview?: boolean;
  lowRiskMaxScore?: number;
  mediumRiskMaxScore?: number;
  minConfidenceScore?: number;
  highConfidenceScore?: number;
  sensitivePathPatterns?: string[];
  sensitiveFindingCategories?: FindingCategory[];
  moduleTrustProfiles?: ModuleTrustProfile[];
}
