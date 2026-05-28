'use client';

import React, { useEffect, useCallback, useState, useMemo } from 'react';
import {
  RefreshCw,
  Heart,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Database,
  Cpu,
  Search,
  Monitor,
} from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  MetricCard,
  StatusBadge,
  SkeletonCard,
  EmptyState,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';
import type { SystemHealthResponse, ServiceHealth, ServiceGroup } from '../../../types/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTO_REFRESH_INTERVAL_MS = 30_000;

const GROUP_ORDER: ServiceGroup[] = [
  'core-data',
  'agent-execution',
  'search-knowledge',
  'frontend',
];

const GROUP_META: Record<
  ServiceGroup,
  { label: string; description: string; icon: React.JSX.Element }
> = {
  'core-data': {
    label: 'Core Data Layer',
    description: 'Foundation databases and caches that all services depend on',
    icon: <Database size={16} />,
  },
  'agent-execution': {
    label: 'Agent Execution Pipeline',
    description: 'Agent conversations, workflow orchestration, and NLU processing',
    icon: <Cpu size={16} />,
  },
  'search-knowledge': {
    label: 'Search & Knowledge Pipeline',
    description: 'RAG stack: ingestion, embedding, vector search, and knowledge graph',
    icon: <Search size={16} />,
  },
  frontend: {
    label: 'Frontend Applications',
    description: 'Web UIs for agent development and platform administration',
    icon: <Monitor size={16} />,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusToVariant(status: ServiceHealth['status']): StatusBadgeVariant {
  switch (status) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    default:
      return 'unknown';
  }
}

function formatLatency(ms: number): string {
  if (ms === 0) return '--';
  if (ms < 1) return '<1ms';
  return `${ms}ms`;
}

function formatLastCheck(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatCodeVersion(codeVersion: string): string {
  return /^[0-9a-f]{7,40}$/i.test(codeVersion) ? codeVersion.slice(0, 12) : codeVersion;
}

function getCodeVersionLabel(service: ServiceHealth): string {
  return service.build?.versionSource === 'git_sha' ? 'Commit' : 'Version';
}

/** Check if any dependency of a service is down. */
function getDownDependencies(
  service: ServiceHealth,
  statusMap: Map<string, ServiceHealth['status']>,
): string[] {
  if (!service.dependsOn) return [];
  return service.dependsOn.filter((dep) => statusMap.get(dep) === 'down');
}

// ─── Service Card ─────────────────────────────────────────────────────────────

function ServiceCard({ service, downDeps }: { service: ServiceHealth; downDeps: string[] }) {
  const isNotConfigured = service.configured === false;

  return (
    <div className="rounded-lg border border-border bg-background-subtle p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">{service.name}</h3>
          {service.port && (
            <span className="shrink-0 rounded bg-background-muted px-1.5 py-0.5 text-xs font-mono text-foreground-muted">
              :{service.port}
            </span>
          )}
        </div>
        {isNotConfigured ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-muted/50 px-2.5 py-0.5 text-xs font-medium text-foreground-subtle">
            Not Configured
          </span>
        ) : (
          <StatusBadge status={statusToVariant(service.status)} />
        )}
      </div>

      {/* Description */}
      {service.description && (
        <p className="text-xs text-foreground-muted mb-3 leading-relaxed">{service.description}</p>
      )}

      {/* Dependency warning */}
      {downDeps.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md bg-warning/10 border border-warning/20 px-2.5 py-1.5 mb-3">
          <AlertTriangle size={12} className="text-warning mt-0.5 shrink-0" />
          <span className="text-xs text-warning">
            {downDeps.length === 1 ? `${downDeps[0]} is down` : `${downDeps.join(', ')} are down`}
          </span>
        </div>
      )}

      {/* Metrics */}
      {!isNotConfigured && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-foreground-muted">Latency</span>
            <span className="text-foreground font-mono">{formatLatency(service.latencyMs)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-foreground-muted">Last Check</span>
            <span className="text-foreground font-mono">{formatLastCheck(service.lastCheck)}</span>
          </div>
        </div>
      )}

      {service.build && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-foreground-muted">{getCodeVersionLabel(service)}</span>
            <span
              className="max-w-[60%] truncate text-right font-mono text-foreground"
              title={service.build.codeVersion}
            >
              {formatCodeVersion(service.build.codeVersion)}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-foreground-muted">Environment</span>
            <span className="font-mono text-foreground">{service.build.environment}</span>
          </div>
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-foreground-muted">Deploy ID</span>
            <span
              className="max-w-[60%] truncate text-right font-mono text-foreground"
              title={service.build.deployId}
            >
              {service.build.deployId}
            </span>
          </div>
        </div>
      )}

      {/* Dependencies list */}
      {service.dependsOn && service.dependsOn.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <span className="text-xs text-foreground-muted">
            Depends on:{' '}
            <span className="text-foreground font-mono">{service.dependsOn.join(', ')}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Group Section ────────────────────────────────────────────────────────────

function GroupSection({
  group,
  services,
  statusMap,
}: {
  group: ServiceGroup;
  services: ServiceHealth[];
  statusMap: Map<string, ServiceHealth['status']>;
}) {
  const meta = GROUP_META[group];
  const healthyCount = services.filter((s) => s.status === 'healthy').length;

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-foreground-muted">{meta.icon}</span>
        <h2 className="text-sm font-semibold text-foreground">{meta.label}</h2>
        <span className="text-xs text-foreground-muted">
          {healthyCount}/{services.length} healthy
        </span>
      </div>
      <p className="text-xs text-foreground-muted mb-4">{meta.description}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {services.map((service) => (
          <ServiceCard
            key={service.id ?? service.name}
            service={service}
            downDeps={getDownDependencies(service, statusMap)}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SystemHealthPage() {
  const { data, loading, error, refetch } = useApi<SystemHealthResponse>('/api/system-health');
  const [lastRefresh, setLastRefresh] = useState<string>('');

  // Auto-refresh every 30 seconds
  const handleRefresh = useCallback(() => {
    refetch();
    setLastRefresh(new Date().toLocaleTimeString());
  }, [refetch]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  useEffect(() => {
    if (data) {
      setLastRefresh(new Date().toLocaleTimeString());
    }
  }, [data]);

  // Build grouped services and status lookup
  const { grouped, statusMap } = useMemo(() => {
    const services = data?.services ?? [];
    const map = new Map<string, ServiceHealth['status']>();
    const groups = new Map<ServiceGroup, ServiceHealth[]>();

    for (const s of services) {
      if (s.id) map.set(s.id, s.status);
      const g = s.group ?? 'core-data';
      const list = groups.get(g) ?? [];
      list.push(s);
      groups.set(g, list);
    }

    return { grouped: groups, statusMap: map };
  }, [data]);

  if (loading && !data) {
    return (
      <div>
        <PageHeader
          title="Cluster Health"
          description="Real-time health status of all platform services"
        />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (error) {
    const retryButton = (
      <button
        type="button"
        onClick={handleRefresh}
        className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
      >
        <RefreshCw size={14} />
        Retry
      </button>
    );
    return (
      <div>
        <PageHeader
          title="Cluster Health"
          description="Real-time health status of all platform services"
        />
        <EmptyState
          title="Failed to load cluster health"
          description={error}
          action={retryButton}
        />
      </div>
    );
  }

  const summary = data?.summary ?? { healthy: 0, degraded: 0, down: 0, unknown: 0, total: 0 };
  const notConfigured = (summary.total ?? 0) - (summary.configured ?? summary.total ?? 0);

  return (
    <div>
      <PageHeader
        title="Cluster Health"
        description="Real-time health status of all platform services"
        actions={
          <>
            {lastRefresh && (
              <span className="text-xs text-foreground-muted">Last refresh: {lastRefresh}</span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </>
        }
      />

      {/* Summary Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        <MetricCard
          title="Healthy"
          value={summary.healthy}
          icon={<Heart size={20} />}
          description={`of ${summary.total ?? 0} services`}
        />
        <MetricCard title="Degraded" value={summary.degraded} icon={<AlertTriangle size={20} />} />
        <MetricCard title="Down" value={summary.down} icon={<XCircle size={20} />} />
        <MetricCard title="Not Configured" value={notConfigured} icon={<HelpCircle size={20} />} />
      </div>

      {/* Grouped Service Sections */}
      {GROUP_ORDER.map((group) => {
        const services = grouped.get(group);
        if (!services || services.length === 0) return null;
        return <GroupSection key={group} group={group} services={services} statusMap={statusMap} />;
      })}

      {(data?.services ?? []).length === 0 && !loading && (
        <EmptyState
          title="No services"
          description="No service health data is currently available."
        />
      )}
    </div>
  );
}
