/**
 * Response Performance Widget
 * Shows end-to-end response latency trends
 */

import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { ChartWidget } from './ChartWidget';

interface ResponsePerformanceWidgetProps {
  data: Array<{
    hour: string;
    avg_e2e_latency_ms: number | null;
  }>;
}

export function ResponsePerformanceWidget({ data }: ResponsePerformanceWidgetProps) {
  const t = useTranslations('voice_analytics');

  const formatHour = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      hour12: true,
    });
  };

  const chartData = data.map((row) => ({
    hour: formatHour(row.hour),
    latency: row.avg_e2e_latency_ms ? parseFloat(row.avg_e2e_latency_ms.toFixed(0)) : null,
  }));

  return (
    <ChartWidget
      title="Response Performance"
      description="End-to-end response latency"
      infoTooltip="E2E Latency measures the time from user's last word to agent's first word. Target: <2000ms for natural conversation."
    >
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData}>
          <XAxis
            dataKey="hour"
            stroke="hsl(var(--foreground-subtle))"
            style={{ fontSize: '12px' }}
            tick={{ fill: 'hsl(var(--foreground-muted))' }}
          />
          <YAxis
            stroke="hsl(var(--foreground-subtle))"
            style={{ fontSize: '12px' }}
            label={{
              value: 'Latency (ms)',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: '12px' },
            }}
          />
          {/* Target latency threshold at 2000ms */}
          <ReferenceLine
            y={2000}
            stroke={SEMANTIC_CHART_COLORS.error}
            strokeDasharray="3 3"
            label={{
              value: 'Target (2000ms)',
              position: 'insideTopRight',
              fill: SEMANTIC_CHART_COLORS.error,
              fontSize: 10,
            }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--background-elevated))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelStyle={{ color: 'hsl(var(--foreground))' }}
            formatter={
              ((value: number | string) =>
                value != null ? [`${value}ms`, 'E2E Latency'] : ['—', 'E2E Latency']) as never
            }
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          <Line
            type="monotone"
            dataKey="latency"
            stroke={SEMANTIC_CHART_COLORS.warning}
            strokeWidth={2}
            dot={{ r: 4, fill: SEMANTIC_CHART_COLORS.warning }}
            name="E2E Latency"
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartWidget>
  );
}
