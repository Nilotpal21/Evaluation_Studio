import type {
  CommitRecord,
  HelixConfig,
  ModelAssignment,
  ProgressEvent,
  ProgressReporter,
  Session,
  Slice,
} from '../types.js';
import { findOrCreateTicket } from '../integrations/jira-client.js';
import { isRealJiraKey } from '../integrations/jira-bootstrap.js';
import {
  summarizeExitCriteria,
  summarizeTestLock,
  getSliceFiles,
  getSliceReviewScopeEntries,
} from './slice-view.js';
import { now } from './stage-execution-shared.js';
import {
  listChangedWorkspacePaths,
  partitionDeterministicOutOfScopeWorkspacePaths,
} from './workspace-status.js';

interface CommitManagerDeps {
  config: HelixConfig;
  reporter: ProgressReporter;
  emitProgress: (event: ProgressEvent) => void;
  reconcileOutOfScopeChanges?: (
    request: CommitWorkspaceReconcileRequest,
  ) => Promise<CommitWorkspaceReconcileResult>;
}

interface SliceCommitOptions {
  requireApproval?: boolean;
  stageName?: string;
  workspaceReconcileModel?: ModelAssignment;
  checkpointSummary?: Record<string, unknown>;
  checkpointTelemetry?: {
    approvalWaitMs?: number;
  };
}

interface CommitWorkspaceReconcileRequest {
  session: Session;
  slice: Slice;
  sliceIndex: number;
  stageName: string;
  modelAssignment: ModelAssignment;
  reviewScopeEntries: string[];
  actualChangedFiles: string[];
  outOfScopeChanges: string[];
}

interface CommitWorkspaceReconcileResult {
  summary: string;
  ignoredFiles: string[];
  blockingFiles: string[];
}

export class CommitManager {
  constructor(private readonly deps: CommitManagerDeps) {}

  /**
   * Commit the current slice's changes via git.
   * GUARD: Only commits if the slice's test lock is engaged.
   */
  async performSliceCommit(
    session: Session,
    slice: Slice,
    sliceIndex: number,
    options: SliceCommitOptions = {},
  ): Promise<CommitRecord | null> {
    if (!slice.testLock.locked) {
      this.deps.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: 'commit',
        message: `Refusing to commit slice ${sliceIndex + 1} — test lock not engaged`,
      });
      return null;
    }

    const sliceFiles = getSliceFiles(slice);

    const requireApproval = options.requireApproval ?? !this.deps.config.autoCommit;
    if (requireApproval) {
      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Commit checkpoint opened for slice ${sliceIndex + 1}: ${slice.title}`,
      });
      const checkpointStartedAt = Date.now();
      const approved = await this.deps.reporter.onCheckpoint(
        `Commit slice ${sliceIndex + 1}: ${slice.title}?`,
        {
          sliceDescription: slice.description,
          dependencies: slice.dependencies.map((dependencyIndex) => `Slice ${dependencyIndex + 1}`),
          files: sliceFiles,
          findings: slice.findings.length,
          requiredTests: slice.testLock.requiredTests.map((test) => ({
            path: test.testFile,
            status: test.status,
            description: test.description,
          })),
          regressionTests: slice.testLock.regressionSuite,
          testLock: summarizeTestLock(slice.testLock),
          exitCriteria: summarizeExitCriteria(slice),
          exitCriteriaItems: slice.exitCriteria.map((criterion) => ({
            id: criterion.id,
            passed: criterion.passed,
            detail: criterion.detail,
          })),
          ...options.checkpointSummary,
        },
      );
      if (options.checkpointTelemetry) {
        options.checkpointTelemetry.approvalWaitMs = Date.now() - checkpointStartedAt;
      }
      if (!approved) {
        this.deps.emitProgress({
          type: 'commit',
          timestamp: now(),
          stage: 'commit',
          message: `Commit checkpoint rejected for slice ${sliceIndex + 1}`,
        });
        return null;
      }
      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Commit checkpoint approved for slice ${sliceIndex + 1}`,
      });
    }

    const { exec } = await import('node:child_process');
    const { access } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    let jiraKey = session.workItem.jiraKey;
    if (!isRealJiraKey(jiraKey)) {
      // Attempt to find or create a JIRA ticket automatically
      this.deps.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'commit',
        message: 'No JIRA key — attempting to find or create a ticket…',
      });
      try {
        const resolved = await findOrCreateTicket(session);
        if (isRealJiraKey(resolved)) {
          jiraKey = resolved;
          session.workItem.jiraKey = resolved;
          this.deps.emitProgress({
            type: 'stage-progress',
            timestamp: now(),
            stage: 'commit',
            message: `Resolved JIRA ticket: ${resolved}`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.emitProgress({
          type: 'error',
          timestamp: now(),
          stage: 'commit',
          message: `JIRA auto-resolve failed: ${msg}`,
        });
      }
    }
    if (!isRealJiraKey(jiraKey)) {
      this.deps.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: 'commit',
        message:
          'Commit skipped: a real JIRA key is required for autonomous commits (auto-create failed or no credentials)',
      });
      return null;
    }

    const changedFiles = await listChangedWorkspacePaths(this.deps.config.workDir);
    const reviewScopeEntries = getSliceReviewScopeEntries(slice);
    const allowedFiles = new Set<string>([...reviewScopeEntries]);
    const baselineDirtySet = new Set(session.verificationBootstrap?.dirtyWorkspaceFiles ?? []);
    const effectiveChangedFiles = changedFiles.filter(
      (file) => allowedFiles.has(file) || !baselineDirtySet.has(file),
    );
    const filesToStage = effectiveChangedFiles.filter((file) => allowedFiles.has(file));
    let outOfScopeChanges = effectiveChangedFiles.filter((file) => !allowedFiles.has(file));
    const deterministicClassification =
      partitionDeterministicOutOfScopeWorkspacePaths(outOfScopeChanges);
    let reconcileSummary =
      deterministicClassification.ignoredFiles.length > 0
        ? `Ignored ${deterministicClassification.ignoredFiles.length} deterministic tool-owned out-of-scope file(s).`
        : undefined;
    outOfScopeChanges = deterministicClassification.blockingFiles;

    if (
      outOfScopeChanges.length > 0 &&
      this.deps.reconcileOutOfScopeChanges &&
      options.workspaceReconcileModel
    ) {
      const assessment = await this.deps.reconcileOutOfScopeChanges({
        session,
        slice,
        sliceIndex,
        stageName: options.stageName ?? 'commit',
        modelAssignment: options.workspaceReconcileModel,
        reviewScopeEntries,
        actualChangedFiles: effectiveChangedFiles,
        outOfScopeChanges,
      });
      reconcileSummary = [reconcileSummary, assessment.summary].filter(Boolean).join(' ');
      outOfScopeChanges = assessment.blockingFiles;
    }

    if (outOfScopeChanges.length > 0) {
      this.deps.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: 'commit',
        message: [
          `Commit blocked: ${outOfScopeChanges.length} out-of-scope files in working tree must be reconciled before slice ${sliceIndex + 1} can commit: ${outOfScopeChanges.slice(0, 5).join(', ')}`,
          reconcileSummary ? `Workspace reconcile: ${reconcileSummary}` : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
      return null;
    }

    if (filesToStage.length === 0) {
      return null;
    }

    const prettierTargets: string[] = [];
    for (const file of filesToStage) {
      if (!isPrettierCandidate(file)) continue;
      try {
        await access(resolve(this.deps.config.workDir, file));
        prettierTargets.push(file);
      } catch {
        // Deleted files should still be staged, but don't send them to prettier.
      }
    }

    const commitType = inferCommitType(session.workItem.type);
    const commitMsg = `[${jiraKey}] ${commitType}(${inferScope(sliceFiles)}): ${slice.title}`;

    try {
      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Preparing slice ${sliceIndex + 1} for commit (${filesToStage.length} file${filesToStage.length === 1 ? '' : 's'})`,
      });
      if (prettierTargets.length > 0) {
        this.deps.emitProgress({
          type: 'commit',
          timestamp: now(),
          stage: 'commit',
          message: `Formatting ${prettierTargets.length} staged file${prettierTargets.length === 1 ? '' : 's'} before commit`,
        });
        await execAsync(
          `npx prettier --write --ignore-unknown -- ${prettierTargets.map(shellQuote).join(' ')}`,
          {
            cwd: this.deps.config.workDir,
          },
        );
      }

      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Staging slice ${sliceIndex + 1} files`,
      });
      await execAsync(`git add -- ${filesToStage.map(shellQuote).join(' ')}`, {
        cwd: this.deps.config.workDir,
      });

      const { stdout: diffStat } = await execAsync('git diff --cached --stat', {
        cwd: this.deps.config.workDir,
      });
      if (!diffStat.trim()) return null;

      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Creating commit for slice ${sliceIndex + 1}`,
        details: {
          commitMessage: commitMsg,
        },
      });
      await execAsync(`git commit -m ${JSON.stringify(commitMsg)}`, {
        cwd: this.deps.config.workDir,
      });
      const { stdout: shaOut } = await execAsync('git rev-parse HEAD', {
        cwd: this.deps.config.workDir,
      });
      const sha = shaOut.trim();
      this.deps.emitProgress({
        type: 'commit',
        timestamp: now(),
        stage: 'commit',
        message: `Committed slice ${sliceIndex + 1} as ${sha.slice(0, 7)}`,
        details: {
          commitMessage: commitMsg,
        },
      });

      this.deps.emitProgress({
        type: 'stage-progress',
        timestamp: now(),
        stage: 'commit',
        message:
          'Deferred JIRA comment until final scenario evidence is available; per-ticket comments must include exact evidence artifacts.',
      });

      return {
        sha,
        message: commitMsg,
        jiraKey,
        sliceIndex,
        files: sliceFiles,
        timestamp: now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.emitProgress({
        type: 'error',
        timestamp: now(),
        stage: 'commit',
        message: `Commit failed: ${msg}`,
      });
      return null;
    }
  }
}

function inferScope(files: string[]): string {
  const scopes = new Set<string>();
  for (const file of files) {
    const match = file.match(/^(?:apps|packages)\/([^/]+)/);
    if (match) scopes.add(match[1]);
  }
  if (scopes.size === 0) return 'core';
  if (scopes.size === 1) return [...scopes][0];
  return [...scopes].slice(0, 2).join(',');
}

function inferCommitType(workItemType: Session['workItem']['type']): 'feat' | 'fix' {
  switch (workItemType) {
    case 'enhancement':
    case 'new-feature':
      return 'feat';
    case 'bug-fix':
    case 'feature-audit':
    default:
      return 'fix';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isPrettierCandidate(file: string): boolean {
  return /\.(?:[cm]?js|jsx|ts|tsx|json|md|ya?ml|css|scss|html)$/i.test(file);
}
