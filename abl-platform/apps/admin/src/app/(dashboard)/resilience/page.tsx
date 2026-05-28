'use client';

import { useState, useCallback } from 'react';
import { Search, AlertTriangle, RefreshCw } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  SkeletonTable,
  EmptyState,
  ConfirmDialog,
  type Column,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CircuitBreaker {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure?: string;
  lastSuccess?: string;
}

interface CircuitBreakersResponse {
  success: boolean;
  data: {
    backend: 'redis' | 'memory';
    breakers: CircuitBreaker[];
  };
}

interface BreakerHealth {
  state: string;
  failures: number;
}

interface TenantHealthResponse {
  success: boolean;
  data: {
    tenantId: string;
    healthy: boolean;
    tenant?: BreakerHealth;
    apps?: Record<string, BreakerHealth>;
    llmProviders?: Record<string, BreakerHealth>;
    toolServices?: Record<string, BreakerHealth>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function breakerStateToVariant(state: string): StatusBadgeVariant {
  switch (state) {
    case 'closed':
      return 'healthy';
    case 'open':
      return 'down';
    case 'half-open':
      return 'degraded';
    default:
      return 'unknown';
  }
}

function breakerStateLabel(state: string): string {
  switch (state) {
    case 'closed':
      return 'Closed';
    case 'open':
      return 'Open';
    case 'half-open':
      return 'Half-Open';
    default:
      return state;
  }
}

// ─── Breaker Health Table ─────────────────────────────────────────────────────

interface BreakerSectionProps {
  title: string;
  breakers: Record<string, BreakerHealth>;
}

function BreakerSection({ title, breakers }: BreakerSectionProps) {
  const entries = Object.entries(breakers);
  if (entries.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-foreground mb-2">{title}</h4>
      <div className="overflow-hidden rounded-lg border border-border bg-background-subtle">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                Name
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                State
              </th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-foreground-muted">
                Failures
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, info]) => (
              <tr
                key={name}
                className="border-b border-border last:border-b-0 hover:bg-background-muted transition-colors duration-150"
              >
                <td className="px-4 py-2 text-sm font-mono text-foreground">{name}</td>
                <td className="px-4 py-2">
                  <StatusBadge
                    status={breakerStateToVariant(info.state)}
                    label={breakerStateLabel(info.state)}
                  />
                </td>
                <td className="px-4 py-2 text-sm text-right tabular-nums text-foreground-muted">
                  {info.failures}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResiliencePage() {
  // ── Circuit Breakers ──
  const {
    data: cbData,
    loading: cbLoading,
    error: cbError,
    refetch: refetchCb,
  } = useApi<CircuitBreakersResponse>('/api/resilience/circuit-breakers');

  const [resetTarget, setResetTarget] = useState<CircuitBreaker | null>(null);
  const [resetting, setResetting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleResetBreaker = useCallback(async () => {
    if (!resetTarget) return;
    setResetting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/resilience/circuit-breakers/${resetTarget.name}/reset`, {
        method: 'POST',
      });
      const result = await res.json();
      if (res.ok && result.success) {
        refetchCb();
      } else {
        setActionError(result.error || `Reset failed with status ${res.status}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setResetting(false);
      setResetTarget(null);
    }
  }, [resetTarget, refetchCb]);

  // ── Tenant Health ──
  const [tenantIdInput, setTenantIdInput] = useState('');
  const [tenantIdQuery, setTenantIdQuery] = useState<string | null>(null);

  const healthUrl = tenantIdQuery
    ? `/api/resilience/tenants/${encodeURIComponent(tenantIdQuery)}/health`
    : null;
  const {
    data: healthData,
    loading: healthLoading,
    error: healthError,
    refetch: refetchHealth,
  } = useApi<TenantHealthResponse>(healthUrl);

  const [forceResetOpen, setForceResetOpen] = useState(false);
  const [forceResetting, setForceResetting] = useState(false);

  const handleTenantSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = tenantIdInput.trim();
      if (trimmed) {
        setTenantIdQuery(trimmed);
      }
    },
    [tenantIdInput],
  );

  const handleForceReset = useCallback(async () => {
    if (!tenantIdQuery) return;
    setForceResetting(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/resilience/tenants/${encodeURIComponent(tenantIdQuery)}/force-reset`,
        { method: 'POST' },
      );
      const result = await res.json();
      if (res.ok && result.success) {
        refetchHealth();
      } else {
        setActionError(result.error || `Force reset failed with status ${res.status}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setForceResetting(false);
      setForceResetOpen(false);
    }
  }, [tenantIdQuery, refetchHealth]);

  // ── Circuit Breaker Columns ──
  const cbColumns: Column<CircuitBreaker>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => <span className="font-mono text-sm text-foreground">{row.name}</span>,
      sortable: true,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <StatusBadge
          status={breakerStateToVariant(row.state)}
          label={breakerStateLabel(row.state)}
        />
      ),
      width: '140px',
    },
    {
      key: 'failures',
      header: 'Failures',
      render: (row) => <span className="tabular-nums text-foreground-muted">{row.failures}</span>,
      sortable: true,
      sortFn: (a, b) => a.failures - b.failures,
      width: '100px',
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setResetTarget(row);
          }}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-foreground-muted border border-border hover:bg-background-muted hover:text-foreground transition-colors"
        >
          Reset
        </button>
      ),
      width: '90px',
    },
  ];

  // ── Backend badge ──
  const backendBadge = cbData?.data ? (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        cbData.data.backend === 'redis'
          ? 'bg-success/15 text-success border-success/25'
          : 'bg-warning/15 text-warning border-warning/25'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          cbData.data.backend === 'redis' ? 'bg-success' : 'bg-warning'
        }`}
      />
      {cbData.data.backend === 'redis' ? 'Redis' : 'Memory'}
    </span>
  ) : null;

  return (
    <div>
      <PageHeader
        title="Resilience Controls"
        description="Monitor circuit breaker states and manage tenant resilience."
      />

      {actionError && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="ml-4 text-xs font-medium hover:text-error-muted transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Section 1: Circuit Breakers Overview ── */}
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-foreground">Circuit Breakers</h2>
          {backendBadge}
          <button
            onClick={refetchCb}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {cbLoading && !cbData ? (
          <SkeletonTable rows={5} />
        ) : cbError ? (
          <EmptyState
            title="Failed to load circuit breakers"
            description={cbError}
            action={
              <button
                onClick={refetchCb}
                className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
              >
                Retry
              </button>
            }
          />
        ) : cbData?.data && cbData.data.breakers.length > 0 ? (
          <DataTable
            columns={cbColumns}
            data={cbData.data.breakers}
            rowKey={(row) => row.name}
            pageSize={25}
          />
        ) : (
          <EmptyState
            title="No circuit breakers"
            description="No circuit breakers are currently registered in the runtime."
          />
        )}
      </div>

      {/* ── Section 2: Tenant Health ── */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4">Tenant Health</h2>

        {/* Tenant ID search form */}
        <form onSubmit={handleTenantSearch} className="mb-6">
          <div className="flex items-center gap-2 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-subtle" />
              <input
                type="text"
                value={tenantIdInput}
                onChange={(e) => setTenantIdInput(e.target.value)}
                placeholder="Enter tenant ID..."
                className="h-9 w-full rounded-md border border-border bg-background-subtle pl-9 pr-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <button
              type="submit"
              disabled={!tenantIdInput.trim()}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              Check Health
            </button>
          </div>
        </form>

        {/* No tenant queried state */}
        {!tenantIdQuery && (
          <EmptyState
            icon={<Search className="h-10 w-10" />}
            title="No tenant selected"
            description="Enter a tenant ID above to check their circuit breaker health across all levels."
          />
        )}

        {/* Loading state */}
        {tenantIdQuery && healthLoading && <SkeletonTable rows={4} />}

        {/* Error state */}
        {tenantIdQuery && healthError && (
          <EmptyState
            title="Failed to load tenant health"
            description={healthError}
            action={
              <button
                onClick={refetchHealth}
                className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
              >
                Retry
              </button>
            }
          />
        )}

        {/* Tenant health display */}
        {tenantIdQuery && healthData?.data && !healthLoading && (
          <div>
            {/* Overall health summary */}
            <div className="mb-4 flex items-center gap-3">
              <StatusBadge
                status={healthData.data.healthy ? 'healthy' : 'down'}
                label={healthData.data.healthy ? 'Healthy' : 'Unhealthy'}
              />
              <span className="text-sm font-mono text-foreground-muted">
                {healthData.data.tenantId}
              </span>
              <button
                onClick={refetchHealth}
                className="ml-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            </div>

            {/* Tenant-level breaker */}
            {healthData.data.tenant && (
              <div className="mb-4 rounded-lg border border-border bg-background-subtle p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-foreground">Tenant Breaker</span>
                    <span className="ml-3 text-sm tabular-nums text-foreground-muted">
                      {healthData.data.tenant.failures} failure
                      {healthData.data.tenant.failures !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <StatusBadge
                    status={breakerStateToVariant(healthData.data.tenant.state)}
                    label={breakerStateLabel(healthData.data.tenant.state)}
                  />
                </div>
              </div>
            )}

            {/* Sub-breaker sections */}
            {healthData.data.apps && Object.keys(healthData.data.apps).length > 0 && (
              <BreakerSection title="App Breakers" breakers={healthData.data.apps} />
            )}

            {healthData.data.llmProviders &&
              Object.keys(healthData.data.llmProviders).length > 0 && (
                <BreakerSection
                  title="LLM Provider Breakers"
                  breakers={healthData.data.llmProviders}
                />
              )}

            {healthData.data.toolServices &&
              Object.keys(healthData.data.toolServices).length > 0 && (
                <BreakerSection
                  title="Tool Service Breakers"
                  breakers={healthData.data.toolServices}
                />
              )}

            {/* Force Reset All button */}
            <div className="mt-6">
              <button
                onClick={() => setForceResetOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-error/30 text-error hover:bg-error/10 transition-colors"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Force Reset All Breakers
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Reset Single Breaker Dialog ── */}
      <ConfirmDialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        title="Reset Circuit Breaker"
        description={
          resetTarget
            ? `Are you sure you want to reset the "${resetTarget.name}" circuit breaker? This will clear its failure count and close the breaker.`
            : ''
        }
        confirmLabel="Reset"
        variant="default"
        onConfirm={handleResetBreaker}
        loading={resetting}
        loadingLabel="Resetting..."
      />

      {/* ── Force Reset All Dialog ── */}
      <ConfirmDialog
        open={forceResetOpen}
        onOpenChange={setForceResetOpen}
        title="Force Reset All Breakers"
        description={`This will force-reset ALL circuit breakers for tenant "${tenantIdQuery ?? ''}". This is an emergency operation that should only be used when breakers are stuck in an open state. This action cannot be undone.`}
        confirmLabel="Force Reset All"
        variant="destructive"
        onConfirm={handleForceReset}
        loading={forceResetting}
        loadingLabel="Resetting..."
      />
    </div>
  );
}
