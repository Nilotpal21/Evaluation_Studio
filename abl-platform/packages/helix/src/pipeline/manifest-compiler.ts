import { dirname, resolve } from 'node:path';

import { inferImpactedTests } from '../intelligence/impacted-tests.js';
import type {
  EntryCondition,
  ExitCriterion,
  ExportContract,
  FileContract,
  ImpactAnalysis,
  ManifestCompletenessHint,
  Session,
  Slice,
  TestRequirement,
} from '../types.js';
import {
  SOURCE_EXTENSIONS,
  buildFocusedRepoIndex,
  isSourceFile,
  isTestFile,
  listScopedSourceFiles,
  normalizeRepoPath,
  pathExists,
  readExportsFromFile,
  sortUnique,
} from './repo-index.js';
import type { RepoIndex } from './repo-index.js';

const MAX_CARRIED_FORWARD_REGRESSION_TESTS = 6;
const MIN_REGRESSION_RELEVANCE_SCORE = 4;
const GENERIC_PATH_SEGMENTS = new Set(['src', 'test', 'tests', '__tests__', 'e2e', 'spec']);

export async function compileSliceArtifacts(
  slice: Slice,
  session: Session,
  workDir: string,
): Promise<Pick<Slice, 'manifest' | 'testLock' | 'impactAnalysis' | 'exitCriteria'>> {
  const directFiles = collectDirectFiles(slice, session);
  const repoFiles = await listScopedSourceFiles(workDir, session.workItem.scope);
  const repoIndex = await buildFocusedRepoIndex(workDir, repoFiles, directFiles);
  const existingContractMap = new Map(
    slice.manifest.fileContracts.map((contract) => [normalizeRepoPath(contract.path), contract]),
  );

  const fileContracts: FileContract[] = [];
  const requiredTestSet = new Set(
    slice.testLock.requiredTests.map((test) => normalizeRepoPath(test.testFile)),
  );

  for (const filePath of directFiles) {
    const existingContract = existingContractMap.get(filePath);
    const fileExists = await pathExists(resolve(workDir, filePath));
    const trackedDeletion =
      existingContract?.action === 'delete' ||
      (!fileExists && (await isTrackedWorkspacePath(workDir, filePath)));
    const currentExports =
      fileExists && isSourceFile(filePath)
        ? (repoIndex.filesByPath.get(filePath)?.exports ??
          repoIndex.exportsByFile.get(filePath) ??
          (await readExportsFromFile(resolve(workDir, filePath))))
        : [];
    const dependents = sortUnique(repoIndex.importersByTarget.get(filePath));

    fileContracts.push({
      path: filePath,
      action: trackedDeletion ? 'delete' : fileExists ? 'modify' : 'create',
      reason: buildFileReason(filePath, slice, session),
      expectedExports: currentExports.length > 0 ? currentExports : undefined,
      dependents:
        dependents.length > 0
          ? dependents.filter((dependent) => !requiredTestSet.has(dependent))
          : undefined,
    });
  }

  const deletedFileSet = new Set(
    fileContracts
      .filter((contract) => contract.action === 'delete')
      .map((contract) => contract.path),
  );
  const requiredTests = (
    await Promise.all(
      dedupeTestRequirements(slice.testLock.requiredTests).map(async (test) =>
        hydrateTestRequirement(test, slice, session, workDir),
      ),
    )
  ).filter((test) => !deletedFileSet.has(test.testFile));
  const inferredAffectedTests = inferImpactedTests(
    fileContracts.map((contract) => contract.path),
    repoFiles,
    repoIndex,
  ).map((test) => test.path);

  const affectedTests = sortUnique(
    [
      ...requiredTests.map((test) => test.testFile),
      ...collectAffectedTests(fileContracts, repoIndex),
      ...inferredAffectedTests,
    ].filter(Boolean),
  );
  const regressionSelection = selectRegressionSuite(
    requiredTests,
    affectedTests,
    slice.testLock.regressionSuite,
    fileContracts,
  );
  const regressionSuite = regressionSelection.regressionSuite;

  const exportContracts = buildExportContracts(fileContracts, repoIndex);
  const completeness = buildManifestCompleteness(
    fileContracts,
    requiredTests,
    regressionSuite,
    affectedTests,
    repoFiles,
  );
  const entryConditions = buildEntryConditions(slice, fileContracts);
  const impactAnalysis = buildImpactAnalysis(fileContracts, affectedTests, regressionSelection);
  const exitCriteria = buildExitCriteria(slice.exitCriteria, exportContracts);

  return {
    manifest: {
      entryConditions,
      fileContracts,
      exportContracts,
      completeness,
    },
    testLock: {
      ...slice.testLock,
      requiredTests,
      regressionSuite,
      locked: false,
      lockedAt: undefined,
    },
    impactAnalysis,
    exitCriteria,
  };
}

async function isTrackedWorkspacePath(workDir: string, filePath: string): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: workDir,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function collectDirectFiles(slice: Slice, session: Session): string[] {
  const files = new Set<string>();

  for (const contract of slice.manifest.fileContracts) {
    const normalized = normalizeRepoPath(contract.path);
    if (normalized) {
      files.add(normalized);
    }
  }

  for (const directFile of slice.impactAnalysis.directFiles) {
    const normalized = normalizeRepoPath(directFile);
    if (normalized) {
      files.add(normalized);
    }
  }

  for (const test of slice.testLock.requiredTests) {
    const normalized = normalizeRepoPath(test.testFile);
    if (normalized) {
      files.add(normalized);
    }
  }

  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));
  for (const finding of sliceFindings) {
    for (const file of finding.files) {
      const normalized = normalizeRepoPath(file.path);
      if (normalized) {
        files.add(normalized);
      }
    }
  }

  return sortUnique(files);
}

function buildFileReason(filePath: string, slice: Slice, session: Session): string {
  const reasons: string[] = [];
  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));

  for (const finding of sliceFindings) {
    if (finding.files.some((file) => normalizeRepoPath(file.path) === filePath)) {
      reasons.push(`Addresses finding: ${finding.title}`);
    }
  }

  if (slice.testLock.requiredTests.some((test) => normalizeRepoPath(test.testFile) === filePath)) {
    reasons.push('Required regression coverage for this slice');
  }

  if (reasons.length === 0) {
    reasons.push('Manifest compilation inferred this file from planned scope');
  }

  return reasons.join('; ');
}

async function hydrateTestRequirement(
  test: TestRequirement,
  slice: Slice,
  session: Session,
  workDir: string,
): Promise<TestRequirement> {
  const normalizedTestFile = normalizeRepoPath(test.testFile);
  const fileExists = await pathExists(resolve(workDir, normalizedTestFile));
  const findingTitles = session.findings
    .filter((finding) => slice.findings.includes(finding.id))
    .map((finding) => finding.title);

  return {
    ...test,
    testFile: normalizedTestFile,
    description:
      test.description ||
      (findingTitles.length > 0
        ? `Regression coverage for ${findingTitles.join(', ')}`
        : `Regression coverage for ${slice.title}`),
    coversFindings: test.coversFindings.length > 0 ? test.coversFindings : [...slice.findings],
    isNew: !fileExists,
    status:
      test.status === 'passing' || test.status === 'failing'
        ? test.status
        : fileExists
          ? 'written'
          : 'pending',
  };
}

function dedupeTestRequirements(requirements: TestRequirement[]): TestRequirement[] {
  const deduped = new Map<string, TestRequirement>();

  for (const requirement of requirements) {
    const key = normalizeRepoPath(requirement.testFile);
    if (!deduped.has(key)) {
      deduped.set(key, { ...requirement, testFile: key });
    }
  }

  return [...deduped.values()];
}

function collectAffectedTests(fileContracts: FileContract[], repoIndex: RepoIndex): string[] {
  const affectedTests = new Set<string>();

  for (const contract of fileContracts) {
    const dependents = repoIndex.importersByTarget.get(contract.path);
    if (!dependents) {
      continue;
    }

    for (const dependent of dependents) {
      if (repoIndex.testFiles.has(dependent)) {
        affectedTests.add(dependent);
      }
    }
  }

  return [...affectedTests];
}

interface RegressionSuiteSelection {
  regressionSuite: string[];
  carriedForwardTests: string[];
  omittedTests: string[];
}

function selectRegressionSuite(
  requiredTests: TestRequirement[],
  affectedTests: string[],
  inheritedRegressionSuite: string[],
  fileContracts: FileContract[],
): RegressionSuiteSelection {
  const requiredTestSet = new Set(requiredTests.map((test) => normalizeRepoPath(test.testFile)));
  const impactedRegressionTests = affectedTests.filter(
    (testFile) => !requiredTestSet.has(testFile),
  );
  const impactedRegressionSet = new Set(impactedRegressionTests);
  const anchors = sortUnique([
    ...fileContracts.map((contract) => contract.path),
    ...fileContracts.flatMap((contract) => contract.dependents ?? []),
  ]).filter((path) => !isTestFile(path));

  const scoredInherited = sortUnique(
    inheritedRegressionSuite.map((testFile) => normalizeRepoPath(testFile)).filter(Boolean),
  )
    .filter((testFile) => !requiredTestSet.has(testFile))
    .filter((testFile) => !impactedRegressionSet.has(testFile))
    .map((testFile) => ({
      testFile,
      score: scoreRegressionTestRelevance(testFile, anchors),
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.testFile.localeCompare(right.testFile);
    });

  const carriedForwardTests = scoredInherited
    .filter((entry) => entry.score >= MIN_REGRESSION_RELEVANCE_SCORE)
    .slice(0, MAX_CARRIED_FORWARD_REGRESSION_TESTS)
    .map((entry) => entry.testFile);
  const carriedForwardSet = new Set(carriedForwardTests);
  const omittedTests = scoredInherited
    .filter((entry) => !carriedForwardSet.has(entry.testFile))
    .map((entry) => entry.testFile);

  return {
    regressionSuite: sortUnique([...impactedRegressionTests, ...carriedForwardTests]),
    carriedForwardTests,
    omittedTests,
  };
}

function scoreRegressionTestRelevance(testFile: string, anchors: string[]): number {
  if (anchors.length === 0) {
    return 0;
  }

  const candidate = analyzePathAffinity(testFile);
  let bestScore = 0;

  for (const anchorPath of anchors) {
    const anchor = analyzePathAffinity(anchorPath);
    let score = 0;

    if (candidate.packageRoot && candidate.packageRoot === anchor.packageRoot) {
      score += 2;
    }

    const sharedPrefix = sharedPrefixLength(candidate.relevantDirs, anchor.relevantDirs);
    score += Math.min(4, sharedPrefix * 2);

    if (candidate.parentDir && candidate.parentDir === anchor.parentDir) {
      score += 2;
    }

    if (
      candidate.stem &&
      anchor.stem &&
      (candidate.stem === anchor.stem ||
        candidate.stem.includes(anchor.stem) ||
        anchor.stem.includes(candidate.stem))
    ) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

interface PathAffinity {
  packageRoot: string;
  relevantDirs: string[];
  parentDir: string;
  stem: string;
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

function buildExportContracts(
  fileContracts: FileContract[],
  repoIndex: RepoIndex,
): ExportContract[] {
  const contracts: ExportContract[] = [];

  for (const fileContract of fileContracts) {
    if (fileContract.action === 'delete') {
      continue;
    }

    const exports =
      fileContract.expectedExports ?? repoIndex.exportsByFile.get(fileContract.path) ?? [];
    if (exports.length === 0) {
      continue;
    }

    const dependents = sortUnique(repoIndex.importersByTarget.get(fileContract.path));
    for (const exportName of exports) {
      contracts.push({
        sourceFile: fileContract.path,
        exportName,
        consumers: dependents,
        isNew: fileContract.action === 'create',
      });
    }
  }

  return contracts;
}

function buildEntryConditions(slice: Slice, fileContracts: FileContract[]): EntryCondition[] {
  const conditions: EntryCondition[] = [];

  for (const dependency of slice.dependencies) {
    conditions.push({
      id: `slice-${dependency}-committed`,
      type: 'slice-committed',
      description: `Slice ${dependency + 1} must be committed first`,
      reference: String(dependency),
      met: false,
    });
  }

  for (const contract of fileContracts) {
    if (contract.action !== 'modify' && contract.action !== 'delete') {
      continue;
    }

    conditions.push({
      id: `file-exists:${contract.path}`,
      type: 'file-exists',
      description: `${contract.path} must exist before this slice starts`,
      reference: contract.path,
      met: false,
    });
  }

  return dedupeEntryConditions(conditions);
}

function dedupeEntryConditions(conditions: EntryCondition[]): EntryCondition[] {
  const deduped = new Map<string, EntryCondition>();

  for (const condition of conditions) {
    deduped.set(condition.id, condition);
  }

  return [...deduped.values()];
}

function buildImpactAnalysis(
  fileContracts: FileContract[],
  affectedTests: string[],
  regressionSelection: RegressionSuiteSelection,
): ImpactAnalysis {
  const directFiles = fileContracts.map((contract) => contract.path);
  const dependentFiles = sortUnique(
    fileContracts
      .flatMap((contract) => contract.dependents ?? [])
      .filter((path) => !isTestFile(path)),
  );
  const nonTestDirectFiles = directFiles.filter((path) => !isTestFile(path));
  const hasDelete = fileContracts.some((contract) => contract.action === 'delete');

  const riskLevel: ImpactAnalysis['riskLevel'] =
    hasDelete || dependentFiles.length >= 5
      ? 'high'
      : dependentFiles.length > 0 || nonTestDirectFiles.length > 2
        ? 'medium'
        : 'low';

  const notes =
    dependentFiles.length > 0
      ? `Manifest compiler found ${dependentFiles.length} dependent files and ${affectedTests.length} affected tests.`
      : `Manifest compiler found ${affectedTests.length} affected tests and no dependent source files.`;
  const regressionNotes = [
    regressionSelection.carriedForwardTests.length > 0
      ? `Retained ${regressionSelection.carriedForwardTests.length} relevant inherited regression test(s).`
      : undefined,
    regressionSelection.omittedTests.length > 0
      ? `Omitted ${regressionSelection.omittedTests.length} low-affinity inherited regression test(s).`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    directFiles,
    dependentFiles,
    affectedTests,
    riskLevel,
    notes: regressionNotes ? `${notes} ${regressionNotes}` : notes,
  };
}

function buildExitCriteria(
  existing: ExitCriterion[],
  exportContracts: ExportContract[],
): ExitCriterion[] {
  const criteria = new Map(existing.map((criterion) => [criterion.id, criterion]));

  if (!criteria.has('workspace-scope-clean')) {
    criteria.set('workspace-scope-clean', {
      id: 'workspace-scope-clean',
      type: 'workspace-scope-clean',
      description:
        'Workspace reconcile produced no out-of-scope working tree changes that fall outside the declared slice manifest',
      passed: false,
    });
  }

  if (!criteria.has('architecture-reviewed')) {
    criteria.set('architecture-reviewed', {
      id: 'architecture-reviewed',
      type: 'architecture-reviewed',
      description: 'Architecture review found no blocking seam, wiring, or future-proofing issues',
      passed: false,
    });
  }

  if (exportContracts.length > 0) {
    criteria.set('exports-wired', {
      id: 'exports-wired',
      type: 'exports-wired',
      description: 'All exported contracts have known consumers or are intentionally isolated',
      passed: false,
    });
  } else {
    criteria.delete('exports-wired');
  }

  return [...criteria.values()];
}

function buildManifestCompleteness(
  fileContracts: FileContract[],
  requiredTests: TestRequirement[],
  regressionSuite: string[],
  affectedTests: string[],
  repoFiles: string[],
) {
  const hints = new Map<string, ManifestCompletenessHint>();
  const directFileSet = new Set(fileContracts.map((contract) => contract.path));
  const requiredTestSet = new Set(requiredTests.map((test) => test.testFile));
  const regressionTestSet = new Set(regressionSuite.map((path) => normalizeRepoPath(path)));
  const repoFileSet = new Set(repoFiles);

  for (const contract of fileContracts) {
    for (const dependent of contract.dependents ?? []) {
      if (isTestFile(dependent) || directFileSet.has(dependent)) {
        continue;
      }

      upsertCompletenessHint(hints, {
        path: dependent,
        kind: 'consumer',
        suggestedAction: 'review',
        reason: `${dependent} imports ${contract.path}; promote it into the direct edit contract if the shared seam or wiring must change.`,
      });
    }

    if (!isSourceFile(contract.path) || isTestFile(contract.path)) {
      continue;
    }

    for (const barrelPath of collectNearbyBarrelFiles(contract.path, repoFileSet)) {
      if (directFileSet.has(barrelPath)) {
        continue;
      }

      upsertCompletenessHint(hints, {
        path: barrelPath,
        kind: 'barrel',
        suggestedAction: 'review',
        reason: `${barrelPath} is a nearby export surface for ${contract.path}; confirm whether the slice must update a barrel or registry entry.`,
      });
    }
  }

  for (const testFile of affectedTests) {
    if (requiredTestSet.has(testFile)) {
      continue;
    }

    upsertCompletenessHint(hints, {
      path: testFile,
      kind: 'test',
      suggestedAction: 'promote-test',
      reason: regressionTestSet.has(testFile)
        ? `${testFile} is covered only as regression today; promote it to a required slice test if this change directly moves the contract it exercises.`
        : `${testFile} was discovered during impact analysis but is not explicitly locked for this slice yet.`,
    });
  }

  const orderedHints = sortCompletenessHints(hints.values());
  const consumerCount = orderedHints.filter(
    (hint) => hint.kind === 'consumer' || hint.kind === 'barrel',
  ).length;
  const testCount = orderedHints.filter((hint) => hint.kind === 'test').length;
  const summary =
    orderedHints.length === 0
      ? 'Manifest completeness preflight found no additional consumer or test touchpoints.'
      : `Manifest completeness preflight flagged ${consumerCount} consumer/barrel touchpoint${consumerCount === 1 ? '' : 's'} and ${testCount} test coverage gap${testCount === 1 ? '' : 's'}.`;

  return {
    summary,
    hints: orderedHints,
  };
}

function collectNearbyBarrelFiles(filePath: string, repoFileSet: Set<string>): string[] {
  const candidates = new Set<string>();
  let currentDir = dirname(filePath);

  for (let depth = 0; depth < 2; depth += 1) {
    if (!currentDir || currentDir === '.' || currentDir === '/') {
      break;
    }

    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = normalizeRepoPath(`${currentDir}/index${extension}`);
      if (candidate !== filePath && repoFileSet.has(candidate)) {
        candidates.add(candidate);
      }
    }

    const nextDir = dirname(currentDir);
    if (nextDir === currentDir) {
      break;
    }
    currentDir = nextDir;
  }

  return sortUnique(candidates);
}

function upsertCompletenessHint(
  hints: Map<string, ManifestCompletenessHint>,
  hint: ManifestCompletenessHint,
): void {
  const existing = hints.get(hint.path);
  if (!existing || completenessHintPriority(hint) > completenessHintPriority(existing)) {
    hints.set(hint.path, hint);
  }
}

function sortCompletenessHints(
  hints: Iterable<ManifestCompletenessHint>,
): ManifestCompletenessHint[] {
  return [...hints].sort((left, right) => {
    const priorityDelta = completenessHintPriority(right) - completenessHintPriority(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.path.localeCompare(right.path);
  });
}

function completenessHintPriority(hint: ManifestCompletenessHint): number {
  switch (hint.kind) {
    case 'consumer':
      return 3;
    case 'barrel':
      return 2;
    case 'test':
      return 1;
  }
}
