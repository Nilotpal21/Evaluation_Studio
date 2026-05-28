'use client';

/**
 * HealthReportCard — Enterprise-grade project health visualization.
 *
 * Displays per-agent health checks in a clean, scannable layout.
 * Agent names are prominent, checks shown as a compact status grid
 * inside expanded detail panels. Uses system design tokens throughout.
 */

import React, { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  Info,
  Wrench,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import { clsx } from 'clsx';
import { buildHealthScore, getHealthVisualTone } from '@/lib/arch-ai/health-score';
import { Tooltip, TooltipProvider } from '@/components/ui/Tooltip';
import type { HealthCheckReport, AgentHealthResult } from '@/lib/arch-ai/types/arch';

// =============================================================================
// CONSTANTS
// =============================================================================

const CHECK_KEYS = [
  'compilation',
  'handoffs',
  'toolBindings',
  'modelConfig',
  'guardrails',
  'entryPoint',
] as const;

type CheckKey = (typeof CHECK_KEYS)[number];

const CHECK_ICONS: Record<CheckKey, string> = {
  compilation: 'Build',
  handoffs: 'Handoffs',
  toolBindings: 'Tools',
  modelConfig: 'Model',
  guardrails: 'Guards',
  entryPoint: 'Entry',
};

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

function getAgentStatus(agent: AgentHealthResult): CheckStatus {
  const values = Object.values(agent.checks);
  if (values.some((c) => c === 'FAIL')) return 'FAIL';
  if (values.some((c) => c === 'WARN')) return 'WARN';
  return 'PASS';
}

// =============================================================================
// STATUS ICON — inline indicator dot or icon
// =============================================================================

function StatusIcon({ status, size = 'sm' }: { status: CheckStatus; size?: 'sm' | 'md' }) {
  const sizeClass = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';
  if (status === 'PASS') return <CheckCircle2 className={clsx(sizeClass, 'text-success')} />;
  if (status === 'WARN') return <AlertTriangle className={clsx(sizeClass, 'text-warning')} />;
  return <XCircle className={clsx(sizeClass, 'text-error')} />;
}

function StatusDot({ status }: { status: CheckStatus }) {
  return (
    <span
      className={clsx(
        'inline-block h-1.5 w-1.5 rounded-full flex-shrink-0',
        status === 'PASS' && 'bg-success',
        status === 'WARN' && 'bg-warning',
        status === 'FAIL' && 'bg-error',
      )}
    />
  );
}

// =============================================================================
// AGENT ROW — expanded detail with check grid
// =============================================================================

interface AgentRowProps {
  agent: AgentHealthResult;
  expanded: boolean;
  onToggle: () => void;
  onFixClick?: (message: string) => void;
  t: ReturnType<typeof useTranslations>;
}

function AgentRow({ agent, expanded, onToggle, onFixClick, t }: AgentRowProps) {
  const agentStatus = getAgentStatus(agent);
  const nonPassDetails = agent.details.filter((d) => d.status !== 'PASS');
  const failCount = Object.values(agent.checks).filter((c) => c === 'FAIL').length;
  const warnCount = Object.values(agent.checks).filter((c) => c === 'WARN').length;
  const passCount = Object.values(agent.checks).filter((c) => c === 'PASS').length;

  return (
    <div
      className={clsx(
        'rounded-lg border transition-colors',
        expanded
          ? 'border-border bg-background-subtle'
          : 'border-border-muted hover:border-border bg-transparent',
      )}
    >
      {/* Agent header — name is prominent, status summary on right */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left group"
      >
        <span className="flex-shrink-0 text-foreground-subtle group-hover:text-foreground-muted transition-colors">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>

        {/* Agent name — always visible and prominent */}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-foreground truncate block">
            {agent.agentName}
          </span>
        </div>

        {/* Compact status summary */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {failCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-error">
              <XCircle className="w-3 h-3" />
              {failCount}
            </span>
          )}
          {warnCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-warning">
              <AlertTriangle className="w-3 h-3" />
              {warnCount}
            </span>
          )}
          {failCount === 0 && warnCount === 0 && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-success">
              <CheckCircle2 className="w-3 h-3" />
              {passCount}
            </span>
          )}
        </div>
      </button>

      {/* Expanded: check grid + details */}
      {expanded && (
        <div className="border-t border-border-muted">
          {/* Check status grid — 3x2 compact grid */}
          <div className="grid grid-cols-3 gap-px bg-border-muted">
            {CHECK_KEYS.map((key) => (
              <div key={key} className="flex items-center gap-1.5 bg-background px-3 py-2">
                <StatusDot status={agent.checks[key]} />
                <span className="text-[11px] text-foreground-muted">{CHECK_ICONS[key]}</span>
              </div>
            ))}
          </div>

          {/* Issue details */}
          {nonPassDetails.length > 0 && (
            <div className="px-3 py-2.5 space-y-2">
              {nonPassDetails.map((detail, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-start gap-2">
                    <StatusIcon status={detail.status} size="sm" />
                    <span className="text-xs text-foreground leading-relaxed">
                      {detail.message}
                    </span>
                  </div>
                  {detail.suggestedFix && (
                    <div className="ml-5.5 flex items-center gap-2 pl-[22px]">
                      <span className="text-[11px] text-foreground-subtle leading-relaxed">
                        {detail.suggestedFix}
                      </span>
                      {onFixClick && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onFixClick(
                              `Fix ${agent.agentName}'s ${detail.check}: ${detail.suggestedFix}`,
                            );
                          }}
                          className={clsx(
                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md',
                            'text-[10px] font-medium flex-shrink-0',
                            'bg-accent/10 text-accent hover:bg-accent/20',
                            'transition-colors',
                          )}
                        >
                          <Wrench className="w-2.5 h-2.5" />
                          {t('fix_this')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* All checks passing */}
          {nonPassDetails.length === 0 && (
            <div className="px-3 py-2.5">
              <p className="text-xs text-foreground-subtle flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                All checks passing
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// HEALTH REPORT CARD
// =============================================================================

interface HealthReportCardProps {
  report: HealthCheckReport;
  onFixClick?: (message: string) => void;
}

export function HealthReportCard({ report, onFixClick }: HealthReportCardProps) {
  const t = useTranslations('arch_in_project');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  const toggleAgent = (agentName: string) => {
    setExpandedAgents((prev) => ({ ...prev, [agentName]: !prev[agentName] }));
  };

  // Compute summary stats
  const stats = useMemo(() => {
    return report.score ?? buildHealthScore(report);
  }, [report]);

  const projectFindings = useMemo(() => {
    return [...(report.semanticFindings ?? []), ...(report.crossAgentFindings ?? [])];
  }, [report.crossAgentFindings, report.semanticFindings]);
  const tone = getHealthVisualTone(report.overall, stats.percent, { success: 90, warning: 50 });

  const overallIcon =
    tone === 'success' ? (
      <ShieldCheck className="w-4 h-4 text-success" />
    ) : tone === 'warning' ? (
      <AlertTriangle className="w-4 h-4 text-warning" />
    ) : (
      <Activity className="w-4 h-4 text-error" />
    );

  return (
    <div className="space-y-3">
      {/* Summary card */}
      <div className="rounded-lg border border-border bg-background-subtle p-4">
        {/* Header line: overall status + percentage */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {overallIcon}
            <span className="text-sm font-semibold text-foreground">
              {t(
                (tone === 'success'
                  ? 'healthy'
                  : tone === 'warning'
                    ? 'warning'
                    : 'critical') as Parameters<typeof t>[0],
              )}
            </span>
            <TooltipProvider>
              <Tooltip content={t('health_score_tooltip')} side="top">
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-foreground-muted transition-colors hover:text-foreground"
                  aria-label={t('health_score_label')}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </TooltipProvider>
          </div>
          <span
            className={clsx(
              'text-lg font-bold tabular-nums',
              tone === 'success'
                ? 'text-success'
                : tone === 'warning'
                  ? 'text-warning'
                  : 'text-error',
            )}
          >
            {stats.percent}%
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 w-full rounded-full bg-background-muted overflow-hidden mb-3">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500 ease-out',
              tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-error',
            )}
            style={{ width: `${stats.percent}%` }}
          />
        </div>

        {/* Stat counters */}
        <div className="flex items-center gap-4 text-xs">
          <span className="text-foreground-muted">
            {t('health_checks_passed', { passed: stats.passedChecks, total: stats.totalChecks })}
          </span>
          <span className="h-3 w-px bg-border-muted" />
          {stats.healthyAgents > 0 && (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="w-3 h-3" />
              {t('health_agents_clean', { passing: stats.healthyAgents, total: stats.totalAgents })}
            </span>
          )}
          {stats.warningAgents > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <AlertTriangle className="w-3 h-3" />
              {t('health_agents_warning', { count: stats.warningAgents })}
            </span>
          )}
          {stats.failingAgents > 0 && (
            <span className="flex items-center gap-1 text-error">
              <XCircle className="w-3 h-3" />
              {t('health_agents_failing', { count: stats.failingAgents })}
            </span>
          )}
        </div>
      </div>

      {/* Summary text */}
      {report.summary && (
        <p className="text-xs text-foreground-muted leading-relaxed px-1">{report.summary}</p>
      )}

      {projectFindings.length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Activity className="h-3.5 w-3.5 text-accent" />
            <span>{t('health_project_findings')}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {stats.projectErrors > 0 && (
              <span className="flex items-center gap-1 text-error">
                <XCircle className="h-3 w-3" />
                {t('health_project_errors', { count: stats.projectErrors })}
              </span>
            )}
            {stats.projectWarnings > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="h-3 w-3" />
                {t('health_project_warnings', { count: stats.projectWarnings })}
              </span>
            )}
            {stats.projectInfos > 0 && (
              <span className="flex items-center gap-1 text-foreground-muted">
                <CheckCircle2 className="h-3 w-3" />
                {t('health_project_infos', { count: stats.projectInfos })}
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1.5">
            {projectFindings.slice(0, 3).map((finding) => (
              <div
                key={`${finding.code}-${finding.agentName ?? 'project'}-${finding.message}`}
                className="flex items-start gap-2"
              >
                <StatusIcon
                  status={
                    finding.severity === 'error'
                      ? 'FAIL'
                      : finding.severity === 'warning'
                        ? 'WARN'
                        : 'PASS'
                  }
                  size="sm"
                />
                <span className="text-xs leading-relaxed text-foreground">{finding.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent list */}
      <div className="space-y-1.5">
        {report.agents.map((agent) => (
          <AgentRow
            key={agent.agentName}
            agent={agent}
            expanded={!!expandedAgents[agent.agentName]}
            onToggle={() => toggleAgent(agent.agentName)}
            onFixClick={onFixClick}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}
