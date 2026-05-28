/**
 * Pure architecture-review helpers.
 *
 * Helpers extracted verbatim from `pipeline-engine.ts`. Each one reads
 * only its arguments and returns a new value (string, record,
 * approval-decision, mutated slice via `updateExitCriterion`, or
 * locked model assignment) without touching engine state.
 *
 *   - `materializeReviewFinding(finding)` — converts a parsed
 *     architecture-review finding shape into the canonical
 *     `ReviewFinding` record.
 *   - `reconcileDeterministicExitCriteria(slice)` — recomputes the
 *     `exports-wired` criterion on a slice from its manifest.
 *   - `formatArchitectureReviewFeedback(review, unresolvedDecisions)`
 *     — renders the multi-line feedback block for a blocking
 *     architecture review.
 *   - `createFailedReview(message, files, reviewer?)` — assembles a
 *     `ReviewResult` representing a high-severity failed review.
 *   - `tryApproveArchitectureReviewFromImplementationReview(slice,
 *     implementationOutput)` — approves the architecture review when
 *     the refined implementation review signals readiness and all
 *     required exit criteria passed.
 *   - `lockReviewAssignmentToPrimary(assignment)` — strips the
 *     fallback leg from a model assignment so review actors only use
 *     the primary model.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { ModelAssignment, ReviewFinding, ReviewResult, Slice } from '../../types.js';
import { now } from '../stage-execution-shared.js';
import { updateExitCriterion } from '../slice-view.js';
import { architectureFindingBlocksApproval } from './exit-criteria-ordering.js';
import { summarizeExportContracts } from './gate-evidence.js';

export function materializeReviewFinding(finding: {
  severity: ReviewFinding['severity'];
  title: string;
  description: string;
  files: string[];
}): ReviewFinding {
  return {
    severity: finding.severity,
    file: finding.files[0] ?? '(unspecified file)',
    message: finding.title,
    suggestion:
      finding.description && finding.description !== finding.title
        ? finding.description
        : undefined,
  };
}

export function reconcileDeterministicExitCriteria(slice: Slice): void {
  const exportsCriterion = slice.exitCriteria.find(
    (criterion) => criterion.type === 'exports-wired',
  );
  if (!exportsCriterion) {
    return;
  }

  const unwired = slice.manifest.exportContracts.filter(
    (contract) => contract.consumers.length === 0 && contract.isNew,
  );
  updateExitCriterion(
    slice,
    exportsCriterion.id,
    unwired.length === 0,
    unwired.length === 0
      ? summarizeExportContracts(slice)
      : `${unwired.length} exports without consumers`,
  );
}

export function formatArchitectureReviewFeedback(
  review: {
    summary: string;
    findings: Array<{
      severity: ReviewFinding['severity'];
      category: string;
      title: string;
      description: string;
      files: string[];
    }>;
  },
  unresolvedDecisions: Array<{ question: string }>,
): string {
  const lines = [review.summary || 'Architecture review found blocking issues.'];
  const blockingFindings = review.findings.filter((finding) =>
    architectureFindingBlocksApproval(finding.severity),
  );
  const advisoryFindings = review.findings.filter(
    (finding) => !architectureFindingBlocksApproval(finding.severity),
  );

  if (blockingFindings.length > 0) {
    lines.push('', 'Blocking findings:');
    for (const finding of blockingFindings) {
      const description =
        finding.description && finding.description !== finding.title
          ? ` — ${finding.description}`
          : '';
      const files = finding.files.length > 0 ? ` | files: ${finding.files.join(', ')}` : '';
      lines.push(
        `- [${finding.severity}] [${finding.category}] ${finding.title}${description}${files}`,
      );
    }
  }

  if (advisoryFindings.length > 0) {
    lines.push('', 'Advisory findings:');
    for (const finding of advisoryFindings) {
      const description =
        finding.description && finding.description !== finding.title
          ? ` — ${finding.description}`
          : '';
      const files = finding.files.length > 0 ? ` | files: ${finding.files.join(', ')}` : '';
      lines.push(
        `- [${finding.severity}] [${finding.category}] ${finding.title}${description}${files}`,
      );
    }
  }

  if (unresolvedDecisions.length > 0) {
    lines.push('', 'Unresolved decisions:');
    for (const decision of unresolvedDecisions) {
      lines.push(`- ${decision.question}`);
    }
  }

  if (blockingFindings.length === 0 && unresolvedDecisions.length === 0) {
    lines.push('', 'No blocking findings.');
  }

  return lines.join('\n');
}

export function createFailedReview(
  message: string,
  files: string[],
  reviewer: string = 'system',
): ReviewResult {
  return {
    approved: false,
    reviewer,
    findings: [
      {
        severity: 'high',
        file: files[0] ?? '(unspecified file)',
        message,
      },
    ],
    timestamp: now(),
  };
}

export function tryApproveArchitectureReviewFromImplementationReview(
  slice: Slice,
  implementationOutput: string,
): { passed: true; feedback: string; review: ReviewResult } | null {
  if (!implementationOutput || implementationOutput.trim().length === 0) {
    return null;
  }

  const normalizedOutput = implementationOutput.toLowerCase();
  const implementationReviewSignalsReady =
    normalizedOutput.includes('ready for helix checkpoint') ||
    (normalizedOutput.includes('correct and complete') &&
      normalizedOutput.includes('no changes required'));
  if (!implementationReviewSignalsReady) {
    return null;
  }

  const requiredSatisfied = ['typecheck', 'lint', 'test-lock', 'impact-reviewed', 'exports-wired']
    .map((criterionType) =>
      slice.exitCriteria.find((criterion) => criterion.type === criterionType),
    )
    .every((criterion) => criterion?.passed === true);
  if (!requiredSatisfied) {
    return null;
  }

  return {
    passed: true,
    feedback:
      'Architecture review approved from the refined implementation review and green proof packet.',
    review: {
      approved: true,
      reviewer: 'helix/refined-implementation-review',
      findings: [],
      timestamp: now(),
    },
  };
}

export function lockReviewAssignmentToPrimary(assignment: ModelAssignment): ModelAssignment {
  return {
    primary: assignment.primary,
  };
}
