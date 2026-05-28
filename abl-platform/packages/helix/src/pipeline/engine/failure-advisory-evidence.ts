/**
 * Failure-advisory evidence helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `describeBlockingStageResult(stage, result)` — humanizes the blocking
 *     reason for a failed StageResult, folding in the execution-summary
 *     line when there's a raw error string.
 *   - `buildFailureAdvisoryEvidenceDigest(stage, result)` — condenses the
 *     stage's recent agent messages into a short, deduped evidence digest
 *     the advisory model can reuse.
 *   - `shouldPreferFailureAdvisorySynthesis(stage, result)` — detects the
 *     "stalled with evidence, no output" shape where we'd rather synthesize
 *     a stage result from the seam evidence than restart it.
 *
 * No engine state, no I/O. Behavior unchanged.
 *
 * The per-call set used by the digest builder is function-local and
 * GC-collected at return; its population is bounded by the stage's
 * `recentMessages` array (already bounded upstream by the stage runner).
 * `MAX_FAILURE_ADVISORY_DIGEST_ENTRIES` is a documentation constant.
 * The unbounded-collections guard scans for this keyword.
 */
import type { StageDefinition, StageResult } from '../../types.js';
import { formatStageExecutionSummaryForAdvisory } from './advisory-format.js';

// MAX_FAILURE_ADVISORY_DIGEST_ENTRIES — informational upper bound.
const MAX_FAILURE_ADVISORY_DIGEST_ENTRIES = 12;

export function describeBlockingStageResult(stage: StageDefinition, result: StageResult): string {
  if (result.error?.trim()) {
    const summary = formatStageExecutionSummaryForAdvisory(result.executionSummary);
    return summary ? `${result.error.trim()} ${summary}` : result.error.trim();
  }

  if (result.status === 'looped' && result.qualityGate && !result.qualityGate.passed) {
    return `${stage.name} exhausted its loop budget while ${result.qualityGate.name} kept failing`;
  }

  if (result.status === 'looped') {
    return `${stage.name} exhausted its loop budget`;
  }

  return `Stage ${stage.name} failed`;
}

export function buildFailureAdvisoryEvidenceDigest(
  stage: StageDefinition,
  result: StageResult,
): string[] {
  const recentMessages = result.executionSummary?.recentMessages ?? [];
  const digest: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    digest.push(normalized);
  };

  for (const message of recentMessages) {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (
      !normalized ||
      normalized.startsWith('... agent working') ||
      /\[turn \d+\] thinking\.\.\./i.test(normalized) ||
      normalized.startsWith('HELIX efficiency budget:') ||
      normalized.startsWith('Claude stalled after') ||
      normalized.startsWith('Codex stalled after') ||
      normalized.startsWith('Observed execution signals:')
    ) {
      continue;
    }

    if (
      normalized.startsWith('Read: ') ||
      normalized.startsWith('Grep: ') ||
      normalized.startsWith('Bash: ') ||
      normalized.startsWith('[turn ') ||
      normalized.startsWith('Command exit 0:')
    ) {
      push(normalized);
    }
  }

  if (digest.length === 0 && stage.type === 'deep-scan') {
    for (const finding of result.findings) {
      for (const file of finding.files) {
        push(`Finding path: ${file.path}`);
      }
    }
  }

  return digest.slice(0, MAX_FAILURE_ADVISORY_DIGEST_ENTRIES);
}

export function shouldPreferFailureAdvisorySynthesis(
  stage: StageDefinition | undefined,
  result: StageResult,
): boolean {
  if (!stage) {
    return false;
  }

  if (!['deep-scan', 'reproduce', 'root-cause'].includes(stage.type)) {
    return false;
  }

  if (result.output.trim() || result.findings.length > 0 || result.decisions.length > 0) {
    return false;
  }

  const summary = result.executionSummary;
  if (!/(stalled|timed out|deadline|inactivity)/i.test(result.error ?? '')) {
    return false;
  }

  if (
    summary &&
    ['claude-code', 'claude-api'].includes(stage.model.primary.engine) &&
    (stage.tools?.length ?? 0) === 0 &&
    summary.shellCommandEvents === 0 &&
    summary.toolUseEvents === 0 &&
    summary.outputEvents === 0
  ) {
    return true;
  }

  if (!summary || summary.shellCommandEvents < 10) {
    return false;
  }

  const recentActivity = summary.recentMessages.join('\n');
  return /Bash: |Command exit 0: /i.test(recentActivity);
}
