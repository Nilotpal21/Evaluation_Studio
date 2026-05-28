/**
 * Deterministic stage runner for the `concerns-audit` stage type.
 *
 * Shells `runConcernsAudit()` and maps its `DetectorFinding[]` into helix
 * `Finding[]` so downstream consumers (slice packets, MCP `search_findings`,
 * JIRA adapter, daemon) see drift as first-class session artifacts. The
 * stage bypasses the model router entirely — no LLM, no tools, no prompt.
 */

import type { AuditOptions, AuditResult } from '../concerns/audit-types.js';
import { runConcernsAudit } from '../concerns/audit.js';
import { concernsAuditFindingId, mapDetectorFindingToFinding } from '../concerns/finding-mapper.js';
import type { Finding, StageDefinition, StageResult } from '../types.js';
import { makeResult } from './stage-execution-shared.js';

export interface ConcernsAuditStageOptions {
  readonly stage: StageDefinition;
  readonly startTime: number;
  readonly repoRoot: string;
  readonly discoveredBy?: string;
  readonly timestamp?: string;
  readonly auditOptions?: Pick<
    AuditOptions,
    'concernsDir' | 'outputDir' | 'filterConcernIds' | 'filterTiers' | 'write'
  >;
  readonly onProgress?: (message: string, details?: Record<string, unknown>) => void;
}

export interface ConcernsAuditStageOutcome {
  readonly stageResult: StageResult;
  readonly auditResult: AuditResult;
  readonly findings: Finding[];
}

export async function runConcernsAuditStage(
  options: ConcernsAuditStageOptions,
): Promise<ConcernsAuditStageOutcome> {
  const { stage, startTime, repoRoot } = options;
  const discoveredBy = options.discoveredBy ?? stage.name;
  const timestamp = options.timestamp ?? new Date().toISOString();

  options.onProgress?.('concerns-audit: starting deterministic scan', {
    repoRoot,
    filterTiers: options.auditOptions?.filterTiers,
    filterConcernIds: options.auditOptions?.filterConcernIds,
  });

  const auditResult = await runConcernsAudit({
    repoRoot,
    ...options.auditOptions,
  });

  const findings: Finding[] = auditResult.findings.map((df) =>
    mapDetectorFindingToFinding(df, { discoveredBy, timestamp }),
  );

  const { summary } = auditResult;
  const status: StageResult['status'] = summary.blockingFindings > 0 ? 'failed' : 'passed';
  const output = formatSummaryOutput(auditResult);
  const error =
    summary.blockingFindings > 0
      ? `concerns-audit: ${summary.blockingFindings} blocking finding(s) across ${summary.concernsScanned} concern(s)`
      : undefined;

  options.onProgress?.('concerns-audit: scan complete', {
    findings: summary.findings,
    blockingFindings: summary.blockingFindings,
    advisoryFindings: summary.advisoryFindings,
    concernsScanned: summary.concernsScanned,
    detectorsRun: summary.detectorsRun,
    detectorsSkipped: summary.detectorsSkipped,
    durationMs: summary.durationMs,
  });

  const stageResult = makeResult(stage, status, output, findings, [], startTime, 1, error);

  return { stageResult, auditResult, findings };
}

function formatSummaryOutput(auditResult: AuditResult): string {
  const { summary } = auditResult;
  const lines = [
    `concerns-audit summary`,
    `  concerns total:    ${summary.concernsTotal}`,
    `  concerns scanned:  ${summary.concernsScanned}`,
    `  detectors run:     ${summary.detectorsRun}`,
    `  detectors skipped: ${summary.detectorsSkipped}`,
    `  files scanned:     ${summary.filesScanned}`,
    `  findings:          ${summary.findings}`,
    `    blocking: ${summary.blockingFindings}`,
    `    advisory: ${summary.advisoryFindings}`,
    `  duration:          ${summary.durationMs} ms`,
  ];
  if (auditResult.findingsPath) {
    lines.push(`  findings file:     ${auditResult.findingsPath}`);
  }
  if (auditResult.summaryPath) {
    lines.push(`  summary file:      ${auditResult.summaryPath}`);
  }
  return lines.join('\n');
}

export { concernsAuditFindingId };
