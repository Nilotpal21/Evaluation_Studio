/**
 * Failure-advisory promotion-output builders.
 *
 * Pure async helpers extracted verbatim from `pipeline-engine.ts`. They
 * compose the structured output that the orchestrator substitutes into a
 * failed stage when a failure advisory has been promoted to `promote-stage`.
 * Semantics unchanged — control flow mirrors the original private methods.
 *
 *   - `buildFailureAdvisoryPromotionOutput(workDir, session, stage, advisory, result)` —
 *     top-level entry point. For `deep-scan` stages under a broad-replay task,
 *     serializes an `AnalysisStageOutput` from the findings and decisions in
 *     the passed `StageResult` (falling back to `buildReplayFallbackFindings`
 *     when the stage reported none). Otherwise delegates to
 *     `buildReplayPostProofPromotionOutput`.
 *   - `buildReplayPostProofPromotionOutput(workDir, session, stage, advisory, result)` —
 *     emits a human-readable summary when the replay context, advisory text,
 *     and workspace evidence together confirm that a post-proof stage (e.g.
 *     implementation/testing/regression/doc-sync) already completed its
 *     primary work. Returns `null` when any prerequisite fails.
 *
 * `captureReplayPostProofCommits` (used by the second function) lives in
 * `./git-capture.ts` alongside the other `git log`/`git diff` helpers.
 *
 * No engine state, no I/O beyond the wrapped git / workspace-status helpers.
 */
import type {
  AnalysisStageOutput,
  FailureAdvisoryRecord,
  Session,
  StageDefinition,
  StageResult,
} from '../../types.js';
import { captureBlockingWorkspaceChanges, captureReplayPostProofCommits } from './git-capture.js';
import { buildReplayFallbackFindings, isBroadReplayReplayTask } from './replay-artifacts.js';

export async function buildFailureAdvisoryPromotionOutput(
  workDir: string,
  session: Session,
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  result: StageResult,
): Promise<string | null> {
  const structuredAnalysisPromotion = buildStructuredAnalysisPromotionOutput(
    stage,
    advisory,
    result,
  );
  if (structuredAnalysisPromotion) {
    return structuredAnalysisPromotion;
  }

  if (stage.type === 'deep-scan' && isBroadReplayReplayTask(session)) {
    const promotedFindings =
      result.findings.length > 0 ? result.findings : buildReplayFallbackFindings(session, stage);
    if (promotedFindings.length === 0 && result.decisions.length === 0) {
      return null;
    }

    const structured: AnalysisStageOutput = {
      summary: `Promoted ${stage.name} from replay seam evidence. ${advisory.summary}`.trim(),
      findings: promotedFindings.map((finding) => ({
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        description: finding.description,
        files: finding.files.map((file) => file.path),
      })),
      decisions: result.decisions.map((decision) => ({
        classification: decision.classification,
        question: decision.question,
        context: decision.context ?? null,
        answer: decision.answer ?? null,
      })),
    };

    return JSON.stringify(structured, null, 2);
  }

  const replayPath = await buildReplayPostProofPromotionOutput(
    workDir,
    session,
    stage,
    advisory,
    result,
  );
  if (replayPath != null) {
    return replayPath;
  }

  return buildNonReplayPostProofPromotionOutput(stage, advisory, result, session);
}

/**
 * Slice 19: non-replay post-proof promotion output.
 *
 * Used when an implementation/regression/doc-sync stage's deterministic
 * verification surface succeeded and the work landed, but a flaky model-review
 * check or post-work bookkeeping kept the stage marked failed. The output is
 * a human-readable summary; the caller substitutes it as the stage's `output`
 * field after marking the stage `passed`.
 *
 * Returns `null` when prerequisites are not met (the predicate
 * `canPromoteFailureAdvisoryStage` should have already filtered those out,
 * but we re-verify here for defense in depth).
 */
function buildNonReplayPostProofPromotionOutput(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  result: StageResult,
  session: Session,
): string | null {
  if (stage.type !== 'implementation' && stage.type !== 'regression' && stage.type !== 'doc-sync') {
    return null;
  }

  if (advisory.recommendedAction !== 'promote-stage') {
    return null;
  }

  const checks = result.qualityGate?.checks ?? [];
  const deterministicChecks = checks.filter((check) => check.modelReview == null);
  if (deterministicChecks.length === 0 || !deterministicChecks.every((check) => check.passed)) {
    return null;
  }
  if (session.commits.length === 0) {
    return null;
  }

  const failedModelReviews = checks.filter((check) => check.modelReview != null && !check.passed);

  const lines = [
    `Promoted ${stage.name} from non-replay post-proof evidence.`,
    advisory.summary || `Deterministic verification passed; the stage's work landed as commits.`,
  ];

  lines.push(`Deterministic checks (${deterministicChecks.length}) all passed:`);
  for (const check of deterministicChecks) {
    lines.push(`- ✓ ${check.name}`);
  }

  if (failedModelReviews.length > 0) {
    lines.push(
      `Failing model-review checks (${failedModelReviews.length}) treated as advisory rather than blocking once deterministic evidence confirmed the work landed:`,
    );
    for (const check of failedModelReviews) {
      lines.push(`- ⚠ ${check.name}`);
    }
  }

  const recentCommits = session.commits.slice(-5);
  lines.push(`Commits landed in this session (${session.commits.length}):`);
  for (const commit of recentCommits) {
    lines.push(`- ${commit.sha.slice(0, 7)} ${commit.message.split('\n')[0]}`);
  }
  if (session.commits.length > recentCommits.length) {
    lines.push(`- …and ${session.commits.length - recentCommits.length} earlier commit(s)`);
  }

  return lines.join('\n');
}

function buildStructuredAnalysisPromotionOutput(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  result: StageResult,
): string | null {
  if (
    stage.outputSchema?.id !== 'analysis-report' ||
    advisory.recommendedAction !== 'promote-stage'
  ) {
    return null;
  }

  const unresolvedDecisions = result.decisions.filter(
    (decision) => decision.classification === 'AMBIGUOUS',
  );
  const blockingFindings = result.findings.filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  );
  if (blockingFindings.length > 0 || unresolvedDecisions.length > 0) {
    return null;
  }

  if (result.findings.length === 0 && result.decisions.length === 0) {
    return null;
  }

  const structured: AnalysisStageOutput = {
    summary: `Promoted ${stage.name} from failure advisory evidence. ${advisory.summary}`.trim(),
    findings: result.findings.map((finding) => ({
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      description: finding.description,
      files: finding.files.map((file) => file.path),
    })),
    decisions: result.decisions.map((decision) => ({
      classification: decision.classification,
      question: decision.question,
      context: decision.context ?? null,
      answer: decision.answer ?? null,
    })),
  };

  return JSON.stringify(structured, null, 2);
}

export async function buildReplayPostProofPromotionOutput(
  workDir: string,
  session: Session,
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  result: StageResult,
): Promise<string | null> {
  if (
    !session.replayContext ||
    !['implementation', 'testing', 'regression', 'doc-sync'].includes(stage.type)
  ) {
    return null;
  }

  if (advisory.recommendedAction !== 'promote-stage') {
    return null;
  }

  const advisoryText = [advisory.summary, advisory.suspectedCause, advisory.sourceError]
    .filter(Boolean)
    .join('\n');
  const postProofPattern =
    stage.type === 'doc-sync'
      ? /documentation targets? (?:were )?(?:fully )?updated|docs? (?:were )?(?:fully )?updated|post-(?:completion|doc)(?:[-\s]+)?(?:documentation|bookkeeping|housekeeping)|agents\.md|journal|feature spec|lld|plan/i
      : /implementation complete and all tests green|completed (?:its )?primary work|all \d+[^.\n]*tests?.*(?:passed|confirmed passing|green)|tests?\s+(?:passed|confirmed passing|already passed|already green|passed green)|tests written and committed|post-(?:completion|test)(?:[-\s]+)?(?:documentation|bookkeeping|housekeeping)|agents\.md|prettier|git diff|jira/i;
  if (!postProofPattern.test(advisoryText)) {
    return null;
  }

  const qualityGatePassed = result.qualityGate?.passed === true;
  const lastRecordedCommitSha = session.commits.at(-1)?.sha ?? session.workspaceBaseline?.headSha;
  const postProofCommits =
    lastRecordedCommitSha == null
      ? []
      : await captureReplayPostProofCommits(workDir, lastRecordedCommitSha);
  const blockingWorkspaceChanges = await captureBlockingWorkspaceChanges(workDir);
  const durableWorkspaceProofPattern =
    stage.type === 'doc-sync'
      ? /\bdocumentation targets? (?:were )?(?:fully )?updated\b|\bdocs? (?:were )?(?:fully )?updated\b|\bfeature spec\b|\bagents\.md\b|\bjournal\b|\bplan\b/i
      : /\ball \d+[^.\n]*tests?.*(?:passed|confirmed passing|green)\b|\btests?\s+(?:passed|confirmed passing|already passed|already green|passed green)\b|\bcompleted (?:its )?primary (?:verification|work)\b|\btests written and committed\b/i;
  const hasDurableWorkspaceProof =
    blockingWorkspaceChanges.length > 0 && durableWorkspaceProofPattern.test(advisoryText);

  if (postProofCommits.length === 0 && !hasDurableWorkspaceProof) {
    return null;
  }

  const summaryLines = [
    `Promoted ${stage.name} from replay post-proof evidence.`,
    advisory.summary,
    stage.type === 'doc-sync'
      ? 'Replay documentation sync is non-blocking once the target artifacts are already written.'
      : qualityGatePassed
        ? 'The recorded quality gate is green.'
        : 'The replay worktree is already at a verified post-proof checkpoint.',
  ];

  if (blockingWorkspaceChanges.length === 0) {
    summaryLines.push(
      'No blocking tracked workspace changes remain after the replay stage completed.',
    );
  } else {
    summaryLines.push('Replay workspace still contains verified post-proof stage artifacts:');
    summaryLines.push(...blockingWorkspaceChanges.map((file) => `- ${file}`));
  }

  if (postProofCommits.length > 0) {
    summaryLines.push('Post-proof commits:');
    summaryLines.push(
      ...postProofCommits.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}`),
    );
  }

  return summaryLines.join('\n');
}
