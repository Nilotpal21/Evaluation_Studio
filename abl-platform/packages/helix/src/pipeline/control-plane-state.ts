import { createHash, randomUUID } from 'node:crypto';

import type {
  CheckpointApprovalRecord,
  FailureAdvisoryRecord,
  Finding,
  HarnessDefectRecord,
  OracleCheckpointRecord,
  OracleReviewStageOutput,
  Session,
  StageResult,
} from '../types.js';

const MAX_CHECKPOINT_APPROVALS = 50;
const MAX_ORACLE_CHECKPOINTS = 50;
const MAX_HARNESS_DEFECTS = 50;
const MAX_FAILURE_ADVISORIES = 50;
const MAX_HARNESS_SAMPLE_CHARS = 600;
const MAX_HARNESS_SIGNATURE_CHARS = 240;

export function computeCheckpointArtifactHash(
  stageName: string,
  message: string,
  data?: unknown,
): string {
  return createHash('sha256').update(stableStringify({ stageName, message, data })).digest('hex');
}

export function hasApprovedCheckpointArtifact(session: Session, artifactHash: string): boolean {
  return (session.checkpointApprovals ?? []).some(
    (approval) => approval.artifactHash === artifactHash,
  );
}

export function recordCheckpointApproval(
  session: Session,
  approval: CheckpointApprovalRecord,
): void {
  const approvals = session.checkpointApprovals ?? [];
  const existingIndex = approvals.findIndex(
    (entry) =>
      entry.artifactHash === approval.artifactHash && entry.stageName === approval.stageName,
  );
  if (existingIndex >= 0) {
    approvals[existingIndex] = approval;
  } else {
    approvals.push(approval);
    trimInPlace(approvals, MAX_CHECKPOINT_APPROVALS);
  }
  session.checkpointApprovals = approvals;
}

export function computeOracleFindingsHash(findings: Finding[]): string {
  const normalized = findings
    .map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      status: finding.status,
      title: finding.title,
      description: finding.description,
      files: [...finding.files]
        .map((file) => ({
          path: file.path,
          lines: file.lines ?? null,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

export function getOracleCheckpoint(
  session: Session,
  stageName: string,
  oracleId: string,
  findingsHash: string,
): OracleCheckpointRecord | undefined {
  return (session.oracleCheckpoints ?? []).find(
    (checkpoint) =>
      checkpoint.stageName === stageName &&
      checkpoint.oracleId === oracleId &&
      checkpoint.findingsHash === findingsHash,
  );
}

export function upsertOracleCheckpoint(session: Session, checkpoint: OracleCheckpointRecord): void {
  const checkpoints = session.oracleCheckpoints ?? [];
  const existingIndex = checkpoints.findIndex(
    (entry) =>
      entry.stageName === checkpoint.stageName &&
      entry.oracleId === checkpoint.oracleId &&
      entry.findingsHash === checkpoint.findingsHash,
  );

  if (existingIndex >= 0) {
    checkpoints[existingIndex] = checkpoint;
  } else {
    checkpoints.push(checkpoint);
    trimInPlace(checkpoints, MAX_ORACLE_CHECKPOINTS);
  }

  session.oracleCheckpoints = checkpoints;
}

export function createOracleCheckpoint(
  stageName: string,
  oracleId: string,
  oracleName: string,
  findingsHash: string,
  review: OracleReviewStageOutput,
): OracleCheckpointRecord {
  return {
    stageName,
    oracleId,
    oracleName,
    findingsHash,
    review,
    capturedAt: new Date().toISOString(),
  };
}

export function upsertHarnessDefect(
  session: Session,
  defect: Pick<HarnessDefectRecord, 'kind' | 'stageName' | 'actor' | 'signature' | 'sample'>,
): HarnessDefectRecord {
  const defects = session.harnessDefects ?? [];
  const existing = defects.find(
    (entry) =>
      entry.kind === defect.kind &&
      entry.stageName === defect.stageName &&
      entry.actor === defect.actor &&
      entry.signature === defect.signature,
  );

  if (existing) {
    existing.occurrences += 1;
    existing.lastSeenAt = new Date().toISOString();
    if (defect.sample.trim()) {
      existing.sample = truncateInline(defect.sample, MAX_HARNESS_SAMPLE_CHARS);
    }
    return existing;
  }

  const next: HarnessDefectRecord = {
    id: randomUUID().slice(0, 8),
    kind: defect.kind,
    stageName: defect.stageName,
    actor: defect.actor,
    signature: truncateInline(defect.signature, MAX_HARNESS_SIGNATURE_CHARS),
    sample: truncateInline(defect.sample, MAX_HARNESS_SAMPLE_CHARS),
    occurrences: 1,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  defects.push(next);
  trimInPlace(defects, MAX_HARNESS_DEFECTS);
  session.harnessDefects = defects;
  return next;
}

export function buildStageFailureSignature(
  stageName: string,
  result: Pick<StageResult, 'status' | 'error' | 'qualityGate' | 'timeoutEvents'>,
): string {
  if (result.qualityGate && !result.qualityGate.passed) {
    return `${stageName}:quality-gate:${buildQualityGateFailureSignature(
      result.qualityGate.name,
      result.qualityGate.feedback,
    )}`;
  }

  const timeoutEvent = result.timeoutEvents?.at(-1);
  if (timeoutEvent) {
    return `${stageName}:timeout:${timeoutEvent.scope}:${timeoutEvent.actor}:${normalizeFailureLine(timeoutEvent.message) || 'unknown'}`;
  }

  if (result.error) {
    return `${stageName}:error:${normalizeFailureLine(firstNonEmptyLine(result.error)) || 'unknown'}`;
  }

  return `${stageName}:status:${result.status}`;
}

export function recordFailureAdvisory(
  session: Session,
  advisory: FailureAdvisoryRecord,
): FailureAdvisoryRecord {
  const advisories = session.failureAdvisories ?? [];
  const existingIndex = advisories.findIndex((entry) => entry.id === advisory.id);

  if (existingIndex >= 0) {
    advisories[existingIndex] = advisory;
  } else {
    advisories.push(advisory);
    trimInPlace(advisories, MAX_FAILURE_ADVISORIES);
  }

  session.failureAdvisories = advisories;
  session.pendingFailureAdvisory = advisory;
  return advisory;
}

export function clearPendingFailureAdvisory(session: Session): void {
  session.pendingFailureAdvisory = undefined;
}

export function getFailureAdvisoryRetryCount(
  session: Session,
  stageName: string,
  failureSignature: string,
): number {
  const counts = (session.failureAdvisories ?? [])
    .filter(
      (advisory) =>
        advisory.stageName === stageName && advisory.failureSignature === failureSignature,
    )
    .map((advisory) => advisory.retryCount);

  if (
    session.pendingFailureAdvisory?.stageName === stageName &&
    session.pendingFailureAdvisory.failureSignature === failureSignature
  ) {
    counts.push(session.pendingFailureAdvisory.retryCount);
  }

  return counts.length > 0 ? Math.max(...counts) : 0;
}

export function buildQualityGateFailureSignature(actor: string, output: string): string {
  const tsCode = output.match(/\berror\s+(TS\d+)\b/i)?.[1];
  if (tsCode) {
    return `${actor}:${tsCode}`;
  }

  const normalized = normalizeFailureLine(firstNonEmptyLine(output));
  return `${actor}:${normalized || 'unknown'}`;
}

export function buildOracleFailureSignature(actor: string, error: string): string {
  if (/budget/i.test(error)) {
    return `${actor}:budget`;
  }
  if (/turn/i.test(error)) {
    return `${actor}:turn-limit`;
  }
  if (/deadline|timed out/i.test(error)) {
    return `${actor}:timeout`;
  }
  return `${actor}:${normalizeFailureLine(firstNonEmptyLine(error)) || 'unknown'}`;
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function normalizeFailureLine(value: string): string {
  return truncateInline(
    value
      .replace(/\/Users\/[^\s:]+/g, '<path>')
      .replace(/[A-Fa-f0-9]{12,}/g, '<hash>')
      .replace(/\b\d+\b/g, '<n>'),
    MAX_HARNESS_SIGNATURE_CHARS,
  );
}

function truncateInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(maxChars - 14, 0)).trimEnd()} [truncated]`;
}

function trimInPlace<T>(values: T[], maxSize: number): void {
  while (values.length > maxSize) {
    values.shift();
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortForStableStringify(entry));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortForStableStringify(entry)]));
  }

  return value;
}
