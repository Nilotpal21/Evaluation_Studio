import type { EvalSources, EvalSourceStats } from '@/lib/mock-data';

export function SourceBreakdown({ sources }: { sources: EvalSources }) {
  const items = [
    {
      label: 'Pre-built CU scenarios',
      sub: 'Platform-curated library of credit-union conversations',
      stats: sources.preBuiltScenarios,
    },
    {
      label: 'SOP-derived tests',
      sub: 'Automatically generated from your uploaded SOP',
      stats: sources.sopDerived,
    },
    {
      label: 'User-defined tests',
      sub: 'Tests you created in the sandbox',
      stats: sources.userDefined,
    },
  ];

  return (
    <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {items.map((it) => {
        const pct = it.stats.count > 0 ? Math.round((it.stats.passed / it.stats.count) * 1000) / 10 : 0;
        return (
          <div
            key={it.label}
            className="rounded-lg border border-border-muted bg-background-subtle p-4 flex items-start gap-3"
          >
            <Donut percentage={pct} />
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-wide text-foreground-meta font-medium">
                {it.label}
              </div>
              <div className="text-xs text-foreground-muted mt-0.5 line-clamp-1">{it.sub}</div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
                <span className="text-[11px] text-foreground-subtle font-mono">pass rate</span>
              </div>
              <div className="text-[11px] text-foreground-subtle font-mono mt-0.5 tabular-nums">
                {it.stats.passed} / {it.stats.count} passed
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Donut({ percentage }: { percentage: number }) {
  const radius = 22;
  const stroke = 5;
  const norm = radius - stroke / 2;
  const circumference = 2 * Math.PI * norm;
  const offset = circumference - (percentage / 100) * circumference;
  const color =
    percentage >= 90
      ? 'hsl(142.1 76.2% 45%)'
      : percentage >= 75
        ? 'hsl(40 93.4% 50%)'
        : 'hsl(0 72.2% 55%)';
  return (
    <svg width={50} height={50} className="shrink-0 -rotate-90">
      <circle
        cx={25}
        cy={25}
        r={norm}
        stroke="hsl(220 3% 12.5%)"
        strokeWidth={stroke}
        fill="transparent"
      />
      <circle
        cx={25}
        cy={25}
        r={norm}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="transparent"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)' }}
      />
    </svg>
  );
}
