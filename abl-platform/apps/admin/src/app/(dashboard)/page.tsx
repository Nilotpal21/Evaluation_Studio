'use client';

import { useApi } from '../../hooks/use-swr-fetch';
import { SkeletonCard } from '../../components/ui/skeleton';
import { EmptyState } from '../../components/ui/empty-state';
import type { ConfigResponse, SecretsResponse, AuditResponse } from '../../types/api';

export default function DashboardPage() {
  const config = useApi<ConfigResponse>('/api/config?env=dev');
  const secrets = useApi<SecretsResponse>('/api/secrets?scope=shared&env=dev');
  const audit = useApi<AuditResponse>('/api/audit?limit=5');

  const anyLoading = config.loading || secrets.loading || audit.loading;
  const anyError = config.error || secrets.error || audit.error;

  if (anyLoading) {
    return (
      <div>
        <h2 className="text-2xl font-bold text-foreground mb-6">Dashboard Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 stagger-children">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (anyError) {
    return (
      <div>
        <h2 className="text-2xl font-bold text-foreground mb-6">Dashboard Overview</h2>
        <EmptyState
          title="Failed to load dashboard"
          description={config.error || secrets.error || audit.error || 'Unknown error'}
          action={
            <button
              onClick={() => {
                config.refetch();
                secrets.refetch();
                audit.refetch();
              }}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm btn-press"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  const configKeyCount = config.data
    ? Object.values(config.data.config).reduce(
        (sum, section) => sum + Object.keys(section as Record<string, unknown>).length,
        0,
      )
    : 0;

  const secretCount = secrets.data?.secrets.length ?? 0;
  const auditCount = audit.data?.count ?? 0;

  return (
    <div>
      <h2 className="text-2xl font-bold text-foreground mb-2">Dashboard Overview</h2>
      <p className="text-sm text-muted mb-6">Monitor configuration, secrets, and activity</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 stagger-children">
        <DashboardCard
          title="Configuration"
          description="Config keys loaded across environments"
          href="/config"
          count={`${configKeyCount} keys`}
        />
        <DashboardCard
          title="Secrets"
          description="Secrets loaded via External Secrets Operator"
          href="/secrets"
          count={`${secretCount} secrets`}
        />
        <DashboardCard
          title="Audit Log"
          description="Admin UI access events"
          href="/audit"
          count={`${auditCount} recent`}
        />
      </div>

      {audit.data && audit.data.entries.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold text-foreground mb-3">Recent Activity</h3>
          <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
            {audit.data.entries.map((entry, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-4 py-3 border-b border-border-muted last:border-b-0 table-row-hover"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs px-2 py-0.5 rounded-[var(--radius-full)] bg-accent-subtle text-accent font-medium">
                    {entry.action}
                  </span>
                  <span className="text-sm text-foreground">{entry.target}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-subtle">
                  <span>{entry.actor}</span>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardCard({
  title,
  description,
  href,
  count,
}: {
  title: string;
  description: string;
  href: string;
  count: string;
}) {
  return (
    <a
      href={href}
      className="block p-6 bg-background-muted border border-default rounded-[var(--radius-xl)] card-hover"
    >
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-muted text-sm mb-4">{description}</p>
      <span className="text-gradient text-xl font-bold">{count}</span>
    </a>
  );
}
