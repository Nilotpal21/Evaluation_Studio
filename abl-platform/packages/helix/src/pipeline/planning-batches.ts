import type { Finding, FindingCategory, FindingSeverity, Session } from '../types.js';
import { getVisiblePlanFindings } from './plan-review-state.js';

const MAX_BATCH_FINDINGS_BEFORE_SPLIT = 8;
const MAX_BATCHES = 8;
const MAX_INLINE_FINDING_IDS = 8;
const MAX_KEY_FILES = 4;

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 50,
  high: 20,
  medium: 8,
  low: 3,
  info: 1,
};

const CATEGORY_WEIGHT: Partial<Record<FindingCategory, number>> = {
  security: 18,
  isolation: 18,
  bug: 10,
  inconsistency: 8,
  'wiring-gap': 7,
  'missing-test': 4,
};

const ROOT_PREFIXES = new Set(['apps', 'packages', 'tools', 'docs']);

export interface PlanningBatch {
  key: string;
  title: string;
  rationale: string;
  orderHint: string;
  scopeRoots: string[];
  seamKey: string;
  findingIds: string[];
  keyFiles: string[];
  categories: FindingCategory[];
  severityCounts: Record<FindingSeverity, number>;
  priorityScore: number;
}

interface DecoratedFinding {
  finding: Finding;
  files: string[];
  primaryRoot: string;
  seamKey: string;
}

export function buildPlanningBatches(session: Session): PlanningBatch[] {
  const openFindings = getVisiblePlanFindings(session);
  if (openFindings.length === 0) {
    return [];
  }

  const scopeRoots = deriveScopeRoots(session);
  const dependentsByFile = new Map(
    (session.promptContext?.codeMap?.keyFiles ?? []).map((file) => [
      normalizePath(file.path),
      file.dependents.length,
    ]),
  );
  const decorated = openFindings.map((finding) =>
    decorateFinding(finding, scopeRoots, dependentsByFile),
  );

  const rootGroups = groupBy(decorated, (candidate) => candidate.primaryRoot, compareGroupKeys);
  const batches: PlanningBatch[] = [];

  for (const [rootKey, rootFindings] of rootGroups) {
    const splitGroups = splitOversizedRootGroup(rootKey, rootFindings);
    for (const [batchKey, findings] of splitGroups) {
      batches.push(buildPlanningBatch(batchKey, findings, dependentsByFile));
    }
  }

  return batches
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      if (right.findingIds.length !== left.findingIds.length) {
        return right.findingIds.length - left.findingIds.length;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, MAX_BATCHES);
}

export function formatPlanningBatches(session: Session): string {
  const batches = buildPlanningBatches(session);
  if (batches.length === 0) {
    return '(no open findings to batch)';
  }

  const lines = ['Use these deterministic planning batches as a starting outline.'];

  for (const [index, batch] of batches.entries()) {
    const severitySummary = summarizeSeverityCounts(batch.severityCounts);
    const findingIds =
      batch.findingIds.length > MAX_INLINE_FINDING_IDS
        ? `${batch.findingIds.slice(0, MAX_INLINE_FINDING_IDS).join(', ')} ... and ${batch.findingIds.length - MAX_INLINE_FINDING_IDS} more`
        : batch.findingIds.join(', ');

    lines.push('');
    lines.push(
      `${index + 1}. ${batch.title} | ${batch.findingIds.length} findings | ${severitySummary} | ${batch.orderHint}`,
    );
    lines.push(`   IDs: ${findingIds}`);
    if (batch.keyFiles.length > 0) {
      lines.push(`   Files: ${batch.keyFiles.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function decorateFinding(
  finding: Finding,
  scopeRoots: string[],
  dependentsByFile: Map<string, number>,
): DecoratedFinding {
  const files = unique(finding.files.map((file) => normalizePath(file.path)));
  const primaryRoot = derivePrimaryRoot(files, scopeRoots, finding.category);
  const seamKey = deriveSeamKey(files, primaryRoot, finding.category, dependentsByFile);
  return { finding, files, primaryRoot, seamKey };
}

function deriveScopeRoots(session: Session): string[] {
  const candidates =
    session.promptContext?.codeMap?.scope && session.promptContext.codeMap.scope.length > 0
      ? session.promptContext.codeMap.scope
      : session.workItem.scope;

  return unique(candidates.map(normalizeScopeEntry)).sort(
    (left, right) => right.length - left.length,
  );
}

function normalizeScopeEntry(scopeEntry: string): string {
  const normalized = normalizePath(scopeEntry);
  if (looksLikeFile(normalized)) {
    return dirname(normalized);
  }
  return normalized;
}

function derivePrimaryRoot(
  files: string[],
  scopeRoots: string[],
  category: FindingCategory,
): string {
  if (files.length === 0) {
    return `category:${category}`;
  }

  const matchedRoots = unique(
    files
      .map((file) => scopeRoots.find((root) => file === root || file.startsWith(`${root}/`)))
      .filter((root): root is string => Boolean(root)),
  );

  if (matchedRoots.length === 1) {
    return matchedRoots[0];
  }

  if (matchedRoots.length > 1) {
    return 'cross-scope';
  }

  const packageRoots = unique(files.map(derivePackageRoot));
  if (packageRoots.length === 1) {
    return packageRoots[0];
  }

  return 'cross-scope';
}

function deriveSeamKey(
  files: string[],
  primaryRoot: string,
  category: FindingCategory,
  dependentsByFile: Map<string, number>,
): string {
  if (files.length === 0) {
    return `category:${category}`;
  }

  if (primaryRoot === 'cross-scope' || primaryRoot.startsWith('category:')) {
    return `category:${category}`;
  }

  const candidateScores = new Map<string, number>();
  for (const file of files) {
    const relative = stripPrefix(file, primaryRoot);
    const seam = relative ? relativeSeamKey(relative) : 'shared-root';
    const dependentWeight = dependentsByFile.get(file) ?? 0;
    candidateScores.set(seam, (candidateScores.get(seam) ?? 0) + 1 + dependentWeight);
  }

  return (
    [...candidateScores.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })[0]?.[0] ?? `category:${category}`
  );
}

function splitOversizedRootGroup(
  rootKey: string,
  findings: DecoratedFinding[],
): Array<[string, DecoratedFinding[]]> {
  if (findings.length <= MAX_BATCH_FINDINGS_BEFORE_SPLIT) {
    return [[rootKey, findings]];
  }

  const seamGroups = groupBy(findings, (candidate) => candidate.seamKey, compareGroupKeys);
  if (seamGroups.length <= 1) {
    return [[rootKey, findings]];
  }

  const splitGroups = seamGroups
    .map(([seamKey, group]) => [`${rootKey}::${seamKey}`, group] as [string, DecoratedFinding[]])
    .sort((left, right) => right[1].length - left[1].length);

  if (splitGroups.length > MAX_BATCHES) {
    return [[rootKey, findings]];
  }

  return splitGroups;
}

function buildPlanningBatch(
  key: string,
  findings: DecoratedFinding[],
  dependentsByFile: Map<string, number>,
): PlanningBatch {
  const findingIds = findings.map((candidate) => candidate.finding.id);
  const scopeRoots = unique(
    findings
      .map((candidate) => candidate.primaryRoot)
      .filter((root) => root !== 'cross-scope' && !root.startsWith('category:')),
  );
  const seamKey = mostCommon(findings.map((candidate) => candidate.seamKey)) ?? 'shared-root';
  const categories = unique(findings.map((candidate) => candidate.finding.category));
  const severityCounts = buildSeverityCounts(
    findings.map((candidate) => candidate.finding.severity),
  );
  const keyFiles = selectKeyFiles(findings, dependentsByFile);
  const priorityScore = scoreBatch(key, findings, dependentsByFile);

  return {
    key,
    title: buildBatchTitle(key, scopeRoots, seamKey, categories),
    rationale: buildBatchRationale(key, scopeRoots, seamKey, findings.length),
    orderHint: buildOrderHint(key, categories, severityCounts, dependentsByFile, keyFiles),
    scopeRoots,
    seamKey,
    findingIds,
    keyFiles,
    categories,
    severityCounts,
    priorityScore,
  };
}

function selectKeyFiles(
  findings: DecoratedFinding[],
  dependentsByFile: Map<string, number>,
): string[] {
  const scores = new Map<string, number>();
  for (const finding of findings) {
    for (const file of finding.files) {
      const dependentWeight = dependentsByFile.get(file) ?? 0;
      scores.set(file, (scores.get(file) ?? 0) + 1 + dependentWeight);
    }
  }

  return [...scores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_KEY_FILES)
    .map(([file]) => file);
}

function buildSeverityCounts(severities: FindingSeverity[]): Record<FindingSeverity, number> {
  return severities.reduce<Record<FindingSeverity, number>>(
    (counts, severity) => {
      counts[severity] += 1;
      return counts;
    },
    {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    },
  );
}

function summarizeSeverityCounts(counts: Record<FindingSeverity, number>): string {
  const parts = (Object.keys(counts) as FindingSeverity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`);
  return parts.join(', ') || 'no severities';
}

function buildBatchTitle(
  key: string,
  scopeRoots: string[],
  seamKey: string,
  categories: FindingCategory[],
): string {
  if (key.startsWith('cross-scope')) {
    const categoryLabel =
      categories.length === 1 ? humanizeCategory(categories[0]) : 'shared seams';
    return `Cross-scope foundation — ${categoryLabel}`;
  }

  if (key.startsWith('category:')) {
    return `Unscoped batch — ${humanizeCategory(categories[0] ?? 'bug')}`;
  }

  const rootLabel = scopeRoots[0] ? compactRootLabel(scopeRoots[0]) : compactRootLabel(key);
  const seamLabel = humanizeSeamKey(seamKey);
  return seamLabel ? `${rootLabel} — ${seamLabel}` : rootLabel;
}

function buildBatchRationale(
  key: string,
  scopeRoots: string[],
  seamKey: string,
  findingCount: number,
): string {
  if (key.startsWith('cross-scope')) {
    return `${findingCount} findings span multiple scope roots, so they likely need shared ordering, contracts, or coordinated cleanup.`;
  }

  if (key.startsWith('category:')) {
    return `${findingCount} findings do not have reliable file anchors, so they are grouped by issue type for manual review.`;
  }

  const scopeLabel = scopeRoots[0] ? compactRootLabel(scopeRoots[0]) : compactRootLabel(key);
  if (seamKey === 'shared-root') {
    return `${findingCount} findings mostly stay inside ${scopeLabel} and can be planned as one local seam lane.`;
  }

  return `${findingCount} findings share the ${humanizeSeamKey(seamKey)} seam inside ${scopeLabel}, which makes them a good planning lane.`;
}

function buildOrderHint(
  key: string,
  categories: FindingCategory[],
  severityCounts: Record<FindingSeverity, number>,
  dependentsByFile: Map<string, number>,
  keyFiles: string[],
): string {
  const sharedDependentCount = keyFiles.reduce(
    (max, file) => Math.max(max, dependentsByFile.get(file) ?? 0),
    0,
  );
  const needsFoundationFirst =
    key.startsWith('cross-scope') ||
    categories.some((category) => category === 'security' || category === 'isolation') ||
    severityCounts.critical > 0 ||
    sharedDependentCount >= 3;

  if (needsFoundationFirst) {
    return 'foundation first';
  }

  if (categories.length === 1 && categories[0] === 'missing-test') {
    return 'verification close to behavior';
  }

  return 'keep slices local unless a shared contract forces cross-batch work';
}

function scoreBatch(
  key: string,
  findings: DecoratedFinding[],
  dependentsByFile: Map<string, number>,
): number {
  let score = key.startsWith('cross-scope') ? 30 : 0;

  for (const { finding, files } of findings) {
    score += SEVERITY_WEIGHT[finding.severity];
    score += CATEGORY_WEIGHT[finding.category] ?? 0;
    if (files.length === 0) {
      score += 2;
    }
  }

  for (const file of selectKeyFiles(findings, dependentsByFile)) {
    score += Math.min(dependentsByFile.get(file) ?? 0, 6);
  }

  return score;
}

function compactRootLabel(value: string): string {
  const normalized = normalizePath(value);
  if (normalized === 'cross-scope') {
    return 'Cross-scope';
  }
  return normalized
    .replace(/^apps\//, 'apps/')
    .replace(/^packages\//, 'packages/')
    .replace(/^tools\//, 'tools/')
    .replace(/^docs\//, 'docs/');
}

function humanizeSeamKey(value: string): string {
  if (!value || value === 'shared-root') {
    return 'shared seam';
  }

  if (value.startsWith('category:')) {
    return humanizeCategory(value.slice('category:'.length) as FindingCategory);
  }

  return value
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[-_]+/g, ' '))
    .join(' / ');
}

function humanizeCategory(value: FindingCategory): string {
  return value.replace(/-/g, ' ');
}

function relativeSeamKey(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) {
    return 'shared-root';
  }

  const directoryParts = looksLikeFile(parts[parts.length - 1] ?? '') ? parts.slice(0, -1) : parts;
  const trimmed = directoryParts.filter((part) => part !== '__tests__');
  if (trimmed.length === 0) {
    return 'shared-root';
  }

  return trimmed.slice(0, 2).join('/');
}

function stripPrefix(filePath: string, prefix: string): string {
  if (filePath === prefix) {
    return '';
  }
  if (filePath.startsWith(`${prefix}/`)) {
    return filePath.slice(prefix.length + 1);
  }
  return filePath;
}

function derivePackageRoot(filePath: string): string {
  const parts = normalizePath(filePath).split('/').filter(Boolean);
  if (parts.length >= 2 && ROOT_PREFIXES.has(parts[0] ?? '')) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? filePath;
}

function dirname(filePath: string): string {
  const parts = normalizePath(filePath).split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

function looksLikeFile(value: string): boolean {
  return /\.[a-z0-9]+$/i.test(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}

function compareGroupKeys(left: string, right: string): number {
  if (left === 'cross-scope') {
    return -1;
  }
  if (right === 'cross-scope') {
    return 1;
  }
  return left.localeCompare(right);
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return (
    [...counts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })[0]?.[0] ?? null
  );
}

function groupBy<T>(
  values: T[],
  getKey: (value: T) => string,
  compareKeys?: (left: string, right: string) => number,
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = getKey(value);
    const existing = groups.get(key);
    if (existing) {
      existing.push(value);
    } else {
      groups.set(key, [value]);
    }
  }

  return [...groups.entries()].sort((left, right) =>
    compareKeys ? compareKeys(left[0], right[0]) : left[0].localeCompare(right[0]),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
