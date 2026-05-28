'use client';

import { useMemo } from 'react';
import { GitBranch, HelpCircle, Link2, ListTree } from 'lucide-react';
import { Badge, type BadgeVariant } from '../ui/Badge';
import {
  buildTraceCausalitySummary,
  formatShortTraceId,
  getTraceCausalFields,
  humanizeTraceCode,
  type TraceCausalityEventLike,
} from '../../utils/trace-causality';

interface TraceCausalChipsProps {
  event: TraceCausalityEventLike;
  compact?: boolean;
  className?: string;
}

interface TraceCausalityLedgerProps {
  events: TraceCausalityEventLike[];
  className?: string;
}

export function TraceCausalChips({ event, compact, className }: TraceCausalChipsProps) {
  const causal = getTraceCausalFields(event);
  const chips = [
    causal.phase ? { label: 'phase', value: causal.phase, variant: 'info' as const } : null,
    causal.reasonCode
      ? { label: 'reason', value: causal.reasonCode, variant: 'purple' as const }
      : null,
    causal.agentRunId
      ? {
          label: 'run',
          value: formatShortTraceId(causal.agentRunId, 12),
          variant: 'default' as const,
        }
      : null,
    causal.causeEventId
      ? {
          label: 'cause',
          value: formatShortTraceId(causal.causeEventId),
          variant: 'accent' as const,
        }
      : null,
    causal.decisionId
      ? {
          label: 'decision',
          value: formatShortTraceId(causal.decisionId),
          variant: 'warning' as const,
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string; variant: BadgeVariant }>;

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className={className ?? 'flex flex-wrap items-center gap-1.5'}>
      {chips.map((chip) => (
        <Badge
          key={`${chip.label}:${chip.value}`}
          variant={chip.variant}
          appearance="outlined"
          className={compact ? 'px-1.5 py-0 text-[10px]' : undefined}
        >
          <span className="text-subtle">{chip.label}</span>
          <span className="font-mono truncate max-w-[120px]" title={chip.value}>
            {chip.value}
          </span>
        </Badge>
      ))}
    </div>
  );
}

export function TraceCausalityLedger({ events, className }: TraceCausalityLedgerProps) {
  const summary = useMemo(() => buildTraceCausalitySummary(events), [events]);

  if (summary.causalRows.length === 0) {
    return null;
  }

  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted uppercase tracking-wide">
            <ListTree className="w-3.5 h-3.5" />
            Execution links
          </h3>
          <p className="mt-1 text-xs text-subtle">
            Follow why each event happened: which agent run owns it, what triggered it, and which
            earlier trace event caused it.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
          <span>{summary.causalRows.length} linked events</span>
          {summary.missingCauseCount > 0 && (
            <span title="The event has a cause id, but that source event is not in the loaded trace set. This is usually an older trace, a source mismatch, or a partial history load.">
              <Badge variant="warning" appearance="outlined">
                {summary.missingCauseCount}{' '}
                {summary.missingCauseCount === 1 ? 'unresolved link' : 'unresolved links'}
              </Badge>
            </span>
          )}
        </div>
      </div>

      <div className="mb-3 grid gap-2 rounded-md border border-default bg-background-subtle p-3 text-xs text-muted md:grid-cols-3">
        <div>
          <div className="font-medium text-foreground">Agent run</div>
          <div className="mt-0.5">
            Groups enter, LLM, tools, decisions, and exit for one agent pass.
          </div>
        </div>
        <div>
          <div className="font-medium text-foreground">Cause</div>
          <div className="mt-0.5">Shows the previous event that triggered this event.</div>
        </div>
        <div>
          <div className="flex items-center gap-1 font-medium text-foreground">
            <HelpCircle className="w-3 h-3" />
            Link health
          </div>
          <div className="mt-0.5">{summary.traceHealthDetail}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <TraceCausalityMetric
          icon={<GitBranch className="w-3 h-3" />}
          label="Agent runs"
          value={summary.agentRunCount}
        />
        <TraceCausalityMetric
          icon={<Link2 className="w-3 h-3" />}
          label="Decisions"
          value={summary.decisionCount}
        />
        <TraceCausalityMetric
          icon={<ListTree className="w-3 h-3" />}
          label="Link quality"
          value={`${summary.resolvedCauseCount}/${summary.linkedCauseCount}`}
        />
      </div>

      <div className="overflow-auto max-h-80 border border-default rounded-md">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-background-subtle text-muted">
            <tr className="border-b border-default">
              <th className="text-left font-medium px-2 py-1.5 w-10">#</th>
              <th className="text-left font-medium px-2 py-1.5">Step</th>
              <th className="text-left font-medium px-2 py-1.5">Phase</th>
              <th className="text-left font-medium px-2 py-1.5">Agent run</th>
              <th className="text-left font-medium px-2 py-1.5">What triggered it</th>
              <th className="text-left font-medium px-2 py-1.5">Runtime reason</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.id} className="border-b border-default/60 last:border-0">
                <td className="px-2 py-1.5 text-subtle tabular-nums">{row.index + 1}</td>
                <td className="px-2 py-1.5">
                  <div className="font-medium text-foreground">{row.label}</div>
                  <div className="font-mono text-[11px] text-subtle">
                    {row.type} {formatShortTraceId(row.id)}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-muted">{humanizeTraceCode(row.causal.phase)}</td>
                <td className="px-2 py-1.5 font-mono text-muted">
                  {formatShortTraceId(row.causal.agentRunId, 12) || '-'}
                </td>
                <td className="px-2 py-1.5">
                  {row.causal.causeEventId ? (
                    <div>
                      <div className={row.causeMissing ? 'text-warning' : 'text-muted'}>
                        {row.causeMissing ? 'Linked event not loaded' : row.causeLabel}
                      </div>
                      <div className="font-mono text-[11px] text-subtle">
                        {row.causeMissing
                          ? formatShortTraceId(row.causal.causeEventId)
                          : row.causeDetail}
                      </div>
                    </div>
                  ) : (
                    <span className="text-subtle">Start of trace</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-muted">
                  {humanizeTraceCode(row.causal.reasonCode)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TraceCausalityMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-background-muted px-2.5 py-2">
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}
