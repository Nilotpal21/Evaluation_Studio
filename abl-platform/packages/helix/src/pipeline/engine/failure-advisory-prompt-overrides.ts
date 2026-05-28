/**
 * Failure-advisory stage.prompt override appliers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`. Each applier
 * mutates the supplied `stage` in place by prepending a recovery-mode
 * header to `stage.prompt` (or replacing it with the compact replay
 * recovery prompt when `shouldUseCompactReplayRecoveryPrompt` fires).
 *
 *   - `applyFailureAdvisorySynthesisPromptOverride(stage, advisory,
 *     session)` — top-priority recovery header for synthesis retries.
 *     Falls through to the compact replay recovery prompt when the
 *     stage+session+advisory match the cold-start / zero-tool-use
 *     pattern.
 *   - `applyFailureAdvisoryRetryPromptOverride(stage, advisory, session)`
 *     — recovery header for generic failure-advisory retries, with
 *     extra seam-preservation lines when the stage is a replay analysis
 *     stage.
 *   - `applyFailureAdvisoryImmediateOnlyPromptOverride(stage, advisory,
 *     session)` — immediate-only continuation header that narrows the
 *     retry to immediate/next horizons and defers near-term/long-term
 *     scope.
 *   - `applyFailureAdvisoryEvidenceOnlyRetryPromptOverride(stage,
 *     advisory, session)` — evidence-only header for retries on the
 *     restored original model. Also falls through to the compact replay
 *     recovery prompt when applicable.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { FailureAdvisoryRecord, Session, StageDefinition } from '../../types.js';
import { defaultPrompts } from '../default-stage-prompts.js';
import {
  buildCompactReplayRecoveryPrompt,
  shouldUseCompactReplayRecoveryPrompt,
} from './recovery-prompts.js';

function prependRecoveryHeader(stage: StageDefinition, header: string): void {
  const basePrompt = stage.prompt ?? defaultPrompts[stage.type];
  stage.prompt = basePrompt ? `${header}\n\n${basePrompt}` : header;
}

export function applyFailureAdvisorySynthesisPromptOverride(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): void {
  const retryGuidance = advisory.promptGuidance?.trim();
  if (shouldUseCompactReplayRecoveryPrompt(stage, advisory, session)) {
    stage.prompt = buildCompactReplayRecoveryPrompt(
      'TOP PRIORITY RECOVERY MODE',
      stage,
      advisory,
      session,
    );
    return;
  }

  const synthesisHeader = [
    '## TOP PRIORITY RECOVERY MODE',
    'You are resuming this stage only to synthesize the structured artifact from seam evidence that is already gathered.',
    'This recovery directive overrides any earlier generic instruction to read AGENTS.md, CLAUDE.md, or restart broad discovery.',
    'Do not read AGENTS.md, CLAUDE.md, docs, journals, or unrelated package files on this retry.',
    'Tool use is disabled on this retry. Synthesize the structured output directly from the already-gathered seam evidence.',
    'Do not use Read, Grep, Glob, or Bash to reopen the same replay seam files on this retry.',
    'Do not inspect source-checkout absolute paths. Only reason over the seam evidence already gathered in the current replay workspace.',
    'Do not reopen the same seam files in line-number windows on this retry.',
    'If the already-read seam evidence supports a finding, emit the structured output immediately instead of gathering more evidence.',
    stage.type === 'plan-generation'
      ? 'For plan generation, emit the complete slice-plan JSON now from the findings registry, planning batches, and already-read seam files. Do not verify one more consumer before you plan.'
      : '',
    retryGuidance ? `Recovery guidance: ${retryGuidance}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  prependRecoveryHeader(stage, synthesisHeader);
}

export function applyFailureAdvisoryRetryPromptOverride(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): void {
  const retryGuidance = advisory.promptGuidance?.trim();
  const isReplayAnalysisStage =
    ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis'].includes(stage.type) &&
    (session.replayContext?.changedFiles?.length ?? 0) > 0;
  const retryHeader = [
    '## FAILURE ADVISORY RECOVERY MODE',
    'Resume from the existing stage evidence and the failure advisory before falling back to any generic startup routine.',
    'Treat the failure advisory guidance as higher priority than generic instructions to re-read AGENTS.md, CLAUDE.md, docs, or broad repo context.',
    isReplayAnalysisStage
      ? 'Do not restart with AGENTS.md, CLAUDE.md, docs, or unrelated package files on this retry unless the failure advisory explicitly requires missing context.'
      : '',
    isReplayAnalysisStage
      ? 'Continue from the already-gathered replay seam evidence and only gather new context if the failure advisory says the seam evidence is insufficient.'
      : '',
    retryGuidance ? `Recovery guidance: ${retryGuidance}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  prependRecoveryHeader(stage, retryHeader);
}

export function applyFailureAdvisoryImmediateOnlyPromptOverride(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): void {
  const retryGuidance = advisory.promptGuidance?.trim();
  const immediateOnlyHeader = [
    '## IMMEDIATE-ONLY CONTINUATION MODE',
    'Complete only the immediate and next work needed to finish this stage.',
    'Defer near-term and long-term follow-up instead of broadening scope inside this retry.',
    'If the current evidence already supports completion for the immediate seam, synthesize or finalize now instead of reopening adjacent surfaces.',
    ['oracle-analysis', 'plan-generation', 'implementation'].includes(stage.type)
      ? 'Treat immediate and next findings as in-scope. Explicitly defer near-term and long-term findings into a later follow-up audit or implementation pass.'
      : '',
    (session.replayContext?.changedFiles?.length ?? 0) > 0
      ? 'Replay seam guidance remains authoritative. Do not fan out into additional packages or helper families unless the immediate seam cannot complete without them.'
      : '',
    retryGuidance ? `Recovery guidance: ${retryGuidance}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  prependRecoveryHeader(stage, immediateOnlyHeader);
}

export function applyFailureAdvisoryEvidenceOnlyRetryPromptOverride(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): void {
  const retryGuidance = advisory.promptGuidance?.trim();
  if (shouldUseCompactReplayRecoveryPrompt(stage, advisory, session)) {
    stage.prompt = buildCompactReplayRecoveryPrompt(
      'EVIDENCE-ONLY RECOVERY MODE',
      stage,
      advisory,
      session,
    );
    return;
  }

  const retryHeader = [
    '## EVIDENCE-ONLY RECOVERY MODE',
    'Retry this stage on the restored original model, but synthesize only from the replay seam evidence already gathered.',
    'This recovery directive overrides any generic startup routine that would re-read AGENTS.md, CLAUDE.md, docs, or broad repo context.',
    'Tool use is disabled on this retry. Do not reopen the same seam files or restart broad rediscovery.',
    'Emit the required structured artifact now from the route, repo, model, audit, and test evidence already inspected.',
    retryGuidance ? `Recovery guidance: ${retryGuidance}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  prependRecoveryHeader(stage, retryHeader);
}
