'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  SkeletonTable,
  EmptyState,
  ConfirmDialog,
  Tabs,
  relativeTime,
  formatNumber,
  type Column,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';
import { resolveTenantDetailTab } from '../../../../lib/tenant-detail-tabs';

// Lazy-load UsageTab (contains recharts ~80KB gzipped)
const UsageTab = dynamic(() => import('./UsageTab').then((m) => ({ default: m.UsageTab })), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" />,
});

// Lazy-load AttachmentConfigTab
const AttachmentConfigTab = dynamic(
  () => import('./AttachmentConfigTab').then((m) => ({ default: m.AttachmentConfigTab })),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" />,
  },
);
import type {
  TenantDetailResponse,
  TenantMember,
  TenantMembersResponse,
  TenantProject,
  TenantProjectsResponse,
  TenantConfigResponse,
  TenantFeaturesResponse,
  Deal,
  DealsResponse,
} from '../../../../types/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toStatusVariant(status: string): StatusBadgeVariant {
  const lower = status.toLowerCase();
  if (lower === 'active') return 'active';
  if (lower === 'suspended') return 'suspended';
  if (lower === 'archived') return 'archived';
  return 'unknown';
}

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  team: 'bg-info/15 text-info border-info/25',
  business: 'bg-purple/15 text-purple border-purple/25',
  enterprise: 'bg-warning/15 text-warning border-warning/25',
};

function getResponseErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return fallback;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string' && error) {
    return error;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      return message;
    }
  }

  return fallback;
}

// ─── Feature Toggle ─────────────────────────────────────────────────────────

function FeatureToggle({
  label,
  description,
  enabled,
  disabled = false,
  externalError = null,
  confirmDescription,
  onSubmit,
  onToggled,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  externalError?: string | null;
  confirmDescription: (nextEnabled: boolean) => string;
  onSubmit: (nextEnabled: boolean) => Promise<Response>;
  onToggled: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    if (disabled) {
      setShowConfirm(false);
      return;
    }

    const nextEnabled = !enabled;
    setUpdating(true);
    setError(null);
    try {
      const res = await onSubmit(nextEnabled);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (res.ok) {
        onToggled();
      } else {
        const body: unknown = await res.json().catch(() => null);
        setError(getResponseErrorMessage(body, `Failed to update (HTTP ${res.status})`));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-foreground-muted">{description}</div>
          {(error || externalError) && (
            <div className="text-xs text-error mt-1">{error ?? externalError}</div>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`}
          onClick={() => setShowConfirm(true)}
          disabled={updating || disabled}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-success' : 'bg-foreground-muted/30'
          } ${updating || disabled ? 'opacity-50' : ''}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <ConfirmDialog
        open={showConfirm}
        onOpenChange={(open) => {
          if (!open) setShowConfirm(false);
        }}
        title={`${enabled ? 'Disable' : 'Enable'} ${label}`}
        description={confirmDescription(!enabled)}
        confirmLabel={enabled ? 'Disable' : 'Enable'}
        variant={enabled ? 'destructive' : 'default'}
        onConfirm={handleToggle}
        loading={updating}
        loadingLabel="Updating..."
      />
    </>
  );
}

// ─── Overview Tab ───────────────────────────────────────────────────────────

const PLAN_TIERS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;

function OverviewTab({ tenantId }: { tenantId: string }) {
  const { data, loading, error, refetch } = useApi<TenantDetailResponse>(
    `/api/tenants/${tenantId}`,
  );
  const tenantFeatures = useApi<TenantFeaturesResponse>(`/api/features/${tenantId}`);
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [planUpdating, setPlanUpdating] = useState(false);
  const [pendingPlanTier, setPendingPlanTier] = useState<string | null>(null);
  const [planSuccess, setPlanSuccess] = useState<string | null>(null);

  const handlePlanChange = async () => {
    if (!pendingPlanTier) return;
    setPlanUpdating(true);
    setStatusError(null);
    setPlanSuccess(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/subscription`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planTier: pendingPlanTier }),
      });
      if (res.ok) {
        setPlanSuccess(
          `Plan updated to ${pendingPlanTier.charAt(0) + pendingPlanTier.slice(1).toLowerCase()}`,
        );
        refetch();
      } else {
        const body = await res.json().catch(() => null);
        const message =
          body?.error?.message || body?.error || `Failed to update plan (HTTP ${res.status})`;
        setStatusError(typeof message === 'string' ? message : 'Failed to update plan');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message || 'Failed to update plan');
    } finally {
      setPlanUpdating(false);
      setPendingPlanTier(null);
    }
  };

  const handleStatusChange = async () => {
    if (!statusAction) return;
    setUpdating(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: statusAction }),
      });
      if (res.ok) {
        refetch();
      } else {
        const body = await res.json().catch(() => null);
        const message =
          body?.error?.message || body?.error || `Failed to update status (HTTP ${res.status})`;
        setStatusError(typeof message === 'string' ? message : 'Failed to update tenant status');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message || 'Failed to update tenant status');
    } finally {
      setUpdating(false);
      setStatusAction(null);
    }
  };

  if (loading && !data) {
    return <SkeletonTable rows={4} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load tenant"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data) return null;

  const { tenant, subscription, memberCount } = data;
  const status = tenant?.status ?? 'unknown';
  const planTier = subscription?.planTier ?? tenant?.planTier ?? 'free';

  return (
    <div className="space-y-6">
      {/* Tenant Info Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Tenant Info</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Name</dt>
              <dd className="text-sm font-medium text-foreground">{tenant?.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Slug</dt>
              <dd className="text-sm font-mono text-foreground">{tenant?.slug}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-sm text-foreground-muted">Status</dt>
              <dd>
                <StatusBadge status={toStatusVariant(status)} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Created</dt>
              <dd
                className="text-sm text-foreground"
                title={tenant?.createdAt ? new Date(tenant.createdAt).toLocaleString() : ''}
              >
                {tenant?.createdAt ? relativeTime(tenant.createdAt) : '--'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Subscription</h3>
          <dl className="space-y-3">
            <div className="flex justify-between items-center">
              <dt className="text-sm text-foreground-muted">Plan Tier</dt>
              <dd>
                <select
                  value={planTier.toUpperCase()}
                  onChange={(e) => {
                    if (e.target.value !== planTier.toUpperCase()) {
                      setPendingPlanTier(e.target.value);
                    }
                  }}
                  disabled={planUpdating}
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium cursor-pointer bg-transparent ${PLAN_BADGE_COLORS[planTier.toLowerCase()] ?? PLAN_BADGE_COLORS.free} ${planUpdating ? 'opacity-50' : ''}`}
                >
                  {PLAN_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {tier.charAt(0) + tier.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Billing Cycle</dt>
              <dd className="text-sm text-foreground">{subscription?.billingCycle ?? '--'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Members</dt>
              <dd className="text-sm text-foreground">{memberCount}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Success Banner */}
      {planSuccess && (
        <div className="rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-success flex items-center justify-between">
          <span>{planSuccess}</span>
          <button
            onClick={() => setPlanSuccess(null)}
            className="ml-4 text-success hover:text-success-muted transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Error Banner */}
      {statusError && (
        <div className="rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error flex items-center justify-between">
          <span>{statusError}</span>
          <button
            onClick={() => setStatusError(null)}
            className="ml-4 text-error hover:text-error-muted transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Action Buttons */}
      <div className="flex gap-3">
        {status !== 'suspended' && (
          <button
            onClick={() => setStatusAction('suspended')}
            className="rounded-md border border-warning/25 px-4 py-2 text-sm font-medium text-warning hover:bg-warning/10 transition-colors"
          >
            Suspend
          </button>
        )}
        {status !== 'active' && (
          <button
            onClick={() => setStatusAction('active')}
            className="rounded-md border border-success/25 px-4 py-2 text-sm font-medium text-success hover:bg-success/10 transition-colors"
          >
            Activate
          </button>
        )}
        {status !== 'archived' && (
          <button
            onClick={() => setStatusAction('archived')}
            className="rounded-md border border-error/25 px-4 py-2 text-sm font-medium text-error hover:bg-error/10 transition-colors"
          >
            Archive
          </button>
        )}
      </div>

      <ConfirmDialog
        open={statusAction !== null}
        onOpenChange={(open) => {
          if (!open) setStatusAction(null);
        }}
        title={`${statusAction === 'active' ? 'Activate' : statusAction === 'suspended' ? 'Suspend' : 'Archive'} Tenant`}
        description={`Are you sure you want to set this tenant's status to "${statusAction}"? This will affect all users and services under this tenant.`}
        confirmLabel={
          statusAction === 'active'
            ? 'Activate'
            : statusAction === 'suspended'
              ? 'Suspend'
              : 'Archive'
        }
        variant={statusAction === 'active' ? 'default' : 'destructive'}
        onConfirm={handleStatusChange}
        loading={updating}
        loadingLabel="Updating..."
      />

      <ConfirmDialog
        open={pendingPlanTier !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPlanTier(null);
        }}
        title="Change Plan Tier"
        description={`Change this tenant's plan from ${planTier.charAt(0).toUpperCase() + planTier.slice(1).toLowerCase()} to ${pendingPlanTier ? pendingPlanTier.charAt(0) + pendingPlanTier.slice(1).toLowerCase() : ''}? This will immediately affect the tenant's available features.`}
        confirmLabel="Change Plan"
        variant={
          pendingPlanTier &&
          PLAN_TIERS.indexOf(pendingPlanTier as (typeof PLAN_TIERS)[number]) <
            PLAN_TIERS.indexOf(planTier.toUpperCase() as (typeof PLAN_TIERS)[number])
            ? 'destructive'
            : 'default'
        }
        onConfirm={handlePlanChange}
        loading={planUpdating}
        loadingLabel="Updating plan..."
      />

      {/* Feature Toggles */}
      <div className="rounded-lg border border-border bg-background-subtle p-5">
        <h3 className="text-sm font-medium text-foreground-muted mb-4">Feature Toggles</h3>
        <div className="space-y-3">
          <FeatureToggle
            label="Code Tools"
            description="Enable JavaScript/Python sandbox code execution"
            enabled={tenant?.settings?.codeToolsEnabled === true}
            confirmDescription={(nextEnabled) =>
              nextEnabled
                ? 'Enable Code Tools for this tenant? This will allow code tool creation and execution.'
                : 'Disable Code Tools for this tenant? Existing code tools will stop executing.'
            }
            onSubmit={(nextEnabled) =>
              fetch(`/api/tenants/${tenantId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codeToolsEnabled: nextEnabled }),
              })
            }
            onToggled={refetch}
          />
          <FeatureToggle
            label="Governance"
            description="Enable the Studio Governance tab for this workspace"
            enabled={tenantFeatures.data?.features?.governance === true}
            disabled={tenantFeatures.loading || tenantFeatures.error !== null}
            externalError={tenantFeatures.error}
            confirmDescription={(nextEnabled) =>
              nextEnabled
                ? 'Enable Governance for this workspace? This will make the Governance tab available in Studio.'
                : 'Disable Governance for this workspace? This will hide the Governance tab in Studio.'
            }
            onSubmit={(nextEnabled) =>
              fetch(`/api/features/${tenantId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ featureId: 'governance', enabled: nextEnabled }),
              })
            }
            onToggled={tenantFeatures.refetch}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Members Tab ────────────────────────────────────────────────────────────

function MembersTab({ tenantId }: { tenantId: string }) {
  const { data, loading, error, refetch } = useApi<TenantMembersResponse>(
    `/api/tenants/${tenantId}/members`,
  );

  const columns: Column<TenantMember>[] = [
    {
      key: 'email',
      header: 'Email',
      render: (row) => <span className="font-medium text-foreground">{row.email}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      render: (row) => <span className="text-foreground-muted">{row.name || '--'}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-foreground">
          {row.role}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'joinedAt',
      header: 'Joined',
      render: (row) => (
        <span className="text-foreground-muted" title={new Date(row.joinedAt).toLocaleString()}>
          {relativeTime(row.joinedAt)}
        </span>
      ),
      width: '140px',
    },
  ];

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load members"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data || data.members.length === 0) {
    return <EmptyState title="No members" description="This tenant has no members yet." />;
  }

  return (
    <DataTable columns={columns} data={data.members} rowKey={(row) => row.userId} pageSize={25} />
  );
}

// ─── Projects Tab ───────────────────────────────────────────────────────────

function ProjectsTab({ tenantId }: { tenantId: string }) {
  const { data, loading, error, refetch } = useApi<TenantProjectsResponse>(
    `/api/tenants/${tenantId}/projects`,
  );

  const columns: Column<TenantProject>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <div>
          <div className="font-medium text-foreground">{row.name}</div>
          <div className="text-xs text-foreground-muted">{row.slug}</div>
        </div>
      ),
      sortable: true,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'agentCount',
      header: 'Agents',
      render: (row) => <span className="text-foreground-muted">{row.agentCount}</span>,
      sortable: true,
      sortFn: (a, b) => a.agentCount - b.agentCount,
      width: '100px',
    },
    {
      key: 'createdAt',
      header: 'Created',
      render: (row) => (
        <span className="text-foreground-muted" title={new Date(row.createdAt).toLocaleString()}>
          {relativeTime(row.createdAt)}
        </span>
      ),
      sortable: true,
      sortFn: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      width: '140px',
    },
  ];

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load projects"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data || data.projects.length === 0) {
    return <EmptyState title="No projects" description="This tenant has no projects yet." />;
  }

  return (
    <DataTable columns={columns} data={data.projects} rowKey={(row) => row._id} pageSize={25} />
  );
}

// ─── Config Overrides Tab ───────────────────────────────────────────────────

interface OverrideEntry {
  key: string;
  value: number;
}

function ConfigOverridesTab({ tenantId }: { tenantId: string }) {
  const { data, loading, error, refetch } = useApi<TenantConfigResponse>(
    `/api/tenant-config/${tenantId}`,
  );

  const overrideEntries: OverrideEntry[] = data?.overrides
    ? Object.entries(data.overrides).map(([key, value]) => ({ key, value }))
    : [];

  const columns: Column<OverrideEntry>[] = [
    {
      key: 'key',
      header: 'Override Key',
      render: (row) => <span className="font-mono text-sm text-foreground">{row.key}</span>,
    },
    {
      key: 'value',
      header: 'Value',
      render: (row) => <span className="font-mono text-sm text-foreground-muted">{row.value}</span>,
      width: '200px',
    },
  ];

  if (loading && !data) {
    return <SkeletonTable rows={4} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load config"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (overrideEntries.length === 0) {
    return (
      <EmptyState
        title="No overrides"
        description="This tenant has no config overrides. All settings use plan defaults."
      />
    );
  }

  return (
    <DataTable columns={columns} data={overrideEntries} rowKey={(row) => row.key} pageSize={25} />
  );
}

// ─── Deals Tab ──────────────────────────────────────────────────────────────

function toDealStatusVariant(status: string): StatusBadgeVariant {
  const lower = status.toLowerCase();
  if (lower === 'active') return 'active';
  if (lower === 'paused' || lower === 'expired') return 'suspended';
  if (lower === 'canceled') return 'archived';
  return 'unknown';
}

function DealsTab({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const tenantDetail = useApi<TenantDetailResponse>(`/api/tenants/${tenantId}`);
  const organizationId = tenantDetail.data?.tenant?.organizationId;
  const { data, loading, error, refetch } = useApi<DealsResponse>(
    organizationId ? `/api/deals?organizationId=${organizationId}` : null,
  );

  const columns: Column<Deal>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => <span className="font-medium text-foreground">{row.name}</span>,
      sortable: true,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={toDealStatusVariant(row.status)} />,
      width: '120px',
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => (
        <span className="text-sm text-foreground-muted">
          {row.scope.charAt(0).toUpperCase() + row.scope.slice(1)}
        </span>
      ),
      width: '120px',
    },
    {
      key: 'credits',
      header: 'Credit Usage',
      render: (row) => {
        const total = row.creditAllotment?.totalCredits ?? 0;
        return (
          <span className="text-sm text-foreground-muted">
            {total > 0 ? `${formatNumber(total)} allocated` : '--'}
          </span>
        );
      },
      width: '140px',
    },
    {
      key: 'renewalDate',
      header: 'Renewal',
      render: (row) => (
        <span className="text-sm text-foreground-muted">
          {row.renewalDate ? new Date(row.renewalDate).toLocaleDateString() : '--'}
        </span>
      ),
      width: '120px',
    },
  ];

  if ((loading || tenantDetail.loading) && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (!organizationId) {
    return (
      <EmptyState
        title="No organization"
        description="This tenant does not have an organization ID. Deals are linked to organizations."
      />
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load deals"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data || data.deals.length === 0) {
    return (
      <EmptyState title="No deals" description="No deals found for this tenant's organization." />
    );
  }

  return (
    <DataTable
      columns={columns}
      data={data.deals}
      rowKey={(row) => row._id}
      onRowClick={(row) => router.push(`/deals/${row._id}`)}
      pageSize={25}
    />
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function TenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = params.id as string;
  const defaultTab = resolveTenantDetailTab(searchParams.get('tab'));

  const tabs = [
    {
      id: 'overview',
      label: 'Overview',
      content: <OverviewTab tenantId={tenantId} />,
    },
    {
      id: 'members',
      label: 'Members',
      content: <MembersTab tenantId={tenantId} />,
    },
    {
      id: 'projects',
      label: 'Projects',
      content: <ProjectsTab tenantId={tenantId} />,
    },
    {
      id: 'config',
      label: 'Config Overrides',
      content: <ConfigOverridesTab tenantId={tenantId} />,
    },
    {
      id: 'deals',
      label: 'Deals',
      content: <DealsTab tenantId={tenantId} />,
    },
    {
      id: 'usage',
      label: 'Usage',
      content: <UsageTab tenantId={tenantId} />,
    },
    {
      id: 'attachments',
      label: 'Attachments',
      content: <AttachmentConfigTab tenantId={tenantId} />,
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <button
          onClick={() => router.push('/tenants')}
          className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft size={16} />
          Back to Tenants
        </button>
        <PageHeader title="Tenant Detail" description={`Manage tenant ${tenantId}`} />
      </div>

      <Tabs key={defaultTab} tabs={tabs} defaultValue={defaultTab} />
    </div>
  );
}
