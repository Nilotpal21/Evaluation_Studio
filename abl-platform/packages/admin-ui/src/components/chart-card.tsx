import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../lib/cn';

// =============================================================================
// CHART COLORS — re-exported from @agent-platform/design-tokens
// =============================================================================

export const CHART_COLORS = SEMANTIC_CHART_COLORS;

// =============================================================================
// GRADIENT DEFINITIONS — SVG linearGradient defs for area charts
// =============================================================================

export const GRADIENT_DEFS = (
  <defs>
    <linearGradient id="gradAccent" x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={CHART_COLORS.accent} stopOpacity={0.3} />
      <stop offset="95%" stopColor={CHART_COLORS.accent} stopOpacity={0} />
    </linearGradient>
    <linearGradient id="gradPurple" x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={CHART_COLORS.purple} stopOpacity={0.3} />
      <stop offset="95%" stopColor={CHART_COLORS.purple} stopOpacity={0} />
    </linearGradient>
    <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={CHART_COLORS.success} stopOpacity={0.3} />
      <stop offset="95%" stopColor={CHART_COLORS.success} stopOpacity={0} />
    </linearGradient>
    <linearGradient id="gradError" x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={CHART_COLORS.error} stopOpacity={0.3} />
      <stop offset="95%" stopColor={CHART_COLORS.error} stopOpacity={0} />
    </linearGradient>
  </defs>
);

// =============================================================================
// CHART TOOLTIP
// =============================================================================

interface TooltipPayloadItem {
  name: string;
  value: number;
  color: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  formatter?: (value: number) => string;
}

function defaultFormat(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function ChartTooltip({ active, payload, label, formatter }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  const fmt = formatter ?? defaultFormat;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-xs shadow-lg',
        'border-border',
        'bg-background-subtle',
      )}
    >
      {label && <p className="mb-1 text-foreground-muted">{label}</p>}
      {payload.map((entry, i) => (
        <p key={i} className="text-foreground" style={{ color: entry.color }}>
          {entry.name}: <span className="font-medium">{fmt(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

// =============================================================================
// CHART CARD
// =============================================================================

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  height?: number;
}

export function ChartCard({ title, children, className, height = 300 }: ChartCardProps) {
  return (
    <div
      className={cn('rounded-lg border p-4', 'border-border', 'bg-background-subtle', className)}
    >
      <h3 className="mb-4 text-sm font-medium text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={height}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}
