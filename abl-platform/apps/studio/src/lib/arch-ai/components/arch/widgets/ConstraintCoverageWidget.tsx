'use client';

import { useState } from 'react';
import { clsx } from 'clsx';

/**
 * ConstraintCoverageWidget — renders constraint coverage matrix from analyze_constraints tool.
 * B23: Constraint Design Coaching — UX Design: summary bar + expandable agent rows.
 */

interface CoverageEntry {
  agent: string;
  regulation: string;
  status: 'covered' | 'partial' | 'missing' | 'n/a';
  detail?: string;
}

interface GapEntry {
  agent: string;
  regulation: string;
  detail?: string;
  suggested: Array<{ condition: string; kind: string; on_fail: { type: string } }>;
}

interface CoverageSummary {
  totalAgents: number;
  totalRegulations: number;
  coveredCount: number;
  partialCount: number;
  missingCount: number;
  naCount: number;
}

interface ConstraintCoverageData {
  coverage: CoverageEntry[];
  summary: CoverageSummary;
  gaps: GapEntry[];
}

interface ConstraintCoverageWidgetProps {
  data: ConstraintCoverageData;
}

const STATUS_STYLES: Record<string, { icon: string; classes: string }> = {
  covered: { icon: '✅', classes: 'text-success' },
  partial: { icon: '⚠️', classes: 'text-warning' },
  missing: { icon: '❌', classes: 'text-error' },
  'n/a': { icon: '—', classes: 'text-foreground-muted/40' },
};

export function ConstraintCoverageWidget({ data }: ConstraintCoverageWidgetProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const { summary, gaps } = data;
  const totalRelevant = summary.coveredCount + summary.partialCount + summary.missingCount;
  const coveragePct =
    totalRelevant > 0 ? Math.round((summary.coveredCount / totalRelevant) * 100) : 100;

  // Group coverage entries by agent
  const agentMap = new Map<string, CoverageEntry[]>();
  for (const entry of data.coverage) {
    const existing = agentMap.get(entry.agent) ?? [];
    existing.push(entry);
    agentMap.set(entry.agent, existing);
  }

  const progressColor =
    coveragePct >= 80 ? 'bg-success' : coveragePct >= 50 ? 'bg-warning' : 'bg-error';

  return (
    <div className="my-4 space-y-3">
      {/* Summary bar */}
      <div className="rounded-lg border border-border/50 bg-surface p-4">
        <div className="mb-2 text-sm font-medium text-foreground">🛡️ Constraint Coverage</div>
        <div className="mb-1 text-xs text-foreground-muted">
          {summary.totalAgents} agents · {summary.totalRegulations} regulations
        </div>
        {/* Progress bar */}
        <div className="mb-2 h-2 rounded-full bg-surface-hover">
          <div
            className={clsx('h-2 rounded-full transition-all', progressColor)}
            style={{ width: `${coveragePct}%` }}
            role="progressbar"
            aria-valuenow={coveragePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Constraint coverage: ${coveragePct}%`}
          />
        </div>
        <div className="text-xs text-foreground-muted">
          {coveragePct}% covered
          {gaps.length > 0 && (
            <span className="text-warning">
              {' '}
              · {gaps.length} gap{gaps.length !== 1 ? 's' : ''} need attention
            </span>
          )}
        </div>
      </div>

      {/* Per-agent rows */}
      {Array.from(agentMap.entries()).map(([agent, entries]) => {
        const agentGaps = gaps.filter((g) => g.agent === agent);
        const hasGap = agentGaps.length > 0;
        const isExpanded = expandedAgent === agent || hasGap;

        const rowClass = hasGap
          ? 'border-warning/30 bg-warning/5'
          : entries.every((e) => e.status === 'n/a')
            ? 'border-border/20 bg-background-muted/10 opacity-60'
            : 'border-border/30 bg-background-muted/20';

        return (
          <button
            key={agent}
            type="button"
            className={clsx('w-full text-left rounded-md border p-3 transition-colors', rowClass)}
            onClick={() => setExpandedAgent(expandedAgent === agent ? null : agent)}
            aria-expanded={isExpanded}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">{agent}</span>
              <div className="flex gap-2">
                {entries.map((e) => {
                  const style = STATUS_STYLES[e.status] ?? STATUS_STYLES['n/a'];
                  return (
                    <span
                      key={e.regulation}
                      className={clsx('text-[10px]', style.classes)}
                      title={`${e.regulation}: ${e.status}`}
                    >
                      {e.regulation} {style.icon}
                    </span>
                  );
                })}
              </div>
            </div>

            {isExpanded && agentGaps.length > 0 && (
              <div className="mt-2 space-y-1">
                {agentGaps.map((gap) => (
                  <div
                    key={`${gap.agent}-${gap.regulation}`}
                    className="rounded bg-warning/5 border border-warning/20 p-2 text-xs text-foreground-muted"
                  >
                    <div className="font-medium text-warning">{gap.regulation}: gap detected</div>
                    {gap.detail && <div className="mt-0.5">{gap.detail}</div>}
                    {gap.suggested.length > 0 && (
                      <div className="mt-1 text-foreground-muted/70">
                        Suggested: {gap.suggested.length} constraint
                        {gap.suggested.length !== 1 ? 's' : ''} (
                        {gap.suggested.map((s) => s.kind).join(', ')})
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
