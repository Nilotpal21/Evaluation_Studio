import { join, resolve } from 'node:path';

import { SessionManager } from '../session/session-manager.js';
import type {
  ExitCriterion,
  HelixConfig,
  ModelSpec,
  Session,
  SessionState,
  Slice,
} from '../types.js';

export interface HelixControlPlaneServiceOptions {
  workDir?: string;
  sessionDir?: string;
  journalDir?: string;
}

export interface ListSessionsOptions {
  limit?: number;
  state?: SessionState;
  titleQuery?: string;
}

export interface HelixSessionSummary {
  id: string;
  title: string;
  state: SessionState;
  updatedAt: string;
  currentStageName: string | null;
  currentStageIndex: number;
  currentSliceNumber: number | null;
  totalSlices: number;
  openFindings: number;
  unresolvedDecisions: number;
  harnessDefects: number;
  lastError?: string;
}

export interface SliceGateResultSummary {
  criterionId: string;
  criterionType: ExitCriterion['type'];
  passed: boolean;
  detail?: string;
  cached: boolean;
  checkpointCapturedAt?: string;
}

const DEFAULT_MODEL: ModelSpec = {
  engine: 'codex-cli',
  model: 'gpt-5.5',
};

export class HelixControlPlaneService {
  private readonly sessionManager: SessionManager;

  constructor(private readonly options: HelixControlPlaneServiceOptions = {}) {
    const workDir = resolve(options.workDir ?? process.cwd());
    this.sessionManager = new SessionManager(
      buildReadonlyConfig(
        workDir,
        options.sessionDir ?? join(workDir, '.helix', 'sessions'),
        options.journalDir ?? join(workDir, 'docs', 'sdlc-logs'),
      ),
    );
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<HelixSessionSummary[]> {
    const limit = clampLimit(options.limit);
    const titleQuery = options.titleQuery?.trim().toLowerCase();
    const listed = await this.sessionManager.list();
    const filtered = listed.filter((entry) => {
      if (options.state && entry.state !== options.state) {
        return false;
      }
      if (titleQuery && !entry.title.toLowerCase().includes(titleQuery)) {
        return false;
      }
      return true;
    });

    const sessions = await Promise.all(
      filtered.slice(0, limit).map(async (entry) => this.sessionManager.load(entry.id)),
    );
    return sessions.map((session) => buildSessionSummary(session));
  }

  async getSession(sessionId: string): Promise<HelixSessionSummary> {
    const session = await this.sessionManager.load(sessionId);
    return buildSessionSummary(session);
  }

  async getSlicePacket(sessionId: string, sliceNumber: number): Promise<Record<string, unknown>> {
    const session = await this.sessionManager.load(sessionId);
    const sliceIndex = normalizeSliceIndex(sliceNumber, session.slices.length);
    const slice = session.slices[sliceIndex];

    return {
      session: buildSessionSummary(session),
      sliceNumber: sliceIndex + 1,
      title: slice.title,
      description: slice.description,
      status: slice.status,
      dependencies: slice.dependencies.map((dependency) => dependency + 1),
      dependentSlices: session.slices
        .filter((candidate) => candidate.dependencies.includes(sliceIndex))
        .map((candidate) => candidate.index + 1),
      findings: session.findings.filter((finding) => slice.findings.includes(finding.id)),
      manifest: slice.manifest,
      testLock: slice.testLock,
      impactAnalysis: slice.impactAnalysis,
      exitCriteria: slice.exitCriteria,
      proofPacket: slice.proofPacket,
      verificationCheckpoint: slice.verificationCheckpoint,
      review: slice.review,
      autonomy: slice.autonomy,
      implementationCheckpoint: slice.implementationCheckpoint,
    };
  }

  async listGateResults(
    sessionId: string,
    sliceNumber?: number,
  ): Promise<Array<Record<string, unknown>>> {
    const session = await this.sessionManager.load(sessionId);
    const slices =
      sliceNumber == null
        ? session.slices.map((slice, index) => ({ slice, index }))
        : [
            {
              slice: session.slices[normalizeSliceIndex(sliceNumber, session.slices.length)],
              index: normalizeSliceIndex(sliceNumber, session.slices.length),
            },
          ];

    return slices.map(({ slice, index }) => ({
      sliceNumber: index + 1,
      title: slice.title,
      status: slice.status,
      gates: buildGateResultSummaries(slice),
    }));
  }

  async getDependencyDag(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.sessionManager.load(sessionId);
    return {
      session: buildSessionSummary(session),
      nodes: session.slices.map((slice, index) => ({
        sliceNumber: index + 1,
        title: slice.title,
        status: slice.status,
      })),
      edges: session.slices.flatMap((slice, index) =>
        slice.dependencies.map((dependency) => ({
          from: dependency + 1,
          to: index + 1,
        })),
      ),
    };
  }

  async searchFindings(
    query: string,
    sessionId?: string,
    limit?: number,
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const sessions =
      sessionId != null
        ? [await this.sessionManager.load(sessionId)]
        : await Promise.all(
            (await this.sessionManager.list()).map((entry) => this.sessionManager.load(entry.id)),
          );

    const matches = sessions.flatMap((session) =>
      session.findings
        .filter((finding) => matchesFindingQuery(finding, normalizedQuery))
        .map((finding) => ({
          sessionId: session.id,
          sessionTitle: session.workItem.title,
          findingId: finding.id,
          title: finding.title,
          severity: finding.severity,
          status: finding.status,
          files: finding.files.map((file) => file.path),
          assignedSlice:
            session.slices.findIndex((slice) => slice.findings.includes(finding.id)) + 1 || null,
        })),
    );

    return matches.slice(0, clampLimit(limit, 200));
  }

  async explainBlocker(sessionId: string, sliceNumber?: number): Promise<Record<string, unknown>> {
    const session = await this.sessionManager.load(sessionId);
    if (sliceNumber != null) {
      const sliceIndex = normalizeSliceIndex(sliceNumber, session.slices.length);
      return explainSliceBlocker(session, sliceIndex);
    }

    if (session.state === 'awaiting-approval') {
      return {
        scope: 'session',
        session: buildSessionSummary(session),
        blockerType: 'checkpoint',
        message: `Waiting for user approval at ${getCurrentStageName(session) ?? 'an unknown stage'}.`,
        checkpointApprovals: session.checkpointApprovals ?? [],
      };
    }

    const unresolvedDecisions = session.decisions.filter((decision) => !decision.answer);
    if (session.state === 'awaiting-input' && unresolvedDecisions.length > 0) {
      return {
        scope: 'session',
        session: buildSessionSummary(session),
        blockerType: 'decision',
        message: `Waiting for ${unresolvedDecisions.length} unresolved decision(s).`,
        unresolvedDecisions: unresolvedDecisions.map((decision) => ({
          id: decision.id,
          classification: decision.classification,
          question: decision.question,
        })),
      };
    }

    const failedStage = [...session.stageHistory]
      .reverse()
      .find((stage) => stage.status === 'failed');
    if (failedStage) {
      return {
        scope: 'session',
        session: buildSessionSummary(session),
        blockerType: 'stage-failure',
        message: failedStage.error ?? `${failedStage.stageName} failed.`,
        stage: {
          name: failedStage.stageName,
          type: failedStage.stageType,
          error: failedStage.error,
          output: failedStage.output,
        },
      };
    }

    const openSliceIndex = session.slices.findIndex((slice) => slice.status !== 'committed');
    if (openSliceIndex >= 0) {
      return explainSliceBlocker(session, openSliceIndex);
    }

    return {
      scope: 'session',
      session: buildSessionSummary(session),
      blockerType: 'none',
      message: 'No blocker detected. The session appears fully committed or completed.',
    };
  }
}

function buildReadonlyConfig(workDir: string, sessionDir: string, journalDir: string): HelixConfig {
  return {
    workDir,
    sessionDir,
    journalDir,
    defaultModel: DEFAULT_MODEL,
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: false,
    budgetLimitUsd: 0,
    verbose: false,
  };
}

function buildSessionSummary(session: Session): HelixSessionSummary {
  return {
    id: session.id,
    title: session.workItem.title,
    state: session.state,
    updatedAt: session.updatedAt,
    currentStageName: getCurrentStageName(session),
    currentStageIndex: session.currentStageIndex,
    currentSliceNumber:
      session.totalSlices > 0 ? Math.min(session.currentSliceIndex + 1, session.totalSlices) : null,
    totalSlices: session.totalSlices,
    openFindings: session.findings.filter(
      (finding) => finding.status === 'open' || finding.status === 'planned',
    ).length,
    unresolvedDecisions: session.decisions.filter((decision) => !decision.answer).length,
    harnessDefects: session.harnessDefects?.length ?? 0,
    lastError: session.error,
  };
}

function getCurrentStageName(session: Session): string | null {
  return (
    session.pipelineSnapshot?.stages[session.currentStageIndex]?.name ??
    session.stageHistory.at(-1)?.stageName ??
    null
  );
}

function buildGateResultSummaries(slice: Slice): SliceGateResultSummary[] {
  return slice.exitCriteria.map((criterion) => {
    const checkpoint = slice.verificationCheckpoint?.criteria.find(
      (entry) => entry.criterionId === criterion.id,
    );
    return {
      criterionId: criterion.id,
      criterionType: criterion.type,
      passed: criterion.passed,
      detail: criterion.detail,
      cached: Boolean(checkpoint),
      checkpointCapturedAt: checkpoint?.capturedAt,
    };
  });
}

function explainSliceBlocker(session: Session, sliceIndex: number): Record<string, unknown> {
  const slice = session.slices[sliceIndex];
  const unmetDependencies = slice.dependencies
    .filter((dependency) => session.slices[dependency]?.status !== 'committed')
    .map((dependency) => ({
      sliceNumber: dependency + 1,
      title: session.slices[dependency]?.title ?? `Slice ${dependency + 1}`,
      status: session.slices[dependency]?.status ?? 'missing',
    }));
  const failedCriteria = slice.exitCriteria.filter((criterion) => !criterion.passed);
  const relatedHarnessDefects = (session.harnessDefects ?? []).filter((defect) =>
    failedCriteria.some(
      (criterion) => criterion.id === defect.actor || criterion.type === defect.actor,
    ),
  );
  const blockingReviewFindings =
    slice.review && !slice.review.approved ? slice.review.findings : [];

  if (unmetDependencies.length > 0) {
    return {
      scope: 'slice',
      sliceNumber: sliceIndex + 1,
      title: slice.title,
      status: slice.status,
      blockerType: 'dependency',
      message: `${unmetDependencies.length} dependency slice(s) are not committed yet.`,
      unmetDependencies,
    };
  }

  if (failedCriteria.length > 0) {
    return {
      scope: 'slice',
      sliceNumber: sliceIndex + 1,
      title: slice.title,
      status: slice.status,
      blockerType: 'exit-criteria',
      message: `${failedCriteria.length} exit criterion/criteria are failing.`,
      failingCriteria: failedCriteria.map((criterion) => ({
        criterionId: criterion.id,
        type: criterion.type,
        description: criterion.description,
        detail: criterion.detail,
      })),
      relatedHarnessDefects,
    };
  }

  if (blockingReviewFindings.length > 0) {
    return {
      scope: 'slice',
      sliceNumber: sliceIndex + 1,
      title: slice.title,
      status: slice.status,
      blockerType: 'review',
      message: `${blockingReviewFindings.length} review finding(s) are blocking this slice.`,
      reviewFindings: blockingReviewFindings,
    };
  }

  return {
    scope: 'slice',
    sliceNumber: sliceIndex + 1,
    title: slice.title,
    status: slice.status,
    blockerType: 'none',
    message: 'No explicit blocker detected for this slice.',
  };
}

function matchesFindingQuery(
  finding: Session['findings'][number],
  normalizedQuery: string,
): boolean {
  const haystack = [
    finding.id,
    finding.title,
    finding.description,
    finding.category,
    finding.severity,
    finding.status,
    ...finding.files.map((file) => file.path),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(normalizedQuery);
}

function normalizeSliceIndex(sliceNumber: number, totalSlices: number): number {
  if (!Number.isInteger(sliceNumber) || sliceNumber < 1 || sliceNumber > totalSlices) {
    throw new Error(`sliceNumber must be between 1 and ${totalSlices}`);
  }
  return sliceNumber - 1;
}

function clampLimit(limit: number | undefined, max: number = 50): number {
  if (!Number.isFinite(limit) || limit == null) {
    return 20;
  }
  return Math.max(1, Math.min(Math.trunc(limit), max));
}
