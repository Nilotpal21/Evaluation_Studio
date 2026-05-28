'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  FilterBar,
  DataTable,
  StatusBadge,
  SkeletonTable,
  EmptyState,
  relativeTime,
  type Column,
  type SelectFilter,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';
import type { TenantSummary, TenantsResponse } from '../../../types/api';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'archived', label: 'Archived' },
];

const PLAN_OPTIONS = [
  { value: '', label: 'All plans' },
  { value: 'free', label: 'Free' },
  { value: 'team', label: 'Team' },
  { value: 'business', label: 'Business' },
  { value: 'enterprise', label: 'Enterprise' },
];

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  team: 'bg-info/15 text-info border-info/25',
  business: 'bg-purple/15 text-purple border-purple/25',
  enterprise: 'bg-warning/15 text-warning border-warning/25',
};

const PAGE_SIZE = 25;

const inputClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const selectClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

type PlanTier = 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';

interface CreateTenantForm {
  name: string;
  slug: string;
  planTier: PlanTier;
}

const INITIAL_FORM: CreateTenantForm = {
  name: '',
  slug: '',
  planTier: 'FREE',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function CreateTenantDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [formData, setFormData] = useState<CreateTenantForm>(INITIAL_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNameChange = (value: string) => {
    setFormData((prev) => ({
      ...prev,
      name: value,
      slug: slugTouched ? prev.slug : slugify(value),
    }));
  };

  const handleSlugChange = (value: string) => {
    setSlugTouched(true);
    setFormData((prev) => ({ ...prev, slug: value }));
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.slug.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        setFormData(INITIAL_FORM);
        setSlugTouched(false);
        onCreated();
        onClose();
      } else {
        setError(data.error || `Request failed with status ${res.status}`);
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setFormData(INITIAL_FORM);
      setSlugTouched(false);
      setError(null);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-4">Create Tenant</h2>
        <div className="space-y-3">
          <div>
            <label htmlFor="tenant-name" className={labelClass}>
              Name
            </label>
            <input
              id="tenant-name"
              type="text"
              value={formData.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Enter tenant name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="tenant-slug" className={labelClass}>
              Slug
            </label>
            <input
              id="tenant-slug"
              type="text"
              value={formData.slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="auto-generated-from-name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="tenant-plan" className={labelClass}>
              Plan Tier
            </label>
            <select
              id="tenant-plan"
              value={formData.planTier}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, planTier: e.target.value as PlanTier }))
              }
              className={selectClass}
            >
              <option value="FREE">Free</option>
              <option value="TEAM">Team</option>
              <option value="BUSINESS">Business</option>
              <option value="ENTERPRISE">Enterprise</option>
            </select>
          </div>
        </div>

        {error && <p className="text-sm text-error mt-3">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !formData.name.trim() || !formData.slug.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Tenant'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toStatusVariant(status: string): StatusBadgeVariant {
  const lower = status.toLowerCase();
  if (lower === 'active') return 'active';
  if (lower === 'suspended') return 'suspended';
  if (lower === 'archived') return 'archived';
  return 'unknown';
}

export default function TenantsPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(PAGE_SIZE));
    if (statusFilter) params.set('status', statusFilter);
    if (planFilter) params.set('planTier', planFilter);
    if (debouncedSearch) params.set('search', debouncedSearch);
    return `/api/tenants?${params.toString()}`;
  }, [page, statusFilter, planFilter, debouncedSearch]);

  const { data, loading, error, refetch } = useApi<TenantsResponse>(url);

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handlePlanChange = (value: string) => {
    setPlanFilter(value);
    setPage(1);
  };

  const filters: SelectFilter[] = [
    {
      id: 'status',
      label: 'Status',
      value: statusFilter,
      options: STATUS_OPTIONS,
      onChange: handleStatusChange,
    },
    {
      id: 'plan',
      label: 'Plan tier',
      value: planFilter,
      options: PLAN_OPTIONS,
      onChange: handlePlanChange,
    },
  ];

  const columns: Column<TenantSummary>[] = [
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
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={toStatusVariant(row.status)} />,
      width: '140px',
    },
    {
      key: 'planTier',
      header: 'Plan Tier',
      render: (row) => {
        const tier = row.planTier ?? 'free';
        const badgeColor = PLAN_BADGE_COLORS[tier.toLowerCase()] ?? PLAN_BADGE_COLORS.free;
        return (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badgeColor}`}
          >
            {tier.charAt(0).toUpperCase() + tier.slice(1)}
          </span>
        );
      },
      width: '130px',
    },
    {
      key: 'members',
      header: 'Members',
      render: (row) => <span className="text-foreground-muted">{row.memberCount}</span>,
      sortable: true,
      sortFn: (a, b) => a.memberCount - b.memberCount,
      width: '100px',
    },
    {
      key: 'created',
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

  const totalPages = data?.pagination?.totalPages ?? 1;

  return (
    <div>
      <PageHeader
        title="Tenant Management"
        description="View and manage platform tenants, subscriptions, and status."
        actions={
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors"
          >
            <Plus size={16} />
            Create Tenant
          </button>
        }
      />

      <FilterBar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search tenants...',
        }}
        filters={filters}
        className="mb-6"
      />

      {loading && !data ? (
        <SkeletonTable rows={8} />
      ) : error && !data ? (
        <EmptyState
          title="Failed to load tenants"
          description={error}
          action={
            <button
              onClick={refetch}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
            >
              Retry
            </button>
          }
        />
      ) : data && data.tenants.length > 0 ? (
        <div className={loading ? 'opacity-60 pointer-events-none transition-opacity' : ''}>
          <DataTable
            columns={columns}
            data={data.tenants}
            rowKey={(row) => row._id}
            onRowClick={(row) => router.push(`/tenants/${row._id}`)}
            pageSize={data.tenants.length || PAGE_SIZE}
          />

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-foreground-muted">
                Page {data.pagination.page} of {totalPages} ({data.pagination.total} tenants)
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  aria-label="Previous page"
                  aria-disabled={page <= 1}
                  className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  aria-label="Next page"
                  aria-disabled={page >= totalPages}
                  className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          title="No tenants found"
          description="No tenants match the current filters. Try adjusting your search or filter criteria."
        />
      )}

      <CreateTenantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
    </div>
  );
}
