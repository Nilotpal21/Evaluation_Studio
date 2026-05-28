import { Bot, Activity, CheckCircle2, Gauge } from 'lucide-react';
import { kpis } from '@/lib/mock-data';

type Tone = 'neutral' | 'success' | 'info' | 'purple';

const cards: { label: string; value: string; delta: string; deltaTone: Tone; icon: typeof Bot }[] =
  [
    {
      label: 'Active agents',
      value: kpis.activeAgents.toString(),
      delta: '+3 this week',
      deltaTone: 'success',
      icon: Bot,
    },
    {
      label: 'Runs · 24h',
      value: kpis.runs24h.toLocaleString(),
      delta: '+12.4% vs yesterday',
      deltaTone: 'success',
      icon: Activity,
    },
    {
      label: 'Success rate',
      value: `${kpis.successRate}%`,
      delta: '−0.2pp vs 7d avg',
      deltaTone: 'neutral',
      icon: CheckCircle2,
    },
    {
      label: 'Avg latency',
      value: `${kpis.avgLatencyMs} ms`,
      delta: 'p95 1.42s',
      deltaTone: 'info',
      icon: Gauge,
    },
  ];

const toneClass: Record<Tone, string> = {
  neutral: 'text-foreground-meta',
  success: 'text-success',
  info: 'text-info',
  purple: 'text-purple',
};

export function StatsCards() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            className="rounded-lg border border-border-muted bg-background-subtle p-4 hover:border-border transition-colors"
          >
            <div className="flex items-start justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wide text-foreground-meta font-medium">
                {c.label}
              </span>
              <Icon className="size-3.5 text-foreground-subtle" />
            </div>
            <div className="text-2xl font-semibold tabular-nums tracking-tight">{c.value}</div>
            <div className={`text-[11px] mt-1 ${toneClass[c.deltaTone]}`}>{c.delta}</div>
          </div>
        );
      })}
    </div>
  );
}
