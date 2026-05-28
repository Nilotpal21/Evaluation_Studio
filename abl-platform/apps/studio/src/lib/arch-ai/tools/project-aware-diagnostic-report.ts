import type { ProjectAwareParseErrorsByAgent } from '@/lib/abl/project-aware-compile';

export interface ScopedDiagnosticFinding {
  code: string;
  message: string;
  severity: string;
  category?: string;
  agentName?: string | null;
}

interface DiagnosticSummaryLike {
  errors?: number;
  warnings?: number;
  infos?: number;
  total?: number;
}

function findingKey(finding: ScopedDiagnosticFinding): string {
  return [
    finding.severity,
    finding.code,
    finding.agentName ?? '_project',
    finding.category ?? '_category',
    finding.message,
  ].join('|');
}

export function dedupeScopedFindings(
  findings: readonly ScopedDiagnosticFinding[],
): ScopedDiagnosticFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = findingKey(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildProjectAwareDiagnosticFindings(input: {
  errors?: readonly string[];
  warnings?: readonly string[];
  parseErrors?: readonly ProjectAwareParseErrorsByAgent[];
}): ScopedDiagnosticFinding[] {
  const findings: ScopedDiagnosticFinding[] = [];

  for (const parseError of input.parseErrors ?? []) {
    for (const issue of parseError.errors) {
      findings.push({
        code: 'STUDIO-PARSE',
        severity: 'error',
        category: 'parse',
        agentName: parseError.agent,
        message: `${parseError.agent}: Line ${issue.line ?? '?'}: ${issue.message}`,
      });
    }
  }

  for (const message of input.errors ?? []) {
    findings.push({
      code: 'STUDIO-PROJECT-AWARE',
      severity: 'error',
      category: 'project_context',
      agentName: null,
      message,
    });
  }

  for (const message of input.warnings ?? []) {
    findings.push({
      code: 'STUDIO-PROJECT-AWARE',
      severity: 'warning',
      category: 'project_context',
      agentName: null,
      message,
    });
  }

  return dedupeScopedFindings(findings);
}

export function mergeScopedFindingsIntoReport<
  T extends {
    topIssues?: ScopedDiagnosticFinding[];
    summary?: DiagnosticSummaryLike;
  },
>(report: T, extraFindings: readonly ScopedDiagnosticFinding[]): T {
  if (extraFindings.length === 0) {
    return report;
  }

  const topIssues = dedupeScopedFindings([...(report.topIssues ?? []), ...extraFindings]);
  const errors = extraFindings.filter((finding) => finding.severity === 'error').length;
  const warnings = extraFindings.filter((finding) => finding.severity === 'warning').length;
  const infos = extraFindings.filter((finding) => finding.severity === 'info').length;

  return {
    ...report,
    topIssues,
    summary: {
      errors: (report.summary?.errors ?? 0) + errors,
      warnings: (report.summary?.warnings ?? 0) + warnings,
      infos: (report.summary?.infos ?? 0) + infos,
      total: (report.summary?.total ?? 0) + extraFindings.length,
    },
  };
}
