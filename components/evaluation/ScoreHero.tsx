'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { EvalReport } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

export function ScoreHero({ report }: { report: EvalReport }) {
  const trendCls =
    report.trend === 'up'
      ? 'text-success'
      : report.trend === 'down'
        ? 'text-error'
        : 'text-foreground-meta';
  const TrendIco =
    report.trend === 'up' ? TrendingUp : report.trend === 'down' ? TrendingDown : Minus;

  const hasPrev = report.prevOverallScore !== null;

  const data = report.trend30Day.map((p) => ({
    date: p.date.slice(5), // MM-DD
    score: p.score,
  }));

  return (
    <section className="rounded-lg border border-border bg-background-subtle overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] divide-y lg:divide-y-0 lg:divide-x divide-border-muted">
        <div className="p-6 flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
            Overall Evaluation Score
          </div>
          <div className="flex items-end gap-3 mt-2">
            <div className="text-6xl font-semibold tabular-nums tracking-tight font-mono">
              {report.overallScore}
            </div>
            <div className="text-foreground-subtle text-sm font-mono mb-2">/100</div>
          </div>
          {hasPrev ? (
            <div
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium mt-2 tabular-nums',
                trendCls,
              )}
            >
              <TrendIco className="size-3.5" />
              {report.delta >= 0 ? '+' : ''}
              {report.delta.toFixed(1)} vs previous run
            </div>
          ) : (
            <div className="text-xs text-foreground-muted mt-2">— first run</div>
          )}
          <div className="text-[11px] text-foreground-subtle mt-3 font-mono">
            Updated {report.ranAgo} · trigger: {report.trigger.replace(/_/g, ' ')}
          </div>
        </div>

        <div className="p-4">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2 px-2">
            30-day score trend
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="hsl(220 4% 18%)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="hsl(220 2% 55%)"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                />
                <YAxis
                  stroke="hsl(220 2% 55%)"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  domain={[50, 100]}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(220 3% 10%)',
                    border: '1px solid hsl(220 4% 18%)',
                    borderRadius: 6,
                    fontSize: 11,
                    color: 'hsl(220 1% 98%)',
                  }}
                  labelStyle={{ color: 'hsl(220 2% 64%)' }}
                  cursor={{ stroke: 'hsl(220 4% 18%)', strokeWidth: 1 }}
                />
                <ReferenceLine
                  y={80}
                  stroke="hsl(40 93.4% 47.5% / 0.4)"
                  strokeDasharray="3 3"
                  label={{
                    value: 'Pilot baseline 80',
                    position: 'insideTopLeft',
                    fill: 'hsl(40 93.4% 47.5%)',
                    fontSize: 9,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="hsl(220 5% 93%)"
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </section>
  );
}
