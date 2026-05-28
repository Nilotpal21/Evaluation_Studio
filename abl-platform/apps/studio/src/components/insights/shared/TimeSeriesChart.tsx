'use client';

import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { CHART_COLOR_PALETTE } from '@agent-platform/design-tokens';

interface MetricConfig {
  key: string;
  label: string;
  color?: string;
  type?: 'line' | 'area';
}

interface TimeSeriesChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  metrics: MetricConfig[];
  height?: number;
  dateKey?: string;
  yAxisFormatter?: (value: number) => string;
  stacked?: boolean;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-default bg-background-elevated px-3 py-2 shadow-lg text-xs">
      {label && <p className="text-muted mb-1 font-medium">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted">{p.name}:</span>
          <span className="text-foreground font-medium">
            {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TimeSeriesChart({
  data,
  metrics,
  height = 300,
  dateKey = 'date',
  yAxisFormatter,
  stacked = false,
}: TimeSeriesChartProps) {
  const hasArea = metrics.some((m) => m.type === 'area');
  const ChartComponent = hasArea ? AreaChart : LineChart;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ChartComponent data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey={dateKey} tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }} />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
          tickFormatter={yAxisFormatter}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />

        {metrics.map((metric, i) => {
          const color = metric.color || CHART_COLOR_PALETTE[i % CHART_COLOR_PALETTE.length];
          const gradientId = `gradient-ts-${i}`;

          if (metric.type === 'area') {
            return (
              <Area
                key={metric.key}
                type="monotone"
                dataKey={metric.key}
                name={metric.label}
                stroke={color}
                fill={`url(#${gradientId})`}
                strokeWidth={2}
                stackId={stacked ? 'stack' : undefined}
              />
            );
          }

          return (
            <Line
              key={metric.key}
              type="monotone"
              dataKey={metric.key}
              name={metric.label}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          );
        })}

        <defs>
          {metrics.map((metric, i) => {
            const color = metric.color || CHART_COLOR_PALETTE[i % CHART_COLOR_PALETTE.length];
            return (
              <linearGradient
                key={`gradient-ts-${i}`}
                id={`gradient-ts-${i}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            );
          })}
        </defs>
      </ChartComponent>
    </ResponsiveContainer>
  );
}
