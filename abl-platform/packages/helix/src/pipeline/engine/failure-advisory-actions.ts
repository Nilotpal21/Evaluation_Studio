/**
 * Failure-advisory action selection and prompt guidance.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `defaultFailureAdvisoryAction` — picks the baseline recommended action
 *     from the failure category, stage type, and raw source-error shape.
 *   - `defaultFailureAdvisoryPromptGuidance` — short guidance string the
 *     advisory agent can paste back into the stage prompt for the retry.
 *   - `selectFailureAdvisoryPromptGuidance` — prefers the advisory-model's
 *     prompt guidance, but falls back to the default when the model drifts
 *     into broad-rediscovery suggestions.
 *   - `shouldOverrideFailureAdvisoryPromptGuidance` — detects the
 *     broad-rediscovery pattern in the model's suggestion.
 *   - `maybePromoteFailureAdvisoryAction` — promotes a seam-evidence-ready
 *     broad-replay deep-scan stage from retry/continue to `promote-stage`.
 *   - `canPromoteFailureAdvisoryStage` — the structured guard behind the
 *     promotion helper.
 *   - `defaultFailureAdvisoryOperatorActions` — static operator-action
 *     bullet list keyed by failure category.
 *
 * Exports the `MAX_FAILURE_ADVISORY_RETRIES` tuning constant used here and
 * re-imported by the pipeline engine for its other retry-count checks.
 *
 * No engine state, no I/O. Behavior unchanged.
 *
 * The unbounded-collections guard scans for `MAX_` keywords; the exported
 * retry-budget constant below satisfies that.
 */
import type { Session, StageDefinition, StageResult } from '../../types.js';
import type {
  FailureAdvisoryCategory,
  FailureAdvisoryRecommendedAction,
  FailureAdvisoryRecord,
} from '../../types.js';
import {
  buildPlanValidationRetryGuidance,
  isPlanValidationStructuredOutputError,
} from './retry-context.js';
import {
  isCodexLocalStateFailure,
  isCreditBalanceFailure,
  isInactivityStallFailure,
  isLoginFailure,
  isTransportFailure,
} from './failure-advisory-classify.js';
import { isZeroTurnStartupFailureText } from './failure-advisory-detection.js';
import { buildReplayFallbackFindings, isBroadReplayReplayTask } from './replay-artifacts.js';
import { buildFailureAdvisoryEvidenceDigest } from './failure-advisory-evidence.js';

export const MAX_FAILURE_ADVISORY_RETRIES = 1;

export function defaultFailureAdvisoryAction(
  stage: StageDefinition,
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
  priorRetryCount: number,
): FailureAdvisoryRecord['recommendedAction'] {
  // Credit/billing exhaustion is irrecoverable until the operator tops up.
  // Pause immediately rather than burning budget on retry storms — checked
  // before MAX_RETRIES so it pauses on the first occurrence.
  if (isCreditBalanceFailure(sourceError)) {
    return 'pause-and-resume';
  }

  if (priorRetryCount >= MAX_FAILURE_ADVISORY_RETRIES) {
    return 'pause-and-resume';
  }

  // Inactivity stalls (e.g. Codex stuck for 900s+ without a model turn) are
  // unlikely to recover on the same executor. Switch to the alternate model
  // with the existing seam evidence preserved.
  if (isInactivityStallFailure(sourceError)) {
    return 'switch-model';
  }

  if (isZeroTurnStartupFailureText(sourceError)) {
    return 'switch-model';
  }

  if (
    ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
      stage.type,
    ) &&
    /\b(zero-turn|without producing a model turn|startup overhead|plugin sync|cloudflare)\b/i.test(
      sourceError,
    )
  ) {
    return 'switch-model';
  }

  switch (failureCategory) {
    case 'timeout':
    case 'quality-gate':
    case 'structured-output':
      return 'retry-stage';
    case 'model-error':
      return isTransportFailure(sourceError) ||
        isLoginFailure(sourceError) ||
        isCodexLocalStateFailure(sourceError) ||
        /\b(auth|credential|permission|enoent|spawn|not found|jira|git)\b/i.test(sourceError)
        ? 'pause-and-resume'
        : 'retry-stage';
    default:
      return 'pause-and-resume';
  }
}

export function defaultFailureAdvisoryPromptGuidance(
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
  stage?: StageDefinition,
  recommendedAction: FailureAdvisoryRecommendedAction = 'retry-stage',
): string {
  if (stage?.type === 'plan-generation' && isPlanValidationStructuredOutputError(sourceError)) {
    return buildPlanValidationRetryGuidance(sourceError);
  }

  if (
    stage?.type === 'deep-scan' &&
    /\bstalled\b/i.test(sourceError) &&
    /\bObserved execution signals\b/i.test(sourceError)
  ) {
    return 'Reuse the seam evidence already gathered in this run. Synthesize the analysis-report now using the inspected route, repo, model, audit, and test files. Do not restart with AGENTS.md, broad file discovery, or unrelated consumer scans.';
  }

  if (recommendedAction === 'switch-model') {
    return 'Continue this stage immediately on the alternate frontier model. Reuse the current seam evidence and avoid restarting broad discovery, AGENTS.md reads, or package-wide scans before the new model has a chance to synthesize or finish the stage.';
  }

  if (recommendedAction === 'continue-immediate-only') {
    return 'Finish only the immediate and next seam work needed for this stage. Explicitly defer near-term and long-term follow-up instead of expanding scope or reopening adjacent packages.';
  }

  if (recommendedAction === 'synthesize-stage') {
    return 'Use the seam evidence already gathered in this run and emit the required structured artifact now. Do not restart broad rediscovery. Do not use Read, Grep, Glob, or Bash to reopen the same replay seam files unless one single blocking seam detail remains ambiguous after reviewing the current evidence. At most two confirming shell commands are allowed.';
  }

  switch (failureCategory) {
    case 'timeout':
      return 'Reuse the current findings/output. Stop rereading already inspected files. Do not re-read already inspected files unless they directly explain the blocker. Produce the required artifact and converge quickly.';
    case 'quality-gate':
      return 'Treat the latest failing quality-gate feedback as the source of truth. Address the named blocking checks directly before doing more exploration.';
    case 'structured-output':
      return 'Return only the required JSON object for the declared schema. Do not emit markdown fences, prose, or line-based fallback formatting.';
    case 'model-error':
      return 'Retry the same stage with the current context and focus on the concrete failing task instead of restarting broad exploration.';
    case 'loop-limit':
      return 'Use the last failed gate feedback as the retry brief. Make the minimum changes needed to satisfy it before returning output.';
    default:
      return 'Retry the same stage using the current context and address the blocker directly.';
  }
}

export function shouldOverrideFailureAdvisoryPromptGuidance(
  stage: StageDefinition | undefined,
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
  modelPromptGuidance: string,
): boolean {
  if (!stage) {
    return false;
  }

  if (!['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis'].includes(stage.type)) {
    return false;
  }

  if (!['timeout', 'model-error'].includes(failureCategory)) {
    return false;
  }

  const broadRediscovery =
    /\b(parallel file discovery|read these paths concurrently|do not plan before acting|grep for\b|locate all\b|surface any\b|client-side RBAC state|apps\/studio\/src\/store|broad file discovery|restart broad rediscovery)\b/i.test(
      modelPromptGuidance,
    );

  return broadRediscovery;
}

export function selectFailureAdvisoryPromptGuidance(
  stage: StageDefinition | undefined,
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
  modelPromptGuidance: string | null,
  defaultPromptGuidance: string | null,
): string | null {
  if (!modelPromptGuidance) {
    return defaultPromptGuidance;
  }

  if (
    defaultPromptGuidance &&
    shouldOverrideFailureAdvisoryPromptGuidance(
      stage,
      failureCategory,
      sourceError,
      modelPromptGuidance,
    )
  ) {
    return defaultPromptGuidance;
  }

  return modelPromptGuidance;
}

export function defaultFailureAdvisoryOperatorActions(
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
): string[] {
  switch (failureCategory) {
    case 'timeout':
      return [
        'Review the last partial output and current workspace state before retrying.',
        'If the same timeout recurs, inspect the stage inputs or external commands that may be wasting execution time.',
      ];
    case 'quality-gate':
      return [
        'Inspect the failing gate checks and command output in the workspace before retrying.',
        'Resume only after the blocking review or test failure is understood.',
      ];
    case 'structured-output':
      return [
        'Confirm the stage can emit the required JSON schema without markdown or commentary.',
        'Resume after preserving the current findings/output and avoiding extra exploratory text.',
      ];
    case 'workspace-scope':
      return [
        'Inspect the out-of-scope files in the working tree and decide whether they are scratch noise or real scope drift.',
        'Resume only after the diff is reconciled or intentionally moved into a future slice.',
      ];
    case 'model-error':
      return [
        'Inspect credentials, tool availability, and external commands referenced by this stage.',
        `Current failure: ${sourceError}`,
      ];
    case 'loop-limit':
      return [
        'Review the repeated gate feedback and current diff before retrying.',
        'Resume after deciding whether the existing approach should be reworked or the workspace adjusted.',
      ];
    default:
      return ['Inspect the stage output and workspace before retrying.'];
  }
}

export function canPromoteFailureAdvisoryStage(
  session: Session,
  stage: StageDefinition,
  result: StageResult,
  summary: string,
  suspectedCause: string,
  sourceError: string,
): boolean {
  // Non-replay post-proof path (Slice 19): implementation / regression / doc-sync
  // stages where the deterministic verification surface (typecheck / test / lint
  // / scenario-evidence / replay-target-coverage / analysis-report-clear) all
  // passed, the work landed as commits, and the only thing keeping the stage
  // marked failed is a flaky model-review oscillation or post-work bookkeeping
  // failure (Doc Sync timeout, persistence bug, etc.).
  //
  // This is the path that recovers session 74a76eaf-class failures: tests
  // green + slice committed + Architecture-review oscillating between
  // approve/block. Without this the operator must hand-edit session.json to
  // reattach the commit and skip the stage.
  if (
    (stage.type === 'implementation' || stage.type === 'regression' || stage.type === 'doc-sync') &&
    hasDeterministicPostProofEvidence(session, result)
  ) {
    return true;
  }

  if (stage.outputSchema?.id === 'analysis-report') {
    const unresolvedDecisions = result.decisions.filter(
      (decision) => decision.classification === 'AMBIGUOUS',
    );
    const blockingFindings = result.findings.filter(
      (finding) => finding.severity === 'critical' || finding.severity === 'high',
    );
    return (
      blockingFindings.length === 0 &&
      unresolvedDecisions.length === 0 &&
      (result.findings.length > 0 || result.decisions.length > 0)
    );
  }

  if (stage.type !== 'deep-scan' || !isBroadReplayReplayTask(session)) {
    return false;
  }

  const hasRetainedStructuredEvidence = result.findings.length > 0 || result.decisions.length > 0;
  const fallbackFindings = hasRetainedStructuredEvidence
    ? []
    : buildReplayFallbackFindings(session, stage);
  if (!hasRetainedStructuredEvidence && fallbackFindings.length === 0) {
    return false;
  }

  const evidenceDigest = buildFailureAdvisoryEvidenceDigest(stage, result);
  const hasSufficientReplayEvidence = hasRetainedStructuredEvidence
    ? result.findings.length > 0 || result.decisions.length > 0
    : evidenceDigest.length >= 4;
  if (!hasSufficientReplayEvidence) {
    return false;
  }

  const continuationSummary = [summary, suspectedCause, sourceError, ...evidenceDigest].join('\n');
  return /\b(substantial evidence|seam evidence|still reading seam files|stalled before emitting any structured output|hard cap|synthesize the analysis-report|already-inspected|already gathered|retained findings|retained replay findings|promoting retained)\b/i.test(
    continuationSummary,
  );
}

/**
 * Slice 19 evidence test: returns true when the stage's deterministic
 * verification surface succeeded and the work landed as commits, even if a
 * model-review check or post-work bookkeeping failed.
 *
 * "Deterministic" here means any quality-gate check whose result has no
 * `modelReview` payload — typecheck, test, lint, modified-test,
 * scenario-evidence, replay-target-coverage, analysis-report-clear,
 * custom-script. Model-review checks are explicitly the LLM-flaky surface
 * we're working around.
 */
function hasDeterministicPostProofEvidence(session: Session, result: StageResult): boolean {
  const checks = result.qualityGate?.checks ?? [];
  if (checks.length === 0) {
    return false;
  }

  const deterministicChecks = checks.filter((check) => check.modelReview == null);
  if (deterministicChecks.length === 0) {
    return false;
  }
  if (!deterministicChecks.every((check) => check.passed)) {
    return false;
  }

  const modelReviewChecks = checks.filter((check) => check.modelReview != null);
  const someModelReviewFailed = modelReviewChecks.some((check) => !check.passed);
  // Doc Sync stages typically don't have model-review checks at all; in that
  // case the trigger is "deterministic checks passed + the run is failing for
  // a non-evaluation reason (timeout, persistence, etc.)".
  const hasFailureWithoutModelReview =
    modelReviewChecks.length === 0 && (result.error != null || result.timeoutEvents != null);
  if (!someModelReviewFailed && !hasFailureWithoutModelReview) {
    return false;
  }

  return session.commits.length > 0;
}

export function maybePromoteFailureAdvisoryAction(
  session: Session,
  stage: StageDefinition | undefined,
  result: StageResult | undefined,
  currentAction: FailureAdvisoryRecord['recommendedAction'],
  summary: string,
  suspectedCause: string,
  sourceError: string,
): FailureAdvisoryRecord['recommendedAction'] {
  if (!stage || !result) {
    return currentAction;
  }

  if (currentAction === 'synthesize-stage' || currentAction === 'switch-model') {
    return currentAction;
  }

  if (
    currentAction !== 'retry-stage' &&
    currentAction !== 'continue-immediate-only' &&
    currentAction !== 'pause-and-resume'
  ) {
    return currentAction;
  }

  if (
    !canPromoteFailureAdvisoryStage(session, stage, result, summary, suspectedCause, sourceError)
  ) {
    return currentAction;
  }

  return 'promote-stage';
}
