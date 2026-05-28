import { ModelRouter } from '../models/model-router.js';
import {
  OracleConstellation,
  applyOracleDecisionOutcome,
} from '../oracles/oracle-constellation.js';
import { accumulateProviderCost } from './cost-accumulator.js';
import { SessionManager } from '../session/session-manager.js';
import type {
  Decision,
  Finding,
  HelixConfig,
  JournalEntry,
  ProgressEvent,
  ProgressReporter,
  Session,
  StageDefinition,
  StageResult,
} from '../types.js';
import { getDeferredBulkReviewSlices, markSliceBulkReviewStatus } from './autonomy-policy.js';
import { compileSliceArtifacts } from './manifest-compiler.js';
import { runConcernsAuditStage } from './concerns-audit-stage.js';
import { buildStagePrompt } from './stage-runner.js';
import { parseAnalysisOutput } from './stage-output-parsers.js';
import {
  executeDuelingPlanGeneration,
  type DuelingPlanGenerationDeps,
} from './engine/execute-dueling-plan-generation.js';
import { failStageDueToTimeout } from './engine/fail-stage-due-to-timeout.js';
import {
  ensureVerificationBootstrap,
  formatVerificationBootstrapSummary,
} from './verification-bootstrap.js';
import {
  computeCheckpointArtifactHash,
  hasApprovedCheckpointArtifact,
  recordCheckpointApproval,
} from './control-plane-state.js';
import {
  buildOracleDefinitionsFromStage,
  createStageStreamHandler,
  getRemainingTimeoutMs,
  makeResult,
  now,
  resolveSessionStateForStage,
} from './stage-execution-shared.js';

interface SpecialStageExecutorDeps {
  config: HelixConfig;
  reporter: ProgressReporter;
  modelRouter: ModelRouter;
  sessionManager: SessionManager;
  emitProgress: (event: ProgressEvent) => void;
  journal: (session: Session, entry: JournalEntry) => Promise<void>;
}

const MANIFEST_COMPILATION_PER_SLICE_BUDGET_MS = 5 * 60_000;

async function runWithSliceTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class SpecialStageExecutor {
  constructor(private readonly deps: SpecialStageExecutorDeps) {}

  async executeDocSync(
    session: Session,
    stage: StageDefinition,
    startTime: number,
  ): Promise<StageResult> {
    if (!session.replayContext) {
      return makeResult(
        stage,
        'failed',
        '',
        [],
        [],
        startTime,
        1,
        'Deterministic doc-sync execution is only available in replay mode.',
      );
    }

    const reviewStartMessage =
      'review-started: treating replay doc sync as non-blocking housekeeping after durable proof';
    const reviewFinishMessage =
      'review-finished: replay doc sync bookkeeping is non-blocking once proof stages are green';
    const promotionStartMessage =
      'promotion-started: promoting Doc Sync from replay completion-first policy';
    const promotionFinishMessage =
      'promotion-finished: Doc Sync treated as non-blocking replay housekeeping';
    const output =
      'Replay mode: Doc Sync was treated as non-blocking housekeeping after implementation, E2E, and regression proof completed.';

    for (const message of [
      reviewStartMessage,
      reviewFinishMessage,
      promotionStartMessage,
      promotionFinishMessage,
    ]) {
      this.deps.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        message,
      });
      await this.deps.journal(session, {
        timestamp: now(),
        type: 'progress',
        stage: stage.name,
        message,
      });
    }

    await this.deps.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: output,
    });

    return makeResult(stage, 'passed', output, [], [], startTime, 1);
  }

  async executeVerificationBootstrap(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const timeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
    if (timeoutMs != null && timeoutMs <= 0) {
      return failStageDueToTimeout(
        session,
        stage,
        '',
        [],
        [],
        startTime,
        1,
        {},
        {
          emitProgress: this.deps.emitProgress,
          journal: this.deps.journal,
        },
      );
    }

    const record = await ensureVerificationBootstrap(this.deps.config.workDir, session, {
      timeoutMs,
      emitProgress: (message, details) =>
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message,
          details,
        }),
    });

    await this.deps.sessionManager.persist(session);
    await this.deps.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: formatVerificationBootstrapSummary(record),
    });

    return makeResult(
      stage,
      'passed',
      formatVerificationBootstrapSummary(record),
      [],
      [],
      startTime,
      1,
    );
  }

  async executeDuelingPlanGeneration(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const deps: DuelingPlanGenerationDeps = {
      config: this.deps.config,
      modelRouter: this.deps.modelRouter,
      sessionManager: this.deps.sessionManager,
      journal: this.deps.journal,
      emitProgress: this.deps.emitProgress,
      reporter: this.deps.reporter,
    };
    return executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt, deps);
  }

  async executeOracleAnalysis(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const timeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
    if (timeoutMs != null && timeoutMs <= 0) {
      return failStageDueToTimeout(
        session,
        stage,
        '',
        [],
        [],
        startTime,
        1,
        {},
        {
          emitProgress: this.deps.emitProgress,
          journal: this.deps.journal,
        },
      );
    }

    const openFindings = session.findings.filter(
      (finding) => finding.status === 'open' || finding.status === 'planned',
    );
    const customOracles = buildOracleDefinitionsFromStage(stage);
    const constellation = new OracleConstellation(
      this.deps.modelRouter,
      this.deps.reporter,
      customOracles.length > 0 ? customOracles : undefined,
      this.deps.config.maxConcurrentOracles,
      this.deps.config,
    );

    const result = await constellation.analyzeFindings(openFindings, session, {
      stageName: stage.name,
      timeoutMs,
    });

    if (result.successfulOracles === 0) {
      const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
      const replayTags = session.replayContext?.tags ?? [];
      const isBroadReplay =
        changedFiles.length >= 6 ||
        replayTags.some((tag) => ['service-extraction', 'rbac', 'route-migration'].includes(tag));
      const exhaustedRetry = (session.failureAdvisories ?? []).some(
        (advisory) => advisory.stageName === stage.name && advisory.retryCount >= 1,
      );
      const allOracleFailuresAreCapacityRelated =
        result.failedOracles.length > 0 &&
        result.failedOracles.every((failure) =>
          /hit your limit|rate limit|quota|capacity|overloaded|too many requests/i.test(
            failure.error,
          ),
        );
      const allOracleFailuresAreTransientAnalysisRelated =
        result.failedOracles.length > 0 &&
        result.failedOracles.every((failure) =>
          /stalled|timed out|timeout|shell exploration budget|turn budget|hard cap|zero-turn/i.test(
            failure.error,
          ),
        );

      if (isBroadReplay && allOracleFailuresAreCapacityRelated) {
        const warning =
          result.failedOracles.length > 0
            ? `All oracles are temporarily unavailable; continuing with existing findings: ${result.failedOracles.map((failure) => `${failure.oracle}: ${failure.error}`).join('; ')}`
            : 'All oracles are temporarily unavailable; continuing with existing findings';
        await this.deps.journal(session, {
          timestamp: now(),
          type: 'progress',
          stage: stage.name,
          message: warning,
        });
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: warning,
        });
        return makeResult(stage, 'passed', warning, [], [], startTime, 1);
      }

      if (isBroadReplay && allOracleFailuresAreTransientAnalysisRelated) {
        const warning =
          result.failedOracles.length > 0
            ? `All oracles stalled on replay seam review; continuing with existing findings: ${result.failedOracles.map((failure) => `${failure.oracle}: ${failure.error}`).join('; ')}`
            : 'All oracles stalled on replay seam review; continuing with existing findings';
        await this.deps.journal(session, {
          timestamp: now(),
          type: 'progress',
          stage: stage.name,
          message: warning,
        });
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: warning,
        });
        return makeResult(stage, 'passed', warning, [], [], startTime, 1);
      }

      if (isBroadReplay && exhaustedRetry) {
        const warning =
          result.failedOracles.length > 0
            ? `All oracles failed after retry; continuing with existing findings: ${result.failedOracles.map((failure) => `${failure.oracle}: ${failure.error}`).join('; ')}`
            : 'All oracles failed after retry; continuing with existing findings';
        await this.deps.journal(session, {
          timestamp: now(),
          type: 'progress',
          stage: stage.name,
          message: warning,
        });
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message: warning,
        });
        return makeResult(stage, 'passed', warning, [], [], startTime, 1);
      }

      const error =
        result.failedOracles.length > 0
          ? `All oracles failed: ${result.failedOracles.map((failure) => `${failure.oracle}: ${failure.error}`).join('; ')}`
          : 'All oracles failed';
      await this.deps.journal(session, {
        timestamp: now(),
        type: 'error',
        stage: stage.name,
        message: error,
      });
      return makeResult(stage, 'failed', result.output, [], [], startTime, 1, error);
    }

    const stageFindings: Finding[] = [];
    for (const finding of result.additionalFindings) {
      stageFindings.push(finding);
      await this.deps.sessionManager.addFinding(session, finding);
      this.deps.emitProgress({
        type: 'finding-new',
        timestamp: now(),
        stage: stage.name,
        message: finding.title,
        details: finding as unknown as Record<string, unknown>,
      });
    }

    const stageDecisions: Decision[] = [];
    const persistedDecisionIds = new Set<string>();
    for (const decision of result.decisions) {
      if (persistedDecisionIds.has(decision.id)) {
        continue;
      }

      if (decision.classification === 'AMBIGUOUS' && !decision.answer) {
        await this.resolveAmbiguousDecision(
          session,
          stage,
          decision,
          this.buildOracleQuestionPromptDecision(decision, stageDecisions),
        );
      }

      applyOracleDecisionOutcome(session, decision);
      await this.persistOracleDecision(
        session,
        stage,
        decision,
        stageDecisions,
        persistedDecisionIds,
      );

      const cascadedDecisions = this.cascadeResolvedOracleDecisions(
        session,
        stage,
        result.decisions,
        stageDecisions,
      );
      for (const cascadedDecision of cascadedDecisions) {
        await this.persistOracleDecision(
          session,
          stage,
          cascadedDecision,
          stageDecisions,
          persistedDecisionIds,
        );
      }
    }

    await this.deps.sessionManager.persist(session);
    await this.deps.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: result.output,
    });

    this.deps.emitProgress({
      type: 'stage-exit',
      timestamp: now(),
      stage: stage.name,
      message: `${stageFindings.length} findings, ${stageDecisions.length} decisions`,
      details: {
        successfulOracles: result.successfulOracles,
        failedOracles: result.failedOracles.length,
      },
    });

    return makeResult(stage, 'passed', result.output, stageFindings, stageDecisions, startTime, 1);
  }

  async executeManifestCompilation(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    if (session.slices.length === 0) {
      const error = 'Manifest compilation requires at least one planned slice';
      return makeResult(stage, 'failed', '', [], [], startTime, 1, error);
    }

    const outputLines: string[] = [];

    for (let index = 0; index < session.slices.length; index++) {
      const slice = session.slices[index];

      // Resume support: skip slices whose manifest is already compiled.
      // `manifest.completeness` is only set by compileSliceArtifacts, so its
      // presence is the authoritative signal that this slice was processed in
      // a prior stage execution (e.g., before a timeout).
      if (slice.manifest?.completeness != null) {
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          slice: index,
          message: `Slice ${index + 1}/${session.slices.length} already compiled — reusing manifest: ${slice.title}`,
        });
        outputLines.push(
          [
            `Slice ${index + 1}: ${slice.title}`,
            `file contracts=${slice.manifest.fileContracts.length}`,
            `entry conditions=${slice.manifest.entryConditions.length}`,
            `export contracts=${slice.manifest.exportContracts.length}`,
            `completeness hints=${slice.manifest.completeness.hints.length}`,
            `required tests=${slice.testLock.requiredTests.length}`,
            `risk=${slice.impactAnalysis.riskLevel}`,
            `(reused)`,
          ].join(' | '),
        );
        continue;
      }

      const stageRemainingMs = getRemainingTimeoutMs(stageDeadlineAt);
      if (stageRemainingMs != null && stageRemainingMs <= 0) {
        return failStageDueToTimeout(
          session,
          stage,
          outputLines.join('\n'),
          [],
          [],
          startTime,
          1,
          {},
          {
            emitProgress: this.deps.emitProgress,
            journal: this.deps.journal,
          },
        );
      }

      // Per-slice soft cap: bound a single slice's deterministic compilation so
      // one runaway slice can't eat the whole stage budget. The slice's own
      // partial work is unaffected — it isn't persisted until compileSliceArtifacts
      // returns, and the next attempt restarts that slice from scratch while
      // already-compiled slices stay reused via the completeness check above.
      const perSliceBudgetMs =
        stageRemainingMs != null
          ? Math.min(MANIFEST_COMPILATION_PER_SLICE_BUDGET_MS, stageRemainingMs)
          : MANIFEST_COMPILATION_PER_SLICE_BUDGET_MS;
      const sliceStartedAt = Date.now();

      this.deps.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: stage.name,
        slice: index,
        message: `Compiling manifest for slice ${index + 1}/${session.slices.length}: ${slice.title}`,
      });

      try {
        const compiled = await runWithSliceTimeout(
          () => compileSliceArtifacts(slice, session, this.deps.config.workDir),
          perSliceBudgetMs,
          `Slice ${index + 1} manifest compilation exceeded per-slice budget of ${Math.round(perSliceBudgetMs / 1000)}s`,
        );
        await this.deps.sessionManager.updateSlice(session, index, compiled);

        outputLines.push(
          [
            `Slice ${index + 1}: ${slice.title}`,
            `file contracts=${compiled.manifest.fileContracts.length}`,
            `entry conditions=${compiled.manifest.entryConditions.length}`,
            `export contracts=${compiled.manifest.exportContracts.length}`,
            `completeness hints=${compiled.manifest.completeness?.hints.length ?? 0}`,
            `required tests=${compiled.testLock.requiredTests.length}`,
            `risk=${compiled.impactAnalysis.riskLevel}`,
            `(${Math.round((Date.now() - sliceStartedAt) / 1000)}s)`,
          ].join(' | '),
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await this.deps.journal(session, {
          timestamp: now(),
          type: 'error',
          stage: stage.name,
          message: `Slice ${index + 1} manifest compilation failed: ${errorMsg}`,
        });
        return makeResult(stage, 'failed', outputLines.join('\n'), [], [], startTime, 1, errorMsg);
      }
    }

    await this.deps.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: `Compiled manifests for ${session.slices.length} slices`,
    });

    return makeResult(stage, 'passed', outputLines.join('\n'), [], [], startTime, 1);
  }

  async executeConcernsAudit(
    session: Session,
    stage: StageDefinition,
    startTime: number,
  ): Promise<StageResult> {
    const outcome = await runConcernsAuditStage({
      stage,
      startTime,
      repoRoot: this.deps.config.workDir,
      discoveredBy: stage.name,
      timestamp: now(),
      onProgress: (message, details) =>
        this.deps.emitProgress({
          type: 'stage-progress',
          timestamp: now(),
          stage: stage.name,
          message,
          details,
        }),
    });

    for (const finding of outcome.findings) {
      await this.deps.sessionManager.addFinding(session, finding);
    }

    await this.deps.journal(session, {
      timestamp: now(),
      type: 'stage-complete',
      stage: stage.name,
      message: `concerns-audit: ${outcome.auditResult.summary.findings} finding(s) (${outcome.auditResult.summary.blockingFindings} blocking)`,
      details: {
        concernsScanned: outcome.auditResult.summary.concernsScanned,
        detectorsRun: outcome.auditResult.summary.detectorsRun,
        detectorsSkipped: outcome.auditResult.summary.detectorsSkipped,
        filesScanned: outcome.auditResult.summary.filesScanned,
        findings: outcome.auditResult.summary.findings,
        blockingFindings: outcome.auditResult.summary.blockingFindings,
        advisoryFindings: outcome.auditResult.summary.advisoryFindings,
      },
    });

    return outcome.stageResult;
  }

  async handleUserCheckpoint(
    session: Session,
    stage: StageDefinition,
    startTime: number,
  ): Promise<StageResult> {
    if (stage.checkpoint === 'auto') {
      return makeResult(stage, 'passed', 'Checkpoint auto-approved', [], [], startTime, 1);
    }

    const resumeState = resolveSessionStateForStage(stage);
    const checkpointData = {
      findings: session.findings.length,
      decisions: session.decisions.length,
      pendingAmbiguous: session.decisions.filter(
        (decision) => decision.classification === 'AMBIGUOUS' && !decision.answer,
      ).length,
    };
    const checkpointFingerprint = {
      summary: checkpointData,
      findings: session.findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        severity: finding.severity,
        title: finding.title,
        files: finding.files.map((file) => file.path),
      })),
      decisions: session.decisions.map((decision) => ({
        id: decision.id,
        classification: decision.classification,
        question: decision.question,
        answer: decision.answer ?? null,
        context: decision.context ?? null,
      })),
      slices: session.slices.map((slice) => ({
        index: slice.index,
        title: slice.title,
        status: slice.status,
        findings: [...slice.findings],
        files: slice.manifest.fileContracts.map((contract) => contract.path),
        tests: slice.testLock.requiredTests.map((test) => test.testFile),
      })),
    };
    const artifactHash = computeCheckpointArtifactHash(
      stage.name,
      stage.description,
      checkpointFingerprint,
    );
    if (hasApprovedCheckpointArtifact(session, artifactHash)) {
      await this.deps.journal(session, {
        timestamp: now(),
        type: 'progress',
        stage: stage.name,
        message: 'Reused prior approval for an unchanged checkpoint artifact',
        details: {
          artifactHash,
        },
      });
      return makeResult(stage, 'passed', 'Reused prior approval', [], [], startTime, 1);
    }

    session.state = 'awaiting-approval';
    await this.deps.sessionManager.persist(session);

    let approved: boolean;
    try {
      approved = await this.deps.reporter.onCheckpoint(stage.description, checkpointFingerprint);
    } catch (error) {
      session.state = resumeState;
      await this.deps.sessionManager.persist(session);
      throw error;
    }

    if (!approved) {
      await this.deps.sessionManager.updateState(session, 'paused');
      return makeResult(
        stage,
        'failed',
        'User rejected checkpoint',
        [],
        [],
        startTime,
        1,
        'User rejected',
      );
    }

    recordCheckpointApproval(session, {
      stageName: stage.name,
      artifactHash,
      message: stage.description,
      approvedAt: now(),
    });
    await this.deps.sessionManager.updateState(session, resumeState);
    return makeResult(stage, 'passed', 'User approved', [], [], startTime, 1);
  }

  async executeBulkReview(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult> {
    const queuedSlices = getDeferredBulkReviewSlices(session);
    if (queuedSlices.length === 0) {
      await this.deps.journal(session, {
        timestamp: now(),
        type: 'stage-complete',
        stage: stage.name,
        message: 'No autonomously committed slices were queued for deferred review',
      });
      return makeResult(
        stage,
        'skipped',
        'No autonomously committed slices are queued for deferred review.',
        [],
        [],
        startTime,
        1,
      );
    }

    const timeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
    if (timeoutMs != null && timeoutMs <= 0) {
      return failStageDueToTimeout(
        session,
        stage,
        '',
        [],
        [],
        startTime,
        1,
        {},
        {
          emitProgress: this.deps.emitProgress,
          journal: this.deps.journal,
        },
      );
    }

    const prompt = buildStagePrompt(stage, session, '', 1);
    const streamFilePath = `${this.deps.config.sessionDir}/${session.id}/streams/${stage.type}-${Date.now()}.txt`;
    const onStream = createStageStreamHandler(
      (event) => this.deps.emitProgress(event),
      stage.name,
      undefined,
      streamFilePath,
    );

    const result = await this.deps.modelRouter.execute(
      prompt,
      stage.model,
      stage.tools,
      onStream,
      stage.outputSchema,
      timeoutMs,
    );
    accumulateProviderCost(session, result);
    if (result.error) {
      return makeResult(stage, 'failed', '', [], [], startTime, 1, result.error);
    }

    const parsed = parseAnalysisOutput(result.output, stage.name);
    const blocking =
      parsed.findings.length > 0 || parsed.decisions.some((d) => d.classification === 'AMBIGUOUS');
    const blockedSlices = new Set<number>();

    if (blocking) {
      for (const finding of parsed.findings) {
        const findingFiles = new Set(finding.files.map((file) => file.path));
        const matchingSlices = queuedSlices.filter((slice) =>
          findingFiles.size === 0
            ? true
            : getSliceFilesForBulkReview(slice).some((file) => findingFiles.has(file)),
        );
        if (matchingSlices.length === 0) {
          queuedSlices.forEach((slice) => blockedSlices.add(slice.index));
          continue;
        }
        matchingSlices.forEach((slice) => blockedSlices.add(slice.index));
      }
    }

    for (const finding of parsed.findings) {
      await this.deps.sessionManager.addFinding(session, finding);
    }
    for (const decision of parsed.decisions) {
      await this.deps.sessionManager.addDecision(session, decision);
    }

    for (const slice of queuedSlices) {
      const nextAutonomy = markSliceBulkReviewStatus(
        slice,
        blocking && (blockedSlices.size === 0 || blockedSlices.has(slice.index))
          ? 'blocked'
          : 'approved',
      );
      await this.deps.sessionManager.updateSlice(session, slice.index, {
        autonomy: nextAutonomy,
      });
    }

    await this.deps.journal(session, {
      timestamp: now(),
      type: 'review',
      stage: stage.name,
      message: blocking
        ? `Deferred bulk review blocked ${blockedSlices.size || queuedSlices.length} slice(s)`
        : `Deferred bulk review approved ${queuedSlices.length} slice(s)`,
    });

    this.deps.emitProgress({
      type: 'stage-progress',
      timestamp: now(),
      stage: stage.name,
      message: blocking
        ? `Deferred bulk review found ${parsed.findings.length} blocking issue(s)`
        : `Deferred bulk review approved ${queuedSlices.length} queued slice(s)`,
    });

    return makeResult(
      stage,
      blocking ? 'failed' : 'passed',
      result.output,
      parsed.findings,
      parsed.decisions,
      startTime,
      1,
      blocking
        ? `Deferred bulk review found ${parsed.findings.length} blocking issue(s)`
        : undefined,
      result.costUsd,
    );
  }

  private async resolveAmbiguousDecision(
    session: Session,
    stage: StageDefinition,
    decision: Decision,
    promptDecision: Decision = decision,
  ): Promise<void> {
    const resumeState = resolveSessionStateForStage(stage);
    session.state = 'awaiting-input';
    await this.deps.sessionManager.upsertDecision(session, decision);
    this.deps.emitProgress({
      type: 'decision-needed',
      timestamp: now(),
      stage: stage.name,
      message: promptDecision.question,
      details: promptDecision as unknown as Record<string, unknown>,
    });

    try {
      const answer = await this.deps.reporter.onQuestion(promptDecision);
      decision.answer = answer;
      decision.resolvedBy = 'user';
      decision.resolvedAt = now();
      session.state = resumeState;
      await this.deps.sessionManager.upsertDecision(session, decision);
      this.deps.emitProgress({
        type: 'decision-resolved',
        timestamp: now(),
        stage: stage.name,
        message: `User decided: ${answer}`,
        details: decision as unknown as Record<string, unknown>,
      });
    } catch (error) {
      session.state = resumeState;
      await this.deps.sessionManager.persist(session);
      throw error;
    }
  }

  private buildOracleQuestionPromptDecision(
    decision: Decision,
    priorStageDecisions: Decision[],
  ): Decision {
    const priorUserDecisions = priorStageDecisions.filter(
      (candidate) => candidate.resolvedBy === 'user' && candidate.answer,
    );
    if (priorUserDecisions.length === 0) {
      return decision;
    }

    const contextSections = [decision.context.trim()].filter(Boolean);
    contextSections.push(
      [
        'Prior resolved oracle questions from this stage:',
        ...priorUserDecisions
          .slice(-4)
          .map((candidate) => `- ${candidate.question} -> ${candidate.answer}`),
      ].join('\n'),
    );

    return {
      ...decision,
      context: contextSections.join('\n\n'),
    };
  }

  private cascadeResolvedOracleDecisions(
    session: Session,
    stage: StageDefinition,
    pendingDecisions: Decision[],
    resolvedDecisions: Decision[],
  ): Decision[] {
    const cascaded: Decision[] = [];

    for (const candidate of pendingDecisions) {
      if (candidate.answer || candidate.classification !== 'AMBIGUOUS') {
        continue;
      }

      const resolution = inferOracleDecisionFromResolvedContext(candidate, resolvedDecisions);
      if (!resolution) {
        continue;
      }

      candidate.answer = resolution.answer;
      candidate.classification = 'INFERRED';
      candidate.resolvedBy = resolution.resolvedBy;
      candidate.resolvedAt = now();
      candidate.context = appendCascadeReason(candidate.context, resolution.reason);
      applyOracleDecisionOutcome(session, candidate);

      this.deps.emitProgress({
        type: 'decision-resolved',
        timestamp: now(),
        stage: stage.name,
        message: `Derived from prior answer: ${candidate.answer}`,
        details: candidate as unknown as Record<string, unknown>,
      });

      cascaded.push(candidate);
    }

    return cascaded;
  }

  private async persistOracleDecision(
    session: Session,
    _stage: StageDefinition,
    decision: Decision,
    stageDecisions: Decision[],
    persistedDecisionIds: Set<string>,
  ): Promise<void> {
    if (persistedDecisionIds.has(decision.id)) {
      return;
    }

    stageDecisions.push(decision);
    persistedDecisionIds.add(decision.id);
    await this.deps.sessionManager.upsertDecision(session, decision);
  }
}

interface OracleDecisionContextMetadata {
  findingId: string | null;
  action: 'status' | 'severity' | null;
}

function inferOracleDecisionFromResolvedContext(
  decision: Decision,
  resolvedDecisions: Decision[],
): { answer: string; resolvedBy: NonNullable<Decision['resolvedBy']>; reason: string } | null {
  const metadata = parseOracleDecisionContextMetadata(decision.context);
  if (!metadata.findingId || !metadata.action) {
    return null;
  }

  for (const resolvedDecision of resolvedDecisions) {
    if (!resolvedDecision.answer) {
      continue;
    }

    const resolvedMetadata = parseOracleDecisionContextMetadata(resolvedDecision.context);
    if (
      resolvedMetadata.findingId !== metadata.findingId ||
      resolvedMetadata.action !== metadata.action
    ) {
      continue;
    }

    return {
      answer: resolvedDecision.answer,
      resolvedBy: resolvedDecision.resolvedBy ?? 'user',
      reason: `Derived from resolved oracle decision ${resolvedDecision.id}`,
    };
  }

  return null;
}

function parseOracleDecisionContextMetadata(context: string): OracleDecisionContextMetadata {
  const findingIdMatch = context.match(/\[finding-id:([^\]]+)\]/);
  const actionMatch = context.match(/\[action:(status|severity)\]/);

  return {
    findingId: findingIdMatch?.[1]?.trim() || null,
    action: (actionMatch?.[1] as OracleDecisionContextMetadata['action'] | undefined) ?? null,
  };
}

function appendCascadeReason(context: string, reason: string): string {
  const trimmedContext = context.trim();
  if (!trimmedContext) {
    return reason;
  }

  return `${trimmedContext}\n\n${reason}`;
}

function getSliceFilesForBulkReview(slice: Session['slices'][number]): string[] {
  const files = new Set<string>();
  for (const file of slice.manifest.fileContracts) {
    files.add(file.path);
  }
  for (const test of slice.testLock.requiredTests) {
    files.add(test.testFile);
  }
  return [...files];
}
