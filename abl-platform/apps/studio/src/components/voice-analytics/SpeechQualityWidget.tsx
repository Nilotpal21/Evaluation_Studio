/**
 * Speech Recognition Quality Widget
 * Shows ASR quality scores over time with threshold indicators
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

interface SpeechQualityWidgetProps {
  data: Array<{
    hour: string;
    avg_asr_score: number | null;
  }>;
}

export function SpeechQualityWidget({ data }: SpeechQualityWidgetProps) {
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
    asr: row.avg_asr_score ? parseFloat(row.avg_asr_score.toFixed(1)) : null,
  }));

  return (
    <ChartWidget
      title="Speech Recognition Quality (ASR)"
      description="ASR quality scores (0-100, higher is better)"
      infoTooltip="ASR Score measures speech recognition accuracy. 80+ = Excellent, 60-79 = Good, <60 = Needs attention."
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
            domain={[0, 100]}
            style={{ fontSize: '12px' }}
            label={{
              value: 'ASR Score',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: '12px' },
            }}
          />
          {/* Threshold line at 80 (excellent) */}
          <ReferenceLine
            y={80}
            stroke={SEMANTIC_CHART_COLORS.success}
            strokeDasharray="3 3"
            label={{
              value: 'Excellent (80+)',
              position: 'insideTopRight',
              fill: SEMANTIC_CHART_COLORS.success,
              fontSize: 10,
            }}
          />
          {/* Threshold line at 60 (good) */}
          <ReferenceLine
            y={60}
            stroke={SEMANTIC_CHART_COLORS.warning}
            strokeDasharray="3 3"
            label={{
              value: 'Good (60+)',
              position: 'insideBottomRight',
              fill: SEMANTIC_CHART_COLORS.warning,
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
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          <Line
            type="monotone"
            dataKey="asr"
            stroke={SEMANTIC_CHART_COLORS.info}
            strokeWidth={2}
            dot={{ r: 4, fill: SEMANTIC_CHART_COLORS.info }}
            name="ASR Score"
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartWidget>
  );
}
