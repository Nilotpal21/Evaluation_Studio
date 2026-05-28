'use client';

import { useMemo } from 'react';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';

interface OutcomeDistributionProps {
  outcomes: { outcome: string; count: number }[];
}

/** Map outcome keys to semantic chart colors. */
function getOutcomeColor(outcome: string): string {
  switch (outcome) {
    case 'contained_resolved':
    case 'contained':
    case 'contained_partial':
      return SEMANTIC_CHART_COLORS.success;
    case 'contained_unresolved':
      return SEMANTIC_CHART_COLORS.warning;
    case 'escalated':
      return SEMANTIC_CHART_COLORS.error;
    case 'abandoned':
    default:
      return SEMANTIC_CHART_COLORS.muted;
  }
}

/** Map outcome keys to semantic Tailwind bg classes for dots and bars. */
function getOutcomeBgClass(outcome: string): string {
  switch (outcome) {
    case 'contained_resolved':
    case 'contained':
    case 'contained_partial':
      return 'bg-success';
    case 'contained_unresolved':
      return 'bg-warning';
    case 'escalated':
      return 'bg-error';
    case 'abandoned':
    default:
      return 'bg-foreground-subtle';
  }
}

/** Map outcome keys to subtle bg classes for the inline progress bar. */
function getOutcomeBgSubtleClass(outcome: string): string {
  switch (outcome) {
    case 'contained_resolved':
    case 'contained':
    case 'contained_partial':
      return 'bg-success-muted';
    case 'contained_unresolved':
      return 'bg-warning-muted';
    case 'escalated':
      return 'bg-error-muted';
    case 'abandoned':
    default:
      return 'bg-background-muted';
  }
}

/** Human-readable description for each outcome. */
function getOutcomeDescription(outcome: string): string {
  switch (outcome) {
    case 'contained_resolved':
      return 'Fully resolved by AI without human help';
    case 'contained_unresolved':
      return 'Handled by AI but resolution uncertain';
    case 'contained':
    case 'contained_partial':
      return 'Partially handled by AI';
    case 'escalated':
      return 'Transferred to a human agent';
    case 'abandoned':
      return 'Customer left before resolution';
    default:
      return 'Other outcome';
  }
}

/** Format outcome key as a readable label: replace underscores, capitalize first letter. */
function formatOutcomeLabel(outcome: string): string {
  const spaced = outcome.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function OutcomeDistribution({ outcomes }: OutcomeDistributionProps) {
  const { total, segments } = useMemo(() => {
    const sum = outcomes.reduce((acc, o) => acc + o.count, 0);
    const segs = outcomes.map((o) => ({
      ...o,
      percentage: sum > 0 ? (o.count / sum) * 100 : 0,
    }));
    return { total: sum, segments: segs };
  }, [outcomes]);

  if (outcomes.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Segmented horizontal bar */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-background-muted">
        {segments.map((seg, idx) => (
          <div
            key={seg.outcome}
            className="h-full transition-all duration-300"
            style={{
              width: `${seg.percentage}%`,
              backgroundColor: getOutcomeColor(seg.outcome),
              borderTopLeftRadius: idx === 0 ? '9999px' : undefined,
              borderBottomLeftRadius: idx === 0 ? '9999px' : undefined,
              borderTopRightRadius: idx === segments.length - 1 ? '9999px' : undefined,
              borderBottomRightRadius: idx === segments.length - 1 ? '9999px' : undefined,
            }}
          />
        ))}
      </div>

      {/* Outcome stat rows */}
      <div className="space-y-3">
        {segments.map((seg) => (
          <div key={seg.outcome} className="space-y-1">
            <div className="flex items-center gap-3">
              {/* Left: dot + label */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span
                  className={`w-2.5 h-2.5 shrink-0 rounded-full ${getOutcomeBgClass(seg.outcome)}`}
                />
                <span className="text-sm font-medium text-foreground truncate">
                  {formatOutcomeLabel(seg.outcome)}
                </span>
              </div>

              {/* Inline proportion bar */}
              <div className="hidden sm:block w-24 shrink-0">
                <div
                  className={`h-1.5 w-full rounded-full ${getOutcomeBgSubtleClass(seg.outcome)}`}
                >
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getOutcomeBgClass(seg.outcome)}`}
                    style={{ width: `${seg.percentage}%` }}
                  />
                </div>
              </div>

              {/* Right: count + percentage */}
              <span className="text-sm text-muted tabular-nums shrink-0">
                {seg.count} ({Math.round(seg.percentage)}%)
              </span>
            </div>

            {/* Description */}
            <p className="text-xs text-subtle ml-[18px]">{getOutcomeDescription(seg.outcome)}</p>
          </div>
        ))}
      </div>

      {/* Total summary */}
      <p className="text-xs text-muted pt-1">
        {total} total conversation{total !== 1 ? 's' : ''} evaluated
      </p>
    </div>
  );
}
