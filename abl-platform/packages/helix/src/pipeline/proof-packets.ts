import { createHash } from 'node:crypto';

import type { Session, Slice, SliceProofCriterion, SliceProofPacket } from '../types.js';

const MAX_IMPLEMENTATION_OUTPUT_EXCERPT_CHARS = 500;

export function hydrateSliceProofPackets(session: Session): void {
  for (const slice of session.slices) {
    slice.proofPacket = buildSliceProofPacket(session, slice);
  }
}

export function buildSliceProofPacket(session: Session, slice: Slice): SliceProofPacket {
  const cachedCriteria = new Set(
    (slice.verificationCheckpoint?.criteria ?? []).map((criterion) => criterion.criterionId),
  );
  const findings = session.findings
    .filter((finding) => slice.findings.includes(finding.id))
    .map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      status: finding.status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const manifestHash = stableHash({
    dependencies: [...slice.dependencies].sort((left, right) => left - right),
    findings: [...slice.findings].sort((left, right) => left.localeCompare(right)),
    manifest: slice.manifest,
    requiredTests: slice.testLock.requiredTests.map((test) => ({
      testFile: test.testFile,
      coversFindings: [...test.coversFindings].sort((left, right) => left.localeCompare(right)),
      isNew: test.isNew,
    })),
    regressionSuite: sortUniqueStrings(slice.testLock.regressionSuite),
  });

  const basePacket = {
    version: 1 as const,
    manifestHash,
    sliceNumber: slice.index + 1,
    title: slice.title,
    status: slice.status,
    findingIds: [...slice.findings].sort((left, right) => left.localeCompare(right)),
    findings,
    artifacts: {
      implementationDiffHash: slice.implementationCheckpoint?.diffHash || undefined,
      verificationDiffHash: slice.verificationCheckpoint?.diffHash || undefined,
      implementationCapturedAt: slice.implementationCheckpoint?.capturedAt,
      verificationCapturedAt: slice.verificationCheckpoint?.capturedAt,
    },
    files: {
      direct: sortUniqueStrings(slice.impactAnalysis.directFiles),
      dependents: sortUniqueStrings(slice.impactAnalysis.dependentFiles),
      affectedTests: sortUniqueStrings(slice.impactAnalysis.affectedTests),
      requiredTests: sortUniqueStrings(slice.testLock.requiredTests.map((test) => test.testFile)),
      regressionSuite: sortUniqueStrings(slice.testLock.regressionSuite),
    },
    criteria: slice.exitCriteria
      .map<SliceProofCriterion>((criterion) => ({
        criterionId: criterion.id,
        criterionType: criterion.type,
        passed: criterion.passed,
        detail: criterion.detail,
        cached: cachedCriteria.has(criterion.id),
      }))
      .sort((left, right) => left.criterionId.localeCompare(right.criterionId)),
    review: slice.review
      ? {
          approved: slice.review.approved,
          reviewer: slice.review.reviewer,
          findingCount: slice.review.findings.length,
          timestamp: slice.review.timestamp,
        }
      : undefined,
    commit: slice.commit
      ? {
          sha: slice.commit.sha,
          message: slice.commit.message,
          timestamp: slice.commit.timestamp,
        }
      : undefined,
    implementationOutputExcerpt: truncateMultilineText(
      slice.implementationCheckpoint?.output,
      MAX_IMPLEMENTATION_OUTPUT_EXCERPT_CHARS,
    ),
  };

  return {
    ...basePacket,
    proofHash: stableHash(basePacket),
    generatedAt: latestTimestamp([
      slice.commit?.timestamp,
      slice.review?.timestamp,
      slice.verificationCheckpoint?.capturedAt,
      slice.implementationCheckpoint?.capturedAt,
      session.updatedAt,
    ]),
  };
}

function truncateMultilineText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function latestTimestamp(values: Array<string | undefined>): string {
  const timestamps = values.filter((value): value is string => Boolean(value));
  if (timestamps.length === 0) {
    return new Date().toISOString();
  }

  return timestamps.sort((left, right) => left.localeCompare(right))[timestamps.length - 1]!;
}

function sortUniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortForStableStringify(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortForStableStringify(entry)]),
    );
  }

  return value;
}
