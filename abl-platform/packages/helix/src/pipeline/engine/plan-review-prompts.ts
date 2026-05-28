/**
 * Plan-review-stage prompt builders and synthesis helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `shouldRetryPlanReviewWithSynthesis(result)` — retry-decision
 *     predicate based on stall/timeout/deadline error shapes.
 *   - `buildBroadReplayPlanReviewPrompt(prompt)` — prepends the broad
 *     replay top-priority synthesis header to the initial review prompt.
 *   - `buildPlanReviewSynthesisPrompt(prompt, sourceError)` — prepends the
 *     review-recovery-mode header for synthesis-only retries.
 *   - `buildBroadReplayPlanReviewContinuationResult(session, stageOutput,
 *     sourceError)` — synthesizes an `ExecutorResult` that carries one
 *     plan-review advisory forward when the planner had already produced
 *     a structurally valid slice plan.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { ExecutorResult, Session } from '../../types.js';
import { parseStructuredStageOutputResult } from '../stage-output-parsers.js';

export function shouldRetryPlanReviewWithSynthesis(result: ExecutorResult): boolean {
  if (!result.error) {
    return false;
  }

  return (
    result.timedOut === true ||
    /\b(stalled|timed out|deadline|hard cap|zero-turn shell saturation|shell commands)\b/i.test(
      result.error,
    )
  );
}

export function buildBroadReplayPlanReviewPrompt(prompt: string): string {
  const synthesisHeader = [
    '## TOP PRIORITY BROAD REPLAY PLAN REVIEW',
    'This is a broad historical replay plan review. Start in synthesis mode from the existing findings, slice plan, and replay seam evidence already present in this prompt.',
    'Do not glob directories, inventory the repository tree, inspect source-checkout absolute paths, or reopen the same route/repo/model/test seam files.',
    'Treat the historical changed-file seam and current slice plan as authoritative for this review pass.',
    'If one blocking judgment remains ambiguous, express it as a blocking finding in the `plan-review` JSON instead of doing more rediscovery.',
    'Emit only the final `plan-review` JSON.',
  ].join('\n');

  return `${synthesisHeader}\n\n${prompt}`;
}

export function buildPlanReviewSynthesisPrompt(prompt: string, sourceError: string): string {
  const synthesisHeader = [
    '## TOP PRIORITY REVIEW RECOVERY MODE',
    'You are resuming this plan review only to synthesize the `plan-review` JSON from the proposed slice plan and evidence already in this prompt.',
    'Do not inventory directories, check whether future replay files exist, or rediscover the repository tree.',
    'Trust the replay substitutions and the named route/repo/model/test seam in the evidence packet.',
    'At most one confirming read is allowed, and only if a single blocking judgment remains ambiguous after reading the existing packet.',
    sourceError ? `Previous review failure: ${sourceError}` : '',
    'Emit only the final `plan-review` JSON.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return `${synthesisHeader}\n\n${prompt}`;
}

export function buildBroadReplayPlanReviewContinuationResult(
  session: Session,
  stageOutput: string | undefined,
  sourceError: string,
): ExecutorResult | null {
  if (!stageOutput) {
    return null;
  }

  const parsed = parseStructuredStageOutputResult(stageOutput, 'slice-plan');
  if (!parsed.data) {
    return null;
  }

  const advisoryDescription = sourceError
    ? `Plan Quality review stalled after the planner had already emitted a structurally valid slice plan (${sourceError}). HELIX is carrying one advisory forward and relying on manifest compilation, implementation proof, and later review stages to validate the seam.`
    : 'Plan Quality review stalled after the planner had already emitted a structurally valid slice plan. HELIX is carrying one advisory forward and relying on manifest compilation, implementation proof, and later review stages to validate the seam.';
  const continuationReview = {
    summary:
      'Broad replay continuation review accepted the structurally valid slice plan so the historical replay can progress into implementation.',
    findings: [
      {
        disposition: 'advisory',
        severity: 'low',
        category: 'inconsistency',
        title: 'Plan Quality review deferred for broad historical replay',
        description: advisoryDescription,
        files: [],
      },
    ],
    sliceAssessments: parsed.data.slices.map((slice, index) => ({
      sliceNumber: index + 1,
      verdict: 'approved' as const,
      rationale: `Replay continuation approved this slice to preserve forward progress on the historical seam: ${slice.title}.`,
      requiredTestAmendments: [],
    })),
    deferredFindings: [],
    decisions: [],
  };

  return {
    output: JSON.stringify(continuationReview),
    model: 'claude-sonnet-4-6',
    engine: 'claude-code',
    turnsUsed: 0,
    durationMs: 0,
  };
}
