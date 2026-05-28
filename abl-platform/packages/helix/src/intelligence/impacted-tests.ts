import { dirname } from 'node:path';

import {
  buildFocusedRepoIndex,
  isTestFile,
  listScopedSourceFiles,
  normalizeRepoPath,
  sortUnique,
  type RepoIndex,
} from '../pipeline/repo-index.js';

const DEFAULT_IMPACTED_TEST_LIMIT = 12;
const MAX_IMPACTED_TEST_SCOPE_FILES = 20_000;
const MIN_IMPACTED_TEST_SCORE = 4;
const MAX_IMPACTED_TEST_REASONS = 3;
const GENERIC_PATH_SEGMENTS = new Set(['src', 'test', 'tests', '__tests__', 'e2e', 'spec']);

export interface RepoImpactedTest {
  path: string;
  score: number;
  reasons: string[];
}

export interface RepoImpactedTestSearchResult {
  paths: string[];
  scope: string[];
  scannedFiles: number;
  tests: RepoImpactedTest[];
  truncated: boolean;
  message?: string;
}

interface ImpactedTestAccumulator {
  score: number;
  reasons: Set<string>;
}

interface PathAffinity {
  packageRoot: string;
  relevantDirs: string[];
  parentDir: string;
  stem: string;
}

interface CandidateAffinity {
  score: number;
  reason?: string;
}

export async function findImpactedTestsInWorkspace(
  workDir: string,
  options: {
    paths: string[];
    scope?: string[];
    limit?: number;
  },
): Promise<RepoImpactedTestSearchResult> {
  const normalizedPaths = sortUnique(
    (options.paths ?? []).map((path) => normalizeRepoPath(path)).filter(Boolean),
  );
  const scope = normalizeImpactedTestScope(options.scope, normalizedPaths);
  const limit = clampImpactedTestLimit(options.limit);

  if (normalizedPaths.length === 0) {
    return {
      paths: normalizedPaths,
      scope,
      scannedFiles: 0,
      tests: [],
      truncated: false,
      message: 'Provide at least one changed file path when using helix_get_impacted_tests.',
    };
  }

  const repoFiles = await listScopedSourceFiles(workDir, scope);
  if (repoFiles.length > MAX_IMPACTED_TEST_SCOPE_FILES) {
    return {
      paths: normalizedPaths,
      scope,
      scannedFiles: repoFiles.length,
      tests: [],
      truncated: false,
      message: `Scope is too large (${repoFiles.length} files). Narrow the request to a package or directory before using helix_get_impacted_tests.`,
    };
  }

  const focusPaths = normalizedPaths.filter((path) => !isTestFile(path));
  const repoIndex = await buildFocusedRepoIndex(
    workDir,
    repoFiles,
    focusPaths.length > 0 ? focusPaths : normalizedPaths,
  );
  const rankedTests = rankImpactedTests(normalizedPaths, repoFiles, repoIndex);
  const tests = rankedTests.slice(0, limit);

  return {
    paths: normalizedPaths,
    scope,
    scannedFiles: repoFiles.length,
    tests,
    truncated: rankedTests.length > limit,
    message:
      tests.length === 0
        ? 'No likely impacted tests were found in the requested scope.'
        : undefined,
  };
}

export function inferImpactedTests(
  paths: string[],
  repoFiles: string[],
  repoIndex: RepoIndex,
  options: { limit?: number } = {},
): RepoImpactedTest[] {
  const limit = clampImpactedTestLimit(options.limit);
  return rankImpactedTests(paths, repoFiles, repoIndex).slice(0, limit);
}

function rankImpactedTests(
  paths: string[],
  repoFiles: string[],
  repoIndex: RepoIndex,
): RepoImpactedTest[] {
  const normalizedPaths = sortUnique(paths.map((path) => normalizeRepoPath(path)).filter(Boolean));
  const sourcePaths = normalizedPaths.filter((path) => !isTestFile(path));
  const explicitTestPaths = normalizedPaths.filter((path) => isTestFile(path));
  const dependentSourcePaths = collectDependentSourcePaths(sourcePaths, repoIndex);
  const candidateTests = sortUnique(repoFiles.filter((path) => isTestFile(path)));
  const impactedTests = new Map<string, ImpactedTestAccumulator>();
  const affinityAnchors = sortUnique([...sourcePaths, ...dependentSourcePaths]);

  for (const testPath of explicitTestPaths) {
    addImpactSignal(
      impactedTests,
      testPath,
      20,
      `${testPath} is already part of the requested path set.`,
    );
  }

  for (const sourcePath of sourcePaths) {
    for (const importer of repoIndex.importersByTarget.get(sourcePath) ?? []) {
      if (!isTestFile(importer)) {
        continue;
      }

      addImpactSignal(impactedTests, importer, 14, `Imports changed file ${sourcePath}.`);
    }
  }

  for (const dependentPath of dependentSourcePaths) {
    for (const candidateTest of candidateTests) {
      const candidateAffinity = scoreCandidateAffinity(candidateTest, dependentPath);
      if (candidateAffinity.score < MIN_IMPACTED_TEST_SCORE) {
        continue;
      }

      addImpactSignal(
        impactedTests,
        candidateTest,
        candidateAffinity.score + 1,
        candidateAffinity.reason
          ? `Touches dependent seam ${dependentPath}; ${candidateAffinity.reason}`
          : `Touches dependent seam ${dependentPath} by path convention.`,
      );
    }
  }

  for (const candidateTest of candidateTests) {
    const affinity = bestCandidateAffinity(candidateTest, affinityAnchors);
    if (affinity.score < MIN_IMPACTED_TEST_SCORE) {
      continue;
    }

    addImpactSignal(
      impactedTests,
      candidateTest,
      affinity.score,
      affinity.reason ?? `${candidateTest} is path-adjacent to the changed seam.`,
    );
  }

  return [...impactedTests.entries()]
    .map(([path, entry]) => ({
      path,
      score: entry.score,
      reasons: [...entry.reasons].slice(0, MAX_IMPACTED_TEST_REASONS),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function collectDependentSourcePaths(sourcePaths: string[], repoIndex: RepoIndex): string[] {
  const dependentPaths = new Set<string>();

  for (const sourcePath of sourcePaths) {
    for (const importer of repoIndex.importersByTarget.get(sourcePath) ?? []) {
      if (importer !== sourcePath && !isTestFile(importer)) {
        dependentPaths.add(importer);
      }
    }
  }

  return sortUnique(dependentPaths);
}

function addImpactSignal(
  impactedTests: Map<string, ImpactedTestAccumulator>,
  testPath: string,
  score: number,
  reason: string,
): void {
  const entry = impactedTests.get(testPath) ?? { score: 0, reasons: new Set<string>() };
  entry.score += score;
  if (reason.trim().length > 0) {
    entry.reasons.add(reason);
  }
  impactedTests.set(testPath, entry);
}

function bestCandidateAffinity(candidatePath: string, anchorPaths: string[]): CandidateAffinity {
  let best: CandidateAffinity = { score: 0 };

  for (const anchorPath of anchorPaths) {
    const candidateAffinity = scoreCandidateAffinity(candidatePath, anchorPath);
    if (candidateAffinity.score > best.score) {
      best = candidateAffinity;
    }
  }

  return best;
}

function scoreCandidateAffinity(candidatePath: string, anchorPath: string): CandidateAffinity {
  const candidate = analyzePathAffinity(candidatePath);
  const anchor = analyzePathAffinity(anchorPath);
  const reasons: string[] = [];
  let score = 0;

  if (candidate.packageRoot && candidate.packageRoot === anchor.packageRoot) {
    score += 1;
  }

  const sharedPrefix = sharedPrefixLength(candidate.relevantDirs, anchor.relevantDirs);
  if (sharedPrefix > 0) {
    score += Math.min(4, sharedPrefix * 2);
    reasons.push('shared directory path');
  }

  if (candidate.parentDir && candidate.parentDir === anchor.parentDir) {
    score += 2;
    reasons.push('same parent directory');
  }

  if (
    candidate.stem &&
    anchor.stem &&
    (candidate.stem === anchor.stem ||
      candidate.stem.includes(anchor.stem) ||
      anchor.stem.includes(candidate.stem))
  ) {
    score += 3;
    reasons.push('matching file stem');
  }

  if (score > 0 && /\.regression\.[cm]?[jt]sx?$/i.test(candidatePath)) {
    score += 1;
    reasons.push('regression variant');
  }

  if (score > 0 && /\.e2e\.[cm]?[jt]sx?$/i.test(candidatePath)) {
    score += 1;
    reasons.push('e2e variant');
  }

  return {
    score,
    reason:
      reasons.length > 0
        ? `${candidatePath} matches ${anchorPath} by ${reasons.join(', ')}.`
        : undefined,
  };
}

function analyzePathAffinity(path: string): PathAffinity {
  const normalized = normalizeRepoPath(path);
  const segments = normalized.split('/').filter(Boolean);
  const packageRootLength =
    segments[0] === 'packages' || segments[0] === 'apps'
      ? Math.min(2, segments.length)
      : Math.min(1, segments.length);
  const packageRoot = segments.slice(0, packageRootLength).join('/');
  const fileName = segments[segments.length - 1] ?? '';
  const dirSegments = segments.slice(packageRootLength, -1).filter(Boolean);
  const relevantDirs = dirSegments.filter((segment) => !GENERIC_PATH_SEGMENTS.has(segment));
  const parentDir =
    relevantDirs[relevantDirs.length - 1] ?? dirSegments[dirSegments.length - 1] ?? '';
  const stem = stripTestDecorators(fileName);

  return {
    packageRoot,
    relevantDirs,
    parentDir,
    stem,
  };
}

function stripTestDecorators(fileName: string): string {
  return fileName
    .replace(/\.[cm]?[jt]sx?$/i, '')
    .replace(/\.(?:test|spec|regression|e2e)$/i, '')
    .replace(/[-_.](?:test|spec|regression|e2e)$/i, '')
    .trim();
}

function sharedPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function clampImpactedTestLimit(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return DEFAULT_IMPACTED_TEST_LIMIT;
  }

  return Math.max(1, Math.min(50, Math.trunc(value)));
}

function normalizeImpactedTestScope(scope: string[] | undefined, paths: string[]): string[] {
  const normalizedScope = sortUnique((scope ?? []).map((entry) => normalizeRepoPath(entry)));
  if (normalizedScope.length > 0) {
    return normalizedScope;
  }

  return sortUnique(
    paths.map((path) => path.match(/^((?:apps|packages)\/[^/]+)/)?.[1] ?? dirname(path)),
  );
}
