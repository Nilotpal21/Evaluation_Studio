import type {
  AutonomyEvidenceSignal,
  AutonomyPolicyConfig,
  Finding,
  FindingCategory,
  ModuleTrustProfile,
  Session,
  Slice,
  SliceAutonomyState,
  SliceBulkReviewStatus,
  SliceConfidenceLevel,
} from '../types.js';
import { getSliceFiles } from './slice-view.js';

const DEFAULT_SENSITIVE_PATH_PATTERNS = [
  'auth',
  'permission',
  'policy',
  'tenant',
  'project',
  'user',
  'session',
  'token',
  'oauth',
  'crypto',
  'secret',
  'middleware',
  'route',
  'router',
  'schema',
  'migration',
  'model',
  'mongo',
  'redis',
] as const;

const DEFAULT_SENSITIVE_FINDING_CATEGORIES: FindingCategory[] = ['security', 'isolation'];
const DEFAULT_MIN_CONFIDENCE_SCORE = 6;
const DEFAULT_HIGH_CONFIDENCE_SCORE = 9;

export interface ResolvedAutonomyPolicy {
  mode: 'manual' | 'thresholded';
  autoCommitMaxRisk: SliceAutonomyState['riskLevel'];
  deferBulkReview: boolean;
  lowRiskMaxScore: number;
  mediumRiskMaxScore: number;
  minConfidenceScore: number;
  highConfidenceScore: number;
  sensitivePathPatterns: string[];
  sensitiveFindingCategories: FindingCategory[];
  moduleTrustProfiles: ModuleTrustProfile[];
}

const RISK_RANK: Record<SliceAutonomyState['riskLevel'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function resolveAutonomyPolicy(policy?: AutonomyPolicyConfig): ResolvedAutonomyPolicy {
  const minConfidenceScore = policy?.minConfidenceScore ?? DEFAULT_MIN_CONFIDENCE_SCORE;
  const highConfidenceScore = Math.max(
    policy?.highConfidenceScore ?? DEFAULT_HIGH_CONFIDENCE_SCORE,
    minConfidenceScore,
  );

  return {
    mode: policy?.mode ?? 'manual',
    autoCommitMaxRisk: policy?.autoCommitMaxRisk ?? 'low',
    deferBulkReview: policy?.deferBulkReview ?? true,
    lowRiskMaxScore: policy?.lowRiskMaxScore ?? 3,
    mediumRiskMaxScore: policy?.mediumRiskMaxScore ?? 7,
    minConfidenceScore,
    highConfidenceScore,
    sensitivePathPatterns: policy?.sensitivePathPatterns ?? [...DEFAULT_SENSITIVE_PATH_PATTERNS],
    sensitiveFindingCategories:
      policy?.sensitiveFindingCategories ?? DEFAULT_SENSITIVE_FINDING_CATEGORIES,
    moduleTrustProfiles: policy?.moduleTrustProfiles ?? [],
  };
}

export function compareRiskLevels(
  left: SliceAutonomyState['riskLevel'],
  right: SliceAutonomyState['riskLevel'],
): number {
  return RISK_RANK[left] - RISK_RANK[right];
}

export function isRiskAtOrBelow(
  riskLevel: SliceAutonomyState['riskLevel'],
  maxRisk: SliceAutonomyState['riskLevel'],
): boolean {
  return compareRiskLevels(riskLevel, maxRisk) <= 0;
}

export function assessSliceAutonomy(
  session: Session,
  slice: Slice,
  policyInput?: AutonomyPolicyConfig,
): SliceAutonomyState {
  const policy = resolveAutonomyPolicy(policyInput);
  const files = collectSlicePaths(slice);
  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));
  const directSourceFiles = slice.impactAnalysis.directFiles.filter((file) => !isTestLike(file));
  const sensitivePaths = files.filter((file) =>
    policy.sensitivePathPatterns.some((pattern) => includesPathToken(file, pattern)),
  );
  const signals = collectConfidenceSignals(slice);
  const matchedProfiles = findMatchedTrustProfiles(files, policy.moduleTrustProfiles);

  const riskReasons: string[] = [];
  let riskScore = baseRiskScore(slice.impactAnalysis.riskLevel);

  riskReasons.push(
    `Manifest impact risk is ${slice.impactAnalysis.riskLevel} (${slice.impactAnalysis.directFiles.length} direct file(s), ${slice.impactAnalysis.dependentFiles.length} dependent file(s))`,
  );

  if (slice.manifest.fileContracts.some((contract) => contract.action === 'delete')) {
    riskScore += 3;
    riskReasons.push('Deletes files or code paths, which makes rollback and compatibility riskier');
  }

  if (slice.impactAnalysis.dependentFiles.length >= 3) {
    riskScore += 2;
    riskReasons.push(
      `Touches ${slice.impactAnalysis.dependentFiles.length} dependent files, so the blast radius extends beyond the slice boundary`,
    );
  }

  if (directSourceFiles.length >= 4) {
    riskScore += 2;
    riskReasons.push(`Changes ${directSourceFiles.length} source files in one slice`);
  } else if (directSourceFiles.length >= 2) {
    riskScore += 1;
    riskReasons.push(`Changes multiple source files (${directSourceFiles.length}) in one slice`);
  }

  if (slice.manifest.exportContracts.length > 0) {
    riskScore += 2;
    riskReasons.push('Touches exported contracts or downstream consumer wiring');
  }

  if (slice.testLock.regressionSuite.length >= 4) {
    riskScore += 1;
    riskReasons.push(
      `Carries a broad regression suite (${slice.testLock.regressionSuite.length} inherited tests)`,
    );
  }

  const highSeverityFindings = sliceFindings.filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  );
  if (highSeverityFindings.length > 0) {
    riskScore += 2;
    riskReasons.push(
      `Addresses ${highSeverityFindings.length} high-severity finding(s), so regressions would be expensive`,
    );
  }

  const sensitiveCategories = unique(
    sliceFindings
      .map((finding) => finding.category)
      .filter((category) => policy.sensitiveFindingCategories.includes(category)),
  );
  if (sensitiveCategories.length > 0) {
    riskScore += 5;
    riskReasons.push(`Includes sensitive finding categories: ${sensitiveCategories.join(', ')}`);
  }

  if (sensitivePaths.length > 0) {
    riskScore += 4;
    riskReasons.push(
      `Touches sensitive files or seams: ${unique(sensitivePaths).slice(0, 5).join(', ')}`,
    );
  }

  const riskLevel = classifyRiskLevel(riskScore, policy);

  const confidenceReasons: string[] = [];
  let confidenceScore = 0;

  if (signals.has('required-tests')) {
    confidenceScore += 2;
    confidenceReasons.push(
      `${slice.testLock.requiredTests.length} required regression test(s) are declared for this slice`,
    );
  } else {
    confidenceScore -= 3;
    confidenceReasons.push('No required regression tests are declared for this slice');
  }

  if (signals.has('passing-required-tests')) {
    confidenceScore += 2;
    confidenceReasons.push('Required tests are passing and the slice can engage the test lock');
  } else if (signals.has('required-tests')) {
    confidenceScore -= 1;
    confidenceReasons.push('Required tests exist, but the slice has not yet proven them passing');
  }

  if (signals.has('regression-suite')) {
    confidenceScore += 2;
    confidenceReasons.push(
      `${slice.testLock.regressionSuite.length} regression test(s) from earlier slices still guard this seam`,
    );
  } else {
    confidenceScore -= 1;
    confidenceReasons.push('No inherited regression suite is protecting this seam yet');
  }

  if (signals.has('affected-tests')) {
    const coverageBreadth =
      directSourceFiles.length > 0
        ? Math.min(slice.impactAnalysis.affectedTests.length, directSourceFiles.length)
        : slice.impactAnalysis.affectedTests.length;
    confidenceScore += coverageBreadth >= Math.max(1, directSourceFiles.length) ? 2 : 1;
    confidenceReasons.push(
      `${slice.impactAnalysis.affectedTests.length} affected test file(s) were discovered for the changed module boundary`,
    );
  } else {
    confidenceScore -= 2;
    confidenceReasons.push(
      'Impact analysis did not identify affected tests for the changed module',
    );
  }

  if (signals.has('e2e')) {
    confidenceScore += 3;
    confidenceReasons.push('Module confidence includes an E2E or boundary-level black-box test');
  } else if (slice.impactAnalysis.dependentFiles.length > 0 || sensitivePaths.length > 0) {
    confidenceScore -= 2;
    confidenceReasons.push(
      'The slice changes a shared or sensitive seam without explicit E2E evidence yet',
    );
  } else {
    confidenceReasons.push('No E2E evidence was detected, but the seam remains locally bounded');
  }

  let effectiveAutoCommitMaxRisk = policy.autoCommitMaxRisk;
  const matchedTrustProfiles: string[] = [];

  for (const profile of matchedProfiles) {
    matchedTrustProfiles.push(profile.name);

    if (profile.notes?.trim()) {
      confidenceReasons.push(`Trust profile ${profile.name}: ${profile.notes.trim()}`);
    }

    const confidenceBoost = profile.confidenceBoost ?? 0;
    if (confidenceBoost !== 0) {
      confidenceScore += confidenceBoost;
      confidenceReasons.push(
        `Trust profile ${profile.name} adjusts confidence by ${formatSignedScore(confidenceBoost)}`,
      );
    }

    if (profile.requiredSignals && profile.requiredSignals.length > 0) {
      const missingSignals = profile.requiredSignals.filter((signal) => !signals.has(signal));
      if (missingSignals.length > 0) {
        confidenceScore -= 3;
        confidenceReasons.push(
          `Trust profile ${profile.name} is missing required evidence: ${missingSignals.join(', ')}`,
        );
      } else {
        confidenceReasons.push(
          `Trust profile ${profile.name} requirements are satisfied: ${profile.requiredSignals.join(', ')}`,
        );
      }
    }

    if (profile.maxAutoCommitRisk) {
      effectiveAutoCommitMaxRisk = maxRiskLevel(
        effectiveAutoCommitMaxRisk,
        profile.maxAutoCommitRisk,
      );
      confidenceReasons.push(
        `Trust profile ${profile.name} allows auto-commit up to ${profile.maxAutoCommitRisk} risk`,
      );
    }
  }

  const confidenceLevel = classifyConfidenceLevel(confidenceScore, policy);
  const disposition =
    policy.mode === 'thresholded' &&
    policy.deferBulkReview &&
    isRiskAtOrBelow(riskLevel, effectiveAutoCommitMaxRisk) &&
    confidenceScore >= policy.minConfidenceScore
      ? 'deferred-bulk-review'
      : 'manual-checkpoint';

  const bulkReviewStatus = preserveBulkReviewStatus(slice.autonomy?.bulkReviewStatus, disposition);

  return {
    disposition,
    riskLevel,
    riskScore,
    reasons: riskReasons,
    confidenceLevel,
    confidenceScore,
    confidenceReasons,
    matchedTrustProfiles,
    bulkReviewStatus,
    assessedAt: new Date().toISOString(),
  };
}

export function markSliceQueuedForBulkReview(slice: Slice): SliceAutonomyState | undefined {
  if (!slice.autonomy || slice.autonomy.disposition !== 'deferred-bulk-review') {
    return slice.autonomy;
  }

  return {
    ...slice.autonomy,
    bulkReviewStatus: 'queued',
    assessedAt: new Date().toISOString(),
  };
}

export function markSliceBulkReviewStatus(
  slice: Slice,
  status: Extract<SliceBulkReviewStatus, 'approved' | 'blocked'>,
): SliceAutonomyState | undefined {
  if (!slice.autonomy) {
    return undefined;
  }

  return {
    ...slice.autonomy,
    bulkReviewStatus: status,
    assessedAt: new Date().toISOString(),
  };
}

export function getDeferredBulkReviewSlices(session: Session): Slice[] {
  return session.slices.filter(
    (slice) => slice.status === 'committed' && slice.autonomy?.bulkReviewStatus === 'queued',
  );
}

export function formatDeferredBulkReviewQueue(session: Session): string {
  const queuedSlices = getDeferredBulkReviewSlices(session);
  if (queuedSlices.length === 0) {
    return '(no autonomously committed slices are queued for deferred review)';
  }

  return queuedSlices
    .map((slice) => {
      const commit = slice.commit
        ? `${slice.commit.sha.slice(0, 7)} ${slice.commit.message}`
        : '(not committed)';
      const riskReasons =
        slice.autonomy && slice.autonomy.reasons.length > 0
          ? slice.autonomy.reasons.map((reason) => `    - ${reason}`).join('\n')
          : '    - (no risk reasons recorded)';
      const confidenceReasons =
        slice.autonomy && slice.autonomy.confidenceReasons.length > 0
          ? slice.autonomy.confidenceReasons.map((reason) => `    - ${reason}`).join('\n')
          : '    - (no confidence reasons recorded)';
      return [
        `Slice ${slice.index + 1}: ${slice.title}`,
        `  Risk: ${slice.autonomy?.riskLevel ?? slice.impactAnalysis.riskLevel} (${slice.autonomy?.riskScore ?? 'n/a'})`,
        `  Confidence: ${slice.autonomy?.confidenceLevel ?? 'n/a'} (${slice.autonomy?.confidenceScore ?? 'n/a'})`,
        `  Commit: ${commit}`,
        `  Files: ${getSliceFiles(slice).join(', ') || '(none declared)'}`,
        '  Why it was auto-committed:',
        riskReasons,
        '  Confidence evidence:',
        confidenceReasons,
      ].join('\n');
    })
    .join('\n\n');
}

export function formatSliceAutonomySummary(slice: Slice): string {
  if (!slice.autonomy) {
    return '(autonomy policy has not been assessed yet)';
  }

  const commitPath =
    slice.autonomy.disposition === 'deferred-bulk-review'
      ? 'Eligible for auto-commit and deferred bulk review if the slice stays bounded.'
      : 'Requires an explicit checkpoint before commit because risk or confidence is outside the autonomy threshold.';
  const riskReasons =
    slice.autonomy.reasons.length > 0
      ? slice.autonomy.reasons.map((reason) => `  - ${reason}`).join('\n')
      : '  - (no risk factors recorded)';
  const confidenceReasons =
    slice.autonomy.confidenceReasons.length > 0
      ? slice.autonomy.confidenceReasons.map((reason) => `  - ${reason}`).join('\n')
      : '  - (no confidence evidence recorded)';
  const trustProfiles =
    slice.autonomy.matchedTrustProfiles.length > 0
      ? slice.autonomy.matchedTrustProfiles.join(', ')
      : '(none)';

  return [
    `Risk: ${slice.autonomy.riskLevel} (score ${slice.autonomy.riskScore})`,
    `Confidence: ${slice.autonomy.confidenceLevel} (score ${slice.autonomy.confidenceScore})`,
    `Matched trust profiles: ${trustProfiles}`,
    `Commit path: ${commitPath}`,
    'Current risk factors:',
    riskReasons,
    'Confidence evidence:',
    confidenceReasons,
  ].join('\n');
}

function baseRiskScore(riskLevel: SliceAutonomyState['riskLevel']): number {
  switch (riskLevel) {
    case 'low':
      return 1;
    case 'medium':
      return 4;
    case 'high':
      return 8;
  }
}

function classifyRiskLevel(
  riskScore: number,
  policy: ResolvedAutonomyPolicy,
): SliceAutonomyState['riskLevel'] {
  if (riskScore <= policy.lowRiskMaxScore) {
    return 'low';
  }

  if (riskScore <= policy.mediumRiskMaxScore) {
    return 'medium';
  }

  return 'high';
}

function classifyConfidenceLevel(
  confidenceScore: number,
  policy: ResolvedAutonomyPolicy,
): SliceConfidenceLevel {
  if (confidenceScore >= policy.highConfidenceScore) {
    return 'high';
  }

  if (confidenceScore >= policy.minConfidenceScore) {
    return 'medium';
  }

  return 'low';
}

function preserveBulkReviewStatus(
  current: SliceBulkReviewStatus | undefined,
  disposition: SliceAutonomyState['disposition'],
): SliceBulkReviewStatus {
  if (disposition !== 'deferred-bulk-review') {
    return 'not-required';
  }

  if (current === 'queued' || current === 'approved' || current === 'blocked') {
    return current;
  }

  return 'not-required';
}

function collectSlicePaths(slice: Slice): string[] {
  return unique([
    ...getSliceFiles(slice),
    ...slice.impactAnalysis.directFiles,
    ...slice.impactAnalysis.dependentFiles,
    ...slice.testLock.requiredTests.map((test) => test.testFile),
    ...slice.testLock.regressionSuite,
    ...slice.legacyPaths.map((legacyPath) => legacyPath.path),
  ]);
}

function collectConfidenceSignals(slice: Slice): Set<AutonomyEvidenceSignal> {
  const signals = new Set<AutonomyEvidenceSignal>();
  const requiredTests = slice.testLock.requiredTests;

  if (requiredTests.length > 0) {
    signals.add('required-tests');
  }

  if (
    requiredTests.length > 0 &&
    requiredTests.every((test) => test.status === 'passing') &&
    slice.testLock.locked
  ) {
    signals.add('passing-required-tests');
  }

  if (slice.testLock.regressionSuite.length > 0) {
    signals.add('regression-suite');
  }

  if (slice.impactAnalysis.affectedTests.length > 0) {
    signals.add('affected-tests');
  }

  const e2eFiles = [
    ...requiredTests.map((test) => test.testFile),
    ...slice.testLock.regressionSuite,
    ...slice.impactAnalysis.affectedTests,
  ];
  const hasE2E = e2eFiles.some(isE2ETestPath);
  const hasE2EDescription = requiredTests.some((test) => /\be2e\b/i.test(test.description));
  if (hasE2E || hasE2EDescription) {
    signals.add('e2e');
  }

  return signals;
}

function findMatchedTrustProfiles(
  files: string[],
  profiles: ModuleTrustProfile[],
): ModuleTrustProfile[] {
  return profiles.filter((profile) =>
    files.some((file) => profile.pathPatterns.some((pattern) => matchesPathPattern(file, pattern))),
  );
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        normalizedPattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '::DOUBLE_STAR::')
          .replace(/\*/g, '[^/]*')
          .replace(/::DOUBLE_STAR::/g, '.*') +
        '$',
    );
    return regex.test(normalizedPath);
  }

  return normalizedPath.includes(normalizedPattern);
}

function includesPathToken(filePath: string, token: string): boolean {
  const normalized = normalizePath(filePath);
  const escaped = escapeRegExp(normalizePath(token));
  const matcher = new RegExp(`(^|[\\/_\\-.])${escaped}($|[\\/_\\-.])`);
  return matcher.test(normalized);
}

function maxRiskLevel(
  left: SliceAutonomyState['riskLevel'],
  right: SliceAutonomyState['riskLevel'],
): SliceAutonomyState['riskLevel'] {
  return compareRiskLevels(left, right) >= 0 ? left : right;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTestLike(filePath: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)[^.]+\.(?:test|spec|e2e)\.[^.]+$/i.test(filePath);
}

function isE2ETestPath(filePath: string): boolean {
  return /(?:^|\/)__tests__\/e2e\/|(?:^|\/)e2e\/|\.e2e\.[^.]+$/i.test(filePath);
}

function formatSignedScore(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function findingCategoriesForSlice(session: Session, slice: Slice): FindingCategory[] {
  return unique(
    session.findings
      .filter((finding) => slice.findings.includes(finding.id))
      .map((finding) => finding.category),
  ) as FindingCategory[];
}

export function findingsForSlice(session: Session, slice: Slice): Finding[] {
  return session.findings.filter((finding) => slice.findings.includes(finding.id));
}
