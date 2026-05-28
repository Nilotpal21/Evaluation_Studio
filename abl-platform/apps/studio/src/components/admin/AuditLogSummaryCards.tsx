'use client';

import { Brain, AlertTriangle, Coins, Hash } from 'lucide-react';
import { useArchAuditStore } from '@/lib/arch-ai/store/arch-audit-store';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface CardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent: string;
}

function KPICard({ icon, label, value, sub, accent }: CardProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background p-4">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground-muted">{label}</div>
        <div className="text-lg font-semibold text-foreground tabular-nums">{value}</div>
        {sub && <div className="text-[10px] text-foreground-subtle">{sub}</div>}
      </div>
    </div>
  );
}

export function AuditLogSummaryCards() {
  const summary = useArchAuditStore((s) => s.summary);
  const loading = useArchAuditStore((s) => s.summaryLoading);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-background-muted" />
        ))}
      </div>
    );
  }

  const s = summary ?? {
    totalEvents: 0,
    totalTokens: { input: 0, output: 0, total: 0 },
    estimatedCost: 0,
    errorCount: { total: 0, critical: 0, error: 0, warning: 0 },
    byCategory: {},
  };

  const llmCalls = s.byCategory['llm_call'] ?? 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KPICard
        icon={<Brain className="h-4 w-4 text-purple" />}
        label="LLM Calls"
        value={String(llmCalls)}
        sub={`of ${s.totalEvents} total events`}
        accent="bg-purple-subtle"
      />
      <KPICard
        icon={<Hash className="h-4 w-4 text-info" />}
        label="Tokens Used"
        value={formatTokens(s.totalTokens.total)}
        sub={`${formatTokens(s.totalTokens.input)} in / ${formatTokens(s.totalTokens.output)} out`}
        accent="bg-info-subtle"
      />
      <KPICard
        icon={<Coins className="h-4 w-4 text-warning" />}
        label="Estimated Cost"
        value={formatCost(s.estimatedCost)}
        accent="bg-warning-subtle"
      />
      <KPICard
        icon={<AlertTriangle className="h-4 w-4 text-error" />}
        label="Errors"
        value={String(s.errorCount.total)}
        sub={
          s.errorCount.total > 0
            ? `${s.errorCount.critical} critical, ${s.errorCount.error} error, ${s.errorCount.warning} warn`
            : undefined
        }
        accent="bg-error-subtle"
      />
    </div>
  );
}
