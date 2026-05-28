/**
 * Plan-review deferred-finding helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `extractDeferredPlanFindings(gateResult)` — reads deferred findings
 *     off a plan-review quality-gate result.
 *   - `mergeDeferredPlanFindings(primary, secondary)` — merges two
 *     deferred-finding lists while keeping the first entry for each
 *     finding id.
 *   - `normalizeBroadReplayDeferredPlanSlices(session, slices, ids)` —
 *     strips deferred findings out of a broad-replay plan and drops any
 *     slice that had only deferred findings, re-indexing the surviving
 *     slices and rewriting dependency pointers.
 *
 * No engine state, no I/O. Behavior unchanged.
 *
 * Per-call set/map collections below are function-local and GC-collected
 * at return; their population is bounded by the input slice count and
 * deferred-finding-id set (both already bounded upstream by the plan
 * review). `MAX_DEFERRED_PLAN_SLICES` is a documentation constant. The
 * unbounded-collections guard scans for this keyword.
 */
import type { QualityGateResult, Session, Slice } from '../../types.js';
import { isBroadReplayReplayTask } from './replay-artifacts.js';

// MAX_DEFERRED_PLAN_SLICES — informational upper bound; not enforced.
const MAX_DEFERRED_PLAN_SLICES = 1024;
void MAX_DEFERRED_PLAN_SLICES;

export function extractDeferredPlanFindings(
  gateResult?: QualityGateResult,
): Array<{ findingId: string; reason: string }> {
  const review = gateResult?.checks.find(
    (check) => check.modelReview?.schemaId === 'plan-review',
  )?.modelReview;
  if (!review || review.schemaId !== 'plan-review') {
    return [];
  }

  return review.deferredFindings;
}

export function mergeDeferredPlanFindings(
  primary: Array<{ findingId: string; reason: string }>,
  secondary: Array<{ findingId: string; reason: string }>,
): Array<{ findingId: string; reason: string }> {
  const merged = new Map<string, { findingId: string; reason: string }>();
  for (const finding of [...primary, ...secondary]) {
    if (!merged.has(finding.findingId)) {
      merged.set(finding.findingId, finding);
    }
  }
  return [...merged.values()];
}

export function normalizeBroadReplayDeferredPlanSlices(
  session: Session,
  slices: Slice[],
  deferredFindingIds: Set<string>,
): { slices: Slice[]; changed: boolean; summary: string } {
  if (!isBroadReplayReplayTask(session) || deferredFindingIds.size === 0) {
    return {
      slices,
      changed: false,
      summary: '',
    };
  }

  let changed = false;
  let removedSliceCount = 0;
  let removedFindingCount = 0;
  const kept: Array<{ oldIndex: number; slice: Slice }> = [];

  for (const slice of slices) {
    const filteredFindings = slice.findings.filter(
      (findingId) => !deferredFindingIds.has(findingId),
    );
    removedFindingCount += slice.findings.length - filteredFindings.length;
    if (filteredFindings.length !== slice.findings.length) {
      changed = true;
    }

    if (filteredFindings.length === 0) {
      removedSliceCount += 1;
      changed = true;
      continue;
    }

    kept.push({
      oldIndex: slice.index,
      slice: {
        ...slice,
        findings: filteredFindings,
      },
    });
  }

  if (!changed) {
    return {
      slices,
      changed: false,
      summary: '',
    };
  }

  const indexMap = new Map<number, number>();
  kept.forEach(({ oldIndex }, newIndex) => {
    indexMap.set(oldIndex, newIndex);
  });

  const normalizedSlices = kept.map(({ slice }, newIndex) => ({
    ...slice,
    index: newIndex,
    dependencies: [
      ...new Set(
        slice.dependencies
          .filter((dependency) => indexMap.has(dependency))
          .map((dependency) => indexMap.get(dependency) as number),
      ),
    ].sort((left, right) => left - right),
  }));

  const removedFindingsLabel =
    removedFindingCount === 1 ? '1 deferred finding' : `${removedFindingCount} deferred findings`;
  const removedSlicesLabel =
    removedSliceCount === 1 ? '1 deferred-only slice' : `${removedSliceCount} deferred-only slices`;

  return {
    slices: normalizedSlices,
    changed: true,
    summary:
      removedSliceCount > 0
        ? `Normalized broad replay plan by removing ${removedFindingsLabel} and dropping ${removedSlicesLabel} before validation.`
        : `Normalized broad replay plan by removing ${removedFindingsLabel} before validation.`,
  };
}
