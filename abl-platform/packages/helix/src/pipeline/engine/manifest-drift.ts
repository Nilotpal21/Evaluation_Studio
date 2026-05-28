/**
 * Manifest-drift helpers: decide whether an out-of-manifest file change is
 * recoverable (narrow in-scope drift that should be absorbed) versus
 * auto-expandable (workspace config under the slice's package root that can
 * be brought into scope). Also derives impact-analysis summaries and slice
 * package roots used when reasoning about drift.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 *
 * MANIFEST_DRIFT_CONFIG_BASENAMES is kept as a readonly array (scanned with
 * `.includes`) rather than a hash set — the unbounded-collections guard
 * warns on ad-hoc collection construction in new files, and a small
 * allowlist does not need a hash set for correctness.
 */
import type { ImpactAnalysis, Slice } from '../../types.js';
import { isSourceFile, isTestFile, normalizeRepoPath } from '../repo-index.js';
import { getSliceFiles } from '../slice-view.js';
import { isTestFilePath } from '../workspace-status.js';
import { dedupeStrings, trimTrailingSlash } from './text-utils.js';

const MANIFEST_DRIFT_CONFIG_BASENAMES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  'tsconfig.test.json',
  'vitest.config.ts',
  'vitest.workspace.ts',
  'vite.config.ts',
] as const;
const VITEST_TIERED_CONFIG_BASENAME_PATTERN = /^vitest(?:\.[a-z0-9-]+)?\.config\.ts$/i;

export function deriveManifestImpactAnalysis(slice: Slice): ImpactAnalysis {
  const directFiles = dedupeStrings(getSliceFiles(slice));
  const dependentFiles = dedupeStrings(
    slice.manifest.fileContracts
      .flatMap((contract) => contract.dependents ?? [])
      .filter((path) => !isTestFilePath(path)),
  );
  const affectedTests = dedupeStrings([
    ...slice.testLock.requiredTests.map((test) => test.testFile),
    ...slice.testLock.regressionSuite,
    ...slice.impactAnalysis.affectedTests,
    ...slice.manifest.fileContracts
      .flatMap((contract) => contract.dependents ?? [])
      .filter(isTestFilePath),
  ]);
  const nonTestDirectFiles = directFiles.filter((path) => !isTestFilePath(path));
  const hasDelete = slice.manifest.fileContracts.some((contract) => contract.action === 'delete');

  const riskLevel: ImpactAnalysis['riskLevel'] =
    hasDelete || dependentFiles.length >= 5
      ? 'high'
      : dependentFiles.length > 0 || nonTestDirectFiles.length > 2
        ? 'medium'
        : 'low';

  const notes =
    dependentFiles.length > 0
      ? `Manifest-derived impact covers ${dependentFiles.length} dependent files and ${affectedTests.length} affected tests.`
      : `Manifest-derived impact covers ${affectedTests.length} affected tests and no dependent source files.`;

  return {
    directFiles,
    dependentFiles,
    affectedTests,
    riskLevel,
    notes,
  };
}

export function isRecoverableManifestDriftPath(
  file: string,
  scopeEntries: string[],
  slice: Slice,
): boolean {
  const normalized = normalizeRepoPath(file);
  if (!normalized) {
    return false;
  }

  if (!matchesWorkItemScope(normalized, scopeEntries)) {
    return false;
  }

  if (!isManifestDriftEligiblePath(normalized)) {
    return false;
  }

  const sliceRoots = dedupeStrings(
    [
      ...getSliceFiles(slice),
      ...slice.impactAnalysis.directFiles,
      ...slice.impactAnalysis.dependentFiles,
      ...slice.impactAnalysis.affectedTests,
      ...slice.testLock.requiredTests.map((test) => test.testFile),
    ]
      .map((entry) => deriveSlicePackageRoot(normalizeRepoPath(entry)))
      .filter(Boolean) as string[],
  );
  if (sliceRoots.length === 0) {
    return true;
  }

  const candidateRoot = deriveSlicePackageRoot(normalized);
  return candidateRoot != null && sliceRoots.includes(candidateRoot);
}

export function isAutoExpandableWorkspaceDriftPath(
  file: string,
  scopeEntries: string[],
  slice: Slice,
): boolean {
  const normalized = normalizeRepoPath(file);
  if (!normalized || !isManifestDriftEligiblePath(normalized)) {
    return false;
  }

  if (isRecoverableManifestDriftPath(normalized, scopeEntries, slice)) {
    return true;
  }

  const candidateRoot = deriveSlicePackageRoot(normalized);
  if (!candidateRoot) {
    return false;
  }

  const sliceRoots = dedupeStrings(
    [
      ...getSliceFiles(slice),
      ...slice.impactAnalysis.directFiles,
      ...slice.impactAnalysis.dependentFiles,
      ...slice.impactAnalysis.affectedTests,
      ...slice.testLock.requiredTests.map((test) => test.testFile),
    ]
      .map((entry) => deriveSlicePackageRoot(normalizeRepoPath(entry)))
      .filter(Boolean) as string[],
  );

  if (!sliceRoots.includes(candidateRoot)) {
    return false;
  }

  if (!candidateRoot.startsWith('apps/') && !candidateRoot.startsWith('packages/')) {
    return false;
  }

  return true;
}

export function matchesWorkItemScope(file: string, scopeEntries: string[]): boolean {
  if (scopeEntries.length === 0) {
    return true;
  }

  return scopeEntries.some((scopeEntry) => {
    const normalizedScope = normalizeRepoPath(scopeEntry);
    if (!normalizedScope || normalizedScope === '.') {
      return true;
    }

    if (looksLikeScopedFile(normalizedScope)) {
      return file === normalizedScope;
    }

    return file === normalizedScope || file.startsWith(`${normalizedScope}/`);
  });
}

export function isManifestDriftEligiblePath(file: string): boolean {
  if (isSourceFile(file) || isTestFile(file)) {
    return true;
  }

  const name = file.split('/').at(-1) ?? file;
  if (VITEST_TIERED_CONFIG_BASENAME_PATTERN.test(name)) {
    return true;
  }

  return (MANIFEST_DRIFT_CONFIG_BASENAMES as readonly string[]).includes(name);
}

export function deriveSlicePackageRoot(file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }

  const segments = file.split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  if ((segments[0] === 'apps' || segments[0] === 'packages') && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }

  return segments[0];
}

export function looksLikeScopedFile(value: string): boolean {
  return /\.[a-z0-9]+$/i.test(value);
}

export function workspaceAssessmentMatchesTarget(target: string, assessedFile: string): boolean {
  const normalizedTarget = trimTrailingSlash(target.trim());
  const normalizedAssessment = trimTrailingSlash(assessedFile.trim());

  if (!normalizedTarget || !normalizedAssessment) {
    return false;
  }

  return (
    normalizedTarget === normalizedAssessment ||
    normalizedTarget.startsWith(`${normalizedAssessment}/`) ||
    normalizedAssessment.startsWith(`${normalizedTarget}/`)
  );
}
