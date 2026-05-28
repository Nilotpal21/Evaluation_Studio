/**
 * Prompt-builders for retry / recovery contexts fed back into the model
 * on subsequent attempts (typecheck repair, test repair, existing-diff
 * resume, implementation recovery, manifest-drift, plan validation).
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type { ExitCriterion, QualityGateResult, Slice } from '../../types.js';
import { formatQualityGateCheckEvidence, summarizeFailedExitCriteria } from './gate-evidence.js';
import { truncateMultilineText, unwrapRetryOutput } from './text-utils.js';

export function buildTypecheckRepairRetryContext(
  slice: Slice,
  failedCriteria: ExitCriterion[],
  typecheckGate: QualityGateResult | undefined,
  previousOutput: string,
): string {
  const failedCriteriaSummary = summarizeFailedExitCriteria(failedCriteria);
  const typecheckEvidence =
    typecheckGate && typecheckGate.checks.length > 0
      ? typecheckGate.checks.map(formatQualityGateCheckEvidence).join('\n\n')
      : 'No scoped compiler output was captured.';
  const priorOutput = unwrapRetryOutput(previousOutput);
  const sections = [
    'TYPECHECK REPAIR REQUIRED',
    `Slice ${slice.index + 1} must fix the scoped TypeScript/compiler errors below before HELIX can continue.`,
    'Focus on the reported typecheck failures first. Keep the change set limited to the current slice files and only the directly required dependent types or wiring.',
    '',
    '## Failed Exit Criteria',
    failedCriteriaSummary,
    '',
    '## Scoped Typecheck Evidence',
    typecheckEvidence,
  ];

  if (priorOutput) {
    sections.push(
      '',
      '## Previous Implementation Output',
      truncateMultilineText(priorOutput, 4000),
    );
  }

  return sections.join('\n');
}

export function buildExistingDiffResumeContext(slice: Slice): string {
  const fileContracts =
    slice.manifest.fileContracts.length > 0
      ? slice.manifest.fileContracts
          .map((contract) => `- [${contract.action}] ${contract.path} — ${contract.reason}`)
          .join('\n')
      : '(no direct file contracts declared)';
  const failedCriteriaSummary = summarizeFailedExitCriteria(
    slice.exitCriteria.filter((criterion) => !criterion.passed),
  );
  const requiredTests =
    slice.testLock.requiredTests.length > 0
      ? slice.testLock.requiredTests.map((test) => `- ${test.testFile}`).join('\n')
      : '(no required tests declared)';

  return [
    'RESUME FROM CURRENT DIFF',
    `Slice ${slice.index + 1} already has unfinished changes in the workspace.`,
    'Do not rediscover the repo seam. Continue from the current diff, keep edits inside the declared file contracts, and rerun only the narrow proof commands needed to fix the remaining compiler/test failures.',
    '',
    '## File Contracts',
    fileContracts,
    '',
    '## Pending Exit Criteria',
    failedCriteriaSummary || '(none recorded)',
    '',
    '## Required Tests',
    requiredTests,
  ].join('\n');
}

export function buildTestRepairRetryContext(
  slice: Slice,
  failedCriteria: ExitCriterion[],
  testGate: QualityGateResult | undefined,
  previousOutput: string,
): string {
  const failedCriteriaSummary = summarizeFailedExitCriteria(failedCriteria);
  const testEvidence =
    testGate && testGate.checks.length > 0
      ? testGate.checks.map(formatQualityGateCheckEvidence).join('\n\n')
      : 'No required test output was captured.';
  const priorOutput = unwrapRetryOutput(previousOutput);
  const sections = [
    'REQUIRED TEST REPAIR REQUIRED',
    `Slice ${slice.index + 1} must fix the failing required/regression test output below before HELIX can continue.`,
    'Start from the current diff and the failing proof output. Do not rediscover the seam or re-audit unrelated workspace wiring unless the failing test output explicitly points there.',
    'Keep edits inside the declared file contracts and, at most, one directly named helper or test harness dependency from the failing proof.',
    '',
    '## Failed Exit Criteria',
    failedCriteriaSummary,
    '',
    '## Required Test Failure Evidence',
    testEvidence,
  ];

  if (priorOutput) {
    sections.push(
      '',
      '## Previous Implementation Output',
      truncateMultilineText(priorOutput, 4000),
    );
  }

  return sections.join('\n');
}

export function buildImplementationRecoveryContext(
  slice: Slice,
  errorMessage: string,
  previousOutput: string,
): string {
  const fileContracts =
    slice.manifest.fileContracts.length > 0
      ? slice.manifest.fileContracts
          .map((contract) => `- [${contract.action}] ${contract.path} — ${contract.reason}`)
          .join('\n')
      : '(no direct file contracts declared)';
  const requiredTests =
    slice.testLock.requiredTests.length > 0
      ? slice.testLock.requiredTests
          .map((test) => `- ${test.testFile}${test.description ? ` — ${test.description}` : ''}`)
          .join('\n')
      : '(no required tests declared)';
  const compactPreviousOutput = previousOutput.trim() || '(no prior output captured)';

  return [
    'IMPLEMENTATION RECOVERY MODE',
    `Previous attempt stopped because: ${errorMessage}`,
    'The slice already has a bounded implementation lane and a narrow proof lane. Reuse the gathered seam evidence and any existing diff. Do not rediscover the seam.',
    'Do not reopen package manifests, Vitest config, AGENTS.md, or unrelated tests unless the failing proof explicitly names them.',
    'Stay inside the declared file contracts. Only inspect one directly imported helper if the failing proof explicitly points there.',
    'First, apply the narrowest edit needed to address the last proof failure or produce the first bounded edit if no diff exists yet. Then rerun only the scoped typecheck and required test commands from the slice packet.',
    '',
    '## File Contracts',
    fileContracts,
    '',
    '## Required Tests',
    requiredTests,
    '',
    '## Previous Recovery Context',
    compactPreviousOutput,
  ].join('\n');
}

export function isImplementationExplorationBudgetError(errorMessage: string): boolean {
  return (
    errorMessage.includes('shell exploration budget') ||
    errorMessage.includes('exploratory shell commands') ||
    errorMessage.includes('exploration budget') ||
    errorMessage.includes('exceeded maxTurns') ||
    errorMessage.includes('stalled after')
  );
}

export function buildManifestDriftRetryContext(
  summary: string | undefined,
  expandedFiles: string[],
  previousOutput: string,
): string {
  const details =
    expandedFiles.length > 0 ? expandedFiles.map((file) => `- ${file}`).join('\n') : '- (none)';
  return [
    'HELIX MANIFEST DRIFT RECOVERY:',
    summary ?? 'HELIX expanded the slice scope to include additional in-scope changed files.',
    '',
    'Expanded files:',
    details,
    '',
    'Do not inspect HELIX internals or reverse-engineer the pipeline. Continue from the existing workspace state, validate the widened slice, and finish any remaining implementation or verification work.',
    '',
    'PREVIOUS OUTPUT:',
    previousOutput,
  ].join('\n');
}

export function isPlanValidationStructuredOutputError(error: string): boolean {
  return (
    /Plan assigned finding .* multiple slices/i.test(error) ||
    /Plan assigned deferred finding/i.test(error) ||
    /Plan assigned unknown or non-open finding/i.test(error) ||
    /Plan left slice .* without finding assignments/i.test(error) ||
    /Plan left slice .* without file scope/i.test(error) ||
    /Plan left .* findings unassigned/i.test(error) ||
    /Plan left .* slices without required tests/i.test(error) ||
    /Plan gave slice .* out-of-range dependency/i.test(error) ||
    /Plan made slice .* depend on itself/i.test(error) ||
    /Plan made slice .* depend on later slice/i.test(error)
  );
}

export function buildPlanValidationRetryGuidance(sourceError: string): string {
  if (/Plan assigned finding .* multiple slices/i.test(sourceError)) {
    return 'Emit a corrected slice-plan JSON where each finding ID appears in exactly one slice. Use only exact HELIX finding IDs from the current open findings registry. For seam-wide findings, keep the finding on the earliest slice that establishes or extracts the seam, preserve later slices as dependencies or follow-on cleanup work, and do not repeat the same finding ID across those later slices.';
  }

  if (/Plan left .* findings unassigned/i.test(sourceError)) {
    return 'Emit a corrected slice-plan JSON that assigns every in-scope open finding exactly once. Use only exact HELIX finding IDs from the current open findings registry. Do not compress multiple findings into invented summary IDs, slugs, or synthetic aliases; if several findings belong to the same slice, list all of their original IDs in that slice.';
  }

  return 'Emit a corrected slice-plan JSON that satisfies the plan contract: every slice needs file scope and required tests, every open finding must be assigned exactly once, and dependencies must stay in-range and point only to earlier slices.';
}
