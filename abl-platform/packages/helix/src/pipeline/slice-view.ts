import type { ExitCriterion, Slice, SliceChecklist, TestLock } from '../types.js';

export function getSliceFiles(slice: Slice): string[] {
  const paths = new Set<string>();

  for (const contract of slice.manifest.fileContracts) {
    const path = contract.path.trim();
    if (path) {
      paths.add(path);
    }
  }

  return [...paths];
}

export function getSliceGateScopeEntries(slice: Slice): string[] {
  const paths = new Set<string>();

  for (const path of getSliceFiles(slice)) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const path of slice.impactAnalysis.dependentFiles) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const path of slice.impactAnalysis.affectedTests) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const test of slice.testLock.requiredTests) {
    const trimmed = test.testFile.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const path of slice.testLock.regressionSuite) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const contract of slice.manifest.exportContracts) {
    const sourceFile = contract.sourceFile.trim();
    if (sourceFile) {
      paths.add(sourceFile);
    }

    for (const consumer of contract.consumers) {
      const trimmed = consumer.trim();
      if (trimmed) {
        paths.add(trimmed);
      }
    }
  }

  return [...paths];
}

export function getSliceVerificationScopeEntries(slice: Slice): string[] {
  const paths = new Set<string>();

  for (const path of getSliceFiles(slice)) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const test of slice.testLock.requiredTests) {
    const trimmed = test.testFile.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const path of slice.testLock.regressionSuite) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  return [...paths];
}

export function getSliceReviewScopeEntries(slice: Slice): string[] {
  const paths = new Set<string>(getSliceGateScopeEntries(slice));

  for (const legacyPath of slice.legacyPaths) {
    const trimmed = legacyPath.path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  return [...paths];
}

/**
 * Build a SliceChecklist view from the slice's typed exit criteria + test lock.
 * This is a read-only derived view — the source of truth is on the Slice itself.
 */
export function buildSliceChecklist(slice: Slice): SliceChecklist {
  return {
    items: slice.exitCriteria.map((ec) => ({
      id: ec.id,
      label: ec.description,
      category: exitCriterionToCategory(ec.type),
      status: ec.passed ? 'passed' : 'pending',
      detail: ec.detail,
    })),
  };
}

/**
 * Update an exit criterion on a slice in-place.
 */
export function updateExitCriterion(
  slice: Slice,
  id: string,
  passed: boolean,
  detail?: string,
): void {
  const criterion = slice.exitCriteria.find((ec) => ec.id === id);
  if (!criterion) return;
  criterion.passed = passed;
  criterion.detail = detail;
}

/**
 * Check whether all exit criteria have passed.
 */
export function allExitCriteriaMet(slice: Slice): boolean {
  return slice.exitCriteria.every((ec) => ec.passed);
}

/**
 * Summarize exit criteria status as a compact string.
 */
export function summarizeExitCriteria(slice: Slice): string {
  const passed = slice.exitCriteria.filter((ec) => ec.passed).length;
  const total = slice.exitCriteria.length;
  const failed = slice.exitCriteria.filter((ec) => !ec.passed);
  const failedNames = failed.map((ec) => ec.id).join(', ');
  return `${passed}/${total} passed${failed.length > 0 ? ` (failing: ${failedNames})` : ''}`;
}

/**
 * Summarize test lock status.
 */
export function summarizeTestLock(lock: TestLock): string {
  const required = lock.requiredTests.length;
  const passing = lock.requiredTests.filter((t) => t.status === 'passing').length;
  const regression = lock.regressionSuite.length;
  const lockedStr = lock.locked ? 'LOCKED' : 'unlocked';
  return `${lockedStr} — ${passing}/${required} tests passing, ${regression} regression tests`;
}

export function canEngageTestLock(lock: TestLock): boolean {
  return (
    lock.requiredTests.length > 0 && lock.requiredTests.every((test) => test.status === 'passing')
  );
}

function exitCriterionToCategory(
  type: ExitCriterion['type'],
):
  | 'entry'
  | 'implementation'
  | 'architecture'
  | 'test-lock'
  | 'verification'
  | 'regression'
  | 'impact'
  | 'cleanup' {
  switch (type) {
    case 'typecheck':
    case 'lint':
      return 'verification';
    case 'workspace-scope-clean':
    case 'architecture-reviewed':
      return 'architecture';
    case 'test-lock':
      return 'test-lock';
    case 'impact-reviewed':
      return 'impact';
    case 'exports-wired':
      return 'implementation';
    case 'no-new-findings':
      return 'regression';
    case 'custom':
      return 'cleanup';
  }
}
