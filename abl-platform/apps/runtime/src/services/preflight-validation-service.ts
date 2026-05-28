/**
 * Preflight Validation Service
 *
 * Runs diagnostic engine checks against a set of agents before deployment.
 * Returns a structured PreflightReport indicating readiness.
 */

import { createLogger } from '@abl/compiler/platform';
import { getDiagnosticEngine, ensureAnalyzersReady } from './diagnostics/engine.js';
import type { DiagnosticFinding, DiagnosticReport } from './diagnostics/types.js';
import type {
  CanonicalConfigurationCategory,
  CanonicalConfigurationCode,
} from './diagnostics/configuration-taxonomy.js';

const log = createLogger('preflight-validation');

export interface PreflightCanonicalIssueSummary {
  severity: Extract<DiagnosticFinding['severity'], 'error' | 'warning'>;
  category: CanonicalConfigurationCategory;
  code: CanonicalConfigurationCode;
  count: number;
  agentNames: string[];
}

export interface PreflightReport {
  status: 'ready' | 'warnings' | 'errors';
  agents: Array<{ agentName: string; report: DiagnosticReport }>;
  summary: {
    total: number;
    passed: number;
    warnings: number;
    errors: number;
    canonicalIssues: PreflightCanonicalIssueSummary[];
  };
}

function summarizeCanonicalIssues(
  agents: PreflightReport['agents'],
): PreflightCanonicalIssueSummary[] {
  const issueMap = new Map<
    string,
    {
      severity: PreflightCanonicalIssueSummary['severity'];
      category: CanonicalConfigurationCategory;
      code: CanonicalConfigurationCode;
      count: number;
      agentNames: Set<string>;
    }
  >();

  for (const agent of agents) {
    for (const finding of agent.report.findings) {
      if (!finding.canonical) {
        continue;
      }
      if (finding.severity !== 'error' && finding.severity !== 'warning') {
        continue;
      }

      const issueKey = `${finding.severity}:${finding.canonical.code}`;
      const existing = issueMap.get(issueKey);
      if (existing) {
        existing.count += 1;
        existing.agentNames.add(agent.agentName);
        continue;
      }

      issueMap.set(issueKey, {
        severity: finding.severity,
        category: finding.canonical.category,
        code: finding.canonical.code,
        count: 1,
        agentNames: new Set([agent.agentName]),
      });
    }
  }

  return Array.from(issueMap.values())
    .map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      code: issue.code,
      count: issue.count,
      agentNames: Array.from(issue.agentNames).sort(),
    }))
    .sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code),
    );
}

/**
 * Run preflight validation against one or more agents using the diagnostic engine.
 * Uses 'quick' depth (infra analyzers only) for fast pre-deployment checks.
 */
export async function runPreflightValidation(params: {
  tenantId: string;
  projectId: string;
  agentNames: string[];
}): Promise<PreflightReport> {
  const { tenantId, projectId, agentNames } = params;

  if (agentNames.length === 0) {
    return {
      status: 'ready',
      agents: [],
      summary: { total: 0, passed: 0, warnings: 0, errors: 0, canonicalIssues: [] },
    };
  }

  await ensureAnalyzersReady();
  const engine = getDiagnosticEngine();

  const agents: PreflightReport['agents'] = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let agentsWithErrors = 0;

  for (const agentName of agentNames) {
    try {
      const report = await engine.diagnose({
        tenantId,
        projectId,
        agentName,
        depth: 'quick',
      });
      agents.push({ agentName, report });
      totalErrors += report.summary.errors;
      totalWarnings += report.summary.warnings;
      if (report.summary.errors > 0) {
        agentsWithErrors++;
      }
    } catch (err) {
      log.error('Preflight diagnostic failed for agent', {
        error: err instanceof Error ? err.message : String(err),
        agentName,
        projectId,
      });
      // Create a synthetic broken report for the failed agent
      agents.push({
        agentName,
        report: {
          status: 'broken',
          target: { type: 'agent', id: agentName, agentName },
          findings: [
            {
              analyzer: 'preflight',
              severity: 'error',
              code: 'PREFLIGHT_AGENT_FAILED',
              title: `Preflight check failed for agent "${agentName}"`,
              detail: err instanceof Error ? err.message : String(err),
              suggestion: 'Check agent configuration and try again.',
              evidence: [],
            },
          ],
          summary: { errors: 1, warnings: 0, infos: 0, analyzersRun: ['preflight'] },
          config: {},
          timestamp: new Date().toISOString(),
        },
      });
      totalErrors += 1;
      agentsWithErrors++;
    }
  }

  const passed = agentNames.length - agentsWithErrors;
  const canonicalIssues = summarizeCanonicalIssues(agents);

  return {
    status: totalErrors > 0 ? 'errors' : totalWarnings > 0 ? 'warnings' : 'ready',
    agents,
    summary: {
      total: agentNames.length,
      passed,
      warnings: totalWarnings,
      errors: totalErrors,
      canonicalIssues,
    },
  };
}
