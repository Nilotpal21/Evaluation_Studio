import { randomUUID } from 'node:crypto';

import { ModelRouter } from '../models/model-router.js';
import { SessionManager } from '../session/session-manager.js';
import { postScenarioEvidenceComment } from '../integrations/jira-client.js';
import { getEmbeddingShardPathsForSession } from '../intelligence/embedding-config.js';
import { createBgeM3Client } from '../intelligence/bge-m3-client.js';
import { EmbeddingStore } from '../intelligence/embedding-store.js';
import { isHelixEmbeddingsEnabled } from '../runtime-config.js';
import type {
  CommitRecord,
  ExitCriterion,
  ExecutorResult,
  ExecutorEfficiencyBudget,
  FailureAdvisoryRecord,
  HelixConfig,
  Decision,
  Finding,
  FindingCategory,
  FindingSeverity,
  ImpactAnalysis,
  JournalEntry,
  ModelAssignment,
  ModelEngine,
  ModelSpec,
  PipelineTemplate,
  ProgressEvent,
  ProgressReporter,
  QualityGateCheckResult,
  QualityGateConfig,
  QualityGateResult,
  ReviewFinding,
  ReviewResult,
  Session,
  Slice,
  SliceVerificationCriterionCheckpoint,
  StageDefinition,
  StageExecutionSummary,
  StageOutputSchemaConfig,
  StageResult,
  StreamEvent,
  TimeoutEvent,
} from '../types.js';
import { LiveContext } from '../interactive/live-context.js';
import type {
  PipelinePauseResult,
  PipelineResumeResult,
  PipelineStatus,
} from '../interactive/types.js';
import { accumulateProviderCost } from './cost-accumulator.js';
import { CommitManager } from './commit-manager.js';
import {
  formatSliceAutonomySummary,
  markSliceQueuedForBulkReview,
  resolveAutonomyPolicy,
} from './autonomy-policy.js';
import {
  buildScopedLintCmd,
  buildScopedTypecheckCmd,
  buildTestLockCommand,
  runQualityGate,
} from './quality-gate.js';
import {
  buildFailureAdvisoryPrompt,
  buildSliceArchitectureReviewPrompt,
  buildWorkspaceReconcilePrompt,
} from './model-review-prompts.js';
import {
  buildStageExecutionEnvelope,
  withExecutionRuntimeHints,
  stripLayeredForLowRiskSlice,
  withExecutorEfficiencyBudget,
} from './execution-envelope.js';
import { buildFailureAdvisoryRetryPlan } from './failure-advisory-retry-plan.js';
import { decideDeterministicStageContinuation } from './stage-continuation-advisor.js';
import {
  buildSliceArchitectureReviewPacket,
  buildSliceContextPacket,
} from './slice-context-packet.js';
import { shouldRequireSliceCommitApproval } from './slice-commit-approval.js';
import { SpecialStageExecutor } from './special-stage-executor.js';
import {
  createStageExecutionSummary,
  createStageStreamHandler,
  getRemainingTimeoutMs,
  hasDeadlineExpired,
  isTimeoutError,
  makeResult,
  now,
  parseLegacyPaths,
  recordStageExecutionStreamEvent,
  resolveSessionStateForStage,
  resolveStageDeadlineAt,
} from './stage-execution-shared.js';
import {
  buildStagePrompt,
  buildSlicePrompt,
  estimateArchitectureReviewEfficiencyBudget,
  estimateSliceEfficiencyBudget,
} from './stage-runner.js';
import { createEmbeddingShardLogger } from './embedding-shard-store.js';
import { decideStageContinuation, resolveStageMaxAttempts } from './stage-machine.js';
import { buildPromptContext, renderPromptContext } from './prompt-context.js';
import {
  applyDeferredPlanFindings,
  buildHorizonDeferredPlanFindings,
  buildPlanReviewState,
  getVisiblePlanFindings,
} from './plan-review-state.js';
import {
  buildStageFailureSignature,
  clearPendingFailureAdvisory,
  getFailureAdvisoryRetryCount,
  recordFailureAdvisory,
} from './control-plane-state.js';
import { buildStageOutputInstructions } from './stage-output-schema.js';
import {
  applySliceAssignments,
  normalizeBroadReplayPlanFindingOwnership,
  parseAnalysisOutput,
  parseImpactAnalysisOutput,
  parseReproductionOutput,
  parseSlicePlanOutput,
  parseStructuredStageOutputResult,
  validateSlicePlan,
} from './stage-output-parsers.js';
import { compileSliceArtifacts } from './manifest-compiler.js';
import {
  ensureVerificationBootstrap,
  matchVerificationBootstrapBaseline,
} from './verification-bootstrap.js';
import type { WorkspaceFileSnapshot } from './workspace-status.js';
import {
  captureWorkspaceFileSnapshot,
  isTestFilePath,
  partitionDeterministicOutOfScopeWorkspacePaths,
  listChangedWorkspacePaths,
} from './workspace-status.js';
import { isTestFile, normalizeRepoPath } from './repo-index.js';
import {
  detectStaleWorkspaceBaseline,
  formatWorkspaceBaselineDrift,
} from '../workspace-baseline.js';
import {
  allExitCriteriaMet,
  buildSliceChecklist,
  canEngageTestLock,
  getSliceGateScopeEntries,
  getSliceFiles,
  getSliceReviewScopeEntries,
  getSliceVerificationScopeEntries,
  summarizeExitCriteria,
  summarizeTestLock,
  updateExitCriterion,
} from './slice-view.js';
import {
  buildDecisionFingerprint,
  buildFindingFingerprint,
  dedupeDecisions,
  dedupeFindings,
} from './engine/dedupe.js';
import {
  dedupeStrings,
  firstNonEmptyLine,
  trimTrailingSlash,
  truncateMultilineText,
  unwrapRetryOutput,
} from './engine/text-utils.js';
import {
  resolveProgressHeartbeatMs,
  shouldPersistProgressHeartbeat,
} from './engine/progress-heartbeat.js';
import {
  architectureFindingBlocksApproval,
  orderExitCriteria,
} from './engine/exit-criteria-ordering.js';
import {
  formatQualityGateCheckEvidence,
  summarizeExportContracts,
  summarizeFailedExitCriteria,
  summarizeImpactAnalysis,
  summarizeQualityGateEvidence,
} from './engine/gate-evidence.js';
import {
  buildExistingDiffResumeContext,
  buildImplementationRecoveryContext,
  buildManifestDriftRetryContext,
  buildTestRepairRetryContext,
  buildTypecheckRepairRetryContext,
  isImplementationExplorationBudgetError,
} from './engine/retry-context.js';
import { analyzeArchReviewHistory, recordArchReviewVerdict } from './engine/review-oscillation.js';
import {
  deriveManifestImpactAnalysis,
  isAutoExpandableWorkspaceDriftPath,
  isRecoverableManifestDriftPath,
  workspaceAssessmentMatchesTarget,
} from './engine/manifest-drift.js';
import {
  annotateReusedVerificationDetail,
  buildArchitectureReviewReuseMetadata,
  buildVerificationReuseKey,
  cacheReusableVerificationCriterion,
  clearReusableVerificationCriterion,
  getReusableVerificationCriterion,
  type SliceReviewWorkspaceState,
} from './engine/verification-reuse.js';
import { buildSliceCommitCheckpointSummary } from './engine/slice-checkpoint-summary.js';
import { estimatePlanReviewEfficiencyBudget } from './engine/plan-review-budget.js';
import { formatStageExecutionSummaryForAdvisory } from './engine/advisory-format.js';
import { isReplayScopedPath, resolveReplayHistoricalPaths } from './engine/replay-paths.js';
import {
  isBroadReplayReplayTask,
  normalizeReplayFinding,
  normalizeReplayParsedArtifacts,
} from './engine/replay-artifacts.js';
import {
  extractDeferredPlanFindings,
  mergeDeferredPlanFindings,
  normalizeBroadReplayDeferredPlanSlices,
} from './engine/plan-review-deferred.js';
import {
  classifyFailureAdvisoryCategory,
  isFailureAdvisoryEligible,
  shouldBypassFailureAdvisoryModel,
} from './engine/failure-advisory-classify.js';
import {
  buildFailureAdvisoryEvidenceDigest,
  describeBlockingStageResult,
} from './engine/failure-advisory-evidence.js';
import {
  MAX_FAILURE_ADVISORY_RETRIES,
  maybePromoteFailureAdvisoryAction,
} from './engine/failure-advisory-actions.js';
import {
  resolveStageExecutionEfficiencyBudget,
  resolveStageExecutionStallThresholdMs,
} from './engine/stage-execution-resolution.js';
import {
  isZeroTurnStartupFailureAdvisory,
  isZeroTurnStartupFailureText,
  shouldUseFailureAdvisoryStableReplayModelSwitch,
  shouldUseFailureAdvisorySwitchModelSynthesis,
} from './engine/failure-advisory-detection.js';
import {
  buildBroadReplayPlanReviewContinuationResult,
  buildBroadReplayPlanReviewPrompt,
  buildPlanReviewSynthesisPrompt,
  shouldRetryPlanReviewWithSynthesis,
} from './engine/plan-review-prompts.js';
import {
  createTimeoutEvent,
  resolveQualityGateTimeoutMs,
  resolveReservedQualityGateTimeoutMs,
} from './engine/quality-gate-timeout.js';
import {
  canPromoteTimedOutDeepScan,
  canPromoteTimedOutReproduction,
  recoverPromotableTimedOutDeepScanCheckpoint,
} from './engine/timed-out-promotion.js';
import {
  buildCompactReplayRecoveryPrompt,
  buildDeterministicStageContinuationPrompt,
  formatCompactPlanFindingsRegistry,
  inferDefaultFindingHorizon,
  shouldUseCompactReplayRecoveryPrompt,
} from './engine/recovery-prompts.js';
import {
  applyDeterministicStageSynthesisMode,
  applyFailureAdvisoryEvidenceOnlyRetryMode,
  applyFailureAdvisoryStableReplayRetryMode,
  applyFailureAdvisorySwitchModelMode,
  applyFailureAdvisorySynthesisMode,
} from './engine/failure-advisory-modes.js';
import {
  applyFailureAdvisoryEvidenceOnlyRetryPromptOverride,
  applyFailureAdvisoryImmediateOnlyPromptOverride,
  applyFailureAdvisoryRetryPromptOverride,
  applyFailureAdvisorySynthesisPromptOverride,
} from './engine/failure-advisory-prompt-overrides.js';
import {
  isReplaySynthesisRetryStage,
  shouldRetainCurrentSynthesisRetry,
  shouldUseFailureAdvisoryEvidenceOnlyRetry,
  shouldUseFailureAdvisoryStableReplayEvidenceRetry,
  shouldUseFailureAdvisoryStableReplayRetry,
} from './engine/failure-advisory-retry-predicates.js';
import {
  countPriorBlockingStageFailures,
  describeExitCriterion,
  isBlockingStageResult,
  restoreStageDefinitionForRetry,
  shouldRetryArchitectureReviewFromEvidence,
  shouldRunDeterministicReplayRegression,
  verifyEntryConditions,
} from './engine/stage-predicates.js';
import { captureHeadSha, captureSliceDiff, captureSliceDiffStat } from './engine/git-capture.js';
import { buildFailureAdvisoryPromotionOutput } from './engine/failure-advisory-promotion.js';
import { maybeRecordDeterministicGateHarnessDefect } from './engine/harness-defect.js';
import {
  failStageDueToTimeout,
  type StageTimeoutSideEffects,
} from './engine/fail-stage-due-to-timeout.js';
import { enforceReproductionArtifact } from './engine/enforce-reproduction-artifact.js';
import {
  evaluateLintCriterion,
  evaluateTypecheckCriterion,
  type ParallelCriterionEvaluation,
} from './engine/parallel-criterion-evaluators.js';
import {
  getStageModelPolicy,
  lockModelReviewEngine,
  resolveArchitectureReviewAssignment,
  resolveFailureAdvisoryAssignment,
  resolveWorkspaceReconcileAssignment,
  selectModelReviewAssignment,
} from './engine/model-assignment-resolvers.js';
import { assessSliceAutonomyFromConfig } from './engine/slice-autonomy-assessor.js';
import { inspectSliceReviewWorkspaceState } from './engine/slice-review-workspace.js';
import { buildFallbackFailureAdvisory } from './engine/fallback-failure-advisory.js';
import {
  createFailedReview,
  formatArchitectureReviewFeedback,
  lockReviewAssignmentToPrimary,
  materializeReviewFinding,
  reconcileDeterministicExitCriteria,
  tryApproveArchitectureReviewFromImplementationReview,
} from './engine/review-helpers.js';
import {
  buildEffectiveQualityGate,
  buildStageQualityGateScopeEntries,
  shouldSkipImplementationStageModelReview,
  shouldUseScopedRegressionQualityGate,
} from './engine/quality-gate-helpers.js';
import {
  applyFailureAdvisoryBudgetRecommendation,
  buildFailureAdvisoryCheckpointData,
  normalizeFailureAdvisoryBudgetRecommendation,
  normalizeFailureAdvisoryOutput,
} from './engine/failure-advisory-normalize.js';

const FAILURE_ADVISORY_TIMEOUT_MS = 60_000;
const MAX_TYPECHECK_REPAIR_ATTEMPTS = 1;
const embeddingHookLog = createEmbeddingShardLogger('helix.embedding-hook');

interface ExitCriteriaEvaluation {
  allMet: boolean;
  failedCriteria: ExitCriterion[];
  qualityGateResults: Record<string, QualityGateResult>;
}

interface WorkspaceReconcileDecision {
  summary: string;
  ignoredFiles: string[];
  blockingFiles: string[];
}

type FailureAdvisoryDisposition = 'continue' | 'retry' | 'paused' | 'promoted';

/**
 * Pipeline Engine — the core orchestrator of HELIX.
 *
 * Drives a session through pipeline stages:
 *   stage → model execution → quality gate → loop or advance
 *
 * Handles:
 * - Sequential and parallel stage execution
 * - Quality gate enforcement with loop-back
 * - User checkpoints (approval, question answering)
 * - Milestone-based slice execution
 * - Session persistence after every state change
 * - Streaming progress to the terminal reporter
 */
export class PipelineEngine {
  private readonly modelRouter: ModelRouter;
  private readonly sessionManager: SessionManager;
  private readonly commitManager: CommitManager;
  private readonly specialStageExecutor: SpecialStageExecutor;
  private aborted = false;
  private pauseRequested = false;
  private pauseController: { promise: Promise<void>; resolve: () => void } | null = null;
  private readonly skipSet = new Set<string>();
  private currentSession: Session | null = null;
  private currentPipeline: PipelineTemplate | null = null;
  private pipelineStartTime = 0;
  private lastHeartbeatPersistAtMs = 0;
  private readonly stageSideEffects: StageTimeoutSideEffects;
  private embeddingStore: EmbeddingStore | null = null;

  /** Live context accumulator — users inject guidance mid-run via the interactive REPL. */
  readonly liveContext = new LiveContext();

  constructor(
    private readonly config: HelixConfig,
    private readonly reporter: ProgressReporter,
  ) {
    this.modelRouter = new ModelRouter(config.codexPath, config.workDir, {
      allowFallbacks: config.allowModelFallbacks ?? false,
      claudeSettingSources: config.claudeSettingSources ?? ['user'],
      mcpServers: config.mcpServers,
      workspaceContext: config.workspaceContext,
    });
    this.sessionManager = new SessionManager(config);
    this.stageSideEffects = {
      emitProgress: (event) => this.emitProgress(event),
      journal: (session, entry) => this.journal(session, entry),
    };
    this.commitManager = new CommitManager({
      config,
      reporter,
      emitProgress: (event) => this.emitProgress(event),
      reconcileOutOfScopeChanges: (request) => this.reconcileCommitOutOfScopeChanges(request),
    });
    this.specialStageExecutor = new SpecialStageExecutor({
      config,
      reporter,
      modelRouter: this.modelRouter,
      sessionManager: this.sessionManager,
      emitProgress: (event) => this.emitProgress(event),
      journal: (session, entry) => this.journal(session, entry),
    });
  }

  private async postScenarioEvidenceCommentIfAvailable(session: Session): Promise<void> {
    const jiraKey = session.workItem.jiraKey?.trim();
    if (!jiraKey || !/^[A-Z][A-Z0-9]+-\d+$/.test(jiraKey)) {
      return;
    }

    const evidenceCheck = session.stageHistory
      .flatMap((stage) => stage.qualityGate?.checks ?? [])
      .find((check) => check.name === 'Scenario-mapped Jira evidence exists' && check.passed);
    if (!evidenceCheck) {
      return;
    }

    try {
      await postScenarioEvidenceComment(jiraKey, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: 'jira-evidence',
        message: `JIRA scenario evidence comment failed (non-blocking): ${message}`,
      });
    }
  }

  /**
   * Run a pipeline from scratch or resume a paused session.
   */
  async run(session: Session, pipeline: PipelineTemplate): Promise<Session> {
    this.aborted = false;
    this.pauseRequested = false;
    this.pauseController = null;
    this.currentSession = session;
    this.currentPipeline = pipeline;
    this.pipelineStartTime = Date.now();
    this.lastHeartbeatPersistAtMs = Date.now();
    this.ensureEmbeddingShardPaths(session);

    // Construct EmbeddingStore once per run (D-L10)
    if (isHelixEmbeddingsEnabled(this.config) && this.config.embeddingProvider) {
      const bgeClient = createBgeM3Client({
        baseUrl: this.config.embeddingProvider.baseUrl,
        timeoutMs: this.config.embeddingProvider.timeoutMs,
        maxBatchSize: this.config.embeddingProvider.maxBatchSize,
        authToken: this.config.embeddingProvider.authToken,
      });
      this.embeddingStore = new EmbeddingStore(this.config.embeddingProvider, bgeClient);
    } else {
      this.embeddingStore = null;
    }

    // Bind live context to session for file-based persistence
    this.liveContext.bindToSession(this.config.sessionDir, session.id);
    await this.liveContext.loadFromFile(this.config.sessionDir, session.id);
    await this.seedInitialLiveContext();

    await this.refreshPromptContext(session);

    this.emitProgress({
      type: 'session-start',
      timestamp: now(),
      message: `${session.workItem.title} — ${pipeline.name}`,
      details: {
        sessionId: session.id,
        workItemType: session.workItem.type,
        scope: session.workItem.scope,
        embeddingsEnabled: isHelixEmbeddingsEnabled(this.config),
        embeddingShardLayout: this.config.embeddingProvider?.shardLayout,
      },
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'stage-start',
      stage: 'pipeline',
      message: `Starting pipeline: ${pipeline.name}`,
    });

    this.syncModelWorkspaceContext(session);
    await this.reconcileCompletedStageCheckpoint(session, pipeline);

    // Execute stages sequentially from current position
    for (let i = session.currentStageIndex; i < pipeline.stages.length; i++) {
      if (this.aborted) break;

      const stage = pipeline.stages[i];
      this.syncModelWorkspaceContext(session);

      // Check for interactive pause
      if (this.pauseRequested || this.pauseController) {
        await this.pauseUntilResumed(session, stage);
        if (this.aborted) {
          break;
        }
      }

      const activeStageState = await this.enterStage(session, stage, i);

      // Skip stages marked by the interactive shell
      if (this.skipSet.has(stage.name) || this.skipSet.has(stage.type)) {
        this.skipSet.delete(stage.name);
        this.skipSet.delete(stage.type);
        const skippedResult = makeResult(
          stage,
          'skipped',
          '',
          [],
          [],
          Date.now(),
          0,
          'Skipped by user',
        );
        this.attachRetrievalTelemetry(skippedResult, session);
        session.stageHistory.push(skippedResult);
        await this.onStageCompleted(session, stage);
        await this.persistSuccessfulStageCheckpoint(session, i);
        this.emitProgress({
          type: 'stage-exit',
          timestamp: now(),
          stage: stage.name,
          message: 'Skipped by user',
        });
        continue;
      }

      if (await this.maybeCompleteFeatureAuditWithoutActionablePlan(session, stage, pipeline)) {
        break;
      }

      let result!: StageResult;
      while (true) {
        const resumeDisposition = await this.resumePendingFailureAdvisory(
          session,
          stage,
          activeStageState,
        );
        if (resumeDisposition === 'paused') {
          return this.finalizePausedSession(session, stage);
        }
        if (resumeDisposition === 'promoted') {
          result = session.stageHistory.at(-1)!;
          break;
        }

        result = await this.executeStage(session, stage, pipeline, undefined, activeStageState);
        this.attachRetrievalTelemetry(result, session);
        session.stageHistory.push(result);
        await this.onStageCompleted(session, stage);

        const failureDisposition = await this.handleBlockingStageResult(
          session,
          stage,
          result,
          activeStageState,
        );
        if (failureDisposition === 'retry') {
          continue;
        }

        if (stage.type === 'plan-generation' && !isBlockingStageResult(result)) {
          const deferredPlanFindings = mergeDeferredPlanFindings(
            extractDeferredPlanFindings(result.qualityGate),
            buildHorizonDeferredPlanFindings(session),
          );
          const deferredFindingIds = new Set(
            deferredPlanFindings.map((finding) => finding.findingId),
          );
          let slices = parseSlicePlanOutput(result.output, session);
          const normalizedPlan = normalizeBroadReplayDeferredPlanSlices(
            session,
            slices,
            deferredFindingIds,
          );
          if (normalizedPlan.changed) {
            slices = normalizedPlan.slices;
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              message: normalizedPlan.summary,
            });
          }
          if (isBroadReplayReplayTask(session)) {
            const normalizedOwnership = normalizeBroadReplayPlanFindingOwnership(slices);
            if (normalizedOwnership.changed) {
              slices = normalizedOwnership.slices;
              this.emitProgress({
                type: 'stage-progress',
                timestamp: now(),
                stage: stage.name,
                message: `Normalized broad replay plan by reassigning ${normalizedOwnership.removedAssignments} duplicate finding ownership entr${normalizedOwnership.removedAssignments === 1 ? 'y' : 'ies'} to the earliest owning slice.`,
              });
            }
          }
          const validation = validateSlicePlan(slices, session, {
            deferredFindingIds,
            allowDependentContinuationSlicesWithoutFindings: isBroadReplayReplayTask(session),
          });

          if (!validation.ok) {
            result.status = 'failed';
            result.error = validation.reason;

            this.emitProgress({
              type: 'error',
              timestamp: now(),
              stage: stage.name,
              message: validation.reason,
            });

            const validationFailureDisposition = await this.handleBlockingStageResult(
              session,
              stage,
              result,
              activeStageState,
            );
            if (validationFailureDisposition === 'retry') {
              continue;
            }
          } else {
            session.slices = slices;
            session.totalSlices = slices.length;
            applySliceAssignments(slices, session);
            applyDeferredPlanFindings(session, deferredPlanFindings);
            session.planReviewState = undefined;
          }
        }

        break;
      }

      if (isBlockingStageResult(result)) {
        if (session.state === 'paused') {
          return this.finalizePausedSession(session, stage);
        }

        await this.sessionManager.updateState(session, 'failed');
        session.error = describeBlockingStageResult(stage, result);
        await this.sessionManager.persist(session);

        this.emitProgress({
          type: 'error',
          timestamp: now(),
          stage: stage.name,
          message: session.error,
        });
        return session;
      }

      await this.persistSuccessfulStageCheckpoint(session, i);

      if (stage.type === 'plan-generation') {
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: `Parsed ${session.slices.length} slices from plan`,
        });
      }
    }

    if (this.aborted) {
      await this.sessionManager.updateState(session, 'failed');
      session.error = 'Aborted by user';
      await this.sessionManager.persist(session);
      this.emitProgress({
        type: 'session-complete',
        timestamp: now(),
        message: 'Session aborted by user',
        details: {
          sessionId: session.id,
          resumeCommand: `helix resume ${session.id}`,
          totalFindings: session.findings.length,
          findingsFixed: session.findings.filter((f) => f.status === 'fixed').length,
          totalCommits: session.commits.length,
        },
      });
      return session;
    }

    // Pipeline complete
    await this.sessionManager.updateState(session, 'completed');
    session.completedAt = now();
    await this.sessionManager.persist(session);
    await this.sessionManager.persistFindings(session);
    await this.sessionManager.persistDecisions(session);
    await this.postScenarioEvidenceCommentIfAvailable(session);

    const totalCostUsd = session.stageHistory.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

    this.emitProgress({
      type: 'session-complete',
      timestamp: now(),
      message: `Pipeline complete: ${pipeline.name}`,
      details: {
        sessionId: session.id,
        totalFindings: session.findings.length,
        findingsFixed: session.findings.filter((f) => f.status === 'fixed').length,
        totalCommits: session.commits.length,
        totalDecisions: session.decisions.length,
        totalCostUsd: totalCostUsd || undefined,
      },
    });

    return session;
  }

  private async maybeCompleteFeatureAuditWithoutActionablePlan(
    session: Session,
    stage: StageDefinition,
    pipeline: PipelineTemplate,
  ): Promise<boolean> {
    if (stage.type !== 'plan-generation' || session.workItem.type !== 'feature-audit') {
      return false;
    }

    if ((session.planReviewState?.approvedSlices.length ?? 0) > 0) {
      return false;
    }

    const actionableFindings = getVisiblePlanFindings(session);
    if (actionableFindings.length > 0) {
      return false;
    }

    const deferredPlanFindings = mergeDeferredPlanFindings(
      session.planReviewState?.deferredFindings ?? [],
      buildHorizonDeferredPlanFindings(session),
    );
    if (deferredPlanFindings.length > 0) {
      applyDeferredPlanFindings(session, deferredPlanFindings);
    }

    const message =
      deferredPlanFindings.length > 0
        ? `No open immediate or next-horizon findings remain for this feature audit; skipping plan generation and ending the pipeline without implementation slices. ${deferredPlanFindings.length} finding(s) remain deferred for a later pass.`
        : 'No open immediate or next-horizon findings remain for this feature audit; skipping plan generation and ending the pipeline without implementation slices.';

    clearPendingFailureAdvisory(session);
    session.error = undefined;
    session.currentStageIndex = pipeline.stages.length;
    const skippedResult = makeResult(stage, 'skipped', message, [], [], Date.now(), 0);
    this.attachRetrievalTelemetry(skippedResult, session);
    session.stageHistory.push(skippedResult);
    await this.onStageCompleted(session, stage);

    await this.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message,
    });

    this.emitProgress({
      type: 'stage-exit',
      timestamp: now(),
      stage: stage.name,
      message,
    });

    return true;
  }

  private syncModelWorkspaceContext(session: Session): void {
    this.modelRouter.setWorkspaceContext(session.workspaceContext ?? this.config.workspaceContext);
  }

  private ensureEmbeddingShardPaths(session: Session): void {
    if (session.embeddingShardPaths || !isHelixEmbeddingsEnabled(this.config)) {
      return;
    }

    session.embeddingShardPaths = getEmbeddingShardPathsForSession(
      this.config.embeddingProvider,
      session.id,
    );
  }

  private attachRetrievalTelemetry(result: StageResult, session: Session): void {
    const shouldAttach =
      result.stageType === 'deep-scan' ||
      result.stageType === 'oracle-analysis' ||
      result.stageType === 'plan-generation' ||
      result.stageType === 'implementation';
    if (!shouldAttach || !session.promptContext?.retrievalTelemetry) {
      return;
    }

    result.retrieval = { ...session.promptContext.retrievalTelemetry };
  }

  /**
   * Narrow stage-complete hook (D-L6, D-L7).
   *
   * Fires ONLY the embedding hook — no journal write, no stageHistory push.
   * Called from each of the 3 stageHistory.push sites after the push.
   * The 3 existing 'stage-complete' journal sites are NOT modified.
   *
   * Error envelope (D-L10): embedding failures are caught here and routed
   * through the structured journal (type: 'error') rather than swallowed.
   * They never stall or fail pipeline progression.
   */
  private async onStageCompleted(session: Session, stage: StageDefinition): Promise<void> {
    if (!this.embeddingStore) return;

    try {
      await this.embeddingStore.notifyStageComplete(session, stage);
    } catch (err) {
      // Embedding errors must never fail the pipeline (graceful degradation).
      // Route through the structured error journal so failures are traceable
      // rather than silently swallowed or only written to stderr.
      const message = err instanceof Error ? err.message : String(err);
      embeddingHookLog.error('notifyStageComplete failed', {
        error: message,
        sessionId: session.id,
        stageName: stage.name,
      });
      try {
        await this.journal(session, {
          timestamp: now(),
          type: 'error',
          stage: stage.name,
          message: `Embedding hook failed (non-blocking): ${message}`,
          details: { embeddingError: true, stageName: stage.name },
        });
      } catch (journalError) {
        const journalMessage =
          journalError instanceof Error ? journalError.message : String(journalError);
        embeddingHookLog.error('Failed to journal embedding hook failure', {
          error: journalMessage,
          sessionId: session.id,
          stageName: stage.name,
        });
      }
    }
  }

  private async seedInitialLiveContext(): Promise<void> {
    const initialEntries = (this.config.initialLiveContext ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (initialEntries.length === 0) {
      return;
    }

    const existing = new Set(this.liveContext.getAll().map((entry) => entry.content));
    for (const entry of initialEntries) {
      if (existing.has(entry)) {
        continue;
      }
      await this.liveContext.add(entry);
      existing.add(entry);
    }
  }

  private async reconcileCompletedStageCheckpoint(
    session: Session,
    pipeline: PipelineTemplate,
  ): Promise<void> {
    const recoveredStages: string[] = [];

    while (session.currentStageIndex < pipeline.stages.length) {
      const currentStage = pipeline.stages[session.currentStageIndex];
      const lastResult = session.stageHistory.at(-1);

      if (!currentStage || !lastResult) {
        break;
      }

      const stageMatchesCheckpoint =
        lastResult.stageName === currentStage.name && lastResult.stageType === currentStage.type;
      if (stageMatchesCheckpoint) {
        const promotedStageLabel = recoverPromotableTimedOutDeepScanCheckpoint(
          session,
          currentStage,
          lastResult,
        );
        if (promotedStageLabel) {
          recoveredStages.push(promotedStageLabel);
          session.currentStageIndex += 1;
          continue;
        }

        const recoveredImplementationLabel =
          await this.recoverReplayImplementationCheckpointFromPostProofCommit(
            session,
            currentStage,
            lastResult,
          );
        if (recoveredImplementationLabel) {
          recoveredStages.push(recoveredImplementationLabel);
          session.currentStageIndex += 1;
          continue;
        }
      }

      const stageAlreadyCompleted =
        lastResult.status === 'passed' || lastResult.status === 'skipped';

      if (!stageMatchesCheckpoint || !stageAlreadyCompleted) {
        break;
      }

      recoveredStages.push(currentStage.name);
      session.currentStageIndex += 1;
    }

    if (recoveredStages.length === 0) {
      return;
    }

    session.state = 'executing';
    await this.sessionManager.persist(session);

    const nextStage = pipeline.stages[session.currentStageIndex]?.name ?? 'pipeline completion';
    const message = `Recovered ${recoveredStages.length} completed stage checkpoint(s); resuming at ${nextStage}`;

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'pipeline',
      message,
      details: { recoveredStages, nextStage },
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: 'pipeline',
      message,
      details: { recoveredStages, nextStage },
    });
  }

  private async persistSuccessfulStageCheckpoint(
    session: Session,
    stageIndex: number,
  ): Promise<void> {
    session.currentStageIndex = stageIndex + 1;
    session.state = 'executing';
    session.error = undefined;
    await this.sessionManager.persist(session);
  }

  private async enterStage(
    session: Session,
    stage: StageDefinition,
    stageIndex: number,
  ): Promise<Session['state']> {
    const activeStageState = resolveSessionStateForStage(stage);
    session.currentStageIndex = stageIndex;
    session.state = activeStageState;
    session.error = undefined;
    await this.sessionManager.persist(session);
    return activeStageState;
  }

  private async finalizePausedSession(session: Session, stage: StageDefinition): Promise<Session> {
    await this.sessionManager.persist(session);
    this.emitProgress({
      type: 'session-complete',
      timestamp: now(),
      message: `Session paused at ${stage.name}`,
      details: {
        sessionId: session.id,
        resumeCommand: `helix resume ${session.id}`,
        pausedAt: stage.name,
        totalFindings: session.findings.length,
        // ABLP-796: include findingsFixed and use the actual commits array so
        // the paused banner reports real progress instead of "0/N fixed" with
        // a stage-history-derived commit count that hides slice commits.
        findingsFixed: session.findings.filter((f) => f.status === 'fixed').length,
        totalCommits: session.commits.length,
      },
    });
    return session;
  }

  private async recoverReplayImplementationCheckpointFromPostProofCommit(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
  ): Promise<string | null> {
    if (
      stage.type !== 'implementation' ||
      !session.replayContext ||
      result.status !== 'failed' ||
      !session.workspaceBaseline?.headSha
    ) {
      return null;
    }

    const failureText = [result.error, result.output, result.qualityGate?.feedback]
      .filter(Boolean)
      .join('\n');
    if (
      !/\b(quality gate|review|wiring|tests green|all tests green|consumer verification)\b/i.test(
        failureText,
      )
    ) {
      return null;
    }

    const syntheticAdvisory: FailureAdvisoryRecord = {
      id: `recovered-${stage.type}-${now()}`,
      stageName: stage.name,
      stageType: stage.type,
      failureCategory: 'quality-gate',
      failureSignature: `${stage.name}:replay-post-proof-checkpoint`,
      retryCount: 0,
      sourceError: result.error ?? 'Replay implementation checkpoint promotion',
      generatedAt: now(),
      summary:
        'Implementation complete and all tests green; the replay worktree already contains the post-proof commit.',
      suspectedCause:
        'A prior quality-gate or reviewer failure interrupted session finalization after the implementation commit was already written.',
      recommendedAction: 'promote-stage',
      promptGuidance: null,
      operatorActions: [
        'Promote the implementation stage from the existing replay commit and continue the pipeline.',
      ],
      evidenceDigest: ['Replay implementation commit exists and the worktree is clean.'],
    };

    const promoted = await this.promoteFailureAdvisoryStage(
      session,
      stage,
      syntheticAdvisory,
      'executing',
      result,
    );
    return promoted ? stage.name : null;
  }

  private async resumePendingFailureAdvisory(
    session: Session,
    stage: StageDefinition,
    resumeState: Session['state'],
  ): Promise<FailureAdvisoryDisposition> {
    const advisory = session.pendingFailureAdvisory;
    if (!advisory || advisory.stageName !== stage.name || advisory.stageType !== stage.type) {
      return 'continue';
    }

    const recoverableStageResults = [...session.stageHistory]
      .reverse()
      .filter(
        (entry) =>
          entry.stageName === stage.name &&
          (entry.status === 'failed' || entry.status === 'looped'),
      );
    const persistedStageResult = recoverableStageResults[0];
    let promotionStageResult: StageResult | undefined;
    for (const candidateResult of recoverableStageResults) {
      const promotedAction = maybePromoteFailureAdvisoryAction(
        session,
        stage,
        candidateResult,
        advisory.recommendedAction,
        advisory.summary,
        advisory.suspectedCause,
        advisory.sourceError,
      );
      if (promotedAction === 'promote-stage') {
        promotionStageResult = candidateResult;
      }
      if (promotedAction !== advisory.recommendedAction) {
        advisory.recommendedAction = promotedAction;
        await this.sessionManager.persist(session);
        if (promotedAction === 'promote-stage') {
          break;
        }
      }
    }

    if (advisory.recommendedAction === 'pause-and-resume') {
      const retainedDeterministicResult = this.findRetainedDeterministicContinuationResult(
        session,
        stage,
      );
      if (retainedDeterministicResult) {
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: `Failure advisory resume: recovering ${stage.name} from retained seam evidence`,
          details: {
            failureSignature: advisory.failureSignature,
            sourceError: retainedDeterministicResult.error,
          },
        });
        await this.continueWithDeterministicStageContinuation(
          session,
          stage,
          retainedDeterministicResult,
          resumeState,
          'A prior attempt already gathered enough seam evidence before HELIX was diverted into later startup stalls, so resume from that retained evidence instead of cold-starting the stage again.',
        );
        return 'continue';
      }
    }

    if (
      advisory.recommendedAction === 'synthesize-stage' ||
      advisory.recommendedAction === 'switch-model' ||
      advisory.recommendedAction === 'continue-immediate-only'
    ) {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message: `Failure advisory resume: continuing ${stage.name} from retained evidence`,
        details: {
          recommendedAction: advisory.recommendedAction,
          failureSignature: advisory.failureSignature,
        },
      });
      await this.continueWithFailureAdvisoryRetry(
        session,
        stage,
        advisory,
        resumeState,
        advisory.recommendedAction === 'synthesize-stage',
      );
      return 'continue';
    }

    if (advisory.recommendedAction === 'promote-stage') {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message: `Failure advisory resume: evaluating promotion for ${stage.name}`,
        details: {
          failureSignature: advisory.failureSignature,
        },
      });
      const promoted = await this.promoteFailureAdvisoryStage(
        session,
        stage,
        advisory,
        resumeState,
        promotionStageResult,
      );
      if (promoted) {
        return 'promoted';
      }

      if (shouldRunDeterministicReplayRegression(session, stage)) {
        clearPendingFailureAdvisory(session);
        session.state = resumeState;
        session.error = undefined;
        await this.sessionManager.persist(session);

        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message:
            'Failure advisory resume: promotion evidence was incomplete; falling back to deterministic replay regression proof',
          details: {
            failureSignature: advisory.failureSignature,
          },
        });

        await this.journal(session, {
          timestamp: now(),
          type: 'progress',
          stage: stage.name,
          message:
            'Promotion evidence was incomplete; retrying Regression from deterministic replay proof instead of prompting for approval',
        });

        return 'continue';
      }
    }

    session.state = 'awaiting-approval';
    await this.sessionManager.persist(session);
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Failure advisory resume: awaiting checkpoint approval for ${stage.name}`,
      details: {
        failureSignature: advisory.failureSignature,
        recommendedAction: advisory.recommendedAction,
      },
    });

    let approved: boolean;
    try {
      approved = await this.reporter.onCheckpoint(
        `Resume ${stage.name} with the persisted failure advisory?`,
        buildFailureAdvisoryCheckpointData(advisory),
      );
    } catch (error) {
      session.state = resumeState;
      await this.sessionManager.persist(session);
      throw error;
    }

    if (!approved) {
      await this.sessionManager.updateState(session, 'paused');
      session.error = advisory.summary;
      await this.sessionManager.persist(session);
      return 'paused';
    }

    if (advisory.recommendedAction === 'promote-stage') {
      const promoted = await this.promoteFailureAdvisoryStage(
        session,
        stage,
        advisory,
        resumeState,
        promotionStageResult,
      );
      if (promoted) {
        return 'promoted';
      }

      if (shouldRunDeterministicReplayRegression(session, stage)) {
        clearPendingFailureAdvisory(session);
        session.state = resumeState;
        session.error = undefined;
        await this.sessionManager.persist(session);

        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message:
            'Failure advisory resume: promotion evidence was incomplete after approval; falling back to deterministic replay regression proof',
          details: {
            failureSignature: advisory.failureSignature,
          },
        });

        await this.journal(session, {
          timestamp: now(),
          type: 'progress',
          stage: stage.name,
          message:
            'Promotion evidence remained incomplete after approval; retrying Regression from deterministic replay proof instead of rerunning the prior stage.',
        });

        return 'continue';
      }
    }

    await this.continueWithFailureAdvisoryRetry(session, stage, advisory, resumeState, false);

    return 'continue';
  }

  private findRetainedDeterministicContinuationResult(
    session: Session,
    stage: StageDefinition,
  ): StageResult | undefined {
    return [...session.stageHistory].reverse().find(
      (entry) =>
        entry.stageName === stage.name &&
        entry.status === 'failed' &&
        decideDeterministicStageContinuation({
          stage,
          result: entry,
          priorFailures: 0,
          isBroadReplayTask: isBroadReplayReplayTask(session),
        }).decision === 'retry',
    );
  }

  private async handleBlockingStageResult(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
    resumeState: Session['state'],
  ): Promise<FailureAdvisoryDisposition> {
    if (!isBlockingStageResult(result)) {
      return 'continue';
    }

    const deterministicContinuationDisposition = await this.handleDeterministicStageContinuation(
      session,
      stage,
      result,
      resumeState,
    );
    if (deterministicContinuationDisposition !== 'continue') {
      return deterministicContinuationDisposition;
    }

    if (this.isDeterministicSynthesisStartupStall(session, stage, result)) {
      const advisory = this.buildDeterministicSynthesisStartupStallAdvisory(session, stage, result);
      recordFailureAdvisory(session, advisory);
      session.error = advisory.sourceError;
      await this.sessionManager.persist(session);

      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message: `Failure advisory: ${advisory.summary}`,
        details: buildFailureAdvisoryCheckpointData(advisory),
      });

      await this.journal(session, {
        timestamp: now(),
        type: 'error',
        stage: stage.name,
        message: `Failure advisory: ${advisory.summary}`,
        details: {
          failureSignature: advisory.failureSignature,
          recommendedAction: advisory.recommendedAction,
        },
      });

      if (
        (advisory.recommendedAction === 'synthesize-stage' ||
          advisory.recommendedAction === 'switch-model' ||
          advisory.recommendedAction === 'continue-immediate-only') &&
        advisory.retryCount < MAX_FAILURE_ADVISORY_RETRIES
      ) {
        await this.continueWithFailureAdvisoryRetry(
          session,
          stage,
          advisory,
          resumeState,
          advisory.recommendedAction === 'synthesize-stage',
        );
        return 'retry';
      }

      await this.pauseForFailureAdvisory(session, stage, advisory);
      return 'paused';
    }

    if (!isFailureAdvisoryEligible(stage, result)) {
      return 'continue';
    }

    const advisory = await this.createFailureAdvisoryRecord(session, stage, result);
    recordFailureAdvisory(session, advisory);
    session.error = advisory.sourceError;
    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Failure advisory: ${advisory.summary}`,
      details: buildFailureAdvisoryCheckpointData(advisory),
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'error',
      stage: stage.name,
      message: `Failure advisory: ${advisory.summary}`,
      details: {
        failureSignature: advisory.failureSignature,
        recommendedAction: advisory.recommendedAction,
      },
    });

    if (
      advisory.recommendedAction === 'retry-stage' &&
      advisory.retryCount < MAX_FAILURE_ADVISORY_RETRIES
    ) {
      return (await this.promptFailureAdvisoryRetry(session, stage, advisory, resumeState))
        ? 'retry'
        : 'paused';
    }

    if (
      (advisory.recommendedAction === 'synthesize-stage' ||
        advisory.recommendedAction === 'switch-model' ||
        advisory.recommendedAction === 'continue-immediate-only') &&
      advisory.retryCount < MAX_FAILURE_ADVISORY_RETRIES
    ) {
      await this.continueWithFailureAdvisoryRetry(
        session,
        stage,
        advisory,
        resumeState,
        advisory.recommendedAction === 'synthesize-stage',
      );
      return 'retry';
    }

    if (advisory.recommendedAction === 'promote-stage') {
      const promoted = await this.promoteFailureAdvisoryStage(
        session,
        stage,
        advisory,
        resumeState,
        result,
      );
      if (promoted) {
        return 'continue';
      }
    }

    await this.pauseForFailureAdvisory(session, stage, advisory);
    return 'paused';
  }

  private async handleDeterministicStageContinuation(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
    resumeState: Session['state'],
  ): Promise<FailureAdvisoryDisposition> {
    const continuation = decideDeterministicStageContinuation({
      stage,
      result,
      priorFailures: countPriorBlockingStageFailures(session, stage),
      isBroadReplayTask: isBroadReplayReplayTask(session),
    });

    if (continuation.decision !== 'retry' || continuation.mode !== 'synthesize-from-evidence') {
      return 'continue';
    }

    await this.continueWithDeterministicStageContinuation(
      session,
      stage,
      result,
      resumeState,
      continuation.reason,
    );
    return 'retry';
  }

  private async continueWithDeterministicStageContinuation(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
    resumeState: Session['state'],
    reason?: string,
  ): Promise<void> {
    restoreStageDefinitionForRetry(session, stage);
    applyDeterministicStageSynthesisMode(stage, session);
    stage.prompt = buildDeterministicStageContinuationPrompt(stage, session, result);
    clearPendingFailureAdvisory(session);
    session.state = resumeState;
    session.error = undefined;
    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Retrying ${stage.name} with deterministic continuation from gathered seam evidence`,
      details: reason ? { reason } : undefined,
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message: reason
        ? `Retrying ${stage.name} with deterministic continuation: ${reason}`
        : `Retrying ${stage.name} with deterministic continuation from gathered seam evidence`,
    });
  }

  private isDeterministicSynthesisStartupStall(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
  ): boolean {
    return (
      !session.replayContext &&
      stage.role === 'synthesize' &&
      (stage.tools?.length ?? 0) === 0 &&
      !result.output.trim() &&
      result.findings.length === 0 &&
      result.decisions.length === 0 &&
      /\b(stalled|timed out|deadline|inactivity)\b/i.test(
        [result.error, result.qualityGate?.feedback].filter(Boolean).join('\n'),
      )
    );
  }

  private buildDeterministicSynthesisStartupStallAdvisory(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
  ): FailureAdvisoryRecord {
    const rawSourceError =
      describeBlockingStageResult(stage, result) ||
      `${stage.name} stalled before emitting output during deterministic synthesis`;
    const sourceError = isZeroTurnStartupFailureText(rawSourceError)
      ? rawSourceError
      : `${rawSourceError} Deterministic synthesis produced zero tool calls, zero shell commands, and zero output before the inactivity timeout.`;
    const failureSignature = `${stage.name}:deterministic-synthesis-startup-stall`;
    const priorRetryCount = getFailureAdvisoryRetryCount(session, stage.name, failureSignature);
    const advisory = buildFallbackFailureAdvisory(
      session,
      stage,
      'timeout',
      failureSignature,
      priorRetryCount,
      sourceError,
      result,
    );

    if (advisory.recommendedAction === 'switch-model') {
      return {
        ...advisory,
        summary:
          'Deterministic synthesis stalled before producing output. HELIX will switch to the alternate frontier model and keep the gathered seam evidence intact.',
        suspectedCause:
          'The analysis stage already had enough seam evidence, but the no-tools synthesis retry hung during model startup before emitting a structured artifact.',
        operatorActions: [
          'HELIX will retry this stage on the alternate frontier model while preserving the gathered seam evidence.',
          ...advisory.operatorActions,
        ],
      };
    }

    return {
      ...advisory,
      summary:
        'Deterministic synthesis stalled before producing output across repeated recovery attempts. HELIX kept the gathered seam evidence and paused instead of reopening discovery.',
      suspectedCause:
        'The analysis stage already had enough seam evidence, but repeated no-tools synthesis retries hung before emitting a structured artifact.',
      operatorActions: [
        `Resume ${stage.name} when the model runtime is healthy; HELIX will continue from the retained seam evidence.`,
        ...advisory.operatorActions,
      ],
    };
  }

  private async promptFailureAdvisoryRetry(
    session: Session,
    stage: StageDefinition,
    advisory: FailureAdvisoryRecord,
    resumeState: Session['state'],
  ): Promise<boolean> {
    session.state = 'awaiting-approval';
    await this.sessionManager.persist(session);

    let approved: boolean;
    try {
      approved = await this.reporter.onCheckpoint(
        `Retry ${stage.name} with failure advisory guidance?`,
        buildFailureAdvisoryCheckpointData(advisory),
      );
    } catch (error) {
      session.state = resumeState;
      await this.sessionManager.persist(session);
      throw error;
    }

    if (!approved) {
      await this.pauseForFailureAdvisory(session, stage, advisory);
      return false;
    }

    await this.continueWithFailureAdvisoryRetry(session, stage, advisory, resumeState, false);

    return true;
  }

  private async continueWithFailureAdvisoryRetry(
    session: Session,
    stage: StageDefinition,
    advisory: FailureAdvisoryRecord,
    resumeState: Session['state'],
    synthesisMode: boolean,
  ): Promise<void> {
    const switchModelRetry = advisory.recommendedAction === 'switch-model';
    const immediateOnlyRetry = advisory.recommendedAction === 'continue-immediate-only';
    const zeroTurnStartupSwitch = switchModelRetry && isZeroTurnStartupFailureAdvisory(advisory);
    const stableReplayModelSwitch =
      switchModelRetry && shouldUseFailureAdvisoryStableReplayModelSwitch(stage, session);
    const retainCurrentSynthesisRetry =
      !synthesisMode && shouldRetainCurrentSynthesisRetry(stage, advisory, session);
    const retryInSynthesisMode =
      synthesisMode ||
      retainCurrentSynthesisRetry ||
      (switchModelRetry && shouldUseFailureAdvisorySwitchModelSynthesis(stage));
    const currentReplaySynthesisRetry = isReplaySynthesisRetryStage(stage, session);
    const evidenceOnlyRetry = shouldUseFailureAdvisoryEvidenceOnlyRetry(stage, advisory, session);
    const stableReplayRetry = shouldUseFailureAdvisoryStableReplayRetry(stage, advisory, session);
    const stableReplayEvidenceRetry = shouldUseFailureAdvisoryStableReplayEvidenceRetry(
      stage,
      advisory,
      session,
    );
    const retryPlan = buildFailureAdvisoryRetryPlan({
      switchModelRetry,
      immediateOnlyRetry,
      zeroTurnStartupSwitch,
      stableReplayModelSwitch,
      retainCurrentSynthesisRetry,
      retryInSynthesisMode,
      currentReplaySynthesisRetry,
      evidenceOnlyRetry,
      stableReplayRetry,
      stableReplayEvidenceRetry,
    });
    advisory.retryCount += 1;
    clearPendingFailureAdvisory(session);
    session.state = resumeState;
    session.error = undefined;
    if (retryPlan.initialRestoreStage) {
      restoreStageDefinitionForRetry(session, stage);
    }
    if (retryPlan.restoreStageBeforeRetryMode) {
      restoreStageDefinitionForRetry(session, stage);
    }
    if (retryPlan.applySynthesisMode) {
      applyFailureAdvisorySynthesisMode(stage, session, advisory);
    }
    if (retryPlan.applyBudgetRecommendation) {
      applyFailureAdvisoryBudgetRecommendation(stage, advisory);
    }
    if (retryPlan.applyEvidenceOnlyRetryMode) {
      applyFailureAdvisoryEvidenceOnlyRetryMode(stage, session);
    }
    if (retryPlan.applyStableReplayRetryMode) {
      applyFailureAdvisoryStableReplayRetryMode(stage);
    }
    if (retryPlan.applySwitchModelMode) {
      applyFailureAdvisorySwitchModelMode(stage);
    }
    if (retryPlan.applyImmediateOnlyPrompt) {
      applyFailureAdvisoryImmediateOnlyPromptOverride(stage, advisory, session);
    }
    if (retryPlan.promptMode === 'evidence-only') {
      applyFailureAdvisoryEvidenceOnlyRetryPromptOverride(stage, advisory, session);
    } else if (retryPlan.promptMode === 'synthesis') {
      applyFailureAdvisorySynthesisPromptOverride(stage, advisory, session);
    } else {
      applyFailureAdvisoryRetryPromptOverride(stage, advisory, session);
    }
    await this.injectFailureAdvisoryGuidance(advisory);
    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: retryPlan.retryInSynthesisMode
        ? `Retrying ${stage.name} in synthesis mode with failure advisory guidance`
        : `Retrying ${stage.name} with failure advisory guidance`,
      details: buildFailureAdvisoryCheckpointData(advisory),
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message: retryPlan.retryInSynthesisMode
        ? `Retrying ${stage.name} in synthesis mode with failure advisory ${advisory.failureSignature}`
        : `Retrying ${stage.name} with failure advisory ${advisory.failureSignature}`,
    });
  }

  private async promoteFailureAdvisoryStage(
    session: Session,
    stage: StageDefinition,
    advisory: FailureAdvisoryRecord,
    resumeState: Session['state'],
    result?: StageResult,
  ): Promise<boolean> {
    const stageResult =
      result ??
      [...session.stageHistory]
        .reverse()
        .find(
          (entry) =>
            entry.stageName === stage.name &&
            (entry.status === 'failed' || entry.status === 'looped'),
        );
    if (!stageResult) {
      return false;
    }

    const promotedOutput = await buildFailureAdvisoryPromotionOutput(
      this.config.workDir,
      session,
      stage,
      advisory,
      stageResult,
    );
    if (!promotedOutput) {
      return false;
    }

    const parsed = parseAnalysisOutput(promotedOutput, stage.name);
    clearPendingFailureAdvisory(session);
    session.state = resumeState;
    session.error = undefined;
    stageResult.status = 'passed';
    stageResult.error = undefined;
    stageResult.output = promotedOutput;
    stageResult.findings = [];
    stageResult.decisions = [];
    await this.recordUniqueStageArtifacts(
      session,
      stage,
      resumeState,
      stageResult.findings,
      stageResult.decisions,
      parsed,
    );
    const stageHistoryIndex = session.stageHistory.indexOf(stageResult);
    if (stageHistoryIndex >= 0 && stageHistoryIndex !== session.stageHistory.length - 1) {
      session.stageHistory.splice(stageHistoryIndex, 1);
      session.stageHistory.push(stageResult);
    }
    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Promoting ${stage.name} from failure advisory evidence (${stageResult.findings.length} findings, ${stageResult.decisions.length} decisions)`,
      details: buildFailureAdvisoryCheckpointData(advisory),
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message: `Promoted ${stage.name} from failure advisory evidence`,
      details: {
        failureSignature: advisory.failureSignature,
        findings: stageResult.findings.length,
        decisions: stageResult.decisions.length,
      },
    });

    return true;
  }

  private async pauseForFailureAdvisory(
    session: Session,
    stage: StageDefinition,
    advisory: FailureAdvisoryRecord,
  ): Promise<void> {
    await this.sessionManager.updateState(session, 'paused');
    session.error = advisory.summary;
    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Paused after failure advisory: ${advisory.summary}`,
      details: buildFailureAdvisoryCheckpointData(advisory),
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message: `Paused after failure advisory ${advisory.failureSignature}: ${advisory.summary}`,
    });
  }

  private async injectFailureAdvisoryGuidance(advisory: FailureAdvisoryRecord): Promise<void> {
    const guidanceLines = [
      `Failure advisory for ${advisory.stageName} (${advisory.failureSignature})`,
      `Summary: ${advisory.summary}`,
      `Suspected cause: ${advisory.suspectedCause}`,
    ];

    if (advisory.promptGuidance) {
      guidanceLines.push(`Retry guidance: ${advisory.promptGuidance}`);
    }

    if (advisory.budgetRecommendation) {
      guidanceLines.push(
        `Budget guidance: ${advisory.budgetRecommendation.rationale}`,
        `Budget override: target=${advisory.budgetRecommendation.targetTurns ?? 'unchanged'}, exploration=${advisory.budgetRecommendation.explorationTurns ?? 'unchanged'}, shellWarn=${advisory.budgetRecommendation.shellWarnFloor ?? 'unchanged'}, shellAbort=${advisory.budgetRecommendation.shellAbortFloor ?? 'unchanged'}`,
      );
    }

    if ((advisory.evidenceDigest?.length ?? 0) > 0) {
      guidanceLines.push(
        'Evidence digest:',
        ...advisory.evidenceDigest!.slice(0, 8).map((entry) => `- ${entry}`),
      );
    }

    await this.liveContext.add(guidanceLines.join('\n'));
  }

  private async resolveAmbiguousDecision(
    session: Session,
    stage: StageDefinition,
    decision: Decision,
    resumeState: Session['state'],
  ): Promise<void> {
    session.state = 'awaiting-input';
    await this.sessionManager.upsertDecision(session, decision);
    this.emitProgress({
      type: 'decision-needed',
      timestamp: now(),
      stage: stage.name,
      message: decision.question,
      details: decision as unknown as Record<string, unknown>,
    });

    try {
      const answer = await this.reporter.onQuestion(decision);
      decision.answer = answer;
      decision.resolvedBy = 'user';
      decision.resolvedAt = now();
      session.state = resumeState;
      await this.sessionManager.upsertDecision(session, decision);

      this.emitProgress({
        type: 'decision-resolved',
        timestamp: now(),
        stage: stage.name,
        message: `User decided: ${answer}`,
        details: decision as unknown as Record<string, unknown>,
      });
    } catch (error) {
      session.state = resumeState;
      await this.sessionManager.persist(session);
      throw error;
    }
  }

  /**
   * Abort a running pipeline gracefully.
   */
  abort(): void {
    this.aborted = true;
    if (this.pauseController) {
      this.pauseController.resolve();
      this.pauseController = null;
      this.pauseRequested = false;
    }
    const abortedExecutions = this.modelRouter.abortActiveExecutions();
    if (abortedExecutions > 0) {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'interactive',
        message: `Abort requested — terminating ${abortedExecutions} active model execution${abortedExecutions === 1 ? '' : 's'}`,
      });
    }
  }

  /**
   * Pause the pipeline after the current stage completes.
   */
  pause(): PipelinePauseResult {
    if (this.pauseRequested || this.pauseController) {
      return 'already-paused';
    }

    this.pauseRequested = true;
    return 'requested';
  }

  /**
   * Resume a paused pipeline (used by interactive REPL to clear the pause flag before re-running).
   */
  unpause(): PipelineResumeResult {
    if (this.pauseController) {
      const controller = this.pauseController;
      this.pauseController = null;
      controller.resolve();
      return 'resumed';
    }

    if (this.pauseRequested) {
      this.pauseRequested = false;
      return 'cancelled-pending-pause';
    }

    return 'not-paused';
  }

  /**
   * Inject user context that will be rendered into the next stage prompt.
   */
  async injectContext(content: string): Promise<string> {
    const id = await this.liveContext.add(content);
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'interactive',
      message: `Context injected: "${content.slice(0, 80)}${content.length > 80 ? '…' : ''}"`,
    });
    return id;
  }

  /**
   * Mark a stage to be skipped when the pipeline reaches it.
   */
  skipStage(stageName: string): boolean {
    if (!this.currentPipeline) return false;
    const found = this.currentPipeline.stages.some(
      (s) => s.name === stageName || s.type === stageName,
    );
    if (found) {
      this.skipSet.add(stageName);
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'interactive',
        message: `Stage "${stageName}" will be skipped`,
      });
    }
    return found;
  }

  /**
   * Escalate a finding's severity to 'critical' so it gets prioritized.
   */
  prioritizeFinding(findingId: string): boolean {
    if (!this.currentSession) return false;
    const finding = this.currentSession.findings.find((f) => f.id === findingId);
    if (!finding) return false;
    finding.severity = 'critical';
    finding.updatedAt = now();
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'interactive',
      message: `Finding ${findingId} escalated to critical`,
    });
    return true;
  }

  /**
   * Get a snapshot of the current pipeline status.
   */
  getStatus(): PipelineStatus | null {
    const session = this.currentSession;
    const pipeline = this.currentPipeline;
    if (!session || !pipeline) return null;

    const currentStageIndex = session.currentStageIndex;
    const currentStage = pipeline.stages[currentStageIndex];

    return {
      sessionId: session.id,
      state: session.state,
      currentStage: currentStage?.name ?? 'unknown',
      currentStageIndex,
      totalStages: pipeline.stages.length,
      currentSlice: session.currentSliceIndex,
      totalSlices: session.totalSlices,
      findingsTotal: session.findings.length,
      findingsOpen: session.findings.filter((f) => f.status === 'open').length,
      findingsFixed: session.findings.filter((f) => f.status === 'fixed').length,
      commits: session.commits.length,
      elapsedMs: Date.now() - this.pipelineStartTime,
      pendingContextEntries: this.liveContext.pendingCount,
    };
  }

  listStageNames(): string[] {
    return this.currentPipeline?.stages.map((stage) => stage.name) ?? [];
  }

  listOpenFindingIds(): string[] {
    return (
      this.currentSession?.findings
        .filter((finding) => finding.status === 'open')
        .map((finding) => finding.id) ?? []
    );
  }

  private async pauseUntilResumed(session: Session, stage: StageDefinition): Promise<void> {
    const resumeState = resolveSessionStateForStage(stage);

    if (this.pauseController) {
      await this.pauseController.promise;
      if (this.aborted) {
        return;
      }

      await this.sessionManager.updateState(session, resumeState);
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'interactive',
        message: `Resuming pipeline at ${stage.name}`,
      });
      return;
    }

    this.pauseRequested = false;
    await this.sessionManager.updateState(session, 'paused');
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'interactive',
      message: `Pipeline paused at ${stage.name}. Type "resume" to continue or "abort" to stop.`,
      details: { sessionId: session.id, pausedAt: stage.name },
    });

    let resolvePause = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });
    this.pauseController = { promise, resolve: resolvePause };

    await promise;
    if (this.aborted) {
      return;
    }

    await this.sessionManager.updateState(session, resumeState);
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'interactive',
      message: `Resuming pipeline at ${stage.name}`,
    });
  }

  private async refreshPromptContext(session: Session): Promise<void> {
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: 'Context Setup',
      message: 'Loading instruction files, feature docs, prior findings, and scoped code map',
    });

    try {
      session.promptContext = await buildPromptContext(session, this.config, this.embeddingStore);
      await this.sessionManager.persist(session);

      const repoIndexTelemetry = session.promptContext.codeMap?.repoIndex;
      const contextSummary: string[] = [];
      if (session.promptContext.buildDurationMs != null) {
        contextSummary.push(`prompt context ${session.promptContext.buildDurationMs} ms`);
      }
      if (repoIndexTelemetry) {
        contextSummary.push(
          `repo-index cache ${repoIndexTelemetry.cacheStatus} for ${repoIndexTelemetry.scopedFileCount} files in ${repoIndexTelemetry.loadDurationMs} ms`,
        );
      }

      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'Context Setup',
        message: `Preloaded ${session.promptContext.instructionDocs.length} instruction docs and ${session.promptContext.codeMap?.keyFiles.length ?? 0} code-map entries${contextSummary.length > 0 ? ` (${contextSummary.join('; ')})` : ''}`,
        details: {
          instructionDocCount: session.promptContext.instructionDocs.length,
          codeMapEntryCount: session.promptContext.codeMap?.keyFiles.length ?? 0,
          promptContextBuildDurationMs: session.promptContext.buildDurationMs,
          repoIndexCacheStatus: repoIndexTelemetry?.cacheStatus,
          repoIndexScopedFileCount: repoIndexTelemetry?.scopedFileCount,
          repoIndexLoadDurationMs: repoIndexTelemetry?.loadDurationMs,
          repoIndexDiffHash: repoIndexTelemetry?.diffHash,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.journal(session, {
        timestamp: now(),
        type: 'error',
        stage: 'Context Setup',
        message: `Prompt context refresh failed: ${message}`,
      });

      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'Context Setup',
        message: `Prompt context refresh failed; continuing without preloaded context (${message})`,
      });
    }
  }

  /**
   * Execute a single pipeline stage with quality gate and loop support.
   */
  private async executeStage(
    session: Session,
    stage: StageDefinition,
    pipeline: PipelineTemplate,
    inheritedDeadlineAt?: number,
    activeStageState: Session['state'] = resolveSessionStateForStage(stage),
  ): Promise<StageResult> {
    const startTime = Date.now();
    const stageDeadlineAt = resolveStageDeadlineAt(stage, inheritedDeadlineAt, startTime);
    // Dueling planners need 18 minutes (3 model calls: 2 planners + Codex synthesis).
    // The holistic-audit template remains immutable at 8 min (D-6); override at dispatch site.
    const effectiveStageDeadlineAt =
      stage.type === 'plan-generation' && this.config.enableDuelingPlanners
        ? startTime + 18 * 60_000
        : stageDeadlineAt;
    const maxAttempts = resolveStageMaxAttempts(stage);
    let iterations = 0;
    let lastOutput = '';
    let exitedDueToLoopLimit = false;
    let stageCostUsd = 0;
    const stageFindings: Finding[] = [];
    const stageDecisions: Decision[] = [];
    const stageTimeoutEvents: TimeoutEvent[] = [];
    let latestQualityGate: QualityGateResult | undefined;
    const stageExecutionSummary = createStageExecutionSummary();

    this.emitProgress({
      type: 'stage-enter',
      timestamp: now(),
      stage: stage.name,
      message: stage.description,
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'stage-start',
      stage: stage.name,
      message: `Entering stage: ${stage.description}`,
    });

    if (stage.type === 'regression') {
      const staleBaseline = await detectStaleWorkspaceBaseline(this.config, session);
      if (staleBaseline) {
        const message = formatWorkspaceBaselineDrift(staleBaseline, stage.name);
        this.emitProgress({
          type: 'error',
          timestamp: now(),
          stage: stage.name,
          message,
          details: staleBaseline as unknown as Record<string, unknown>,
        });
        await this.journal(session, {
          timestamp: now(),
          type: 'error',
          stage: stage.name,
          message,
          details: staleBaseline as unknown as Record<string, unknown>,
        });
        return makeResult(
          stage,
          'failed',
          '',
          stageFindings,
          stageDecisions,
          startTime,
          0,
          message,
          undefined,
          { executionSummary: stageExecutionSummary },
        );
      }
    }

    // Handle user checkpoints
    if (stage.type === 'user-checkpoint') {
      return this.specialStageExecutor.handleUserCheckpoint(session, stage, startTime);
    }

    if (stage.type === 'bootstrap') {
      return this.specialStageExecutor.executeVerificationBootstrap(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
      );
    }

    if (stage.type === 'plan-generation' && this.config.enableDuelingPlanners) {
      return this.specialStageExecutor.executeDuelingPlanGeneration(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
      );
    }

    // Handle implementation as slice-by-slice execution
    if (stage.type === 'implementation' && session.slices.length > 0) {
      return this.executeSlices(session, stage, pipeline, startTime, effectiveStageDeadlineAt);
    }

    if (stage.type === 'oracle-analysis') {
      return this.specialStageExecutor.executeOracleAnalysis(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
      );
    }

    if (stage.type === 'manifest-compilation') {
      return this.specialStageExecutor.executeManifestCompilation(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
      );
    }

    if (stage.type === 'bulk-review') {
      return this.specialStageExecutor.executeBulkReview(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
      );
    }

    if (stage.type === 'doc-sync' && session.replayContext) {
      return this.specialStageExecutor.executeDocSync(session, stage, startTime);
    }

    if (stage.type === 'concerns-audit') {
      return this.specialStageExecutor.executeConcernsAudit(session, stage, startTime);
    }

    if (shouldRunDeterministicReplayRegression(session, stage)) {
      return this.executeDeterministicReplayRegression(
        session,
        stage,
        startTime,
        effectiveStageDeadlineAt,
        stageExecutionSummary,
      );
    }

    // Handle substages (parallel or sequential)
    if (stage.substages && stage.substages.length > 0) {
      return this.executeSubstages(session, stage, pipeline, startTime, effectiveStageDeadlineAt);
    }

    // Main stage execution loop
    do {
      iterations++;
      const scopedTestTargets = session.workItem.scope.filter(isTestFilePath);
      const scopedTestSnapshots = new Map<string, WorkspaceFileSnapshot>();
      for (const testFile of scopedTestTargets) {
        scopedTestSnapshots.set(
          testFile,
          await captureWorkspaceFileSnapshot(this.config.workDir, testFile),
        );
      }

      if (this.aborted) {
        return makeResult(
          stage,
          'failed',
          lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          'Aborted',
          undefined,
          { executionSummary: stageExecutionSummary },
        );
      }

      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message: `Iteration ${iterations}/${maxAttempts}`,
      });

      const remainingTimeoutMs = getRemainingTimeoutMs(effectiveStageDeadlineAt);
      if (remainingTimeoutMs != null && remainingTimeoutMs <= 0) {
        return failStageDueToTimeout(
          session,
          stage,
          lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          {
            qualityGate: latestQualityGate,
            timeoutEvents: stageTimeoutEvents,
            executionSummary: stageExecutionSummary,
          },
          this.stageSideEffects,
        );
      }

      const reservedQualityGateTimeoutMs = resolveReservedQualityGateTimeoutMs(
        stage.qualityGate,
        remainingTimeoutMs,
      );
      const stageExecutionTimeoutMs =
        remainingTimeoutMs == null
          ? undefined
          : Math.max(remainingTimeoutMs - (reservedQualityGateTimeoutMs ?? 0), 0);
      if (stageExecutionTimeoutMs != null && stageExecutionTimeoutMs <= 0) {
        return failStageDueToTimeout(
          session,
          stage,
          lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          {
            qualityGate: latestQualityGate,
            timeoutEvents: stageTimeoutEvents,
            executionSummary: stageExecutionSummary,
          },
          this.stageSideEffects,
        );
      }

      // Build the prompt for this stage, including any live context from the REPL
      const liveContextBlock = this.liveContext.renderForPrompt();
      const basePrompt = buildStagePrompt(stage, session, lastOutput, iterations);
      const prompt = liveContextBlock ? `${liveContextBlock}\n\n${basePrompt}` : basePrompt;
      await this.liveContext.markConsumed(stage.name);

      // Execute via model router
      const emitStageStream = createStageStreamHandler(
        (event) => this.emitProgress(event),
        stage.name,
      );
      const onStream = (event: StreamEvent): void => {
        recordStageExecutionStreamEvent(stageExecutionSummary, event);
        emitStageStream(event);
      };
      const stageEfficiencyBudget = resolveStageExecutionEfficiencyBudget(stage, session);
      const stageStallThresholdMs = resolveStageExecutionStallThresholdMs(
        stage,
        session,
        stageEfficiencyBudget,
      );
      const stageExecutionEnvelope = buildStageExecutionEnvelope({
        stage,
        session,
        prompt,
        timeoutMs: stageExecutionTimeoutMs,
        efficiencyBudget: stageEfficiencyBudget,
        stallThresholdMs: stageStallThresholdMs,
        policy: getStageModelPolicy(this.config),
        allowFallbacks: this.config.allowModelFallbacks ?? false,
        isBroadReplayTask: isBroadReplayReplayTask(session),
      });

      const result = await this.modelRouter.execute(
        stageExecutionEnvelope.prompt,
        stageExecutionEnvelope.assignment,
        stageExecutionEnvelope.tools,
        onStream,
        stageExecutionEnvelope.outputSchema,
        stageExecutionEnvelope.timeoutMs,
      );
      accumulateProviderCost(session, result);

      stageCostUsd += result.costUsd ?? 0;
      if (stageCostUsd > 0) {
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: `model execution complete (${result.engine}/${result.model})`,
          details: { costUsd: stageCostUsd },
        });
      }
      if (result.timedOut) {
        stageTimeoutEvents.push(
          createTimeoutEvent(
            'model',
            stage.name,
            result.error ?? `${stage.name} timed out`,
            result.timeoutMs ?? stageExecutionTimeoutMs,
            Date.now() - startTime,
            {
              engine: result.engine,
              model: result.model,
              iteration: iterations,
            },
          ),
        );
      }

      if (result.error) {
        if (result.timedOut || isTimeoutError(result.error)) {
          const promotedTimedOutResult = await this.maybePromoteTimedOutStageResult(
            session,
            stage,
            activeStageState,
            result.output || lastOutput,
            stageFindings,
            stageDecisions,
            startTime,
            iterations,
            {
              costUsd: stageCostUsd || undefined,
              qualityGate: latestQualityGate,
              timeoutEvents: stageTimeoutEvents,
              scopedTestTargets,
              scopedTestSnapshots,
            },
          );
          if (promotedTimedOutResult) {
            return promotedTimedOutResult;
          }
        }

        await this.journal(session, {
          timestamp: now(),
          type: 'error',
          stage: stage.name,
          message: `Model error: ${result.error}`,
        });

        return makeResult(
          stage,
          'failed',
          result.output || lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          result.error,
          stageCostUsd || undefined,
          {
            qualityGate: latestQualityGate,
            timeoutEvents: stageTimeoutEvents,
            executionSummary: stageExecutionSummary,
          },
        );
      }

      lastOutput = result.output;

      const outputSchema = stage.outputSchema;
      const requiresStrictStructuredOutput =
        outputSchema != null && (outputSchema.strict === true || outputSchema.id === 'slice-plan');
      if (requiresStrictStructuredOutput) {
        const structuredOutput = parseStructuredStageOutputResult(result.output, outputSchema.id);

        if (!structuredOutput.data) {
          const reason =
            structuredOutput.error.message ||
            `${outputSchema.id} stage output did not satisfy the structured contract`;

          await this.journal(session, {
            timestamp: now(),
            type: 'error',
            stage: stage.name,
            message: `Structured output validation failed: ${reason}`,
          });

          if (
            decideStageContinuation({
              stage,
              attempt: iterations,
              failureKind: 'structured-output',
            }) === 'retry-with-feedback'
          ) {
            lastOutput = `STRUCTURED OUTPUT CONTRACT FAILED:\n${reason}\n\nPREVIOUS OUTPUT:\n${result.output}`;
            continue;
          }

          return makeResult(
            stage,
            'failed',
            result.output,
            stageFindings,
            stageDecisions,
            startTime,
            iterations,
            reason,
            stageCostUsd || undefined,
            {
              qualityGate: latestQualityGate,
              timeoutEvents: stageTimeoutEvents,
              executionSummary: stageExecutionSummary,
            },
          );
        }
      }

      const reproductionOutput =
        stage.type === 'reproduce' ? parseReproductionOutput(result.output, stage.name) : null;
      if (stage.type === 'reproduce') {
        const artifactCheck = await enforceReproductionArtifact(
          this.config.workDir,
          session,
          stage,
          result.output,
          reproductionOutput,
          scopedTestTargets,
          scopedTestSnapshots,
          this.stageSideEffects,
        );
        if (!artifactCheck.ok) {
          if (
            decideStageContinuation({
              stage,
              attempt: iterations,
              failureKind: 'artifact-contract',
            }) === 'retry-with-feedback'
          ) {
            lastOutput = `REPRODUCTION CONTRACT FAILED:\n${artifactCheck.reason}\n\nPREVIOUS OUTPUT:\n${result.output}`;
            continue;
          }

          return makeResult(
            stage,
            'failed',
            result.output,
            stageFindings,
            stageDecisions,
            startTime,
            iterations,
            artifactCheck.reason,
            undefined,
            { executionSummary: stageExecutionSummary },
          );
        }
      }

      // Parse findings and decisions from model output
      const parsed = reproductionOutput ?? parseAnalysisOutput(result.output, stage.name);
      const dedupeSummary = await this.recordUniqueStageArtifacts(
        session,
        stage,
        activeStageState,
        stageFindings,
        stageDecisions,
        parsed,
      );
      if (dedupeSummary.duplicateFindings > 0 || dedupeSummary.duplicateDecisions > 0) {
        const duplicateParts: string[] = [];
        if (dedupeSummary.duplicateFindings > 0) {
          duplicateParts.push(
            `${dedupeSummary.duplicateFindings} duplicate finding${dedupeSummary.duplicateFindings === 1 ? '' : 's'}`,
          );
        }
        if (dedupeSummary.duplicateDecisions > 0) {
          duplicateParts.push(
            `${dedupeSummary.duplicateDecisions} duplicate decision${dedupeSummary.duplicateDecisions === 1 ? '' : 's'}`,
          );
        }
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: `Suppressed ${duplicateParts.join(' and ')} from this ${stage.name} run`,
        });
      }

      if (hasDeadlineExpired(effectiveStageDeadlineAt)) {
        const promotedTimedOutResult = await this.maybePromoteTimedOutStageResult(
          session,
          stage,
          activeStageState,
          lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          {
            costUsd: stageCostUsd || undefined,
            qualityGate: latestQualityGate,
            timeoutEvents: stageTimeoutEvents,
            reproductionOutput,
            reproductionArtifactVerified: stage.type === 'reproduce',
            scopedTestTargets,
            scopedTestSnapshots,
          },
        );
        if (promotedTimedOutResult) {
          return promotedTimedOutResult;
        }

        return failStageDueToTimeout(
          session,
          stage,
          lastOutput,
          stageFindings,
          stageDecisions,
          startTime,
          iterations,
          {
            qualityGate: latestQualityGate,
            timeoutEvents: stageTimeoutEvents,
            executionSummary: stageExecutionSummary,
          },
          this.stageSideEffects,
        );
      }

      // Run quality gate if configured
      if (stage.qualityGate) {
        const gateTimeoutMs = resolveQualityGateTimeoutMs(
          stage.qualityGate,
          effectiveStageDeadlineAt,
          reservedQualityGateTimeoutMs,
        );
        const gateResult = await this.runQualityGate(session, stage, stage.qualityGate, {
          stageOutput: lastOutput,
          timeoutMs: gateTimeoutMs,
        });
        latestQualityGate = gateResult;

        if (gateResult.timedOut) {
          const timedOutChecks = gateResult.checks
            .filter((check) => check.timedOut)
            .map((check) => check.name);
          stageTimeoutEvents.push(
            createTimeoutEvent(
              'quality-gate',
              gateResult.name,
              `${gateResult.name} timed out`,
              gateResult.timeoutMs,
              gateResult.durationMs,
              timedOutChecks.length > 0 ? { checks: timedOutChecks } : undefined,
            ),
          );
        }

        this.emitProgress({
          type: 'quality-gate-result',
          timestamp: now(),
          stage: stage.name,
          message: `${stage.qualityGate.name}: ${gateResult.passed ? 'PASSED' : 'FAILED'}`,
          details: { passed: gateResult.passed, checks: gateResult.checks },
        });

        if (stage.type === 'plan-generation' && !gateResult.passed) {
          await this.persistPlanReviewCarryForwardState(session, gateResult, lastOutput);
        }

        if (
          !gateResult.passed &&
          decideStageContinuation({
            stage,
            attempt: iterations,
            failureKind: 'quality-gate',
          }) === 'retry-with-feedback'
        ) {
          // Loop back with quality gate feedback
          lastOutput = `QUALITY GATE FAILED:\n${gateResult.feedback}\n\nPREVIOUS OUTPUT:\n${lastOutput}`;
          continue;
        }

        if (!gateResult.passed && stage.qualityGate.failAction === 'stop') {
          return makeResult(
            stage,
            'failed',
            lastOutput,
            stageFindings,
            stageDecisions,
            startTime,
            iterations,
            `Quality gate failed: ${gateResult.feedback}`,
            stageCostUsd || undefined,
            {
              qualityGate: latestQualityGate,
              timeoutEvents: stageTimeoutEvents,
              executionSummary: stageExecutionSummary,
            },
          );
        }

        if (!gateResult.passed && stage.canLoop && iterations >= maxAttempts) {
          exitedDueToLoopLimit = true;
        }
      }

      // Stage completed successfully (or loop limit reached)
      break;
    } while (stage.canLoop && iterations < maxAttempts);

    const status = exitedDueToLoopLimit ? 'looped' : 'passed';

    this.emitProgress({
      type: 'stage-exit',
      timestamp: now(),
      stage: stage.name,
      message: `${stageFindings.length} findings, ${stageDecisions.length} decisions`,
      details: stageCostUsd > 0 ? { costUsd: stageCostUsd } : undefined,
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: `Completed with ${stageFindings.length} findings after ${iterations} iterations`,
    });

    return makeResult(
      stage,
      status,
      lastOutput,
      stageFindings,
      stageDecisions,
      startTime,
      iterations,
      undefined,
      stageCostUsd || undefined,
      {
        qualityGate: latestQualityGate,
        timeoutEvents: stageTimeoutEvents,
        executionSummary: stageExecutionSummary,
      },
    );
  }

  private async executeDeterministicReplayRegression(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt: number | undefined,
    executionSummary: StageExecutionSummary,
  ): Promise<StageResult> {
    const gate = stage.qualityGate;
    if (!gate) {
      return makeResult(
        stage,
        'failed',
        '',
        [],
        [],
        startTime,
        1,
        'Deterministic replay regression requires a quality gate',
        undefined,
        {
          executionSummary,
        },
      );
    }

    const timeoutEvents: TimeoutEvent[] = [];

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message:
        'review-started: running deterministic replay regression proof from the carried test locks',
    });
    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message:
        'Deterministic replay regression started from the carried test locks and replay seam obligations',
    });

    const gateTimeoutMs = resolveQualityGateTimeoutMs(gate, stageDeadlineAt, undefined);
    const gateResult = await this.runQualityGate(session, stage, gate, {
      timeoutMs: gateTimeoutMs,
    });

    if (gateResult.timedOut) {
      const timedOutChecks = gateResult.checks
        .filter((check) => check.timedOut)
        .map((check) => check.name);
      timeoutEvents.push(
        createTimeoutEvent(
          'quality-gate',
          gateResult.name,
          `${gateResult.name} timed out`,
          gateResult.timeoutMs,
          gateResult.durationMs,
          timedOutChecks.length > 0 ? { checks: timedOutChecks } : undefined,
        ),
      );
    }

    this.emitProgress({
      type: 'quality-gate-result',
      timestamp: now(),
      stage: stage.name,
      message: `${gate.name}: ${gateResult.passed ? 'PASSED' : 'FAILED'}`,
      details: { passed: gateResult.passed, checks: gateResult.checks },
    });
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `review-finished: ${gateResult.passed ? 'deterministic replay regression proof is green' : 'deterministic replay regression proof is blocked'}`,
    });

    const output = [
      `Deterministic replay regression ${gateResult.passed ? 'passed' : 'failed'}.`,
      summarizeQualityGateEvidence(gateResult),
    ]
      .filter(Boolean)
      .join('\n\n');

    if (!gateResult.passed) {
      await this.journal(session, {
        timestamp: now(),
        type: 'error',
        stage: stage.name,
        message: `Deterministic replay regression failed: ${gateResult.feedback}`,
      });

      return makeResult(
        stage,
        'failed',
        output,
        [],
        [],
        startTime,
        1,
        `Quality gate failed: ${gateResult.feedback}`,
        undefined,
        {
          qualityGate: gateResult,
          timeoutEvents,
          executionSummary,
        },
      );
    }

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: 'promotion-started: promoting Regression from durable replay proof',
    });
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: 'promotion-finished: Regression promoted from deterministic replay proof',
    });
    await this.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: 'Deterministic replay regression completed from carried proof artifacts',
    });

    this.emitProgress({
      type: 'stage-exit',
      timestamp: now(),
      stage: stage.name,
      message: '0 findings, 0 decisions',
    });

    return makeResult(stage, 'passed', output, [], [], startTime, 1, undefined, undefined, {
      qualityGate: gateResult,
      timeoutEvents,
      executionSummary,
    });
  }

  /**
   * Execute substages, optionally in parallel.
   */
  private async executeSubstages(
    session: Session,
    stage: StageDefinition,
    pipeline: PipelineTemplate,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const substages = stage.substages!;
    const allFindings: Finding[] = [];
    const allDecisions: Decision[] = [];
    const outputs: string[] = [];

    if (hasDeadlineExpired(stageDeadlineAt)) {
      return failStageDueToTimeout(
        session,
        stage,
        outputs.join('\n\n'),
        allFindings,
        allDecisions,
        startTime,
        1,
        {},
        this.stageSideEffects,
      );
    }

    if (stage.parallel) {
      // Run all substages in parallel
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message: `Running ${substages.length} substages in parallel`,
      });

      const results = await Promise.all(
        substages.map((sub) => this.executeStage(session, sub, pipeline, stageDeadlineAt)),
      );

      for (const r of results) {
        allFindings.push(...r.findings);
        allDecisions.push(...r.decisions);
        outputs.push(r.output);
        if (r.status === 'failed') {
          return makeResult(
            stage,
            'failed',
            outputs.join('\n\n'),
            allFindings,
            allDecisions,
            startTime,
            1,
            r.error,
          );
        }
      }
    } else {
      // Run substages sequentially
      for (const sub of substages) {
        const r = await this.executeStage(session, sub, pipeline, stageDeadlineAt);
        allFindings.push(...r.findings);
        allDecisions.push(...r.decisions);
        outputs.push(r.output);
        if (r.status === 'failed') {
          return makeResult(
            stage,
            'failed',
            outputs.join('\n\n'),
            allFindings,
            allDecisions,
            startTime,
            1,
            r.error,
          );
        }
      }
    }

    return makeResult(
      stage,
      'passed',
      outputs.join('\n\n'),
      allFindings,
      allDecisions,
      startTime,
      1,
    );
  }

  /**
   * Execute the implementation stage slice-by-slice using typed contracts.
   *
   * For each slice:
   *   1. Verify entry conditions (manifest.entryConditions)
   *   2. Execute implementation via model (scoped to manifest.fileContracts)
   *   3. Run exit criteria (typecheck, lint, test-lock, impact-reviewed, exports-wired)
   *   4. Engage test lock (requiredTests all passing → locked)
   *   5. Git commit only if test lock is engaged
   *   6. Carry this slice's tests into next slice's regression suite
   */
  private async executeSlices(
    session: Session,
    stage: StageDefinition,
    _pipeline: PipelineTemplate,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const allFindings: Finding[] = [];
    const allDecisions: Decision[] = [];
    const outputs: string[] = [];
    let sliceCostUsd = 0;
    let effectiveStageDeadlineAt = stageDeadlineAt;

    // Resume from the first non-committed slice (scan back from currentSliceIndex
    // to pick up locked-but-uncommitted slices that need commit retry)
    let startSlice = 0;
    while (
      startSlice < session.slices.length &&
      session.slices[startSlice].status === 'committed'
    ) {
      startSlice++;
    }

    for (let i = startSlice; i < session.slices.length; i++) {
      if (this.aborted) break;

      const slice = session.slices[i];
      const sliceFiles = getSliceFiles(slice);
      let sliceHeadBeforeImplementation: string | undefined;
      let resumedImplementationContext: string | undefined;
      let currentSliceDiffHash: string | undefined;
      session.currentSliceIndex = i;

      // Skip already-committed slices on resume
      if (slice.status === 'committed') continue;

      // Per-slice deadline reset: the stage's configured timeoutMs is intended
      // as a per-slice budget. Without this, one slow slice (model errors,
      // large diff, retries) burns the entire stage budget and later slices
      // start with the deadline already expired.
      if (stage.timeoutMs != null && stage.timeoutMs > 0) {
        effectiveStageDeadlineAt = Date.now() + stage.timeoutMs;
      }

      if (!slice.commit && !slice.testLock.locked) {
        await this.refreshUnlockedSliceArtifacts(session, slice, i, stage.name);
      }

      if (!slice.commit) {
        currentSliceDiffHash = await captureSliceDiff(sliceFiles, this.config.workDir);
        const recoveredExternalCommit =
          await this.maybeRecoverExternallyCommittedSliceFromCleanWorkspace(
            session,
            slice,
            stage,
            i,
            currentSliceDiffHash,
          );
        if (recoveredExternalCommit) {
          continue;
        }
      }

      if (slice.status === 'locked' && !slice.commit && !allExitCriteriaMet(slice)) {
        slice.testLock.locked = false;
        slice.testLock.lockedAt = undefined;
        await this.sessionManager.updateSlice(session, i, {
          status: 'failed',
          testLock: slice.testLock,
        });
        await this.refreshUnlockedSliceArtifacts(session, slice, i, stage.name);
        if (slice.implementationCheckpoint) {
          outputs.push(slice.implementationCheckpoint.output);
          resumedImplementationContext =
            slice.implementationCheckpoint.recoveryContext ?? slice.implementationCheckpoint.output;
        }
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Slice ${i + 1} had a locked checkpoint with failing exit criteria — rerunning implementation proof before any commit retry`,
        });
      }

      // Locked but uncommitted → the commit failed (e.g. JIRA error), skip directly to commit
      let skipToCommit = false;
      if (slice.status === 'locked' && !slice.commit) {
        if (slice.implementationCheckpoint) {
          outputs.push(slice.implementationCheckpoint.output);
        }
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Slice ${i + 1} is locked but uncommitted — skipping to commit retry`,
        });
        skipToCommit = true;
      } else if (
        slice.status === 'in-progress' &&
        !slice.commit &&
        slice.testLock.locked &&
        slice.implementationCheckpoint
      ) {
        const currentDiffHash =
          currentSliceDiffHash ??
          (currentSliceDiffHash = await captureSliceDiff(sliceFiles, this.config.workDir));
        if (currentDiffHash === slice.implementationCheckpoint.diffHash) {
          await this.sessionManager.updateSlice(session, i, { status: 'locked' });
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} matches its persisted implementation checkpoint — skipping to commit retry`,
          });
          outputs.push(slice.implementationCheckpoint.output);
          skipToCommit = true;
        } else {
          await this.sessionManager.updateSlice(session, i, {
            implementationCheckpoint: undefined,
          });
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} checkpoint no longer matches the working tree — rerunning implementation`,
          });
        }
      } else if (
        (slice.status === 'in-progress' || slice.status === 'failed') &&
        !slice.commit &&
        !slice.testLock.locked
      ) {
        const currentDiffHash =
          currentSliceDiffHash ??
          (currentSliceDiffHash = await captureSliceDiff(sliceFiles, this.config.workDir));
        if (
          slice.implementationCheckpoint &&
          currentDiffHash &&
          slice.implementationCheckpoint.diffHash &&
          currentDiffHash === slice.implementationCheckpoint.diffHash
        ) {
          resumedImplementationContext =
            slice.implementationCheckpoint.recoveryContext ?? slice.implementationCheckpoint.output;
          outputs.push(slice.implementationCheckpoint.output);
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} matches its persisted implementation checkpoint — resuming from the current diff and recorded proof failures`,
          });
        } else if (
          slice.implementationCheckpoint &&
          !currentDiffHash &&
          !slice.implementationCheckpoint.diffHash
        ) {
          resumedImplementationContext =
            slice.implementationCheckpoint.recoveryContext ?? slice.implementationCheckpoint.output;
          outputs.push(slice.implementationCheckpoint.output);
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} has a persisted no-diff recovery checkpoint — resuming from the recorded implementation plan instead of rediscovering the seam`,
          });
        } else if (!slice.implementationCheckpoint && currentDiffHash) {
          resumedImplementationContext = buildExistingDiffResumeContext(slice);
          const syntheticCheckpoint = {
            output: resumedImplementationContext,
            diffHash: currentDiffHash,
            capturedAt: now(),
            recoveryContext: resumedImplementationContext,
            failedCriteriaSummary: summarizeFailedExitCriteria(
              slice.exitCriteria.filter((criterion) => !criterion.passed),
            ),
          };
          await this.sessionManager.updateSlice(session, i, {
            implementationCheckpoint: syntheticCheckpoint,
          });
          slice.implementationCheckpoint = syntheticCheckpoint;
          outputs.push(resumedImplementationContext);
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} already has an unfinished diff in the workspace — resuming from the current changes and rerunning narrow proof instead of rediscovering the seam`,
          });
        } else if (slice.implementationCheckpoint) {
          await this.sessionManager.updateSlice(session, i, {
            implementationCheckpoint: undefined,
          });
          slice.implementationCheckpoint = undefined;
          if (currentDiffHash) {
            resumedImplementationContext = buildExistingDiffResumeContext(slice);
            const syntheticCheckpoint = {
              output: resumedImplementationContext,
              diffHash: currentDiffHash,
              capturedAt: now(),
              recoveryContext: resumedImplementationContext,
              failedCriteriaSummary: summarizeFailedExitCriteria(
                slice.exitCriteria.filter((criterion) => !criterion.passed),
              ),
            };
            await this.sessionManager.updateSlice(session, i, {
              implementationCheckpoint: syntheticCheckpoint,
            });
            slice.implementationCheckpoint = syntheticCheckpoint;
            outputs.push(resumedImplementationContext);
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: i,
              message: `Slice ${i + 1} implementation checkpoint no longer matches the working tree — rebuilding recovery context from the current diff`,
            });
          } else {
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: i,
              message: `Slice ${i + 1} implementation checkpoint no longer matches the working tree — discarding the old recovery context`,
            });
          }
        }
      }

      if (!skipToCommit) {
        // ── 1. Verify entry conditions ──
        const entryBlocked = verifyEntryConditions(session, slice);
        if (entryBlocked) {
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Skipping slice ${i + 1} — ${entryBlocked}`,
          });
          continue;
        }

        sliceHeadBeforeImplementation = await captureHeadSha(this.config.workDir);

        // ── Slice start ──
        const initialAutonomy = assessSliceAutonomyFromConfig(this.config, session, slice);
        await this.sessionManager.updateSlice(session, i, {
          status: 'in-progress',
          autonomy: initialAutonomy,
          ...(resumedImplementationContext ? {} : { implementationCheckpoint: undefined }),
        });
        this.emitProgress({
          type: 'slice-start',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `${slice.title} — ${slice.manifest.fileContracts.length} file contracts, ${slice.manifest.exportContracts.length} export contracts`,
        });
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Autonomy: ${initialAutonomy.riskLevel} risk / ${initialAutonomy.confidenceLevel} confidence → ${initialAutonomy.disposition === 'deferred-bulk-review' ? 'eligible for deferred bulk review' : 'manual commit checkpoint will be required before commit'}`,
          details: {
            riskScore: initialAutonomy.riskScore,
            reasons: initialAutonomy.reasons,
            confidenceScore: initialAutonomy.confidenceScore,
            confidenceReasons: initialAutonomy.confidenceReasons,
          },
        });

        await this.journal(session, {
          timestamp: now(),
          type: 'slice-start',
          stage: stage.name,
          message: `Slice ${i + 1}/${session.slices.length}: ${slice.title}`,
        });

        // ── 2. Implementation loop (with quality gate retry) ──
        const checklist = buildSliceChecklist(slice);
        let lastOutput = resumedImplementationContext ?? '';
        let sliceRetries = 0;
        let modelAttempts = 0;
        let pendingTypecheckRepairAttempt = false;
        let typecheckRepairAttempts = 0;
        const maxRetries = this.config.maxSliceRetries;

        // No per-slice deadline — stall detection in executors is the guard.
        // The stage deadline (if any) is still respected.
        const sliceDeadlineAt = effectiveStageDeadlineAt;

        const persistImplementationCheckpoint = async (
          output: string,
          recoveryContext?: string,
          failedCriteriaSummary?: string,
        ): Promise<void> => {
          const diffHash = await captureSliceDiff(sliceFiles, this.config.workDir);
          if (!diffHash && !recoveryContext) {
            return;
          }

          const checkpoint = {
            output,
            diffHash: diffHash || undefined,
            capturedAt: now(),
            recoveryContext,
            failedCriteriaSummary,
          };
          slice.implementationCheckpoint = checkpoint;
          await this.sessionManager.updateSlice(session, i, {
            implementationCheckpoint: checkpoint,
          });
        };

        if (resumedImplementationContext) {
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message:
              'Resuming implementation from the current diff and recorded proof failures — rerun the narrow proof first and keep the change set inside the declared file contracts.',
          });
        }

        while (sliceRetries < maxRetries || pendingTypecheckRepairAttempt) {
          const isTypecheckRepairAttempt = pendingTypecheckRepairAttempt;
          pendingTypecheckRepairAttempt = false;
          if (isTypecheckRepairAttempt) {
            typecheckRepairAttempts += 1;
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: i,
              message: `Typecheck repair attempt ${typecheckRepairAttempts}/${MAX_TYPECHECK_REPAIR_ATTEMPTS}: asking Codex to fix the scoped compiler errors before HELIX fails the slice`,
            });
          } else {
            sliceRetries++;
          }
          modelAttempts++;

          const remainingSliceMs = getRemainingTimeoutMs(sliceDeadlineAt);
          const remainingStageMs = getRemainingTimeoutMs(effectiveStageDeadlineAt);
          // Fail if either the per-slice or stage deadline has expired
          if (
            (remainingSliceMs != null && remainingSliceMs <= 0) ||
            (remainingStageMs != null && remainingStageMs <= 0)
          ) {
            await this.sessionManager.updateSlice(session, i, { status: 'failed' });
            return failStageDueToTimeout(
              session,
              stage,
              outputs.join('\n\n'),
              allFindings,
              allDecisions,
              startTime,
              modelAttempts,
              {},
              this.stageSideEffects,
            );
          }

          // Use the tighter of the two deadlines for model execution
          const effectiveTimeoutMs =
            remainingSliceMs != null && remainingStageMs != null
              ? Math.min(remainingSliceMs, remainingStageMs)
              : (remainingSliceMs ?? remainingStageMs);

          const sliceLiveContext = this.liveContext.renderForPrompt();
          const efficiencyBudget = estimateSliceEfficiencyBudget(slice, session);
          const contextPacket = await buildSliceContextPacket(this.config.workDir, session, slice);
          const baseSlicePrompt = buildSlicePrompt(
            stage,
            session,
            slice,
            checklist,
            lastOutput,
            modelAttempts,
            contextPacket,
          );
          const prompt = sliceLiveContext
            ? `${baseSlicePrompt}\n\n${sliceLiveContext}`
            : baseSlicePrompt;
          await this.liveContext.markConsumed(stage.name);

          const onStream = createStageStreamHandler(
            (event) => this.emitProgress(event),
            stage.name,
            i,
          );

          const result = await this.modelRouter.execute(
            prompt,
            stripLayeredForLowRiskSlice(
              withExecutorEfficiencyBudget(stage.model, efficiencyBudget),
              slice,
            ),
            stage.tools,
            onStream,
            stage.outputSchema,
            effectiveTimeoutMs,
          );
          accumulateProviderCost(session, result);

          sliceCostUsd += result.costUsd ?? 0;
          if (sliceCostUsd > 0) {
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: i,
              message: `slice ${i + 1} model execution complete (${result.engine}/${result.model})`,
              details: { costUsd: sliceCostUsd },
            });
          }

          if (result.error) {
            await this.journal(session, {
              timestamp: now(),
              type: 'error',
              stage: stage.name,
              message: `Slice ${i + 1} model error: ${result.error}`,
            });
            if (isTimeoutError(result.error)) {
              await this.sessionManager.updateSlice(session, i, { status: 'failed' });
              return makeResult(
                stage,
                'failed',
                outputs.join('\n\n'),
                allFindings,
                allDecisions,
                startTime,
                modelAttempts,
                result.error,
              );
            }
            const recoveryContext = isImplementationExplorationBudgetError(result.error)
              ? buildImplementationRecoveryContext(slice, result.error, lastOutput)
              : `ERROR: ${result.error}\n\nPREVIOUS OUTPUT:\n${lastOutput}`;
            lastOutput = recoveryContext;
            if (isImplementationExplorationBudgetError(result.error)) {
              const currentDiffHash = await captureSliceDiff(sliceFiles, this.config.workDir);
              if (currentDiffHash) {
                this.emitProgress({
                  type: 'stage-progress',
                  timestamp: now(),
                  stage: stage.name,
                  slice: i,
                  message:
                    'Implementation hit the exploration cap with a real diff in the workspace — running the narrow proof lane on the current changes before retrying.',
                });

                await persistImplementationCheckpoint(
                  result.output || recoveryContext,
                  recoveryContext,
                  summarizeFailedExitCriteria(
                    slice.exitCriteria.filter((criterion) => !criterion.passed),
                  ),
                );

                const recoveryExitDeadlineAt =
                  sliceDeadlineAt != null && effectiveStageDeadlineAt != null
                    ? Math.min(sliceDeadlineAt, effectiveStageDeadlineAt)
                    : (sliceDeadlineAt ?? effectiveStageDeadlineAt);

                let recoveryExitResult: ExitCriteriaEvaluation;
                try {
                  recoveryExitResult = await this.runExitCriteria(
                    session,
                    slice,
                    stage,
                    i,
                    result.output || recoveryContext,
                    recoveryExitDeadlineAt,
                  );
                } catch (error) {
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  await this.sessionManager.updateSlice(session, i, { status: 'failed' });
                  await this.journal(session, {
                    timestamp: now(),
                    type: 'error',
                    stage: stage.name,
                    message: `Slice ${i + 1} exit criteria error: ${errorMsg}`,
                  });
                  return makeResult(
                    stage,
                    'failed',
                    outputs.join('\n\n'),
                    allFindings,
                    allDecisions,
                    startTime,
                    modelAttempts,
                    errorMsg,
                  );
                }

                this.emitProgress({
                  type: 'quality-gate-result',
                  timestamp: now(),
                  stage: stage.name,
                  slice: i,
                  message: `Exit criteria: ${summarizeExitCriteria(slice)}`,
                  details: { allMet: recoveryExitResult.allMet },
                });

                if (recoveryExitResult.allMet) {
                  outputs.push(result.output || recoveryContext);
                  break;
                }
              }
            }
            await persistImplementationCheckpoint(
              recoveryContext,
              recoveryContext,
              summarizeFailedExitCriteria(
                slice.exitCriteria.filter((criterion) => !criterion.passed),
              ),
            );
            continue;
          }

          lastOutput = result.output;
          outputs.push(result.output);
          await persistImplementationCheckpoint(result.output);
          // Parse findings from slice output
          const parsed = parseAnalysisOutput(result.output, stage.name);
          for (const f of parsed.findings) {
            allFindings.push(f);
            await this.sessionManager.addFinding(session, f);
          }
          for (const d of parsed.decisions) {
            allDecisions.push(d);
            if (d.classification === 'AMBIGUOUS') {
              await this.resolveAmbiguousDecision(
                session,
                stage,
                d,
                resolveSessionStateForStage(stage),
              );
            }
            await this.sessionManager.upsertDecision(session, d);
          }

          // ── 3. Run exit criteria ──
          const deadlineExpiredAfterModelTurn =
            hasDeadlineExpired(sliceDeadlineAt) || hasDeadlineExpired(effectiveStageDeadlineAt);
          if (deadlineExpiredAfterModelTurn) {
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: i,
              message:
                'Implementation turn completed after the stage deadline — allowing one deterministic closeout pass for verification and commit.',
            });
          }

          // Pass per-slice deadline to exit criteria (tighter than stage deadline)
          const exitDeadlineAt = deadlineExpiredAfterModelTurn
            ? undefined
            : sliceDeadlineAt != null && effectiveStageDeadlineAt != null
              ? Math.min(sliceDeadlineAt, effectiveStageDeadlineAt)
              : (sliceDeadlineAt ?? effectiveStageDeadlineAt);

          let exitResult: ExitCriteriaEvaluation;
          try {
            exitResult = await this.runExitCriteria(
              session,
              slice,
              stage,
              i,
              result.output,
              exitDeadlineAt,
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            await this.sessionManager.updateSlice(session, i, { status: 'failed' });
            await this.journal(session, {
              timestamp: now(),
              type: 'error',
              stage: stage.name,
              message: `Slice ${i + 1} exit criteria error: ${errorMsg}`,
            });
            return makeResult(
              stage,
              'failed',
              outputs.join('\n\n'),
              allFindings,
              allDecisions,
              startTime,
              modelAttempts,
              errorMsg,
            );
          }

          this.emitProgress({
            type: 'quality-gate-result',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Exit criteria: ${summarizeExitCriteria(slice)}`,
            details: { allMet: exitResult.allMet },
          });

          const typecheckFailure = exitResult.failedCriteria.find(
            (criterion) => criterion.type === 'typecheck',
          );
          const testLockFailure = exitResult.failedCriteria.find(
            (criterion) => criterion.type === 'test-lock',
          );

          if (!exitResult.allMet && typecheckFailure) {
            lastOutput = buildTypecheckRepairRetryContext(
              slice,
              exitResult.failedCriteria,
              exitResult.qualityGateResults[typecheckFailure.id],
              lastOutput,
            );
            await persistImplementationCheckpoint(
              result.output,
              lastOutput,
              summarizeFailedExitCriteria(exitResult.failedCriteria),
            );

            if (!isTypecheckRepairAttempt && sliceRetries < maxRetries) {
              continue;
            }

            if (
              !isTypecheckRepairAttempt &&
              typecheckRepairAttempts < MAX_TYPECHECK_REPAIR_ATTEMPTS
            ) {
              pendingTypecheckRepairAttempt = true;
              continue;
            }
          }

          if (!exitResult.allMet && testLockFailure) {
            lastOutput = buildTestRepairRetryContext(
              slice,
              exitResult.failedCriteria,
              exitResult.qualityGateResults[testLockFailure.id],
              lastOutput,
            );
            await persistImplementationCheckpoint(
              result.output,
              lastOutput,
              summarizeFailedExitCriteria(exitResult.failedCriteria),
            );

            if (!isTypecheckRepairAttempt && sliceRetries < maxRetries) {
              continue;
            }
          }

          if (!exitResult.allMet) {
            const manifestDriftRecovery = await this.maybeRecoverSliceManifestDrift(
              session,
              slice,
              stage,
              i,
              exitResult.failedCriteria,
            );

            if (manifestDriftRecovery.recovered) {
              if (!isTypecheckRepairAttempt && sliceRetries > 0) {
                sliceRetries -= 1;
              }
              lastOutput = buildManifestDriftRetryContext(
                manifestDriftRecovery.summary,
                manifestDriftRecovery.expandedFiles,
                lastOutput,
              );
              await persistImplementationCheckpoint(
                result.output,
                lastOutput,
                manifestDriftRecovery.summary,
              );
              continue;
            }
          }

          // Escalation gate (ABLP-789 Slice 14):
          // When the only failing criterion is architecture-reviewed AND
          // tests are already passing AND review history shows oscillation,
          // pause and prompt the operator before burning another retry.
          // The reporter will force an interactive prompt even when
          // --auto-approve is on — the operator authorized auto-approve for
          // routine flow, not for "the reviewer keeps changing its mind".
          if (!exitResult.allMet) {
            const failingCriteria = exitResult.failedCriteria;
            const onlyArchReviewFailing =
              failingCriteria.length === 1 && failingCriteria[0]?.type === 'architecture-reviewed';
            const allRequiredTestsPassing =
              slice.testLock.locked &&
              slice.testLock.requiredTests.every((req) => req.status === 'passing');
            const oscillation = analyzeArchReviewHistory(slice.archReviewHistory);

            if (onlyArchReviewFailing && allRequiredTestsPassing && oscillation.isOscillating) {
              const archCriterion = slice.exitCriteria.find(
                (ec) => ec.type === 'architecture-reviewed',
              );
              const approved = await this.reporter.onCheckpoint(
                `Slice ${i + 1} architecture review is oscillating (${oscillation.totalAttempts} attempts; ${oscillation.consecutiveBlocked} consecutive blocked verdicts). Tests pass. Approve commit anyway?`,
                {
                  sliceTitle: slice.title,
                  sliceDescription: slice.description,
                  files: getSliceFiles(slice),
                  testLock: summarizeTestLock(slice.testLock),
                  exitCriteriaItems: slice.exitCriteria.map((criterion) => ({
                    id: criterion.id,
                    passed: criterion.passed,
                    detail: criterion.detail,
                  })),
                  reviewHistory: slice.archReviewHistory ?? [],
                  reviewFindings: slice.review?.findings ?? [],
                },
                { forceInteractive: true },
              );

              if (approved) {
                if (archCriterion) {
                  updateExitCriterion(
                    slice,
                    archCriterion.id,
                    true,
                    `Operator override after ${oscillation.totalAttempts} oscillating reviews; tests passing.`,
                  );
                }
                await this.journal(session, {
                  timestamp: now(),
                  type: 'review',
                  stage: stage.name,
                  message: `Slice ${i + 1} architecture review override approved by operator after ${oscillation.totalAttempts} oscillating attempts`,
                });
                if (allExitCriteriaMet(slice)) {
                  // Re-emit a passed quality-gate event so downstream consumers see the final state.
                  this.emitProgress({
                    type: 'quality-gate-result',
                    timestamp: now(),
                    stage: stage.name,
                    slice: i,
                    message: `Exit criteria: ${summarizeExitCriteria(slice)}`,
                    details: { allMet: true },
                  });
                  break; // exit retry loop, proceed to commit
                }
              } else {
                await this.journal(session, {
                  timestamp: now(),
                  type: 'review',
                  stage: stage.name,
                  message: `Slice ${i + 1} architecture review override REJECTED by operator after ${oscillation.totalAttempts} oscillating attempts; pausing session`,
                });
                await this.sessionManager.updateSlice(session, i, { status: 'failed' });
                return makeResult(
                  stage,
                  'failed',
                  outputs.join('\n\n'),
                  allFindings,
                  allDecisions,
                  startTime,
                  modelAttempts,
                  `Slice ${i + 1} architecture review oscillating; operator rejected the override.`,
                );
              }
            }
          }

          if (!exitResult.allMet && sliceRetries < maxRetries) {
            const failedCriteria = summarizeFailedExitCriteria(
              slice.exitCriteria.filter((ec) => !ec.passed),
            );
            lastOutput = `EXIT CRITERIA NOT MET:\n${failedCriteria}\n\nPREVIOUS OUTPUT:\n${lastOutput}`;
            await persistImplementationCheckpoint(result.output, lastOutput, failedCriteria);
            continue;
          }

          if (!exitResult.allMet) {
            await persistImplementationCheckpoint(
              result.output,
              lastOutput,
              summarizeFailedExitCriteria(
                slice.exitCriteria.filter((criterion) => !criterion.passed),
              ),
            );
            await this.sessionManager.updateSlice(session, i, { status: 'failed' });
            return makeResult(
              stage,
              'failed',
              outputs.join('\n\n'),
              allFindings,
              allDecisions,
              startTime,
              modelAttempts,
              `Slice ${i + 1} failed exit criteria after ${maxRetries} retries${typecheckRepairAttempts > 0 ? ` and ${typecheckRepairAttempts} dedicated typecheck repair attempt${typecheckRepairAttempts === 1 ? '' : 's'}` : ''}: ${summarizeExitCriteria(slice)}`,
            );
          }

          // ── Legacy path identification from model output ──
          const legacyPaths = parseLegacyPaths(result.output, i);
          if (legacyPaths.length > 0) {
            await this.sessionManager.updateSlice(session, i, { legacyPaths });
          }

          // All exit criteria passed — break the retry loop
          break;
        }

        // ── 4. Engage test lock ──
        const lockEngaged = canEngageTestLock(slice.testLock);
        slice.testLock.locked = lockEngaged;
        let implementationCheckpoint = slice.implementationCheckpoint;
        if (lockEngaged) {
          const capturedAt = now();
          slice.testLock.lockedAt = capturedAt;
          implementationCheckpoint = {
            output: lastOutput,
            diffHash: await captureSliceDiff(sliceFiles, this.config.workDir),
            capturedAt,
          };
        }
        await this.sessionManager.updateSlice(session, i, {
          status: lockEngaged ? 'locked' : slice.status,
          testLock: slice.testLock,
          implementationCheckpoint: lockEngaged ? implementationCheckpoint : undefined,
        });

        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Test lock: ${summarizeTestLock(slice.testLock)}`,
        });
      } // end if (!skipToCommit)

      // ── 5. Git commit (only if test lock is engaged) ──
      if (!slice.testLock.locked) {
        this.emitProgress({
          type: 'error',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Cannot commit slice ${i + 1} — test lock not engaged`,
        });
        await this.sessionManager.updateSlice(session, i, { status: 'failed' });
        return makeResult(
          stage,
          'failed',
          outputs.join('\n\n'),
          allFindings,
          allDecisions,
          startTime,
          1,
          `Slice ${i + 1} cannot commit because the test lock was not engaged: ${summarizeTestLock(slice.testLock)}`,
          sliceCostUsd || undefined,
        );
      }

      const commitAutonomy = assessSliceAutonomyFromConfig(this.config, session, slice);
      await this.sessionManager.updateSlice(session, i, { autonomy: commitAutonomy });
      const autonomyPolicy = resolveAutonomyPolicy(this.config.autonomy);
      const baselineRequireApproval =
        autonomyPolicy.mode === 'thresholded'
          ? commitAutonomy.disposition !== 'deferred-bulk-review'
          : !this.config.autoCommit;
      const requireApproval = shouldRequireSliceCommitApproval({
        baselineRequireApproval,
        isReplayMode: Boolean(session.replayContext),
        testLockLocked: slice.testLock.locked,
        exitCriteria: slice.exitCriteria,
      });
      const checkpointTelemetry = { approvalWaitMs: 0 };

      const commitRecord = await this.commitManager.performSliceCommit(session, slice, i, {
        requireApproval,
        stageName: stage.name,
        workspaceReconcileModel: resolveWorkspaceReconcileAssignment(this.config, stage),
        checkpointSummary: buildSliceCommitCheckpointSummary(session, slice),
        checkpointTelemetry,
      });
      if (checkpointTelemetry.approvalWaitMs > 0 && effectiveStageDeadlineAt != null) {
        effectiveStageDeadlineAt += checkpointTelemetry.approvalWaitMs;
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `Excluded ${Math.round(checkpointTelemetry.approvalWaitMs / 1000)}s of manual checkpoint wait from the stage deadline`,
        });
      }
      if (commitRecord) {
        const postCommitAutonomy = requireApproval
          ? slice.autonomy
          : autonomyPolicy.mode === 'thresholded'
            ? markSliceQueuedForBulkReview(slice)
            : slice.autonomy;

        await this.sessionManager.addCommit(session, commitRecord);
        await this.sessionManager.updateSlice(session, i, {
          status: 'committed',
          commit: commitRecord,
          autonomy: postCommitAutonomy,
          implementationCheckpoint: undefined,
        });

        // Mark assigned findings as fixed
        for (const findingId of slice.findings) {
          const finding = session.findings.find((f) => f.id === findingId);
          if (finding) {
            finding.status = 'fixed';
            finding.fixedInCommit = commitRecord.sha;
            finding.updatedAt = now();
          }
        }
        await this.sessionManager.persist(session);

        this.emitProgress({
          type: 'commit',
          timestamp: now(),
          stage: stage.name,
          slice: i,
          message: `${commitRecord.sha.slice(0, 7)} ${commitRecord.message}`,
        });

        if (postCommitAutonomy?.bulkReviewStatus === 'queued') {
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Queued slice ${i + 1} for deferred bulk review`,
            details: {
              riskLevel: postCommitAutonomy.riskLevel,
              riskScore: postCommitAutonomy.riskScore,
            },
          });
        }
      } else {
        const recoveredCommit = await this.recoverModelManagedCommit(
          session,
          slice,
          i,
          stage.name,
          sliceHeadBeforeImplementation ?? this.resolveCommitRecoveryBaselineSha(session, i),
        );
        if (recoveredCommit) {
          await this.sessionManager.addCommit(session, recoveredCommit);
          await this.sessionManager.updateSlice(session, i, {
            status: 'committed',
            commit: recoveredCommit,
            implementationCheckpoint: undefined,
          });

          for (const findingId of slice.findings) {
            const finding = session.findings.find((f) => f.id === findingId);
            if (finding) {
              finding.status = 'fixed';
              finding.fixedInCommit = recoveredCommit.sha;
              finding.updatedAt = now();
            }
          }
          await this.sessionManager.persist(session);

          this.emitProgress({
            type: 'commit',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `${recoveredCommit.sha.slice(0, 7)} ${recoveredCommit.message}`,
          });
        } else {
          // Commit returned null (e.g. JIRA failure, user rejected) — leave as in-progress for retry
          this.emitProgress({
            type: 'error',
            timestamp: now(),
            stage: stage.name,
            slice: i,
            message: `Slice ${i + 1} commit failed — will retry on resume`,
          });
          await this.sessionManager.updateSlice(session, i, { status: 'locked' });
          return makeResult(
            stage,
            'failed',
            outputs.join('\n\n'),
            allFindings,
            allDecisions,
            startTime,
            1,
            `Slice ${i + 1} commit checkpoint was not approved or the commit did not complete — resume after approval to retry this commit`,
            sliceCostUsd || undefined,
          );
        }
      }

      // ── 6. Carry tests to next slice's regression suite ──
      const thisSliceTests = slice.testLock.requiredTests.map((t) => t.testFile);
      for (let j = i + 1; j < session.slices.length; j++) {
        const nextSlice = session.slices[j];
        for (const testFile of thisSliceTests) {
          if (!nextSlice.testLock.regressionSuite.includes(testFile)) {
            nextSlice.testLock.regressionSuite.push(testFile);
          }
        }
      }

      this.emitProgress({
        type: 'slice-complete',
        timestamp: now(),
        stage: stage.name,
        slice: i,
        message: `${slice.title} — ${summarizeExitCriteria(slice)}, lock: ${summarizeTestLock(slice.testLock)}`,
      });

      await this.journal(session, {
        timestamp: now(),
        type: 'slice-complete',
        stage: stage.name,
        message: `Slice ${i + 1} committed: ${slice.title}`,
      });
    }

    // ── Compile legacy path report for subsequent stages ──
    const allLegacyPaths = session.slices.flatMap((s) => s.legacyPaths);
    if (allLegacyPaths.length > 0) {
      const legacyReport = allLegacyPaths
        .filter((lp) => lp.status === 'identified')
        .map(
          (lp) => `  - ${lp.path}: ${lp.reason} (removable after slice ${lp.removableAfter + 1})`,
        )
        .join('\n');
      outputs.push(`\n## Legacy Paths for Cleanup\n${legacyReport}`);
    }

    const completedCount = session.slices.filter((s) => s.status === 'committed').length;
    return makeResult(
      stage,
      completedCount === session.slices.length ? 'passed' : 'failed',
      outputs.join('\n\n'),
      allFindings,
      allDecisions,
      startTime,
      1,
      completedCount < session.slices.length
        ? `${completedCount}/${session.slices.length} slices completed`
        : undefined,
      sliceCostUsd || undefined,
    );
  }

  private async refreshUnlockedSliceArtifacts(
    session: Session,
    slice: Slice,
    sliceIndex: number,
    stageName: string,
  ): Promise<void> {
    const compiled = await compileSliceArtifacts(slice, session, this.config.workDir);
    const currentFingerprint = JSON.stringify({
      manifest: slice.manifest,
      testLock: {
        requiredTests: slice.testLock.requiredTests,
        regressionSuite: slice.testLock.regressionSuite,
      },
      impactAnalysis: slice.impactAnalysis,
      exitCriteria: slice.exitCriteria,
    });
    const compiledFingerprint = JSON.stringify({
      manifest: compiled.manifest,
      testLock: {
        requiredTests: compiled.testLock.requiredTests,
        regressionSuite: compiled.testLock.regressionSuite,
      },
      impactAnalysis: compiled.impactAnalysis,
      exitCriteria: compiled.exitCriteria,
    });

    if (currentFingerprint === compiledFingerprint) {
      return;
    }

    await this.sessionManager.updateSlice(session, sliceIndex, {
      manifest: compiled.manifest,
      testLock: compiled.testLock,
      impactAnalysis: compiled.impactAnalysis,
      exitCriteria: compiled.exitCriteria,
      review: undefined,
      verificationCheckpoint: undefined,
      proofPacket: undefined,
    });

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stageName,
      slice: sliceIndex,
      message: `Refreshed slice ${sliceIndex + 1} manifest and test lock from the current workspace state (${compiled.testLock.requiredTests.length} required test${compiled.testLock.requiredTests.length === 1 ? '' : 's'})`,
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stageName,
      message: `Refreshed slice ${sliceIndex + 1} manifest/test lock before implementation retry`,
      details: {
        requiredTests: compiled.testLock.requiredTests.map((test) => test.testFile),
        fileContracts: compiled.manifest.fileContracts.map((contract) => ({
          path: contract.path,
          action: contract.action,
        })),
      },
    });
  }

  /**
   * Verify a slice's entry conditions. Returns null if all met, or a reason string if blocked.
   */
  /**
   * Run all exit criteria for a slice. Updates the criteria in-place.
   */
  private async runExitCriteria(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    implementationOutput: string,
    stageDeadlineAt?: number,
  ): Promise<ExitCriteriaEvaluation> {
    const gateScopeEntries = dedupeStrings(getSliceGateScopeEntries(slice));
    const typecheckScopeEntries = dedupeStrings(getSliceFiles(slice));
    const verificationScopeEntries = dedupeStrings(getSliceVerificationScopeEntries(slice));
    const reviewScopeEntries = dedupeStrings(getSliceReviewScopeEntries(slice));
    const qualityGateResults: Record<string, QualityGateResult> = {};
    // Shared across the workspace-scope-clean and architecture-reviewed cases
    // so the arch-review doesn't have to re-run inspect + reconcile when the
    // scope-clean gate has already produced a resolved workspace state.
    let reconciledWorkspaceState: SliceReviewWorkspaceState | undefined;
    const verificationDiffHash = await captureSliceDiff(
      verificationScopeEntries.length > 0 ? verificationScopeEntries : gateScopeEntries,
      this.config.workDir,
    );
    const typecheckVerificationDiffHash =
      typecheckScopeEntries.length > 0
        ? await captureSliceDiff(typecheckScopeEntries, this.config.workDir)
        : verificationDiffHash;
    const precomputedCriteria = await this.precomputeParallelVerificationCriteria({
      session,
      slice,
      stage,
      sliceIndex,
      gateScopeEntries,
      typecheckScopeEntries,
      verificationScopeEntries,
      verificationDiffHash,
      typecheckVerificationDiffHash,
      stageDeadlineAt,
    });

    const applyReusableCriterion = (
      criterion: ExitCriterion,
      reusableCriterion: SliceVerificationCriterionCheckpoint,
    ): true => {
      if (reusableCriterion.qualityGate) {
        qualityGateResults[criterion.id] = reusableCriterion.qualityGate;
      }
      if (criterion.type === 'test-lock') {
        for (const req of slice.testLock.requiredTests) {
          req.status = 'passing';
        }
      }
      if (criterion.type === 'architecture-reviewed' && reusableCriterion.review) {
        slice.review = reusableCriterion.review;
      }
      updateExitCriterion(
        slice,
        criterion.id,
        true,
        annotateReusedVerificationDetail(reusableCriterion.detail),
      );
      return true;
    };

    const applyParallelEvaluation = (
      criterion: ExitCriterion,
      evaluation: ParallelCriterionEvaluation,
    ): true => {
      qualityGateResults[criterion.id] = evaluation.gate;
      updateExitCriterion(slice, criterion.id, evaluation.gate.passed, evaluation.detail);
      if (evaluation.cachedCriterion) {
        cacheReusableVerificationCriterion(
          slice,
          evaluation.checkpointDiffHash,
          evaluation.cachedCriterion,
        );
      } else {
        clearReusableVerificationCriterion(slice, criterion.id);
      }
      return true;
    };

    for (const criterion of orderExitCriteria(slice.exitCriteria)) {
      switch (criterion.type) {
        case 'typecheck': {
          const reusableCriterion = precomputedCriteria.reused.get(criterion.id);
          if (reusableCriterion) {
            applyReusableCriterion(criterion, reusableCriterion);
            continue;
          }
          const evaluation = precomputedCriteria.evaluated.get(criterion.id);
          if (evaluation) {
            applyParallelEvaluation(criterion, evaluation);
            continue;
          }
          break;
        }
        case 'lint': {
          const reusableCriterion = precomputedCriteria.reused.get(criterion.id);
          if (reusableCriterion) {
            applyReusableCriterion(criterion, reusableCriterion);
            continue;
          }
          const evaluation = precomputedCriteria.evaluated.get(criterion.id);
          if (evaluation) {
            applyParallelEvaluation(criterion, evaluation);
            continue;
          }
          break;
        }
        case 'test-lock': {
          // Run required tests + regression suite
          const testFiles = [
            ...slice.testLock.requiredTests.map((t) => t.testFile),
            ...slice.testLock.regressionSuite,
          ];
          if (testFiles.length > 0) {
            const testCommand = await buildTestLockCommand(this.config.workDir, testFiles);
            const testLockReuseKey = buildVerificationReuseKey({
              criterionId: criterion.id,
              criterionType: criterion.type,
              diffHash: verificationDiffHash,
              command: testCommand,
              scopeEntries: testFiles,
            });
            const reusableCriterion = getReusableVerificationCriterion(
              slice,
              criterion.id,
              testLockReuseKey,
              verificationDiffHash,
            );
            if (reusableCriterion) {
              applyReusableCriterion(criterion, reusableCriterion);
              continue;
            }

            const gate = await runQualityGate(
              {
                name: 'Test Lock',
                checks: [
                  {
                    name: 'Required + regression tests',
                    type: 'test',
                    command: testCommand,
                  },
                ],
                passThreshold: 1.0,
                failAction: 'loop',
              },
              this.config.workDir,
              session,
              stage.name,
            );
            qualityGateResults[criterion.id] = gate;
            // Update individual test requirement statuses
            for (const req of slice.testLock.requiredTests) {
              req.status = gate.passed ? 'passing' : 'failing';
            }
            const detail = summarizeQualityGateEvidence(gate);
            updateExitCriterion(slice, criterion.id, gate.passed, detail);
            if (gate.passed) {
              cacheReusableVerificationCriterion(slice, verificationDiffHash, {
                criterionId: criterion.id,
                criterionType: criterion.type,
                reuseKey: testLockReuseKey,
                detail,
                qualityGate: gate,
                capturedAt: now(),
              });
            } else {
              clearReusableVerificationCriterion(slice, criterion.id);
            }
          } else {
            updateExitCriterion(
              slice,
              criterion.id,
              false,
              'No test requirements declared for this slice',
            );
            clearReusableVerificationCriterion(slice, criterion.id);
          }
          break;
        }
        case 'impact-reviewed': {
          const impact = deriveManifestImpactAnalysis(slice);
          await this.sessionManager.updateSlice(session, sliceIndex, { impactAnalysis: impact });

          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: sliceIndex,
            message: `Impact: ${impact.directFiles.length} direct, ${impact.dependentFiles.length} dependent, ${impact.affectedTests.length} tests — risk: ${impact.riskLevel}`,
          });

          updateExitCriterion(slice, criterion.id, true, summarizeImpactAnalysis(impact));
          break;
        }
        case 'exports-wired': {
          const unwired = slice.manifest.exportContracts.filter(
            (ec) => ec.consumers.length === 0 && ec.isNew,
          );
          const passed = unwired.length === 0;
          updateExitCriterion(
            slice,
            criterion.id,
            passed,
            passed
              ? summarizeExportContracts(slice)
              : `${unwired.length} exports without consumers`,
          );
          break;
        }
        case 'workspace-scope-clean': {
          const preReconcileWorkspaceState = await inspectSliceReviewWorkspaceState(
            slice,
            this.config.workDir,
            {
              baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
            },
          );
          reconciledWorkspaceState = await this.reconcileSliceReviewWorkspaceState(
            session,
            slice,
            stage,
            sliceIndex,
            preReconcileWorkspaceState,
          );
          const passed = reconciledWorkspaceState.outOfScopeChanges.length === 0;
          const summary =
            reconciledWorkspaceState.workspaceReconcileSummary ??
            'Workspace reconcile produced no out-of-scope changes.';
          const detail = passed
            ? summary
            : [
                `${reconciledWorkspaceState.outOfScopeChanges.length} out-of-scope working tree file(s) remain after reconcile.`,
                `Out-of-scope files: ${reconciledWorkspaceState.outOfScopeChanges.slice(0, 10).join(', ')}`,
                reconciledWorkspaceState.workspaceReconcileSummary
                  ? `Workspace reconcile: ${reconciledWorkspaceState.workspaceReconcileSummary}`
                  : null,
              ]
                .filter((entry): entry is string => Boolean(entry))
                .join(' ');
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: sliceIndex,
            message: passed
              ? 'Workspace scope-clean: PASSED'
              : `Workspace scope-clean: FAILED (${reconciledWorkspaceState.outOfScopeChanges.length} out-of-scope file(s))`,
          });
          updateExitCriterion(slice, criterion.id, passed, detail);
          break;
        }
        case 'architecture-reviewed': {
          const reviewWorkspaceState =
            reconciledWorkspaceState ??
            (await inspectSliceReviewWorkspaceState(slice, this.config.workDir, {
              baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
            }));
          const architectureReviewReuseKey = buildVerificationReuseKey({
            criterionId: criterion.id,
            criterionType: criterion.type,
            diffHash:
              reviewScopeEntries.length > 0
                ? await captureSliceDiff(reviewScopeEntries, this.config.workDir)
                : verificationDiffHash,
            scopeEntries: reviewScopeEntries,
            metadata: buildArchitectureReviewReuseMetadata(slice, reviewWorkspaceState),
          });
          const reusableCriterion = getReusableVerificationCriterion(
            slice,
            criterion.id,
            architectureReviewReuseKey,
            verificationDiffHash,
          );
          if (reusableCriterion) {
            applyReusableCriterion(criterion, reusableCriterion);
            continue;
          }
          const reviewEvidence = await this.buildSliceReviewEvidence(
            session,
            slice,
            reviewWorkspaceState,
          );
          const architectureReview = await this.runSliceArchitectureReview(
            session,
            slice,
            stage,
            sliceIndex,
            implementationOutput,
            reviewEvidence,
            stageDeadlineAt,
            reviewWorkspaceState,
          );

          const updatedHistory = recordArchReviewVerdict(
            slice.archReviewHistory,
            architectureReview.passed,
            architectureReview.review.findings.length,
            now(),
          );
          await this.sessionManager.updateSlice(session, sliceIndex, {
            review: architectureReview.review,
            archReviewHistory: updatedHistory,
          });

          slice.review = architectureReview.review;
          slice.archReviewHistory = updatedHistory;

          const oscillation = analyzeArchReviewHistory(updatedHistory);
          if (oscillation.flappedToApproved) {
            this.emitProgress({
              type: 'stage-progress',
              timestamp: now(),
              stage: stage.name,
              slice: sliceIndex,
              message: `Architecture review approved after ${oscillation.totalAttempts} attempts (oscillation detected; trusting current approval as authoritative).`,
            });
            await this.journal(session, {
              timestamp: now(),
              type: 'review',
              stage: stage.name,
              message: `Slice ${sliceIndex + 1} review oscillation resolved: approved after ${oscillation.totalAttempts} attempts (${oscillation.totalAttempts - 1} prior blocked verdicts)`,
            });
          } else if (oscillation.isOscillating && !architectureReview.passed) {
            await this.journal(session, {
              timestamp: now(),
              type: 'review',
              stage: stage.name,
              message: `Slice ${sliceIndex + 1} review oscillating: ${oscillation.totalAttempts} attempts with ${oscillation.consecutiveBlocked} consecutive blocked verdicts. Operator escalation recommended.`,
            });
          }

          updateExitCriterion(
            slice,
            criterion.id,
            architectureReview.passed,
            architectureReview.passed
              ? 'Architecture review approved using the precomputed evidence package.'
              : architectureReview.feedback,
          );
          if (architectureReview.passed) {
            cacheReusableVerificationCriterion(slice, verificationDiffHash, {
              criterionId: criterion.id,
              criterionType: criterion.type,
              reuseKey: architectureReviewReuseKey,
              detail: 'Architecture review approved using the precomputed evidence package.',
              review: architectureReview.review,
              capturedAt: now(),
            });
          } else {
            clearReusableVerificationCriterion(slice, criterion.id);
          }
          break;
        }
        case 'no-new-findings': {
          updateExitCriterion(slice, criterion.id, true);
          break;
        }
        case 'custom': {
          if (criterion.command) {
            const customReuseKey = buildVerificationReuseKey({
              criterionId: criterion.id,
              criterionType: criterion.type,
              diffHash: verificationDiffHash,
              command: criterion.command,
              scopeEntries: gateScopeEntries,
            });
            const reusableCriterion = getReusableVerificationCriterion(
              slice,
              criterion.id,
              customReuseKey,
              verificationDiffHash,
            );
            if (reusableCriterion) {
              applyReusableCriterion(criterion, reusableCriterion);
              continue;
            }

            const gate = await runQualityGate(
              {
                name: criterion.description,
                checks: [{ name: criterion.id, type: 'custom-script', command: criterion.command }],
                passThreshold: 1.0,
                failAction: 'loop',
              },
              this.config.workDir,
              session,
              stage.name,
            );
            qualityGateResults[criterion.id] = gate;
            const detail = summarizeQualityGateEvidence(gate);
            updateExitCriterion(slice, criterion.id, gate.passed, detail);
            if (gate.passed) {
              cacheReusableVerificationCriterion(slice, verificationDiffHash, {
                criterionId: criterion.id,
                criterionType: criterion.type,
                reuseKey: customReuseKey,
                detail,
                qualityGate: gate,
                capturedAt: now(),
              });
            } else {
              clearReusableVerificationCriterion(slice, criterion.id);
            }
          } else {
            updateExitCriterion(slice, criterion.id, true);
          }
          break;
        }
      }
    }

    reconcileDeterministicExitCriteria(slice);
    await this.sessionManager.persist(session);
    const failedCriteria = slice.exitCriteria.filter((criterion) => !criterion.passed);
    return {
      allMet: allExitCriteriaMet(slice),
      failedCriteria,
      qualityGateResults,
    };
  }

  private async precomputeParallelVerificationCriteria(params: {
    session: Session;
    slice: Slice;
    stage: StageDefinition;
    sliceIndex: number;
    gateScopeEntries: string[];
    typecheckScopeEntries: string[];
    verificationScopeEntries: string[];
    verificationDiffHash: string;
    typecheckVerificationDiffHash: string;
    stageDeadlineAt?: number;
  }): Promise<{
    reused: Map<string, SliceVerificationCriterionCheckpoint>;
    evaluated: Map<string, ParallelCriterionEvaluation>;
  }> {
    const {
      session,
      slice,
      stage,
      sliceIndex,
      gateScopeEntries,
      typecheckScopeEntries,
      verificationScopeEntries,
      verificationDiffHash,
      typecheckVerificationDiffHash,
      stageDeadlineAt,
    } = params;
    const reused = new Map<string, SliceVerificationCriterionCheckpoint>();
    const evaluated = new Map<string, ParallelCriterionEvaluation>();
    const typecheckCriterion = slice.exitCriteria.find(
      (criterion) => criterion.type === 'typecheck',
    );
    const lintCriterion = slice.exitCriteria.find((criterion) => criterion.type === 'lint');

    if (!typecheckCriterion && !lintCriterion) {
      return { reused, evaluated };
    }

    const lintScopeEntries =
      verificationScopeEntries.length > 0 ? verificationScopeEntries : gateScopeEntries;

    if (typecheckCriterion && !session.verificationBootstrap) {
      const bootstrapTimeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
      await ensureVerificationBootstrap(this.config.workDir, session, {
        scopeEntries: typecheckScopeEntries,
        timeoutMs: bootstrapTimeoutMs,
        emitProgress: (message, details) =>
          this.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: stage.name,
            slice: sliceIndex,
            message,
            details,
          }),
      });
    }

    let typecheckCommand: string | undefined;
    if (typecheckCriterion) {
      typecheckCommand = await buildScopedTypecheckCmd(
        this.config.workDir,
        session,
        typecheckScopeEntries,
      );
      const typecheckReuseKey = buildVerificationReuseKey({
        criterionId: typecheckCriterion.id,
        criterionType: typecheckCriterion.type,
        diffHash: typecheckVerificationDiffHash,
        command: typecheckCommand,
        scopeEntries: typecheckScopeEntries,
      });
      const reusableCriterion = getReusableVerificationCriterion(
        slice,
        typecheckCriterion.id,
        typecheckReuseKey,
        verificationDiffHash,
      );
      if (reusableCriterion) {
        reused.set(typecheckCriterion.id, reusableCriterion);
      }
    }

    let lintCommand: string | undefined;
    if (lintCriterion) {
      lintCommand = await buildScopedLintCmd(this.config.workDir, session, lintScopeEntries);
      const lintReuseKey = buildVerificationReuseKey({
        criterionId: lintCriterion.id,
        criterionType: lintCriterion.type,
        diffHash: verificationDiffHash,
        command: lintCommand,
        scopeEntries: lintScopeEntries,
      });
      const reusableCriterion = getReusableVerificationCriterion(
        slice,
        lintCriterion.id,
        lintReuseKey,
        verificationDiffHash,
      );
      if (reusableCriterion) {
        reused.set(lintCriterion.id, reusableCriterion);
      }
    }

    const tasks: Promise<void>[] = [];

    if (typecheckCriterion && !reused.has(typecheckCriterion.id) && typecheckCommand) {
      tasks.push(
        evaluateTypecheckCriterion(
          this.config.workDir,
          {
            session,
            stage,
            criterion: typecheckCriterion,
            typecheckScopeEntries,
            verificationDiffHash,
            typecheckVerificationDiffHash,
            typecheckCommand,
          },
          (event) => this.emitProgress(event),
        ).then((evaluation) => {
          evaluated.set(typecheckCriterion.id, evaluation);
        }),
      );
    }

    if (lintCriterion && !reused.has(lintCriterion.id) && lintCommand) {
      tasks.push(
        evaluateLintCriterion(this.config.workDir, {
          session,
          stage,
          criterion: lintCriterion,
          scopeEntries: lintScopeEntries,
          verificationDiffHash,
          lintCommand,
        }).then((evaluation) => {
          evaluated.set(lintCriterion.id, evaluation);
        }),
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    return {
      reused,
      evaluated,
    };
  }

  private async maybeRecoverSliceManifestDrift(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    failedCriteria: ExitCriterion[],
  ): Promise<{ recovered: boolean; summary?: string; expandedFiles: string[] }> {
    if (failedCriteria.length !== 1 || failedCriteria[0]?.type !== 'architecture-reviewed') {
      return { recovered: false, expandedFiles: [] };
    }

    const workspaceState = await inspectSliceReviewWorkspaceState(slice, this.config.workDir, {
      baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
    });
    const blockingFiles = partitionDeterministicOutOfScopeWorkspacePaths(
      workspaceState.outOfScopeChanges,
    ).blockingFiles;
    return this.expandSliceManifestForWorkspaceDrift(
      session,
      slice,
      stage,
      sliceIndex,
      blockingFiles,
      'architecture review',
      (file) => isRecoverableManifestDriftPath(file, session.workItem.scope, slice),
    );
  }

  /**
   * Run impact analysis: find files that depend on the slice's modified files.
   */
  private async runImpactAnalysis(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    stageDeadlineAt?: number,
  ): Promise<ImpactAnalysis> {
    const sliceFiles = getSliceFiles(slice);
    const timeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
    if (timeoutMs != null && timeoutMs <= 0) {
      throw new Error(`${stage.name} exceeded its execution deadline`);
    }

    const prompt = `Analyze the impact of changes to these files:
${sliceFiles.map((f) => `- ${f}`).join('\n')}

For each file, find:
1. Files that import from it (dependentFiles)
2. Test files that cover it (affectedTests)

${buildStageOutputInstructions({ id: 'impact-analysis', strict: false })}`;

    const onStream = createStageStreamHandler((event) => this.emitProgress(event), stage.name);

    const result = await this.modelRouter.execute(
      prompt,
      {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 15,
          maxBudgetUsd: 5,
        },
      },
      ['Read', 'Grep', 'Glob'],
      onStream,
      { id: 'impact-analysis', strict: false },
      timeoutMs,
    );
    accumulateProviderCost(session, result);

    if (result.error) {
      throw new Error(result.error);
    }

    return parseImpactAnalysisOutput(result.output, sliceFiles);
  }

  private async runSliceArchitectureReview(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    implementationOutput: string,
    reviewEvidence?: string,
    stageDeadlineAt?: number,
    reviewWorkspaceState?: SliceReviewWorkspaceState,
  ): Promise<{ passed: boolean; feedback: string; review: ReviewResult }> {
    // Architecture review gets its own dedicated budget — it must not be
    // starved by implementation time already consumed within the stage.
    // The stage deadline is intentionally ignored here because the review
    // is a distinct verification step that runs *after* implementation.
    // No hard timeout — stall detection in the executor is the guard.
    const timeoutMs: number | undefined = undefined;
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: 'Architecture review: preparing retained proof packet and workspace scope',
    });

    const unresolvedWorkspaceState =
      reviewWorkspaceState ??
      (await inspectSliceReviewWorkspaceState(slice, this.config.workDir, {
        baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
      }));
    const workspaceState = await this.reconcileSliceReviewWorkspaceState(
      session,
      slice,
      stage,
      sliceIndex,
      unresolvedWorkspaceState,
    );
    const reviewEvidenceSummary =
      reviewEvidence ?? (await this.buildSliceReviewEvidence(session, slice, workspaceState));
    const architectureReviewPacket = await buildSliceArchitectureReviewPacket(
      this.config.workDir,
      session,
      slice,
      workspaceState,
    );
    const efficiencyBudget = estimateArchitectureReviewEfficiencyBudget(slice);
    const evidence = [architectureReviewPacket, '## REVIEW EVIDENCE SUMMARY', reviewEvidenceSummary]
      .filter((section) => section.trim().length > 0)
      .join('\n\n');

    if (workspaceState.outOfScopeChanges.length > 0) {
      const feedback = [
        `Architecture review blocked: ${workspaceState.outOfScopeChanges.length} out-of-scope working tree file(s) are not covered by the current slice proof packet.`,
        `Out-of-scope files: ${workspaceState.outOfScopeChanges.join(', ')}`,
        workspaceState.workspaceReconcileSummary
          ? `Workspace reconcile: ${workspaceState.workspaceReconcileSummary}`
          : null,
        'Reconcile the diff or update the slice scope before this slice can be approved.',
      ]
        .filter(Boolean)
        .join(' ');
      const review = createFailedReview(
        feedback,
        workspaceState.outOfScopeChanges,
        'helix/workspace-guard',
      );
      await this.journal(session, {
        timestamp: now(),
        type: 'review',
        stage: stage.name,
        message: `Slice ${sliceIndex + 1} architecture review blocked by out-of-scope workspace changes`,
      });
      this.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: stage.name,
        slice: sliceIndex,
        message: `Architecture review blocked by ${workspaceState.outOfScopeChanges.length} out-of-scope workspace file(s)`,
      });
      return {
        passed: false,
        feedback,
        review,
      };
    }

    const implementationReviewApproval = tryApproveArchitectureReviewFromImplementationReview(
      slice,
      implementationOutput,
    );
    if (implementationReviewApproval) {
      await this.journal(session, {
        timestamp: now(),
        type: 'review',
        stage: stage.name,
        message: `Slice ${sliceIndex + 1} architecture review approved from the refined implementation review`,
      });
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        slice: sliceIndex,
        message: 'Architecture review: PASSED',
      });
      return implementationReviewApproval;
    }

    const prompt = buildSliceArchitectureReviewPrompt(
      session,
      slice,
      implementationOutput,
      evidence,
      renderPromptContext(stage.type, session.promptContext),
      efficiencyBudget,
    );
    const onStream = createStageStreamHandler(
      (event) => this.emitProgress(event),
      `${stage.name} Architecture Review`,
      sliceIndex,
    );

    const reviewBudget: ExecutorEfficiencyBudget = {
      ...efficiencyBudget,
      disableToolUse: true,
      summary:
        'Architecture review must decide from the retained evidence packet and proof results instead of reopening the workspace.',
    };
    const reviewAssignment = withExecutorEfficiencyBudget(
      resolveArchitectureReviewAssignment(this.config, stage),
      reviewBudget,
    );
    const reviewTools: string[] = [];
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: 'Architecture review: evaluating retained evidence packet',
      details: {
        toolUse: 'disabled',
      },
    });

    let result = await this.modelRouter.execute(
      prompt,
      reviewAssignment,
      reviewTools,
      onStream,
      { id: 'analysis-report', strict: true },
      timeoutMs,
    );
    accumulateProviderCost(session, result);

    if (result.error && shouldRetryArchitectureReviewFromEvidence(result.error)) {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        slice: sliceIndex,
        message:
          'Architecture review exhausted its budget after reading the seam evidence — retrying once in compact evidence-only mode.',
      });

      const recoveryBudget: ExecutorEfficiencyBudget = {
        targetTurns: Math.max(6, Math.min(efficiencyBudget.targetTurns, 10)),
        explorationTurns: 1,
        hardTurnCap: Math.max(
          6,
          Math.min(efficiencyBudget.hardTurnCap ?? efficiencyBudget.targetTurns, 10),
        ),
        shellWarnFloor: 1,
        shellAbortFloor: 1,
        disableToolUse: true,
        summary:
          'Architecture review recovery: emit the blocking verdict from the retained evidence packet without reopening the workspace.',
      };
      const recoveryPrompt = [
        '## TOP PRIORITY RECOVERY MODE',
        'The prior architecture review already inspected the slice seam and exhausted its budget.',
        'Tool use is disabled for this retry. Use the evidence packet, declared file contracts, automated proof results, and implementation output below as the authoritative source of truth.',
        'Do not reopen the workspace or inspect additional files unless the packet is internally contradictory.',
        'Approve when the immediate slice findings, direct file contracts, and required tests are satisfied. Leave broader follow-up out of this blocking review.',
        '',
        prompt,
      ].join('\n');

      const recoveryAssignment = lockModelReviewEngine(
        this.config,
        'claude-code',
        reviewAssignment,
      );
      const applyCompactRecoverySpec = (spec: ModelSpec): ModelSpec => ({
        ...spec,
        maxTurns: Math.min(spec.maxTurns ?? recoveryBudget.targetTurns, recoveryBudget.targetTurns),
        stallThresholdMs: Math.min(spec.stallThresholdMs ?? 45_000, 45_000),
        efficiencyBudget: recoveryBudget,
      });

      result = await this.modelRouter.execute(
        recoveryPrompt,
        {
          primary: applyCompactRecoverySpec(recoveryAssignment.primary),
          fallback: recoveryAssignment.fallback
            ? applyCompactRecoverySpec(recoveryAssignment.fallback)
            : undefined,
          layered: recoveryAssignment.layered?.map(applyCompactRecoverySpec),
        },
        reviewTools,
        onStream,
        { id: 'analysis-report', strict: true },
        timeoutMs,
      );
      accumulateProviderCost(session, result);
    }

    if (result.error) {
      const review = createFailedReview(
        `Architecture review could not complete: ${result.error}`,
        getSliceFiles(slice),
      );
      await this.journal(session, {
        timestamp: now(),
        type: 'review',
        stage: stage.name,
        message: `Slice ${sliceIndex + 1} architecture review failed to run`,
      });
      return {
        passed: false,
        feedback: `Architecture review failed: ${result.error}`,
        review,
      };
    }

    const parsed = parseStructuredStageOutputResult(result.output, 'analysis-report');
    if (!parsed.data) {
      const feedback =
        parsed.error.message ||
        'Architecture review returned invalid output. The reviewer must return analysis-report JSON.';
      const review = createFailedReview(
        feedback,
        getSliceFiles(slice),
        `${result.engine}/${result.model}`,
      );
      await this.journal(session, {
        timestamp: now(),
        type: 'review',
        stage: stage.name,
        message: `Slice ${sliceIndex + 1} architecture review returned invalid output`,
      });
      return {
        passed: false,
        feedback,
        review,
      };
    }

    const unresolvedDecisions = parsed.data.decisions.filter(
      (decision) => decision.classification === 'AMBIGUOUS',
    );
    const blockingFindings = parsed.data.findings.filter((finding) =>
      architectureFindingBlocksApproval(finding.severity),
    );
    const review: ReviewResult = {
      approved: blockingFindings.length === 0 && unresolvedDecisions.length === 0,
      reviewer: `${result.engine}/${result.model}`,
      findings: parsed.data.findings.map((finding) => materializeReviewFinding(finding)),
      timestamp: now(),
    };

    const feedback = formatArchitectureReviewFeedback(parsed.data, unresolvedDecisions);
    await this.journal(session, {
      timestamp: now(),
      type: 'review',
      stage: stage.name,
      message: `Slice ${sliceIndex + 1} architecture review ${review.approved ? 'approved' : 'blocked'} (${review.findings.length} findings)`,
    });

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: `Architecture review: ${review.approved ? 'PASSED' : 'FAILED'}`,
    });

    return {
      passed: review.approved,
      feedback,
      review,
    };
  }

  private async buildSliceReviewEvidence(
    session: Session,
    slice: Slice,
    workspaceState?: SliceReviewWorkspaceState,
  ): Promise<string> {
    const resolvedWorkspaceState =
      workspaceState ??
      (await inspectSliceReviewWorkspaceState(slice, this.config.workDir, {
        baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
      }));
    const sliceFiles = getSliceFiles(slice);
    const typecheck = describeExitCriterion(slice, 'typecheck');
    const lint = describeExitCriterion(slice, 'lint');
    const testLock = describeExitCriterion(slice, 'test-lock');
    const impact = describeExitCriterion(slice, 'impact-reviewed');
    const exportsWired = describeExitCriterion(slice, 'exports-wired');
    const dependentConsumers = dedupeStrings([
      ...slice.impactAnalysis.dependentFiles,
      ...slice.manifest.exportContracts.flatMap((contract) => contract.consumers),
    ]);
    const affectedTests = dedupeStrings([
      ...slice.impactAnalysis.affectedTests,
      ...slice.testLock.regressionSuite,
      ...slice.testLock.requiredTests.map((test) => test.testFile),
    ]);

    return [
      'Use this packet as the default evidence base. Re-read the workspace only if something here looks incomplete or inconsistent.',
      '',
      '### Automated Checks',
      `- Typecheck: ${typecheck}`,
      `- Lint: ${lint}`,
      `- Test lock: ${testLock}`,
      `- Export wiring: ${exportsWired}`,
      `- Impact analysis: ${impact}`,
      '',
      '### Workspace Reconcile',
      resolvedWorkspaceState.workspaceReconcileSummary ?? '- (not needed)',
      '',
      '### Actual Changed Files',
      resolvedWorkspaceState.actualChangedFiles.length > 0
        ? resolvedWorkspaceState.actualChangedFiles.map((file) => `- ${file}`).join('\n')
        : '- (no workspace changes detected)',
      '',
      '### Ignored Workspace Noise',
      resolvedWorkspaceState.ignoredOutOfScopeChanges.length > 0
        ? resolvedWorkspaceState.ignoredOutOfScopeChanges.map((file) => `- ${file}`).join('\n')
        : '- (none)',
      '',
      '### Out-of-Scope Working Tree Changes',
      resolvedWorkspaceState.outOfScopeChanges.length > 0
        ? resolvedWorkspaceState.outOfScopeChanges.map((file) => `- ${file}`).join('\n')
        : '- (none)',
      '',
      '### Changed Diff Stat',
      resolvedWorkspaceState.diffStat
        ? resolvedWorkspaceState.diffStat
        : '- (diff stat unavailable)',
      '',
      '### Dependent Consumers',
      dependentConsumers.length > 0
        ? dependentConsumers.map((file) => `- ${file}`).join('\n')
        : '- (none identified)',
      '',
      '### Affected Tests',
      affectedTests.length > 0
        ? affectedTests.map((file) => `- ${file}`).join('\n')
        : '- (none identified)',
      '',
      '### Export Contracts',
      summarizeExportContracts(slice),
      '',
      '### Review Scope',
      resolvedWorkspaceState.reviewScopeEntries.length > 0
        ? resolvedWorkspaceState.reviewScopeEntries.map((file) => `- ${file}`).join('\n')
        : '- (none declared)',
      '',
      '### Declared Slice Files',
      sliceFiles.length > 0
        ? sliceFiles.map((file) => `- ${file}`).join('\n')
        : '- (none declared)',
      '',
      `### Work Item Scope\n- ${session.workItem.scope.join('\n- ')}`,
    ].join('\n');
  }

  private async reconcileSliceReviewWorkspaceState(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    workspaceState: SliceReviewWorkspaceState,
  ): Promise<SliceReviewWorkspaceState> {
    if (workspaceState.outOfScopeChanges.length === 0) {
      return workspaceState;
    }

    const deterministicClassification = partitionDeterministicOutOfScopeWorkspacePaths(
      workspaceState.outOfScopeChanges,
    );
    const deterministicIgnoredSet = new Set(deterministicClassification.ignoredFiles);
    const deterministicSummary =
      deterministicClassification.ignoredFiles.length > 0
        ? `Ignored ${deterministicClassification.ignoredFiles.length} deterministic tool-owned out-of-scope file(s)`
        : undefined;

    if (deterministicClassification.ignoredFiles.length > 0) {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        slice: sliceIndex,
        message: `Workspace reconcile ignored ${deterministicClassification.ignoredFiles.length} deterministic out-of-scope file(s): ${deterministicClassification.ignoredFiles
          .slice(0, 5)
          .join(', ')}`,
      });
    }

    const seededActualChangedFiles = workspaceState.actualChangedFiles.filter(
      (file) => !deterministicIgnoredSet.has(file),
    );
    if (deterministicClassification.blockingFiles.length === 0) {
      return {
        ...workspaceState,
        actualChangedFiles: seededActualChangedFiles,
        outOfScopeChanges: [],
        ignoredOutOfScopeChanges: dedupeStrings([
          ...workspaceState.ignoredOutOfScopeChanges,
          ...deterministicClassification.ignoredFiles,
        ]),
        diffStat: await captureSliceDiffStat(
          seededActualChangedFiles.length > 0 ? seededActualChangedFiles : getSliceFiles(slice),
          this.config.workDir,
        ),
        workspaceReconcileSummary: deterministicSummary,
      };
    }

    const assessment = await this.assessOutOfScopeWorkspaceChanges(
      session,
      slice,
      stage.name,
      sliceIndex,
      workspaceState.reviewScopeEntries,
      seededActualChangedFiles,
      deterministicClassification.blockingFiles,
      resolveWorkspaceReconcileAssignment(this.config, stage, {
        blockingFileCount: deterministicClassification.blockingFiles.length,
        sliceFileCount: slice.manifest.fileContracts.length,
      }),
    );

    const assessedExpansion = await this.expandSliceManifestForWorkspaceDrift(
      session,
      slice,
      stage,
      sliceIndex,
      assessment.blockingFiles,
      'workspace reconcile',
      (file) => isAutoExpandableWorkspaceDriftPath(file, session.workItem.scope, slice),
    );
    if (assessedExpansion.recovered) {
      const reviewScopeEntries = dedupeStrings(getSliceReviewScopeEntries(slice));
      const reviewScope = new Set(reviewScopeEntries);
      const actualChangedFiles = seededActualChangedFiles;
      const outOfScopeChanges = actualChangedFiles.filter((file) => !reviewScope.has(file));
      const diffStat = await captureSliceDiffStat(
        actualChangedFiles.length > 0 ? actualChangedFiles : getSliceFiles(slice),
        this.config.workDir,
      );

      return {
        ...workspaceState,
        reviewScopeEntries,
        actualChangedFiles,
        outOfScopeChanges,
        ignoredOutOfScopeChanges: dedupeStrings([
          ...workspaceState.ignoredOutOfScopeChanges,
          ...deterministicClassification.ignoredFiles,
        ]),
        diffStat,
        workspaceReconcileSummary: [
          deterministicSummary,
          assessment.summary,
          assessedExpansion.summary,
        ]
          .filter(Boolean)
          .join('; '),
      };
    }

    const ignoredFiles = dedupeStrings([
      ...deterministicClassification.ignoredFiles,
      ...assessment.ignoredFiles,
    ]);
    const ignoredSet = new Set(ignoredFiles);
    const actualChangedFiles = workspaceState.actualChangedFiles.filter(
      (file) => !ignoredSet.has(file),
    );
    const diffStat = await captureSliceDiffStat(
      actualChangedFiles.length > 0 ? actualChangedFiles : getSliceFiles(slice),
      this.config.workDir,
    );

    return {
      ...workspaceState,
      actualChangedFiles,
      outOfScopeChanges: assessment.blockingFiles,
      ignoredOutOfScopeChanges: dedupeStrings([
        ...workspaceState.ignoredOutOfScopeChanges,
        ...ignoredFiles,
      ]),
      diffStat,
      workspaceReconcileSummary: [deterministicSummary, assessment.summary]
        .filter(Boolean)
        .join('; '),
    };
  }

  private async expandSliceManifestForWorkspaceDrift(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    candidateFiles: string[],
    recoverySource: string,
    isEligible: (file: string) => boolean,
  ): Promise<{ recovered: boolean; summary?: string; expandedFiles: string[] }> {
    if (candidateFiles.length === 0) {
      return { recovered: false, expandedFiles: [] };
    }

    const eligibleFiles = candidateFiles.filter(isEligible);
    if (eligibleFiles.length !== candidateFiles.length) {
      return { recovered: false, expandedFiles: [] };
    }

    const existingDirectFiles = new Set(
      getSliceFiles(slice).map((file) => normalizeRepoPath(file)),
    );
    const expandedFiles = eligibleFiles
      .map((file) => normalizeRepoPath(file))
      .filter((file): file is string => Boolean(file))
      .filter((file) => !existingDirectFiles.has(file));

    if (expandedFiles.length === 0) {
      return { recovered: false, expandedFiles: [] };
    }

    const expandedRequiredTests = [
      ...slice.testLock.requiredTests,
      ...expandedFiles
        .filter((file) => isTestFile(file))
        .filter(
          (file) =>
            !slice.testLock.requiredTests.some(
              (requirement) => normalizeRepoPath(requirement.testFile) === file,
            ),
        )
        .map((file) => ({
          testFile: file,
          description: 'Detected as required regression coverage from implementation drift',
          status: 'pending' as const,
          coversFindings: [...slice.findings],
          isNew: false,
        })),
    ];

    const expandedSlice: Slice = {
      ...slice,
      manifest: {
        ...slice.manifest,
        fileContracts: [
          ...slice.manifest.fileContracts,
          ...expandedFiles.map((file) => ({
            path: file,
            action: 'modify' as const,
            reason: `Detected as substantive package-local implementation drift during ${recoverySource}`,
          })),
        ],
      },
      testLock: {
        ...slice.testLock,
        requiredTests: expandedRequiredTests,
      },
      impactAnalysis: {
        ...slice.impactAnalysis,
        directFiles: dedupeStrings([...slice.impactAnalysis.directFiles, ...expandedFiles]),
      },
      verificationCheckpoint: undefined,
      proofPacket: undefined,
    };

    const compiled = await compileSliceArtifacts(expandedSlice, session, this.config.workDir);
    await this.sessionManager.updateSlice(session, sliceIndex, {
      manifest: compiled.manifest,
      testLock: compiled.testLock,
      impactAnalysis: compiled.impactAnalysis,
      exitCriteria: compiled.exitCriteria,
      review: undefined,
      verificationCheckpoint: undefined,
      proofPacket: undefined,
    });

    const summary = `Recovered manifest drift by expanding slice ${sliceIndex + 1} to ${expandedFiles.length} additional changed file(s) during ${recoverySource}: ${expandedFiles.join(', ')}`;
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: summary,
    });
    await this.journal(session, {
      timestamp: now(),
      type: 'review',
      stage: stage.name,
      message: summary,
    });

    return {
      recovered: true,
      summary,
      expandedFiles,
    };
  }

  private async assessOutOfScopeWorkspaceChanges(
    session: Session,
    slice: Slice,
    stageName: string,
    sliceIndex: number,
    reviewScopeEntries: string[],
    actualChangedFiles: string[],
    outOfScopeChanges: string[],
    modelAssignment: ModelAssignment,
  ): Promise<WorkspaceReconcileDecision> {
    if (outOfScopeChanges.length === 0) {
      return {
        summary: 'No out-of-scope files required review.',
        ignoredFiles: [],
        blockingFiles: [],
      };
    }

    const prompt = buildWorkspaceReconcilePrompt({
      session,
      slice,
      stageName,
      reviewScopeEntries,
      actualChangedFiles,
      outOfScopeChanges,
    });
    const onStream = createStageStreamHandler(
      (event) => this.emitProgress(event),
      `${stageName} Workspace Reconcile`,
      sliceIndex,
    );
    const timeoutMs = 60_000;

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stageName,
      slice: sliceIndex,
      message: `Workspace reconcile: classifying ${outOfScopeChanges.length} out-of-scope file(s)`,
    });

    const result = await this.modelRouter.execute(
      prompt,
      modelAssignment,
      ['Read', 'Grep', 'Glob', 'Bash'],
      onStream,
      { id: 'workspace-reconcile', strict: true },
      timeoutMs,
    );
    accumulateProviderCost(session, result);

    if (result.error) {
      const summary = `workspace reconcile failed (${result.error}); defaulted to blocking all out-of-scope files`;
      this.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: stageName,
        slice: sliceIndex,
        message: `Workspace reconcile failed; blocking ${outOfScopeChanges.length} out-of-scope file(s)`,
      });
      return {
        summary,
        ignoredFiles: [],
        blockingFiles: outOfScopeChanges,
      };
    }

    const parsed = parseStructuredStageOutputResult(result.output, 'workspace-reconcile');
    if (!parsed.data) {
      const summary = `${
        parsed.error?.message ?? 'workspace reconcile returned invalid output'
      }; defaulted to blocking all out-of-scope files`;
      this.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: stageName,
        slice: sliceIndex,
        message: `Workspace reconcile returned invalid output; blocking ${outOfScopeChanges.length} out-of-scope file(s)`,
      });
      return {
        summary,
        ignoredFiles: [],
        blockingFiles: outOfScopeChanges,
      };
    }

    const ignoredFiles: string[] = [];
    const blockingFiles: string[] = [];
    const unassessedFiles: string[] = [];

    for (const file of outOfScopeChanges) {
      const matchingAssessments = parsed.data.assessments.filter((assessment) =>
        workspaceAssessmentMatchesTarget(file, assessment.file),
      );
      if (matchingAssessments.length === 0) {
        unassessedFiles.push(file);
        blockingFiles.push(file);
        continue;
      }

      if (matchingAssessments.some((assessment) => assessment.disposition === 'block')) {
        blockingFiles.push(file);
      } else {
        ignoredFiles.push(file);
      }
    }

    const summaryParts = [parsed.data.summary];
    if (ignoredFiles.length > 0) {
      summaryParts.push(`ignored ${ignoredFiles.length} file(s)`);
    }
    if (blockingFiles.length > 0) {
      summaryParts.push(`${blockingFiles.length} file(s) still block`);
    }
    if (unassessedFiles.length > 0) {
      summaryParts.push(`default-blocked ${unassessedFiles.length} unassessed file(s)`);
    }
    const summary = summaryParts.join('; ');

    if (ignoredFiles.length > 0) {
      this.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stageName,
        slice: sliceIndex,
        message: `Workspace reconcile ignored ${ignoredFiles.length} out-of-scope file(s): ${ignoredFiles.slice(0, 5).join(', ')}`,
      });
    }

    return {
      summary,
      ignoredFiles,
      blockingFiles,
    };
  }

  private async reconcileCommitOutOfScopeChanges(request: {
    session: Session;
    slice: Slice;
    sliceIndex: number;
    stageName: string;
    modelAssignment: ModelAssignment;
    reviewScopeEntries: string[];
    actualChangedFiles: string[];
    outOfScopeChanges: string[];
  }): Promise<WorkspaceReconcileDecision> {
    const syntheticStage: StageDefinition = {
      name: request.stageName,
      type: 'implementation',
      description: 'Commit retry reconcile',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'claude-sonnet-4-6',
        },
      },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const currentSlice = request.session.slices[request.sliceIndex] ?? request.slice;
    const expansion = await this.expandSliceManifestForWorkspaceDrift(
      request.session,
      currentSlice,
      syntheticStage,
      request.sliceIndex,
      request.outOfScopeChanges,
      'commit retry',
      (file) =>
        isAutoExpandableWorkspaceDriftPath(file, request.session.workItem.scope, currentSlice),
    );

    const expandedSet = new Set(expansion.expandedFiles.map((file) => normalizeRepoPath(file)));
    const remainingOutOfScopeChanges = request.outOfScopeChanges.filter((file) => {
      const normalized = normalizeRepoPath(file);
      return !normalized || !expandedSet.has(normalized);
    });

    if (remainingOutOfScopeChanges.length === 0) {
      return {
        summary: expansion.summary ?? 'Recovered commit-time slice drift before staging.',
        ignoredFiles: [],
        blockingFiles: [],
      };
    }

    const refreshedSlice = request.session.slices[request.sliceIndex] ?? currentSlice;
    return this.assessOutOfScopeWorkspaceChanges(
      request.session,
      refreshedSlice,
      request.stageName,
      request.sliceIndex,
      getSliceReviewScopeEntries(refreshedSlice),
      request.actualChangedFiles,
      remainingOutOfScopeChanges,
      request.modelAssignment,
    );
  }

  private async recoverModelManagedCommit(
    session: Session,
    slice: Slice,
    sliceIndex: number,
    stageName: string,
    baselineHeadSha: string | undefined,
  ): Promise<CommitRecord | null> {
    if (!baselineHeadSha) {
      return null;
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const { stdout: currentHeadOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: this.config.workDir,
      });
      const currentHeadSha = currentHeadOut.trim();
      if (!currentHeadSha) {
        return null;
      }

      const changedWorkspaceFiles = await listChangedWorkspacePaths(this.config.workDir);
      if (changedWorkspaceFiles.length > 0) {
        const baselineDirtySet = new Set(session.verificationBootstrap?.dirtyWorkspaceFiles ?? []);
        const effectiveChangedFiles = changedWorkspaceFiles.filter(
          (file) => !baselineDirtySet.has(file),
        );
        const deterministicClassification =
          partitionDeterministicOutOfScopeWorkspacePaths(effectiveChangedFiles);
        if (deterministicClassification.blockingFiles.length > 0) {
          return null;
        }
      }

      // ABLP-791: When HEAD didn't move during this slice's run (because the
      // work was already committed in an earlier session run that failed to
      // attribute the commit to the slice), scan recent history for an
      // unattributed commit that matches the slice's review scope. This
      // recovers from the orphan-slice "stuck locked" pattern without
      // requiring manual session.json surgery.
      if (currentHeadSha === baselineHeadSha) {
        return await this.recoverOrphanCommitFromHistory(
          session,
          slice,
          sliceIndex,
          stageName,
          execFileAsync,
        );
      }

      const { stdout: commitRangeOut } = await execFileAsync(
        'git',
        ['rev-list', '--reverse', `${baselineHeadSha}..${currentHeadSha}`],
        {
          cwd: this.config.workDir,
        },
      );
      const candidateShas = commitRangeOut
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidateShas.length === 0) {
        return null;
      }

      const reviewScopeEntries = new Set(getSliceReviewScopeEntries(slice));
      for (let i = candidateShas.length - 1; i >= 0; i -= 1) {
        const candidateSha = candidateShas[i]!;
        const { stdout: commitFilesOut } = await execFileAsync(
          'git',
          ['diff-tree', '--no-commit-id', '--name-only', '-r', candidateSha],
          {
            cwd: this.config.workDir,
          },
        );
        const commitFiles = dedupeStrings(
          commitFilesOut
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        );
        if (commitFiles.length === 0) {
          continue;
        }

        const deterministicClassification =
          partitionDeterministicOutOfScopeWorkspacePaths(commitFiles);
        const blockingCommitFiles = deterministicClassification.blockingFiles.filter(
          (file) => !reviewScopeEntries.has(file),
        );
        if (blockingCommitFiles.length > 0) {
          continue;
        }

        const { stdout: subjectOut } = await execFileAsync(
          'git',
          ['log', '-1', '--pretty=%s', candidateSha],
          {
            cwd: this.config.workDir,
          },
        );
        const { stdout: committedAtOut } = await execFileAsync(
          'git',
          ['log', '-1', '--format=%cI', candidateSha],
          {
            cwd: this.config.workDir,
          },
        );
        const subject = subjectOut.trim();
        const committedAt = committedAtOut.trim() || now();
        const jiraKey =
          subject.match(/\[([A-Z][A-Z0-9]+-\d+)\]/)?.[1] || session.workItem.jiraKey || 'UNKNOWN';

        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stageName,
          slice: sliceIndex,
          message: `Recovered model-managed commit ${candidateSha.slice(0, 7)} after deterministic proof and a clean workspace closeout`,
        });

        return {
          sha: candidateSha,
          message: subject,
          jiraKey,
          sliceIndex,
          files: dedupeStrings([
            ...deterministicClassification.ignoredFiles,
            ...deterministicClassification.blockingFiles,
          ]),
          timestamp: committedAt,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * ABLP-791: Find an existing commit that represents this slice's work but
   * was never attributed (slice.commit stayed null after a prior failed run).
   *
   * Scans the most recent commits looking for one that:
   *   1. Touches only files within the slice's review scope (or deterministic
   *      tool-owned ignored paths)
   *   2. Is not already claimed by another slice in this session
   *   3. Has a JIRA key matching the session's work item (when available)
   *
   * Picks the most recent matching commit and returns it as the slice's
   * representative commit. Conservative — if no clean match exists, returns
   * null so the operator still gets a clear "commit failed" surface.
   */
  private async recoverOrphanCommitFromHistory(
    session: Session,
    slice: Slice,
    sliceIndex: number,
    stageName: string,
    execFileAsync: (
      file: string,
      args: ReadonlyArray<string>,
      options: { cwd: string },
    ) => Promise<{ stdout: string; stderr: string }>,
  ): Promise<CommitRecord | null> {
    const HISTORY_DEPTH = 30;
    const reviewScopeEntries = new Set(getSliceReviewScopeEntries(slice));
    if (reviewScopeEntries.size === 0) {
      return null;
    }

    // Collect SHAs already attributed to other slices in this session.
    const claimedShas = new Set<string>();
    for (const otherSlice of session.slices) {
      if (otherSlice.index === sliceIndex) continue;
      if (otherSlice.commit?.sha) {
        claimedShas.add(otherSlice.commit.sha);
      }
    }
    for (const commit of session.commits) {
      if (commit.sliceIndex !== sliceIndex && commit.sha) {
        claimedShas.add(commit.sha);
      }
    }

    try {
      const { stdout: shaListOut } = await execFileAsync(
        'git',
        ['rev-list', `--max-count=${HISTORY_DEPTH}`, 'HEAD'],
        { cwd: this.config.workDir },
      );
      const shas = shaListOut
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const candidateSha of shas) {
        if (claimedShas.has(candidateSha)) {
          continue;
        }

        const { stdout: filesOut } = await execFileAsync(
          'git',
          ['diff-tree', '--no-commit-id', '--name-only', '-r', candidateSha],
          { cwd: this.config.workDir },
        );
        const candidateFiles = dedupeStrings(
          filesOut
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        );
        if (candidateFiles.length === 0) {
          continue;
        }

        const partition = partitionDeterministicOutOfScopeWorkspacePaths(candidateFiles);
        const blockingFiles = partition.blockingFiles.filter(
          (file) => !reviewScopeEntries.has(file),
        );
        if (blockingFiles.length > 0) {
          continue;
        }
        // Require at least one in-scope file (don't claim commits that only
        // touch tool-owned paths — those aren't this slice's work).
        const inScopeFiles = partition.blockingFiles.filter((file) => reviewScopeEntries.has(file));
        if (inScopeFiles.length === 0) {
          continue;
        }

        const { stdout: subjectOut } = await execFileAsync(
          'git',
          ['log', '-1', '--format=%s', candidateSha],
          { cwd: this.config.workDir },
        );
        const subject = subjectOut.trim();

        // If the session has a real JIRA key, require the commit to reference it.
        const sessionJiraKey = session.workItem.jiraKey;
        const subjectKey = subject.match(/\[([A-Z][A-Z0-9]+-\d+)\]/)?.[1];
        if (sessionJiraKey && subjectKey && sessionJiraKey !== subjectKey) {
          continue;
        }

        const { stdout: committedAtOut } = await execFileAsync(
          'git',
          ['log', '-1', '--format=%cI', candidateSha],
          { cwd: this.config.workDir },
        );
        const committedAt = committedAtOut.trim() || now();
        const jiraKey = subjectKey || sessionJiraKey || 'UNKNOWN';

        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stageName,
          slice: sliceIndex,
          message: `Recovered orphan commit ${candidateSha.slice(0, 7)} from history — slice work was committed in a prior run but never attributed`,
        });

        return {
          sha: candidateSha,
          message: subject,
          jiraKey,
          sliceIndex,
          files: dedupeStrings([...partition.ignoredFiles, ...partition.blockingFiles]),
          timestamp: committedAt,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private async maybeRecoverExternallyCommittedSliceFromCleanWorkspace(
    session: Session,
    slice: Slice,
    stage: StageDefinition,
    sliceIndex: number,
    currentDiffHash: string,
  ): Promise<CommitRecord | null> {
    if (slice.commit || currentDiffHash || slice.status === 'pending') {
      return null;
    }

    const hasPriorProof =
      slice.testLock.locked ||
      Boolean(slice.implementationCheckpoint) ||
      slice.testLock.requiredTests.some((requirement) => requirement.status === 'passing') ||
      slice.exitCriteria.some((criterion) => criterion.passed);
    if (!hasPriorProof) {
      return null;
    }

    const recoveredCommit = await this.recoverModelManagedCommit(
      session,
      slice,
      sliceIndex,
      stage.name,
      this.resolveCommitRecoveryBaselineSha(session, sliceIndex),
    );
    if (!recoveredCommit) {
      return null;
    }

    const unresolvedWorkspaceState = await inspectSliceReviewWorkspaceState(
      slice,
      this.config.workDir,
      {
        baselineDirtyFiles: session.verificationBootstrap?.dirtyWorkspaceFiles,
      },
    );
    const workspaceState = await this.reconcileSliceReviewWorkspaceState(
      session,
      slice,
      stage,
      sliceIndex,
      unresolvedWorkspaceState,
    );
    const workspaceCriterion = slice.exitCriteria.find(
      (criterion) => criterion.type === 'workspace-scope-clean',
    );
    if (workspaceCriterion) {
      const workspacePassed = workspaceState.outOfScopeChanges.length === 0;
      const workspaceSummary =
        workspaceState.workspaceReconcileSummary ??
        'Workspace reconcile produced no out-of-scope changes.';
      const workspaceDetail = workspacePassed
        ? workspaceSummary
        : [
            `${workspaceState.outOfScopeChanges.length} out-of-scope working tree file(s) remain after reconcile.`,
            `Out-of-scope files: ${workspaceState.outOfScopeChanges.slice(0, 10).join(', ')}`,
            workspaceState.workspaceReconcileSummary
              ? `Workspace reconcile: ${workspaceState.workspaceReconcileSummary}`
              : null,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join(' ');
      updateExitCriterion(slice, workspaceCriterion.id, workspacePassed, workspaceDetail);
    }

    if (workspaceState.outOfScopeChanges.length > 0) {
      await this.sessionManager.persist(session);
      return null;
    }

    reconcileDeterministicExitCriteria(slice);

    const architectureCriterion = slice.exitCriteria.find(
      (criterion) => criterion.type === 'architecture-reviewed',
    );
    if (architectureCriterion && !architectureCriterion.passed) {
      const architectureDetail = (architectureCriterion.detail ?? '').toLowerCase();
      const blockedOnlyByWorkspace =
        architectureDetail.includes('out-of-scope') ||
        architectureDetail.includes('workspace reconcile');
      if (!blockedOnlyByWorkspace) {
        await this.sessionManager.persist(session);
        return null;
      }

      const recoveredReview: ReviewResult = {
        approved: true,
        reviewer: 'helix/external-commit-recovery',
        findings: [],
        timestamp: now(),
      };
      slice.review = recoveredReview;
      updateExitCriterion(
        slice,
        architectureCriterion.id,
        true,
        'Architecture review recovered from an externally satisfied commit checkpoint after workspace reconcile cleared the prior out-of-scope drift.',
      );
    }

    const requiredCriteriaSatisfied = [
      'typecheck',
      'lint',
      'test-lock',
      'impact-reviewed',
      'exports-wired',
    ]
      .map((criterionType) =>
        slice.exitCriteria.find((criterion) => criterion.type === criterionType),
      )
      .every((criterion) => criterion?.passed === true);
    if (
      !requiredCriteriaSatisfied ||
      !allExitCriteriaMet(slice) ||
      !canEngageTestLock(slice.testLock)
    ) {
      await this.sessionManager.persist(session);
      return null;
    }

    slice.testLock.locked = true;
    slice.testLock.lockedAt ??= now();

    await this.sessionManager.addCommit(session, recoveredCommit);
    await this.sessionManager.updateSlice(session, sliceIndex, {
      status: 'committed',
      commit: recoveredCommit,
      testLock: slice.testLock,
      implementationCheckpoint: undefined,
      review: slice.review,
    });

    for (const findingId of slice.findings) {
      const finding = session.findings.find((candidate) => candidate.id === findingId);
      if (finding) {
        finding.status = 'fixed';
        finding.fixedInCommit = recoveredCommit.sha;
        finding.updatedAt = now();
      }
    }

    const thisSliceTests = slice.testLock.requiredTests.map((requirement) => requirement.testFile);
    for (let nextIndex = sliceIndex + 1; nextIndex < session.slices.length; nextIndex += 1) {
      const nextSlice = session.slices[nextIndex];
      for (const testFile of thisSliceTests) {
        if (!nextSlice.testLock.regressionSuite.includes(testFile)) {
          nextSlice.testLock.regressionSuite.push(testFile);
        }
      }
    }

    await this.sessionManager.persist(session);

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: `Recovered externally satisfied slice ${sliceIndex + 1} from clean workspace proof without rerunning implementation`,
    });
    this.emitProgress({
      type: 'commit',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: `${recoveredCommit.sha.slice(0, 7)} ${recoveredCommit.message}`,
    });
    this.emitProgress({
      type: 'slice-complete',
      timestamp: now(),
      stage: stage.name,
      slice: sliceIndex,
      message: `${slice.title} — ${summarizeExitCriteria(slice)}, lock: ${summarizeTestLock(slice.testLock)}`,
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'slice-complete',
      stage: stage.name,
      message: `Slice ${sliceIndex + 1} recovered from external commit: ${slice.title}`,
    });

    return recoveredCommit;
  }

  private resolveCommitRecoveryBaselineSha(
    session: Session,
    sliceIndex: number,
  ): string | undefined {
    for (let i = session.commits.length - 1; i >= 0; i -= 1) {
      const commit = session.commits[i];
      if (commit.sliceIndex < sliceIndex) {
        return commit.sha;
      }
    }

    return session.workspaceBaseline?.headSha;
  }

  private async maybePromoteTimedOutStageResult(
    session: Session,
    stage: StageDefinition,
    activeStageState: Session['state'],
    output: string,
    findings: Finding[],
    decisions: Decision[],
    startTime: number,
    iterations: number,
    options: {
      costUsd?: number;
      qualityGate?: QualityGateResult;
      timeoutEvents?: TimeoutEvent[];
      reproductionOutput?: ReturnType<typeof parseReproductionOutput>;
      reproductionArtifactVerified?: boolean;
      scopedTestTargets?: string[];
      scopedTestSnapshots?: Map<string, WorkspaceFileSnapshot>;
    } = {},
  ): Promise<StageResult | undefined> {
    if (stage.type === 'deep-scan') {
      if (!canPromoteTimedOutDeepScan(stage, output, findings, decisions)) {
        return undefined;
      }

      if (findings.length === 0 && decisions.length === 0 && output.trim().length > 0) {
        const parsed = parseAnalysisOutput(output, stage.name);
        await this.recordUniqueStageArtifacts(
          session,
          stage,
          activeStageState,
          findings,
          decisions,
          parsed,
        );
      }
    } else if (stage.type === 'reproduce') {
      const reproductionOutput =
        options.reproductionOutput ?? parseReproductionOutput(output, stage.name);
      if (!canPromoteTimedOutReproduction(stage, reproductionOutput)) {
        return undefined;
      }

      if (!options.reproductionArtifactVerified) {
        const artifactCheck = await enforceReproductionArtifact(
          this.config.workDir,
          session,
          stage,
          output,
          reproductionOutput,
          options.scopedTestTargets ?? [],
          options.scopedTestSnapshots ?? new Map<string, WorkspaceFileSnapshot>(),
          this.stageSideEffects,
        );
        if (!artifactCheck.ok) {
          return undefined;
        }
      }

      if (findings.length === 0 && decisions.length === 0) {
        await this.recordUniqueStageArtifacts(
          session,
          stage,
          activeStageState,
          findings,
          decisions,
          reproductionOutput,
        );
      }
    } else {
      return undefined;
    }

    const findingsCount = findings.length;
    const decisionsCount = decisions.length;
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Promoting ${stage.name} output captured before timeout (${findingsCount} findings, ${decisionsCount} decisions)`,
      details: {
        promoted: true,
        findings: findingsCount,
        decisions: decisionsCount,
      },
    });

    await this.journal(session, {
      timestamp: now(),
      type: 'progress',
      stage: stage.name,
      message: `Promoted ${stage.name} output captured before timeout (${findingsCount} findings, ${decisionsCount} decisions)`,
    });

    return makeResult(
      stage,
      'passed',
      output,
      findings,
      decisions,
      startTime,
      iterations,
      undefined,
      options.costUsd,
      {
        qualityGate: options.qualityGate,
        timeoutEvents: options.timeoutEvents,
      },
    );
  }

  private async recordUniqueStageArtifacts(
    session: Session,
    stage: StageDefinition,
    activeStageState: Session['state'],
    stageFindings: Finding[],
    stageDecisions: Decision[],
    parsed: { findings: Finding[]; decisions: Decision[] },
  ): Promise<{
    duplicateFindings: number;
    duplicateDecisions: number;
  }> {
    const normalizedParsed = normalizeReplayParsedArtifacts(session, stage, parsed);
    const knownFindingFingerprints = new Set(
      [...session.findings, ...stageFindings].map((finding) => buildFindingFingerprint(finding)),
    );
    const knownDecisionFingerprints = new Set(
      [...session.decisions, ...stageDecisions].map((decision) =>
        buildDecisionFingerprint(decision),
      ),
    );

    let duplicateFindings = 0;
    for (const finding of normalizedParsed.findings) {
      const fingerprint = buildFindingFingerprint(finding);
      if (knownFindingFingerprints.has(fingerprint)) {
        duplicateFindings += 1;
        continue;
      }

      knownFindingFingerprints.add(fingerprint);
      stageFindings.push(finding);
      await this.sessionManager.addFinding(session, finding);
      this.emitProgress({
        type: 'finding-new',
        timestamp: now(),
        stage: stage.name,
        message: finding.title,
        details: finding as unknown as Record<string, unknown>,
      });
    }

    let duplicateDecisions = 0;
    for (const decision of normalizedParsed.decisions) {
      const fingerprint = buildDecisionFingerprint(decision);
      if (knownDecisionFingerprints.has(fingerprint)) {
        duplicateDecisions += 1;
        continue;
      }

      knownDecisionFingerprints.add(fingerprint);
      stageDecisions.push(decision);
      if (decision.classification === 'AMBIGUOUS') {
        await this.resolveAmbiguousDecision(session, stage, decision, activeStageState);
      }
      await this.sessionManager.upsertDecision(session, decision);
    }

    return {
      duplicateFindings,
      duplicateDecisions,
    };
  }

  private async createFailureAdvisoryRecord(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
  ): Promise<FailureAdvisoryRecord> {
    const failureCategory = classifyFailureAdvisoryCategory(result);
    const failureSignature = buildStageFailureSignature(stage.name, result);
    const priorRetryCount = getFailureAdvisoryRetryCount(session, stage.name, failureSignature);
    const sourceError = describeBlockingStageResult(stage, result);
    const evidenceDigest = buildFailureAdvisoryEvidenceDigest(stage, result);
    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: `Failure advisory: analyzing ${stage.name} for the next continuation step`,
      details: {
        failureCategory,
        failureSignature,
      },
    });

    if (shouldBypassFailureAdvisoryModel(failureCategory, sourceError)) {
      return buildFallbackFailureAdvisory(
        session,
        stage,
        failureCategory,
        failureSignature,
        priorRetryCount,
        sourceError,
        result,
      );
    }

    try {
      const prompt = buildFailureAdvisoryPrompt({
        session,
        stage,
        result,
        failureCategory,
        failureSignature,
        priorRetryCount,
        currentEfficiencyBudget: resolveStageExecutionEfficiencyBudget(stage, session),
      });
      const onStream = createStageStreamHandler(
        (event) => this.emitProgress(event),
        `${stage.name} Failure Advisory`,
      );
      const advisoryResult = await this.modelRouter.execute(
        prompt,
        resolveFailureAdvisoryAssignment(this.config, stage),
        ['Read', 'Grep', 'Glob', 'Bash'],
        onStream,
        { id: 'failure-advisory', strict: true },
        FAILURE_ADVISORY_TIMEOUT_MS,
      );
      accumulateProviderCost(session, advisoryResult);

      if (advisoryResult.error) {
        return buildFallbackFailureAdvisory(
          session,
          stage,
          failureCategory,
          failureSignature,
          priorRetryCount,
          sourceError,
          result,
        );
      }

      const parsed = parseStructuredStageOutputResult(advisoryResult.output, 'failure-advisory');
      if (!parsed.data) {
        return buildFallbackFailureAdvisory(
          session,
          stage,
          failureCategory,
          failureSignature,
          priorRetryCount,
          sourceError,
          result,
        );
      }

      const normalized = normalizeFailureAdvisoryOutput(
        session,
        parsed.data,
        failureCategory,
        priorRetryCount,
        sourceError,
        result,
        resolveStageExecutionEfficiencyBudget(stage, session),
        stage,
      );
      return {
        id: randomUUID().slice(0, 8),
        stageName: stage.name,
        stageType: stage.type,
        failureCategory,
        failureSignature,
        retryCount: priorRetryCount,
        sourceError,
        generatedAt: now(),
        evidenceDigest,
        ...normalized,
      };
    } catch {
      return buildFallbackFailureAdvisory(
        session,
        stage,
        failureCategory,
        failureSignature,
        priorRetryCount,
        sourceError,
        result,
      );
    }
  }

  private async runQualityGate(
    session: Session,
    stage: StageDefinition,
    gate: QualityGateConfig,
    options: {
      stageOutput?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<QualityGateResult> {
    const effectiveGate = buildEffectiveQualityGate(session, stage, gate);
    const scopeEntries = buildStageQualityGateScopeEntries(session, stage);
    return runQualityGate(effectiveGate, this.config.workDir, session, stage.name, {
      scopeEntries,
      stageOutput: options.stageOutput,
      promptContext: renderPromptContext(stage.type, session.promptContext),
      timeoutMs: options.timeoutMs,
      runModelReview: async ({ check, prompt, outputSchema, timeoutMs }) => {
        const onStream = createStageStreamHandler(
          (event) => this.emitProgress(event),
          `${stage.name} Quality Review`,
        );
        return this.executeQualityGateModelReview(
          session,
          stage,
          check,
          prompt,
          outputSchema,
          timeoutMs ?? options.timeoutMs,
          onStream,
          options.stageOutput,
        );
      },
    });
  }

  private async executeQualityGateModelReview(
    session: Session,
    stage: StageDefinition,
    check: QualityGateConfig['checks'][number],
    prompt: string,
    outputSchema: StageOutputSchemaConfig,
    timeoutMs: number | undefined,
    onStream: (event: StreamEvent) => void,
    stageOutput?: string,
  ): Promise<ExecutorResult> {
    const isPlanReview = outputSchema.id === 'plan-review';
    const isBroadReplayPlanReview = isPlanReview && isBroadReplayReplayTask(session);
    const synthesisOnlyReviewBudget: ExecutorEfficiencyBudget = {
      targetTurns: 6,
      explorationTurns: 0,
      shellWarnFloor: 0,
      shellAbortFloor: 1,
      disableToolUse: true,
      summary:
        'Broad replay plan review: synthesize the plan-review JSON from the existing evidence packet without more repo rediscovery.',
    };
    const tools = isBroadReplayPlanReview ? [] : (check.tools ?? ['Read', 'Grep', 'Glob', 'Bash']);
    const reviewAssignment = isPlanReview
      ? withExecutorEfficiencyBudget(
          isBroadReplayPlanReview
            ? lockModelReviewEngine(this.config, 'claude-api', check.model)
            : selectModelReviewAssignment(this.config, check.model),
          isBroadReplayPlanReview
            ? synthesisOnlyReviewBudget
            : estimatePlanReviewEfficiencyBudget(session, stageOutput),
        )
      : selectModelReviewAssignment(this.config, check.model);
    const lockedReviewAssignment = isPlanReview
      ? lockReviewAssignmentToPrimary(reviewAssignment)
      : reviewAssignment;
    const initialPrompt = isBroadReplayPlanReview
      ? buildBroadReplayPlanReviewPrompt(prompt)
      : prompt;

    const result = await this.modelRouter.execute(
      initialPrompt,
      lockedReviewAssignment,
      tools,
      onStream,
      outputSchema,
      timeoutMs,
    );
    accumulateProviderCost(session, result);

    if (isBroadReplayPlanReview && shouldRetryPlanReviewWithSynthesis(result)) {
      const continued = buildBroadReplayPlanReviewContinuationResult(
        session,
        stageOutput,
        result.error ?? '',
      );
      if (continued) {
        this.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: `${stage.name} Quality Review`,
          message:
            'Broad replay plan review stalled after the planner emitted a valid slice plan. Proceeding with an advisory continuation review so the replay can move forward.',
        });
        return continued;
      }
    }

    if (!isPlanReview || !shouldRetryPlanReviewWithSynthesis(result)) {
      return result;
    }

    this.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: `${stage.name} Quality Review`,
      message:
        'Plan review drifted or stalled after gathering seam evidence. Retrying once in synthesis mode from the current evidence packet.',
    });

    const synthesisPrompt = buildPlanReviewSynthesisPrompt(initialPrompt, result.error ?? '');
    const synthesisBudget: ExecutorEfficiencyBudget = {
      targetTurns: 8,
      explorationTurns: 0,
      shellWarnFloor: 0,
      shellAbortFloor: 2,
      disableToolUse: true,
      summary:
        'Plan-review synthesis retry: reuse the current evidence packet and emit the plan-review JSON without more repo rediscovery.',
    };
    const synthesisAssignment = lockReviewAssignmentToPrimary(
      withExecutorEfficiencyBudget(
        lockModelReviewEngine(this.config, 'claude-api', check.model),
        synthesisBudget,
      ),
    );

    const synthesisResult = await this.modelRouter.execute(
      synthesisPrompt,
      synthesisAssignment,
      [],
      onStream,
      outputSchema,
      timeoutMs,
    );
    accumulateProviderCost(session, synthesisResult);
    return synthesisResult;
  }

  private async persistPlanReviewCarryForwardState(
    session: Session,
    gateResult: QualityGateResult,
    stageOutput: string,
  ): Promise<void> {
    const review = gateResult.checks.find(
      (check) => check.modelReview?.schemaId === 'plan-review',
    )?.modelReview;
    if (!review || review.schemaId !== 'plan-review') {
      return;
    }

    const parsedPlan = parseStructuredStageOutputResult(stageOutput, 'slice-plan');
    if (!parsedPlan.data) {
      return;
    }

    session.planReviewState = buildPlanReviewState(
      {
        summary: review.summary,
        findings: [...review.blockingFindings, ...review.advisoryFindings],
        sliceAssessments: review.sliceAssessments,
        deferredFindings: mergeDeferredPlanFindings(
          review.deferredFindings,
          buildHorizonDeferredPlanFindings(session),
        ),
        decisions: review.unresolvedDecisions,
      },
      parsedPlan.data,
    );
    await this.sessionManager.persist(session);
  }

  // ── Helpers ──────────────────────────────────────────────────

  private emitProgress(event: ProgressEvent): void {
    this.reporter.emit(event);
    void this.persistProgressHeartbeat(event);
  }

  private async journal(session: Session, entry: JournalEntry): Promise<void> {
    await this.sessionManager.addJournalEntry(session, entry);
  }

  private async persistProgressHeartbeat(event: ProgressEvent): Promise<void> {
    const session = this.currentSession;
    if (!session || !shouldPersistProgressHeartbeat(event)) {
      return;
    }

    const intervalMs = resolveProgressHeartbeatMs(this.config.progressHeartbeatMs);
    const nowMs = Date.now();
    if (intervalMs > 0 && nowMs - this.lastHeartbeatPersistAtMs < intervalMs) {
      return;
    }

    this.lastHeartbeatPersistAtMs = nowMs;
    await this.sessionManager.persistHeartbeat(session, {
      at: event.timestamp,
      eventType: event.type,
      stage: event.stage,
      message: event.message,
    });
  }
}
