/**
 * Slice-review workspace inspection.
 *
 * Pure helper extracted verbatim from `pipeline-engine.ts`. Inspects the
 * working tree for a slice under architecture review and returns a
 * `SliceReviewWorkspaceState` describing the review scope, actual
 * changed files, out-of-scope changes, and a per-slice `git diff --stat`.
 *
 *   - `inspectSliceReviewWorkspaceState(slice, workDir)` — lists currently
 *     changed workspace paths (pruned of synthetic directory entries),
 *     partitions them against the slice review scope, and captures the
 *     scoped diff stat (falling back to the slice's declared files when
 *     no actual changes are present). Returns an
 *     `ignoredOutOfScopeChanges: []` placeholder — callers (e.g.
 *     `reconcileSliceReviewWorkspaceState`) populate it as needed.
 *
 * No engine state, no I/O beyond the wrapped git / workspace-status
 * helpers. Behavior unchanged.
 */
import type { Slice } from '../../types.js';
import { getSliceFiles, getSliceReviewScopeEntries } from '../slice-view.js';
import { listChangedWorkspacePaths } from '../workspace-status.js';
import { captureSliceDiffStat } from './git-capture.js';
import { dedupeStrings, pruneSyntheticWorkspaceDirectoryEntries } from './text-utils.js';
import type { SliceReviewWorkspaceState } from './verification-reuse.js';

interface InspectSliceReviewWorkspaceStateOptions {
  baselineDirtyFiles?: string[];
}

export async function inspectSliceReviewWorkspaceState(
  slice: Slice,
  workDir: string,
  options: InspectSliceReviewWorkspaceStateOptions = {},
): Promise<SliceReviewWorkspaceState> {
  const reviewScopeEntries = dedupeStrings(getSliceReviewScopeEntries(slice));
  const reviewScope = new Set(reviewScopeEntries);
  const baselineDirtySet = new Set(dedupeStrings(options.baselineDirtyFiles ?? []));
  const changedFiles = pruneSyntheticWorkspaceDirectoryEntries(
    dedupeStrings(await listChangedWorkspacePaths(workDir)),
  );
  const ignoredOutOfScopeChanges = changedFiles.filter(
    (file) => !reviewScope.has(file) && baselineDirtySet.has(file),
  );
  const actualChangedFiles = changedFiles.filter(
    (file) => reviewScope.has(file) || !baselineDirtySet.has(file),
  );
  const outOfScopeChanges = actualChangedFiles.filter((file) => !reviewScope.has(file));
  const diffStat = await captureSliceDiffStat(
    actualChangedFiles.length > 0 ? actualChangedFiles : getSliceFiles(slice),
    workDir,
  );

  return {
    reviewScopeEntries,
    actualChangedFiles,
    outOfScopeChanges,
    ignoredOutOfScopeChanges,
    diffStat,
  };
}
