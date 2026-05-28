'use client';

import { useState, useMemo } from 'react';
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
import type { Deal, DealsResponse } from '../../../types/api';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'expired', label: 'Expired' },
  { value: 'canceled', label: 'Canceled' },
];

const SCOPE_OPTIONS = [
  { value: '', label: 'All scopes' },
  { value: 'organization', label: 'Organization' },
  { value: 'project', label: 'Project' },
];

const inputClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const selectClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

interface CreateDealForm {
  name: string;
  organizationId: string;
  scope: Deal['scope'];
  status: Deal['status'];
  aggregationMode: Deal['aggregationMode'];
  overagePolicy: Deal['overagePolicy'];
}

const INITIAL_FORM: CreateDealForm = {
  name: '',
  organizationId: '',
  scope: 'organization',
  status: 'active',
  aggregationMode: 'additive',
  overagePolicy: 'hard_stop',
};

function CreateDealDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [formData, setFormData] = useState<CreateDealForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.organizationId.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        setFormData(INITIAL_FORM);
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
      setError(null);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-4">Create Deal</h2>
        <div className="space-y-3">
          <div>
            <label htmlFor="deal-name" className={labelClass}>
              Name
            </label>
            <input
              id="deal-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Enter deal name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="deal-org-id" className={labelClass}>
              Organization ID
            </label>
            <input
              id="deal-org-id"
              type="text"
              value={formData.organizationId}
              onChange={(e) => setFormData((prev) => ({ ...prev, organizationId: e.target.value }))}
              placeholder="Enter organization ID"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="deal-scope" className={labelClass}>
                Scope
              </label>
              <select
                id="deal-scope"
                value={formData.scope}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, scope: e.target.value as Deal['scope'] }))
                }
                className={selectClass}
              >
                <option value="organization">Organization</option>
                <option value="project">Project</option>
              </select>
            </div>
            <div>
              <label htmlFor="deal-status" className={labelClass}>
                Status
              </label>
              <select
                id="deal-status"
                value={formData.status}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    status: e.target.value as Deal['status'],
                  }))
                }
                className={selectClass}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="deal-aggregation" className={labelClass}>
                Aggregation Mode
              </label>
              <select
                id="deal-aggregation"
                value={formData.aggregationMode}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    aggregationMode: e.target.value as Deal['aggregationMode'],
                  }))
                }
                className={selectClass}
              >
                <option value="additive">Additive</option>
                <option value="max_wins">Max Wins</option>
                <option value="dedicated">Dedicated</option>
              </select>
            </div>
            <div>
              <label htmlFor="deal-overage" className={labelClass}>
                Overage Policy
              </label>
              <select
                id="deal-overage"
                value={formData.overagePolicy}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    overagePolicy: e.target.value as Deal['overagePolicy'],
                  }))
                }
                className={selectClass}
              >
                <option value="hard_stop">Hard Stop</option>
                <option value="soft_cap">Soft Cap</option>
                <option value="auto_upgrade">Auto Upgrade</option>
              </select>
            </div>
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
            disabled={submitting || !formData.name.trim() || !formData.organizationId.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Deal'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toStatusVariant(status: string): StatusBadgeVariant {
  if (status === 'active') return 'active';
  if (status === 'paused' || status === 'expired') return 'degraded';
  if (status === 'canceled') return 'archived';
  return 'unknown';
}

export default function DealsPage() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '25');
    if (statusFilter) params.set('status', statusFilter);
    if (scopeFilter) params.set('scope', scopeFilter);
    return `/api/deals?${params.toString()}`;
  }, [page, statusFilter, scopeFilter]);

  const { data, loading, error, refetch } = useApi<DealsResponse>(url);

  const filters: SelectFilter[] = [
    {
      id: 'status',
      label: 'Status',
      value: statusFilter,
      options: STATUS_OPTIONS,
      onChange: (v) => {
        setStatusFilter(v);
        setPage(1);
      },
    },
    {
      id: 'scope',
      label: 'Scope',
      value: scopeFilter,
      options: SCOPE_OPTIONS,
      onChange: (v) => {
        setScopeFilter(v);
        setPage(1);
      },
    },
  ];

  const columns: Column<Deal>[] = [
    {
      key: 'name',
      header: 'Deal Name',
      render: (row) => <span className="font-medium text-foreground">{row.name}</span>,
      sortable: true,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={toStatusVariant(row.status)} label={row.status} />,
      width: '130px',
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => <span className="text-foreground-muted capitalize">{row.scope}</span>,
      width: '130px',
    },
    {
      key: 'credits',
      header: 'Credits',
      render: (row) => {
        const allot = row.creditAllotment;
        return (
          <span className="text-foreground-muted">
            {allot?.totalCredits?.toLocaleString() ?? '—'}
          </span>
        );
      },
      width: '120px',
    },
    {
      key: 'renewalDate',
      header: 'Renewal',
      render: (row) => (
        <span className="text-foreground-muted">
          {row.renewalDate ? relativeTime(row.renewalDate) : '—'}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'created',
      header: 'Created',
      render: (row) => <span className="text-foreground-muted">{relativeTime(row.createdAt)}</span>,
      sortable: true,
      sortFn: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      width: '140px',
    },
  ];

  const totalPages = data?.pagination?.totalPages ?? 1;

  return (
    <div>
      <PageHeader
        title="Deal Management"
        description="View and manage deals, credits, and billing across organizations."
        actions={
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors"
          >
            <Plus size={16} />
            Create Deal
          </button>
        }
      />

      <FilterBar filters={filters} className="mb-6" />

      {loading && !data ? (
        <SkeletonTable rows={8} />
      ) : error && !data ? (
        <EmptyState
          title="Failed to load deals"
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
      ) : data && data.deals.length > 0 ? (
        <div className={loading ? 'opacity-60 pointer-events-none transition-opacity' : ''}>
          <DataTable
            columns={columns}
            data={data.deals}
            rowKey={(row) => row._id}
            onRowClick={(row) => router.push(`/deals/${row._id}`)}
            pageSize={data.deals.length || 25}
          />

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-foreground-muted">
                Page {data.pagination.page} of {totalPages} ({data.pagination.total} deals)
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  aria-label="Previous page"
                  aria-disabled={page <= 1}
                  className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  aria-label="Next page"
                  aria-disabled={page >= totalPages}
                  className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          title="No deals found"
          description="No deals match the current filters. Create a deal to get started."
        />
      )}

      <CreateDealDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
    </div>
  );
}
