/**
 * Network Quality & Call Volume Widget
 * Shows MOS scores and call count trends over time
 */

import { useTranslations } from 'next-intl';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { ChartWidget } from './ChartWidget';

interface NetworkQualityWidgetProps {
  data: Array<{
    hour: string;
    session_count: number;
    avg_inbound_mos: number | null;
    avg_outbound_mos: number | null;
  }>;
}

export function NetworkQualityWidget({ data }: NetworkQualityWidgetProps) {
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
    calls: row.session_count,
    mos: row.avg_inbound_mos ? parseFloat(row.avg_inbound_mos.toFixed(2)) : null,
  }));

  return (
    <ChartWidget
      title="Network Quality & Call Volume"
      description="MOS scores and call count trends"
      infoTooltip="MOS (Mean Opinion Score) measures call quality from 1-5. Higher is better. Purple = call count, Green = MOS score."
    >
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="colorCalls2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SEMANTIC_CHART_COLORS.info} stopOpacity={0.3} />
              <stop offset="95%" stopColor={SEMANTIC_CHART_COLORS.info} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorMOS2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SEMANTIC_CHART_COLORS.success} stopOpacity={0.3} />
              <stop offset="95%" stopColor={SEMANTIC_CHART_COLORS.success} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="hour"
            stroke="hsl(var(--foreground-subtle))"
            style={{ fontSize: '12px' }}
            tick={{ fill: 'hsl(var(--foreground-muted))' }}
          />
          <YAxis
            yAxisId="left"
            stroke={SEMANTIC_CHART_COLORS.info}
            style={{ fontSize: '12px' }}
            label={{
              value: 'Calls',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: '12px', fill: SEMANTIC_CHART_COLORS.info },
            }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke={SEMANTIC_CHART_COLORS.success}
            domain={[0, 5]}
            style={{ fontSize: '12px' }}
            label={{
              value: 'MOS',
              angle: 90,
              position: 'insideRight',
              style: { fontSize: '12px', fill: SEMANTIC_CHART_COLORS.success },
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
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="calls"
            stroke={SEMANTIC_CHART_COLORS.info}
            fillOpacity={1}
            fill="url(#colorCalls2)"
            name="Calls"
          />
          <Area
            yAxisId="right"
            type="monotone"
            dataKey="mos"
            stroke={SEMANTIC_CHART_COLORS.success}
            fillOpacity={1}
            fill="url(#colorMOS2)"
            name="Avg MOS"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartWidget>
  );
}
