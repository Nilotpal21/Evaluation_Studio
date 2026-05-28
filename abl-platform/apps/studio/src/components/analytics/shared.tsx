/**
 * Shared formatting utilities for analytics and observatory components.
 */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatCost(cost: number): string {
  if (cost < 0.001) return '<$0.001';
  return `$${cost.toFixed(4)}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatTimestamp(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleString();
}

export function formatChartTick(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Fill gaps in time-series data so charts render continuous lines.
 * @param data - Raw data points
 * @param timeKey - Key holding the time value
 * @param from - Start of range (ISO string)
 * @param to - End of range (ISO string)
 * @param granularity - 'hour' or 'day'
 * @param defaults - Default values for missing data points
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fillTimeGaps<T>(
  data: T[],
  timeKey: keyof T & string,
  from: string,
  to: string,
  granularity: 'hour' | 'day',
  defaults: Partial<T>,
): T[] {
  if (data.length === 0) return data;
  // ClickHouse returns bare datetime strings like "2026-05-06 00:00:00.000" with no timezone.
  // JS parses these as local time, but the cursor generates UTC ISO strings — causing a key
  // mismatch on non-UTC machines. Treat the space-format as UTC by converting to ISO first.
  const toUtcMs = (s: string) =>
    new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
  const normalize = (s: string) => toUtcMs(s);
  const existing = new Map(data.map((d) => [normalize(String(d[timeKey])), d]));
  const result: T[] = [];
  const start = new Date(from);
  const end = new Date(to);
  const cursor = new Date(start);

  // Round cursor down to the bucket boundary so it aligns with the
  // ClickHouse-bucketed keys (toDate → midnight UTC, toStartOfHour → :00:00).
  // Without this, ranges like "now - 30d" never match any returned bucket.
  if (granularity === 'day') {
    cursor.setUTCHours(0, 0, 0, 0);
  } else {
    cursor.setUTCMinutes(0, 0, 0);
  }

  while (cursor <= end) {
    const key = cursor.toISOString();
    result.push(existing.get(normalize(key)) ?? ({ ...defaults, [timeKey]: key } as unknown as T));
    if (granularity === 'hour') {
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    } else {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return result;
}

/** Standard chart color palette */
export const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

/** Bright, saturated palette for pie/donut charts where distinct segments matter */
export const PIE_CHART_COLORS = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
];

/** Category colors for event type pie charts */
export const CATEGORY_COLORS: Record<string, string> = {
  session: CHART_COLORS[0],
  message: CHART_COLORS[1],
  llm: CHART_COLORS[2],
  tool: CHART_COLORS[3],
  error: 'hsl(var(--error))',
  other: CHART_COLORS[4],
};

/** SVG gradient definitions for area charts */
export const GRADIENT_DEFS = (
  <defs>
    {CHART_COLORS.map((color, i) => (
      <linearGradient key={`gradient-${i}`} id={`gradient-${i}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stopColor={color} stopOpacity={0.3} />
        <stop offset="95%" stopColor={color} stopOpacity={0} />
      </linearGradient>
    ))}
  </defs>
);

// ─── Re-usable Chart Components ─────────────────────────────────────────────

import React from 'react';

export function AnalyticsSkeleton() {
  return (
    <div className="space-y-4 p-4 animate-pulse">
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-20 rounded-lg bg-background-muted" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-background-muted" />
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-10 rounded bg-background-muted" />
        ))}
      </div>
    </div>
  );
}

export function KPICard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-background p-4">
      <p className="text-xs text-muted">{title}</p>
      <p className="text-2xl font-semibold text-foreground">{value}</p>
      {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
    </div>
  );
}

export function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-default bg-background p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">{title}</h3>
      {children}
    </div>
  );
}

export function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatter?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-default bg-background-elevated px-3 py-2 shadow-md text-xs">
      {label && <p className="text-muted mb-1">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}:</span>
          <span className="text-foreground font-medium">
            {formatter ? formatter(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}
