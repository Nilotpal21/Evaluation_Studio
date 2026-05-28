/**
 * User Experience Widget
 * Shows barge-in and DTMF fallback rates
 */

import { useTranslations } from 'next-intl';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { ChartWidget } from './ChartWidget';

interface UserExperienceWidgetProps {
  data: Array<{
    hour: string;
    avg_barge_in_rate: number | null;
    avg_dtmf_fallback_rate: number | null;
  }>;
}

export function UserExperienceWidget({ data }: UserExperienceWidgetProps) {
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
    bargeIn: row.avg_barge_in_rate ? parseFloat(row.avg_barge_in_rate.toFixed(1)) : null,
    dtmf: row.avg_dtmf_fallback_rate ? parseFloat(row.avg_dtmf_fallback_rate.toFixed(1)) : null,
  }));

  return (
    <ChartWidget
      title="User Experience Metrics"
      description="Barge-in and DTMF fallback rates (%)"
      infoTooltip="Barge-in: users interrupting the agent. DTMF Fallback: users pressing keys instead of speaking."
    >
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="colorBargeIn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SEMANTIC_CHART_COLORS.error} stopOpacity={0.3} />
              <stop offset="95%" stopColor={SEMANTIC_CHART_COLORS.error} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorDTMF" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SEMANTIC_CHART_COLORS.info} stopOpacity={0.3} />
              <stop offset="95%" stopColor={SEMANTIC_CHART_COLORS.info} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="hour"
            stroke="hsl(var(--foreground-subtle))"
            style={{ fontSize: '12px' }}
            tick={{ fill: 'hsl(var(--foreground-muted))' }}
          />
          <YAxis
            stroke="hsl(var(--foreground-subtle))"
            domain={[0, 100]}
            style={{ fontSize: '12px' }}
            label={{
              value: 'Rate (%)',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: '12px' },
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
            formatter={((value: number | string) => (value != null ? `${value}%` : '—')) as never}
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          <Area
            type="monotone"
            dataKey="bargeIn"
            stroke={SEMANTIC_CHART_COLORS.error}
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#colorBargeIn)"
            name="Barge-in Rate"
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="dtmf"
            stroke={SEMANTIC_CHART_COLORS.info}
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#colorDTMF)"
            name="DTMF Fallback"
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartWidget>
  );
}
