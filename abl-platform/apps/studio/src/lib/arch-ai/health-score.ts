import type {
  AgentHealthResult,
  HealthCheckReport,
  HealthFinding,
  HealthScoreSummary,
} from '@/lib/arch-ai/types/arch';

type AgentCheckStatus = AgentHealthResult['checks'][keyof AgentHealthResult['checks']];
export type HealthVisualTone = 'success' | 'warning' | 'error';

/** Points deducted from raw percent per semantic/cross-agent error finding */
const PENALTY_ERROR = 10;
/** Points deducted from raw percent per semantic/cross-agent warning finding */
const PENALTY_WARNING = 2;

interface HealthToneThresholds {
  success: number;
  warning: number;
}

function getCheckStatuses(agent: AgentHealthResult): AgentCheckStatus[] {
  return Object.values(agent.checks);
}

function getProjectFindings(
  report: Pick<HealthCheckReport, 'semanticFindings' | 'crossAgentFindings'>,
): HealthFinding[] {
  return [...(report.semanticFindings ?? []), ...(report.crossAgentFindings ?? [])];
}

export function buildHealthScore(
  report: Pick<HealthCheckReport, 'agents' | 'semanticFindings' | 'crossAgentFindings'>,
): HealthScoreSummary {
  const totalAgents = report.agents.length;
  const healthyAgents = report.agents.filter((agent) =>
    getCheckStatuses(agent).every((status) => status === 'PASS'),
  ).length;
  const warningAgents = report.agents.filter((agent) => {
    const statuses = getCheckStatuses(agent);
    return (
      statuses.some((status) => status === 'WARN') && !statuses.some((status) => status === 'FAIL')
    );
  }).length;
  const failingAgents = report.agents.filter((agent) =>
    getCheckStatuses(agent).some((status) => status === 'FAIL'),
  ).length;

  const checkStatuses = report.agents.flatMap((agent) => getCheckStatuses(agent));
  const totalChecks = checkStatuses.length;
  const passedChecks = checkStatuses.filter((status) => status === 'PASS').length;
  const warningChecks = checkStatuses.filter((status) => status === 'WARN').length;
  const failedChecks = checkStatuses.filter((status) => status === 'FAIL').length;

  const projectFindings = getProjectFindings(report);
  const projectErrors = projectFindings.filter((finding) => finding.severity === 'error').length;
  const projectWarnings = projectFindings.filter(
    (finding) => finding.severity === 'warning',
  ).length;
  const projectInfos = projectFindings.filter((finding) => finding.severity === 'info').length;

  const rawPercent = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
  const findingPenalty = projectErrors * PENALTY_ERROR + projectWarnings * PENALTY_WARNING;
  const percent = Math.max(0, Math.round(rawPercent - findingPenalty));
  const blockingFindings = projectErrors + failedChecks;
  const deployReady = blockingFindings === 0;

  return {
    percent,
    totalAgents,
    healthyAgents,
    warningAgents,
    failingAgents,
    totalChecks,
    passedChecks,
    warningChecks,
    failedChecks,
    projectErrors,
    projectWarnings,
    projectInfos,
    blockingFindings,
    deployReady,
  };
}

export function getHealthTopIssue(
  report: Pick<HealthCheckReport, 'agents' | 'semanticFindings' | 'crossAgentFindings'>,
): string | null {
  const projectIssues = getProjectFindings(report)
    .filter((finding) => finding.severity === 'error' || finding.severity === 'warning')
    .map((finding) => ({
      message: finding.message,
      rank: finding.severity === 'error' ? 0 : 1,
    }));

  const agentIssues = report.agents.flatMap((agent) =>
    agent.details
      .filter((detail) => detail.status === 'FAIL' || detail.status === 'WARN')
      .map((detail) => ({
        message: detail.message,
        rank: detail.status === 'FAIL' ? 0 : 1,
      })),
  );

  const topIssue = [...projectIssues, ...agentIssues].sort((a, b) => a.rank - b.rank)[0];
  return topIssue?.message ?? null;
}

export function getHealthVisualTone(
  overall: string,
  percent: number,
  thresholds: HealthToneThresholds,
): HealthVisualTone {
  if (overall === 'Critical') return 'error';
  if (overall === 'Warning' && percent >= thresholds.success) return 'success';
  if (overall === 'Warning') return 'warning';
  if (overall === 'Healthy') return 'success';
  if (percent >= thresholds.success) return 'success';
  if (percent >= thresholds.warning) return 'warning';
  return 'error';
}
