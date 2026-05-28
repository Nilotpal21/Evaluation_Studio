/**
 * Formatters that summarize quality-gate evidence, failed exit criteria,
 * impact analysis, and slice export-contract state.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type {
  ExitCriterion,
  ImpactAnalysis,
  QualityGateCheckResult,
  QualityGateResult,
  Slice,
} from '../../types.js';
import { firstNonEmptyLine, truncateMultilineText } from './text-utils.js';

export function summarizeQualityGateEvidence(gate: QualityGateResult): string {
  const check = gate.checks[0];
  if (!check) {
    return gate.passed ? 'PASS' : `FAIL — ${gate.feedback}`;
  }

  const parts = [check.passed ? 'PASS' : 'FAIL'];
  if (check.command) {
    parts.push(`via ${check.command}`);
  }

  const detailSource = check.output?.trim() || gate.feedback.trim();
  const detail = firstNonEmptyLine(detailSource);
  if (detail && !parts.some((part) => part.includes(detail))) {
    parts.push(detail);
  }

  return parts.join(' — ');
}

export function formatQualityGateCheckEvidence(check: QualityGateCheckResult): string {
  const lines = [`Check: ${check.name}`];
  if (check.command) {
    lines.push(`Command: ${check.command}`);
  }
  if (check.output?.trim()) {
    lines.push('', truncateMultilineText(check.output.trim(), 6000));
  }
  return lines.join('\n');
}

export function summarizeFailedExitCriteria(failedCriteria: ExitCriterion[]): string {
  return failedCriteria
    .map(
      (criterion) =>
        `- [FAIL] ${criterion.description}${criterion.detail ? `: ${criterion.detail}` : ''}`,
    )
    .join('\n');
}

export function summarizeImpactAnalysis(impact: ImpactAnalysis): string {
  const base = `${impact.directFiles.length} direct, ${impact.dependentFiles.length} dependent, ${impact.affectedTests.length} affected tests, risk ${impact.riskLevel}`;
  return impact.notes ? `${base}. ${impact.notes}` : base;
}

export function summarizeExportContracts(slice: Slice): string {
  if (slice.manifest.exportContracts.length === 0) {
    return 'No export contracts declared for this slice.';
  }

  const unwiredNewExports = slice.manifest.exportContracts.filter(
    (contract) => contract.isNew && contract.consumers.length === 0,
  ).length;
  const wiredExports = slice.manifest.exportContracts.length - unwiredNewExports;
  const summary = `${wiredExports}/${slice.manifest.exportContracts.length} export contracts have known consumers`;

  return unwiredNewExports > 0
    ? `${summary}; ${unwiredNewExports} new export(s) are still unwired`
    : `${summary}; all new/modified exports stay wired`;
}
