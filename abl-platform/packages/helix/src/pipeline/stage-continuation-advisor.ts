import type { StageDefinition, StageResult } from '../types.js';

export type DeterministicStageContinuationMode = 'synthesize-from-evidence';

export interface DeterministicStageContinuationPlan {
  decision: 'retry' | 'stop';
  mode?: DeterministicStageContinuationMode;
  reason?: string;
}

export interface DeterministicStageContinuationInput {
  stage: Pick<StageDefinition, 'type'>;
  result: Pick<
    StageResult,
    'status' | 'error' | 'output' | 'findings' | 'decisions' | 'executionSummary'
  >;
  priorFailures: number;
  isBroadReplayTask: boolean;
}

const DETERMINISTIC_STAGE_TYPES = new Set<StageDefinition['type']>([
  'deep-scan',
  'reproduce',
  'root-cause',
]);

export function isDeterministicStageContinuationStage(
  stage: Pick<StageDefinition, 'type'>,
): boolean {
  return DETERMINISTIC_STAGE_TYPES.has(stage.type);
}

export function decideDeterministicStageContinuation(
  input: DeterministicStageContinuationInput,
): DeterministicStageContinuationPlan {
  if (!isDeterministicStageContinuationStage(input.stage)) {
    return { decision: 'stop' };
  }

  // Allow up to 2 deterministic synthesis retries before giving up — the
  // first synthesis attempt sometimes still hits the shell budget (esp. on
  // Codex), and a second strict-synthesis pass usually clears it without
  // forcing the operator to re-run `helix resume` manually.
  if (input.priorFailures >= 2) {
    return { decision: 'stop' };
  }

  if (!hasSynthesizableEvidence(input.result)) {
    return { decision: 'stop' };
  }

  if (!input.isBroadReplayTask && !shouldUseGeneralEvidenceContinuation(input.result)) {
    return { decision: 'stop' };
  }

  return {
    decision: 'retry',
    mode: 'synthesize-from-evidence',
    reason: input.isBroadReplayTask
      ? 'Broad replay analysis already gathered enough seam evidence to synthesize the structured artifact without another advisory loop.'
      : 'The stage already gathered enough seam evidence before HELIX stopped broad exploration, so retry once in deterministic synthesis mode instead of restarting discovery.',
  };
}

function hasSynthesizableEvidence(
  result: Pick<
    StageResult,
    'output' | 'findings' | 'decisions' | 'executionSummary' | 'error' | 'status'
  >,
): boolean {
  if (result.output.trim().length > 0) {
    return true;
  }

  if (result.findings.length > 0 || result.decisions.length > 0) {
    return true;
  }

  if (
    /\b(shell commands without producing a model turn|shell-only startup without producing a model turn|zero-turn|seam evidence already gathered)\b/i.test(
      result.error ?? '',
    )
  ) {
    return true;
  }

  if (shouldUseGeneralEvidenceContinuation(result)) {
    return true;
  }

  const summary = result.executionSummary;
  if (!summary) {
    return false;
  }

  if (summary.outputEvents > 0 || summary.toolUseEvents > 0) {
    return true;
  }

  if (summary.shellCommandEvents >= 1) {
    return true;
  }

  if (result.status === 'looped' && /\bquality gate failed\b/i.test(result.error ?? '')) {
    return true;
  }

  return false;
}

function shouldUseGeneralEvidenceContinuation(
  result: Pick<StageResult, 'error' | 'executionSummary'>,
): boolean {
  const error = result.error ?? '';
  const summary = result.executionSummary;

  const helixExplorationStop =
    /\b(shell exploration budget|exploration budget|too many shell exploration commands|hard cap reached|HELIX efficiency hard cap|exceeding HELIX's shell exploration budget)\b/i.test(
      error,
    );

  if (!helixExplorationStop) {
    return false;
  }

  const explicitShellCount = extractExplorationCommandCount(error);
  if (explicitShellCount !== null && explicitShellCount >= 10) {
    return true;
  }

  if (!summary) {
    return false;
  }

  return (
    summary.shellCommandEvents >= 8 ||
    summary.toolUseEvents >= 8 ||
    summary.outputEvents >= 8 ||
    summary.recentMessages.length >= 8
  );
}

function extractExplorationCommandCount(error: string): number | null {
  const issuedMatch = error.match(/issued\s+(\d+)\s+exploratory shell commands/i);
  if (issuedMatch) {
    return Number.parseInt(issuedMatch[1] ?? '', 10);
  }

  const repeatedMatch = error.match(/too many shell exploration commands\s*\((\d+)\)/i);
  if (repeatedMatch) {
    return Number.parseInt(repeatedMatch[1] ?? '', 10);
  }

  return null;
}
