/**
 * Compact-replay and deterministic-continuation recovery prompt builders.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `shouldUseCompactReplayRecoveryPrompt(stage, advisory, session)` —
 *     gate predicate: true when the stage is one of the replay-capable
 *     stages, the session has recorded a replay seam, and the advisory
 *     text matches any of the cold-start / zero-tool-use / hard-cap
 *     signatures enumerated inline.
 *   - `buildCompactReplayRecoveryPrompt(mode, stage, advisory, session)` —
 *     assembles the full recovery prompt (seam files, evidence digest,
 *     open findings registry, planning batches, final emit instruction)
 *     from the advisory and session replay context.
 *   - `buildDeterministicStageContinuationPrompt(stage, session, result)` —
 *     assembles the deterministic-continuation prompt using the failure
 *     advisory evidence digest for the gathered seam.
 *   - `formatCompactPlanFindingsRegistry(findings)` — renders the plan
 *     findings registry as fenced JSON with horizon defaults applied.
 *   - `inferDefaultFindingHorizon(severity)` — maps a finding severity
 *     onto a default horizon (immediate/next/near-term/long-term).
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type {
  FailureAdvisoryRecord,
  Finding,
  Session,
  StageDefinition,
  StageResult,
} from '../../types.js';
import { formatPlanningBatches } from '../planning-batches.js';
import { getFollowUpPlanFindings, getVisiblePlanFindings } from '../plan-review-state.js';
import { buildFailureAdvisoryEvidenceDigest } from './failure-advisory-evidence.js';

export function shouldUseCompactReplayRecoveryPrompt(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): boolean {
  if (!['deep-scan', 'reproduce', 'root-cause', 'plan-generation'].includes(stage.type)) {
    return false;
  }

  const changedFiles = session.replayContext?.changedFiles?.length ?? 0;
  if (changedFiles === 0) {
    return false;
  }

  const replaySummary = [
    advisory.summary,
    advisory.suspectedCause,
    advisory.sourceError,
    advisory.promptGuidance ?? '',
  ].join('\n');

  return /\b(cold-start hang|stalled at startup|zero tool use|zero tool-use|zero tool calls|zero shell commands|zero output|zero work was completed|never issued a single tool call|produced no output before the inactivity timeout|startup hang|hard cap|never produced output|timed out before emitting complete json output|sufficient evidence for plan synthesis|tooluse\s*=\s*0|shellcommands\s*=\s*0)\b/i.test(
    replaySummary,
  );
}

export function buildCompactReplayRecoveryPrompt(
  mode: 'TOP PRIORITY RECOVERY MODE' | 'EVIDENCE-ONLY RECOVERY MODE',
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): string {
  const seamFiles = (session.replayContext?.changedFiles ?? [])
    .slice(0, 12)
    .map((filePath) => `- ${filePath}`)
    .join('\n');
  const tags = (session.replayContext?.tags ?? []).filter(Boolean);
  const evidenceDigest = (advisory.evidenceDigest ?? [])
    .slice(0, 10)
    .map((entry) => `- ${entry}`)
    .join('\n');
  const openFindingsRegistry =
    stage.type === 'plan-generation'
      ? formatCompactPlanFindingsRegistry(getVisiblePlanFindings(session))
      : '';
  const followUpFindings =
    stage.type === 'plan-generation'
      ? formatCompactPlanFindingsRegistry(getFollowUpPlanFindings(session))
      : '';
  const planningBatches = stage.type === 'plan-generation' ? formatPlanningBatches(session) : '';
  const lines = [
    `## ${mode}`,
    `Stage: ${stage.name}`,
    `Work item: ${session.workItem.title}`,
    `Replay tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`,
    'Synthesize the structured result only from the replay seam evidence already gathered in this run.',
    'Do not restart with AGENTS.md, CLAUDE.md, docs, code maps, or broad repo discovery.',
    'Tool use is disabled. Emit the structured artifact directly from the known route/repo/model/test seam and any already-confirmed missing future files.',
    '',
    '## Historical Replay Seam',
    seamFiles || '- (no explicit replay seam files recorded)',
    '',
    '## Failure Advisory',
    `Summary: ${advisory.summary}`,
    `Cause: ${advisory.suspectedCause}`,
    advisory.promptGuidance ? `Retry guidance: ${advisory.promptGuidance}` : '',
    '',
    '## Gathered Seam Evidence',
    evidenceDigest || '- (no retained evidence digest)',
    '',
    stage.type === 'plan-generation' ? '## Complete Open Findings Registry' : '',
    stage.type === 'plan-generation' ? openFindingsRegistry : '',
    '',
    stage.type === 'plan-generation' ? '## Follow-up Findings (Not For This Pass)' : '',
    stage.type === 'plan-generation' ? followUpFindings : '',
    '',
    stage.type === 'plan-generation' ? '## Planning Batches' : '',
    stage.type === 'plan-generation' ? planningBatches : '',
    '',
    stage.type === 'deep-scan'
      ? 'Return the analysis-report JSON now. Focus on the extraction gap, canonical memberId route gap, test/contract gap, and any immediate RBAC validation or audit seam issue directly supported by the seam.'
      : stage.type === 'reproduce'
        ? 'Return the analysis-report JSON now. Describe the reproduced gap directly from the replay seam evidence already gathered.'
        : stage.type === 'plan-generation'
          ? 'Return the slice-plan JSON now. Use only immediate and next-horizon findings from the open findings registry above, copy those exact HELIX IDs verbatim, do not search the filesystem for finding IDs, split the work into committable milestones, and list near-term or long-term findings as follow-up work instead of expanding the current plan.'
          : 'Return the analysis-report JSON now. Explain the root cause directly from the replay seam evidence already gathered.',
  ];

  return lines.filter((line) => line.length > 0).join('\n');
}

export function formatCompactPlanFindingsRegistry(findings: Finding[]): string {
  if (findings.length === 0) {
    return '(none)';
  }

  const registry = findings.map((finding) => ({
    id: finding.id,
    horizon: finding.horizon ?? inferDefaultFindingHorizon(finding.severity),
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    description:
      finding.description.length > 220
        ? `${finding.description.slice(0, 217).trimEnd()}...`
        : finding.description,
    files: finding.files.slice(0, 4).map((file) => file.path),
    ...(finding.files.length > 4 ? { additionalFiles: finding.files.length - 4 } : {}),
  }));

  return ['```json', JSON.stringify(registry, null, 2), '```'].join('\n');
}

export function inferDefaultFindingHorizon(severity: Finding['severity']): Finding['horizon'] {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'immediate';
    case 'medium':
      return 'next';
    case 'low':
      return 'near-term';
    case 'info':
    default:
      return 'long-term';
  }
}

export function buildDeterministicStageContinuationPrompt(
  stage: StageDefinition,
  session: Session,
  result: StageResult,
): string {
  const replaySeamFiles = (session.replayContext?.changedFiles ?? [])
    .slice(0, 12)
    .map((filePath) => `- ${filePath}`)
    .join('\n');
  const evidenceDigest = buildFailureAdvisoryEvidenceDigest(stage, result)
    .slice(0, 10)
    .map((entry) => `- ${entry}`)
    .join('\n');
  const stageFailure = result.qualityGate?.feedback ?? result.error ?? `${stage.name} failed`;
  const hasReplaySeam = replaySeamFiles.trim().length > 0;

  const lines = [
    '## DETERMINISTIC CONTINUATION MODE',
    `Stage: ${stage.name}`,
    `Work item: ${session.workItem.title}`,
    hasReplaySeam
      ? 'Continue from the gathered replay seam evidence only.'
      : 'Continue from the gathered stage evidence only.',
    'Do not restart with AGENTS.md, CLAUDE.md, docs, journals, code maps, or broad repo discovery.',
    'Tool use is disabled on this retry. Emit the required structured artifact directly from the already inspected seam.',
    '',
    '## Blocking Signal',
    stageFailure,
    '',
    hasReplaySeam ? '## Historical Replay Seam' : '## Gathered Stage Seam',
    hasReplaySeam ? replaySeamFiles : '- (no explicit replay seam files recorded)',
    '',
    '## Gathered Seam Evidence',
    evidenceDigest || '- (no retained evidence digest)',
    '',
    stage.type === 'reproduce'
      ? 'Return the reproduction-report JSON now from the failing test seam already gathered in this run.'
      : stage.type === 'root-cause'
        ? 'Return the analysis-report JSON now. Explain the root cause directly from the gathered route, repo, model, audit, and test seam evidence.'
        : 'Return the analysis-report JSON now. Focus on the immediate seam gaps directly supported by the gathered evidence.',
  ];

  return lines.filter((line) => line.length > 0).join('\n');
}
