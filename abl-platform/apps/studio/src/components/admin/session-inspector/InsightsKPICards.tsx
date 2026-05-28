'use client';

import { useEffect } from 'react';
import { useSessionInspectorStore } from '@/store/session-inspector-store';
import { InsightKPICard } from '@/components/insights/shared/InsightKPICard';
import { formatCost } from '@/components/analytics/shared';

export function InsightsKPICards() {
  const { sparkline, sparklineLoading, sessions, total, fetchSparkline } =
    useSessionInspectorStore();

  useEffect(() => {
    fetchSparkline();
  }, [fetchSparkline]);

  const totalSessions = sparkline.reduce((sum, p) => sum + p.sessions, 0);
  const totalCost = sparkline.reduce((sum, p) => sum + p.cost, 0);
  const totalErrors = sparkline.reduce((sum, p) => sum + p.errors, 0);
  const sessionSparkline = sparkline.map((p) => p.sessions);
  const errorSparkline = sparkline.map((p) => p.errors);

  return (
    <div className="grid grid-cols-4 gap-3 px-4 py-3 border-b border-border">
      <InsightKPICard
        title="Sessions (24h)"
        value={sparklineLoading ? '…' : totalSessions}
        sparkline={sessionSparkline.length > 0 ? sessionSparkline : undefined}
      />
      <InsightKPICard
        title="Total Cost (24h)"
        value={sparklineLoading ? '…' : formatCost(totalCost)}
      />
      <InsightKPICard
        title="Errors (24h)"
        value={sparklineLoading ? '…' : totalErrors}
        sparkline={errorSparkline.length > 0 ? errorSparkline : undefined}
        status={totalErrors > 5 ? 'critical' : totalErrors > 0 ? 'warning' : 'healthy'}
      />
      <InsightKPICard title="Listed Sessions" value={total} />
    </div>
  );
}
