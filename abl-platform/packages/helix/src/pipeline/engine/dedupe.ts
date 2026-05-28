/**
 * Pure deduplication helpers for findings and decisions.
 *
 * Extracted verbatim from `pipeline-engine.ts` as the first cut of the
 * engine decomposition. Behavior is unchanged; call sites still go
 * through `dedupeFindings`, `dedupeDecisions`, `buildFindingFingerprint`,
 * and `buildDecisionFingerprint`. The merge, rank, and timestamp helpers
 * are internal to this module.
 */
import type { Decision, Finding } from '../../types.js';

export function buildFindingFingerprint(
  finding: Pick<
    Finding,
    'category' | 'severity' | 'title' | 'description' | 'files' | 'discoveredBy'
  >,
): string {
  const fileKey = finding.files
    .map((file) => normalizeArtifactText(file.path))
    .filter(Boolean)
    .sort()
    .join('|');
  return [
    normalizeArtifactText(finding.discoveredBy),
    finding.category,
    finding.severity,
    normalizeArtifactText(finding.title),
    normalizeArtifactText(finding.description),
    fileKey,
  ].join('::');
}

export function buildDecisionFingerprint(decision: Pick<Decision, 'stage' | 'question'>): string {
  return [normalizeArtifactText(decision.stage), normalizeArtifactText(decision.question)].join(
    '::',
  );
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const deduped = new Map<string, Finding>();
  for (const finding of findings) {
    const fingerprint = buildFindingFingerprint(finding);
    const existing = deduped.get(fingerprint);
    if (!existing) {
      deduped.set(fingerprint, finding);
      continue;
    }

    deduped.set(fingerprint, mergeFindings(existing, finding));
  }
  return [...deduped.values()];
}

export function dedupeDecisions(decisions: Decision[]): Decision[] {
  const deduped = new Map<string, Decision>();
  for (const decision of decisions) {
    const fingerprint = buildDecisionFingerprint(decision);
    const existing = deduped.get(fingerprint);
    if (!existing) {
      deduped.set(fingerprint, decision);
      continue;
    }

    deduped.set(fingerprint, mergeDecisions(existing, decision));
  }
  return [...deduped.values()];
}

// ─── Internal helpers ────────────────────────────────────────────────────

function normalizeArtifactText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeFindings(existing: Finding, candidate: Finding): Finding {
  const keepCandidate =
    resolveIsoTimestamp(candidate.updatedAt) >= resolveIsoTimestamp(existing.updatedAt);
  const primary = keepCandidate ? candidate : existing;
  const secondary = keepCandidate ? existing : candidate;
  return {
    ...primary,
    status:
      findStatusRank(candidate.status) > findStatusRank(existing.status)
        ? candidate.status
        : existing.status,
    files: dedupeFileReferences([...existing.files, ...candidate.files]),
    suggestedFix: primary.suggestedFix ?? secondary.suggestedFix,
    deferredReason: primary.deferredReason ?? secondary.deferredReason,
    assignedSlice: primary.assignedSlice ?? secondary.assignedSlice,
    fixedInCommit: primary.fixedInCommit ?? secondary.fixedInCommit,
    createdAt:
      resolveIsoTimestamp(existing.createdAt) <= resolveIsoTimestamp(candidate.createdAt)
        ? existing.createdAt
        : candidate.createdAt,
    updatedAt:
      resolveIsoTimestamp(existing.updatedAt) >= resolveIsoTimestamp(candidate.updatedAt)
        ? existing.updatedAt
        : candidate.updatedAt,
  };
}

function mergeDecisions(existing: Decision, candidate: Decision): Decision {
  const keepCandidate =
    resolveIsoTimestamp(candidate.resolvedAt) >= resolveIsoTimestamp(existing.resolvedAt);
  const primary = keepCandidate ? candidate : existing;
  const secondary = keepCandidate ? existing : candidate;

  return {
    ...primary,
    context: primary.context || secondary.context,
    classification:
      primary.classification === 'AMBIGUOUS' && secondary.classification !== 'AMBIGUOUS'
        ? secondary.classification
        : primary.classification,
    answer: primary.answer ?? secondary.answer,
    oracleVotes: dedupeOracleVotes([...existing.oracleVotes, ...candidate.oracleVotes]),
    resolvedBy: primary.resolvedBy ?? secondary.resolvedBy,
    resolvedAt: primary.resolvedAt ?? secondary.resolvedAt,
  };
}

function dedupeOracleVotes(votes: Decision['oracleVotes']): Decision['oracleVotes'] {
  const deduped = new Map<string, Decision['oracleVotes'][number]>();
  for (const vote of votes) {
    const fingerprint = [
      normalizeArtifactText(vote.oracleId),
      normalizeArtifactText(vote.oracleName),
      normalizeArtifactText(vote.answer),
    ].join('::');
    const existing = deduped.get(fingerprint);
    if (!existing || vote.confidence > existing.confidence) {
      deduped.set(fingerprint, vote);
    }
  }
  return [...deduped.values()];
}

function dedupeFileReferences(files: Finding['files']): Finding['files'] {
  const deduped = new Map<string, Finding['files'][number]>();
  for (const file of files) {
    const fingerprint = [
      normalizeArtifactText(file.path),
      file.lines?.join(':') ?? '',
      normalizeArtifactText(file.snippet),
    ].join('::');
    if (!deduped.has(fingerprint)) {
      deduped.set(fingerprint, file);
    }
  }
  return [...deduped.values()];
}

function findStatusRank(status: Finding['status']): number {
  switch (status) {
    case 'open':
      return 0;
    case 'planned':
      return 1;
    case 'in-progress':
      return 2;
    case 'deferred':
      return 3;
    case 'wont-fix':
      return 4;
    case 'fixed':
      return 5;
  }
}

function resolveIsoTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
