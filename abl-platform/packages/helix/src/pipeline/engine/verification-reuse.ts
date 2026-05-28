/**
 * Verification-reuse helpers: cache/lookup/clear the per-slice verification
 * checkpoint criteria and build the deterministic `reuseKey` used to decide
 * whether a prior pass is still valid for the current diff.
 *
 * Pure helpers — state lives on the `Slice` argument's
 * `verificationCheckpoint` field. No module-level cache. `stableStringify`
 * / `sortForStableStringify` are local utilities (duplicated in
 * `control-plane-state.ts` and `proof-packets.ts`; consolidation is
 * deferred to a follow-up).
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import { createHash } from 'node:crypto';
import type { Slice, SliceVerificationCriterionCheckpoint } from '../../types.js';
import { dedupeStrings } from './text-utils.js';

export interface SliceReviewWorkspaceState {
  reviewScopeEntries: string[];
  actualChangedFiles: string[];
  outOfScopeChanges: string[];
  ignoredOutOfScopeChanges: string[];
  diffStat: string;
  workspaceReconcileSummary?: string;
}

export function getReusableVerificationCriterion(
  slice: Slice,
  criterionId: string,
  reuseKey: string,
  legacyDiffHash?: string,
): SliceVerificationCriterionCheckpoint | undefined {
  const checkpoint = slice.verificationCheckpoint;
  if (!checkpoint) {
    return undefined;
  }

  const criterion = checkpoint.criteria.find((entry) => entry.criterionId === criterionId);
  if (!criterion) {
    return undefined;
  }

  if (criterion.reuseKey) {
    return criterion.reuseKey === reuseKey ? criterion : undefined;
  }

  return checkpoint.diffHash === legacyDiffHash ? criterion : undefined;
}

export function cacheReusableVerificationCriterion(
  slice: Slice,
  diffHash: string,
  criterion: SliceVerificationCriterionCheckpoint,
): void {
  if (!slice.verificationCheckpoint) {
    slice.verificationCheckpoint = {
      diffHash,
      capturedAt: criterion.capturedAt,
      criteria: [criterion],
    };
    return;
  }

  slice.verificationCheckpoint.diffHash = diffHash;
  slice.verificationCheckpoint.capturedAt = criterion.capturedAt;
  const existingIndex = slice.verificationCheckpoint.criteria.findIndex(
    (entry) => entry.criterionId === criterion.criterionId,
  );
  if (existingIndex >= 0) {
    slice.verificationCheckpoint.criteria[existingIndex] = criterion;
  } else {
    slice.verificationCheckpoint.criteria.push(criterion);
  }
}

export function clearReusableVerificationCriterion(slice: Slice, criterionId: string): void {
  const checkpoint = slice.verificationCheckpoint;
  if (!checkpoint) {
    return;
  }

  checkpoint.criteria = checkpoint.criteria.filter((entry) => entry.criterionId !== criterionId);
  if (checkpoint.criteria.length === 0) {
    slice.verificationCheckpoint = undefined;
  }
}

export function buildVerificationReuseKey({
  criterionId,
  criterionType,
  diffHash,
  command,
  scopeEntries = [],
  metadata,
}: {
  criterionId: string;
  criterionType: SliceVerificationCriterionCheckpoint['criterionType'];
  diffHash: string;
  command?: string;
  scopeEntries?: string[];
  metadata?: unknown;
}): string {
  const payload = {
    criterionId,
    criterionType,
    diffHash,
    command: command?.trim(),
    scopeEntries: dedupeStrings(scopeEntries).sort((left, right) => left.localeCompare(right)),
    metadata,
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function buildArchitectureReviewReuseMetadata(
  slice: Slice,
  workspaceState: SliceReviewWorkspaceState,
): unknown {
  return {
    manifest: slice.manifest,
    impactAnalysis: slice.impactAnalysis,
    requiredTests: slice.testLock.requiredTests.map((test) => ({
      testFile: test.testFile,
      status: test.status,
      coversFindings: [...test.coversFindings].sort((left, right) => left.localeCompare(right)),
      isNew: test.isNew,
    })),
    regressionSuite: dedupeStrings(slice.testLock.regressionSuite).sort((left, right) =>
      left.localeCompare(right),
    ),
    legacyPaths: slice.legacyPaths
      .map((path) => ({
        path: path.path,
        reason: path.reason,
        removableAfter: path.removableAfter,
        status: path.status,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    reviewScopeEntries: dedupeStrings(workspaceState.reviewScopeEntries).sort((left, right) =>
      left.localeCompare(right),
    ),
    actualChangedFiles: dedupeStrings(workspaceState.actualChangedFiles).sort((left, right) =>
      left.localeCompare(right),
    ),
    outOfScopeChanges: dedupeStrings(workspaceState.outOfScopeChanges).sort((left, right) =>
      left.localeCompare(right),
    ),
    ignoredOutOfScopeChanges: dedupeStrings(workspaceState.ignoredOutOfScopeChanges).sort(
      (left, right) => left.localeCompare(right),
    ),
    diffStat: workspaceState.diffStat,
    workspaceReconcileSummary: workspaceState.workspaceReconcileSummary,
  };
}

export function annotateReusedVerificationDetail(detail: string | undefined): string {
  const base = detail?.trim();
  if (!base) {
    return 'PASS — reused prior passing verification for an unchanged diff';
  }

  return base.startsWith('PASS')
    ? `${base} | reused prior passing verification for unchanged diff`
    : `PASS — ${base} | reused prior passing verification for unchanged diff`;
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
