'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ExternalLink, RefreshCw, Link2, Pencil, Trash2, Plus } from 'lucide-react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { Breadcrumb } from '../../../../components/ui/breadcrumb';
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
import type {
  Deal,
  DealDetailResponse,
  CreditEntry,
  CreditLedger,
  CreditLedgerResponse,
  BillingLineItem,
  BillingLineItemsResponse,
} from '../../../../types/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toDealStatusVariant(status: string): StatusBadgeVariant {
  const lower = status.toLowerCase();
  if (lower === 'active') return 'active';
  if (lower === 'paused' || lower === 'expired') return 'suspended';
  if (lower === 'canceled') return 'archived';
  return 'unknown';
}

const SOURCE_BADGE_COLORS: Record<string, string> = {
  usage: 'bg-info/15 text-info border-info/25',
  topup: 'bg-success/15 text-success border-success/25',
  adjustment: 'bg-warning/15 text-warning border-warning/25',
  rollover: 'bg-purple/15 text-purple border-purple/25',
};

const CATEGORY_BADGE_COLORS: Record<string, string> = {
  base: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  overage: 'bg-error/15 text-error border-error/25',
  addon: 'bg-info/15 text-info border-info/25',
  credit_topup: 'bg-success/15 text-success border-success/25',
};

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}

function isCurrentPhase(phase: { startDate: string; endDate: string }): boolean {
  const now = new Date();
  return new Date(phase.startDate) <= now && now <= new Date(phase.endDate);
}

const inputClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const selectClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

// ─── Overview Tab ───────────────────────────────────────────────────────────

function OverviewTab({ deal, onRefresh }: { deal: Deal; onRefresh: () => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [hubspotInput, setHubspotInput] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const [linkError, setLinkError] = useState<string | null>(null);

  // Auto-dismiss sync status after 4 seconds
  useEffect(() => {
    if (!syncStatus) return;
    const timer = setTimeout(() => setSyncStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [syncStatus]);

  const handleLinkHubSpot = async () => {
    if (!hubspotInput.trim()) return;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await fetch(`/api/deals/${deal._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotDealId: hubspotInput.trim() }),
      });
      if (res.ok) {
        setLinkOpen(false);
        setHubspotInput('');
        onRefresh();
      } else {
        const body = await res.json().catch(() => null);
        setLinkError(body?.error || `Failed to link deal (HTTP ${res.status})`);
      }
    } catch {
      setLinkError('Failed to connect to server');
    } finally {
      setLinking(false);
    }
  };

  const handleSyncFromHubSpot = async () => {
    if (!deal.hubspotDealId) return;
    setSyncing(true);
    setSyncStatus(null);
    try {
      const res = await fetch('/api/hubspot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotDealId: deal.hubspotDealId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSyncStatus('Synced successfully');
        onRefresh();
      } else {
        setSyncStatus(data.error || 'Sync failed');
      }
    } catch {
      setSyncStatus('Failed to connect');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Deal Info Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Deal Info</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Name</dt>
              <dd className="text-sm font-medium text-foreground">{deal.name}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-sm text-foreground-muted">Status</dt>
              <dd>
                <StatusBadge status={toDealStatusVariant(deal.status)} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Scope</dt>
              <dd className="text-sm text-foreground">{capitalize(deal.scope)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Aggregation Mode</dt>
              <dd className="text-sm text-foreground">{capitalize(deal.aggregationMode)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Overage Policy</dt>
              <dd className="text-sm text-foreground">{capitalize(deal.overagePolicy)}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Organization & Dates</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Organization ID</dt>
              <dd className="text-sm font-mono text-foreground">{deal.organizationId}</dd>
            </div>
            {deal.hubspotDealId && (
              <div className="flex justify-between">
                <dt className="text-sm text-foreground-muted">HubSpot Deal</dt>
                <dd className="text-sm font-mono text-foreground">{deal.hubspotDealId}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Renewal Date</dt>
              <dd className="text-sm text-foreground">
                {deal.renewalDate ? new Date(deal.renewalDate).toLocaleDateString() : '--'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Contract End</dt>
              <dd className="text-sm text-foreground">
                {deal.contractEndDate ? new Date(deal.contractEndDate).toLocaleDateString() : '--'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Created</dt>
              <dd
                className="text-sm text-foreground"
                title={new Date(deal.createdAt).toLocaleString()}
              >
                {relativeTime(deal.createdAt)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* HubSpot Integration */}
      <div className="rounded-lg border border-border bg-background-subtle p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-foreground-muted">HubSpot Integration</h3>
          {deal.hubspotDealId && <StatusBadge status="active" label="Linked" />}
        </div>
        <div className="flex flex-wrap gap-2">
          {!deal.hubspotDealId ? (
            <button
              onClick={() => setLinkOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-muted transition-colors"
            >
              <Link2 size={14} />
              Link HubSpot Deal
            </button>
          ) : (
            <>
              <button
                onClick={handleSyncFromHubSpot}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-muted transition-colors disabled:opacity-50"
              >
                <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Syncing...' : 'Refresh from HubSpot'}
              </button>
              <a
                href={`https://app.hubspot.com/contacts/deals/${deal.hubspotDealId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-accent hover:bg-background-muted transition-colors"
              >
                <ExternalLink size={14} />
                View in HubSpot
              </a>
              <button
                onClick={() => setLinkOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground-muted hover:bg-background-muted transition-colors"
              >
                <Link2 size={14} />
                Change Link
              </button>
            </>
          )}
        </div>
        {syncStatus && (
          <p
            className={`text-xs mt-2 ${syncStatus.includes('success') ? 'text-success' : 'text-error'}`}
          >
            {syncStatus}
          </p>
        )}
      </div>

      {/* Link HubSpot Dialog */}
      {linkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-overlay" onClick={() => setLinkOpen(false)} />
          <div className="relative z-50 w-full max-w-md rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground mb-4">Link HubSpot Deal</h2>
            <div>
              <label className={labelClass}>HubSpot Deal ID</label>
              <input
                type="text"
                value={hubspotInput}
                onChange={(e) => setHubspotInput(e.target.value)}
                placeholder="Enter HubSpot deal ID"
                className={inputClass}
              />
            </div>
            {linkError && <p className="mt-3 text-xs text-error">{linkError}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setLinkOpen(false);
                  setLinkError(null);
                }}
                disabled={linking}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleLinkHubSpot}
                disabled={linking || !hubspotInput.trim()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {linking ? 'Linking...' : 'Link Deal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phases Timeline */}
      {deal.phases.length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Phases</h3>
          <div className="space-y-3">
            {deal.phases.map((phase, idx) => {
              const current = isCurrentPhase(phase);
              return (
                <div
                  key={idx}
                  className={`flex items-center justify-between rounded-md border px-4 py-3 ${
                    current ? 'border-accent bg-accent/5' : 'border-border'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {current && <span className="flex h-2 w-2 rounded-full bg-accent" />}
                    <span className="text-sm font-medium text-foreground">{phase.name}</span>
                  </div>
                  <span className="text-xs text-foreground-muted">
                    {new Date(phase.startDate).toLocaleDateString()} &mdash;{' '}
                    {new Date(phase.endDate).toLocaleDateString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Features */}
      {deal.features.length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Features</h3>
          <div className="flex flex-wrap gap-2">
            {deal.features.map((feature) => (
              <span
                key={feature}
                className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-foreground"
              >
                {feature}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Credits Tab ────────────────────────────────────────────────────────────

function CreditsTab({ dealId }: { dealId: string }) {
  const { data, loading, error, refetch } = useApi<CreditLedgerResponse>(
    `/api/deals/${dealId}/credits`,
  );
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpDescription, setTopUpDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const handleTopUp = async () => {
    const amount = parseFloat(topUpAmount);
    if (isNaN(amount) || amount <= 0) return;

    setSubmitting(true);
    setTopUpError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credits: amount,
          description: topUpDescription || 'Admin credit top-up',
        }),
      });
      if (res.ok) {
        refetch();
        setTopUpOpen(false);
        setTopUpAmount('');
        setTopUpDescription('');
      } else {
        const result = await res.json().catch(() => ({}));
        setTopUpError(result.error || `Top-up failed with status ${res.status}`);
      }
    } catch {
      setTopUpError('Failed to connect to server');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: Column<CreditEntry>[] = [
    {
      key: 'timestamp',
      header: 'Time',
      render: (row) => (
        <span className="text-foreground-muted" title={new Date(row.timestamp).toLocaleString()}>
          {relativeTime(row.timestamp)}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'feature',
      header: 'Feature',
      render: (row) => <span className="text-sm text-foreground">{row.feature}</span>,
    },
    {
      key: 'units',
      header: 'Units',
      render: (row) => (
        <span className="text-sm text-foreground-muted">{formatNumber(row.units)}</span>
      ),
      width: '100px',
    },
    {
      key: 'credits',
      header: 'Credits',
      render: (row) => (
        <span className="text-sm font-medium text-foreground">{formatNumber(row.credits)}</span>
      ),
      width: '100px',
    },
    {
      key: 'source',
      header: 'Source',
      render: (row) => (
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGE_COLORS[row.source] ?? SOURCE_BADGE_COLORS.usage}`}
        >
          {capitalize(row.source)}
        </span>
      ),
      width: '120px',
    },
  ];

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load credits"
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
    );
  }

  const ledger: CreditLedger | null = data?.ledger ?? null;
  const totalAllocated = ledger?.totalAllocated ?? 0;
  const totalConsumed = ledger?.totalConsumed ?? 0;
  const usagePercent =
    totalAllocated > 0 ? Math.min(100, (totalConsumed / totalAllocated) * 100) : 0;
  const featureUsage = ledger?.featureUsage ?? {};
  const entries = ledger?.entries ?? [];

  return (
    <div className="space-y-6">
      {/* Credit Gauge */}
      <div className="rounded-lg border border-border bg-background-subtle p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-foreground-muted">Credit Usage</h3>
          <button
            onClick={() => setTopUpOpen(true)}
            className="px-3 py-1.5 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-xs font-medium hover:opacity-90 transition-colors"
          >
            Top Up Credits
          </button>
        </div>
        <div className="flex items-end gap-2 mb-2">
          <span className="text-2xl font-bold text-foreground">{formatNumber(totalConsumed)}</span>
          <span className="text-sm text-foreground-muted mb-0.5">
            / {formatNumber(totalAllocated)} credits
          </span>
        </div>
        <div className="w-full h-3 rounded-full bg-background-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${usagePercent > 90 ? 'bg-error' : usagePercent > 70 ? 'bg-warning' : 'bg-accent'}`}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
        <p className="text-xs text-foreground-muted mt-1">{usagePercent.toFixed(1)}% used</p>
      </div>

      {/* Per-Feature Breakdown */}
      {Object.keys(featureUsage).length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Per-Feature Breakdown</h3>
          <div className="space-y-3">
            {Object.entries(featureUsage).map(([feature, used]) => {
              const maxVal = totalAllocated > 0 ? totalAllocated : 1;
              const pct = Math.min(100, (used / maxVal) * 100);
              return (
                <div key={feature}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-foreground">{feature}</span>
                    <span className="text-foreground-muted">{formatNumber(used)}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-background-muted overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Entries */}
      {entries.length > 0 ? (
        <DataTable
          columns={columns}
          data={entries}
          rowKey={(row) => `${row.timestamp}-${row.feature}-${row.credits}`}
          pageSize={25}
        />
      ) : (
        <EmptyState
          title="No credit entries"
          description="No credit activity has been recorded for this deal yet."
        />
      )}

      {/* Top Up Dialog */}
      <ConfirmDialog
        open={topUpOpen}
        onOpenChange={(open) => {
          if (!open) {
            setTopUpOpen(false);
            setTopUpAmount('');
            setTopUpDescription('');
            setTopUpError(null);
          }
        }}
        title="Top Up Credits"
        description="Add credits to this deal. This will be recorded as a top-up entry in the credit ledger."
        confirmLabel="Add Credits"
        onConfirm={handleTopUp}
        loading={submitting}
        loadingLabel="Adding..."
      />
      {topUpOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto w-full max-w-md p-6 space-y-3">
            <div>
              <label className={labelClass}>Credit Amount</label>
              <input
                type="number"
                min="1"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                placeholder="Enter credit amount"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Description (optional)</label>
              <input
                type="text"
                value={topUpDescription}
                onChange={(e) => setTopUpDescription(e.target.value)}
                placeholder="Reason for top-up"
                className={inputClass}
              />
            </div>
            {topUpError && <p className="text-sm text-error">{topUpError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Line Items Tab ─────────────────────────────────────────────────────────

function LineItemsTab({ dealId }: { dealId: string }) {
  const { data, loading, error, refetch } = useApi<BillingLineItemsResponse>(
    `/api/deals/${dealId}/line-items`,
  );

  // Add dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addFormData, setAddFormData] = useState({
    periodLabel: '',
    description: '',
    quantity: '',
    unitPrice: '',
    category: 'base' as BillingLineItem['category'],
  });
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editItem, setEditItem] = useState<BillingLineItem | null>(null);
  const [editFormData, setEditFormData] = useState({
    description: '',
    quantity: '',
    unitPrice: '',
    category: 'base' as BillingLineItem['category'],
  });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Delete dialog state
  const [deleteItem, setDeleteItem] = useState<BillingLineItem | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Feedback banner state
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Auto-dismiss banner after 4 seconds
  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(timer);
  }, [banner]);

  const handleAdd = async () => {
    if (!addFormData.description.trim() || !addFormData.quantity || !addFormData.unitPrice) return;

    const quantity = parseFloat(addFormData.quantity);
    const unitPrice = parseFloat(addFormData.unitPrice);

    setAddSubmitting(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/line-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodLabel: addFormData.periodLabel,
          description: addFormData.description,
          quantity,
          unitPrice,
          totalAmount: quantity * unitPrice,
          category: addFormData.category,
        }),
      });
      if (res.ok) {
        refetch();
        setAddOpen(false);
        setAddFormData({
          periodLabel: '',
          description: '',
          quantity: '',
          unitPrice: '',
          category: 'base',
        });
        setBanner({ type: 'success', message: 'Line item added successfully' });
      } else {
        const body = await res.json().catch(() => null);
        setBanner({
          type: 'error',
          message: body?.error || `Failed to add line item (HTTP ${res.status})`,
        });
      }
    } catch {
      setBanner({ type: 'error', message: 'Failed to connect to server' });
    } finally {
      setAddSubmitting(false);
    }
  };

  const openEdit = (item: BillingLineItem) => {
    setEditItem(item);
    setEditFormData({
      description: item.description,
      quantity: String(item.quantity),
      unitPrice: String(item.unitPrice),
      category: item.category,
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (
      !editItem ||
      !editFormData.description.trim() ||
      !editFormData.quantity ||
      !editFormData.unitPrice
    )
      return;

    const quantity = parseFloat(editFormData.quantity);
    const unitPrice = parseFloat(editFormData.unitPrice);

    setEditSubmitting(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/line-items/${editItem._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: editFormData.description,
          quantity,
          unitPrice,
          totalAmount: quantity * unitPrice,
          category: editFormData.category,
        }),
      });
      if (res.ok) {
        refetch();
        setEditOpen(false);
        setEditItem(null);
        setBanner({ type: 'success', message: 'Line item updated successfully' });
      } else {
        const body = await res.json().catch(() => null);
        setBanner({
          type: 'error',
          message: body?.error || `Failed to update line item (HTTP ${res.status})`,
        });
      }
    } catch {
      setBanner({ type: 'error', message: 'Failed to connect to server' });
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteItem) return;

    setDeleteSubmitting(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/line-items/${deleteItem._id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        refetch();
        setDeleteItem(null);
        setBanner({ type: 'success', message: 'Line item deleted successfully' });
      } else {
        const body = await res.json().catch(() => null);
        setBanner({
          type: 'error',
          message: body?.error || `Failed to delete line item (HTTP ${res.status})`,
        });
      }
    } catch {
      setBanner({ type: 'error', message: 'Failed to connect to server' });
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const isOperationInProgress = addSubmitting || editSubmitting || deleteSubmitting;

  const columns: Column<BillingLineItem>[] = [
    {
      key: 'periodLabel',
      header: 'Period',
      render: (row) => <span className="text-sm text-foreground">{row.periodLabel}</span>,
      width: '120px',
    },
    {
      key: 'description',
      header: 'Description',
      render: (row) => <span className="text-sm text-foreground">{row.description}</span>,
    },
    {
      key: 'quantity',
      header: 'Qty',
      render: (row) => (
        <span className="text-sm text-foreground-muted">{formatNumber(row.quantity)}</span>
      ),
      width: '80px',
    },
    {
      key: 'unitPrice',
      header: 'Unit Price',
      render: (row) => (
        <span className="text-sm text-foreground-muted">${row.unitPrice.toFixed(2)}</span>
      ),
      width: '100px',
    },
    {
      key: 'totalAmount',
      header: 'Total',
      render: (row) => (
        <span className="text-sm font-medium text-foreground">${row.totalAmount.toFixed(2)}</span>
      ),
      width: '100px',
    },
    {
      key: 'category',
      header: 'Category',
      render: (row) => (
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${CATEGORY_BADGE_COLORS[row.category] ?? CATEGORY_BADGE_COLORS.base}`}
        >
          {capitalize(row.category)}
        </span>
      ),
      width: '120px',
    },
    {
      key: 'invoiced',
      header: 'Invoiced',
      render: (row) => (
        <span
          className={`text-xs font-medium ${row.invoiced ? 'text-success' : 'text-foreground-muted'}`}
        >
          {row.invoiced ? 'Yes' : 'No'}
        </span>
      ),
      width: '80px',
    },
    {
      key: '_id' as keyof BillingLineItem,
      header: '',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => openEdit(row)}
            disabled={isOperationInProgress}
            className="rounded-md p-1.5 text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Edit line item"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => setDeleteItem(row)}
            disabled={isOperationInProgress}
            className="rounded-md p-1.5 text-foreground-muted hover:text-error hover:bg-error-subtle transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Delete line item"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
      width: '80px',
    },
  ];

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load line items"
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
    );
  }

  const lineItems = data?.lineItems ?? [];

  return (
    <div className="space-y-4">
      {/* Feedback Banner */}
      {banner && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            banner.type === 'success'
              ? 'border-success bg-success-subtle text-success'
              : 'border-error bg-error-subtle text-error'
          }`}
        >
          {banner.message}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => setAddOpen(true)}
          disabled={isOperationInProgress}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
          Add Line Item
        </button>
      </div>

      {lineItems.length > 0 ? (
        <DataTable columns={columns} data={lineItems} rowKey={(row) => row._id} pageSize={25} />
      ) : (
        <EmptyState
          title="No line items"
          description="No billing line items have been created for this deal yet."
        />
      )}

      {/* Add Line Item Dialog */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-overlay" onClick={() => setAddOpen(false)} />
          <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground mb-4">Add Line Item</h2>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Period Label</label>
                <input
                  type="text"
                  value={addFormData.periodLabel}
                  onChange={(e) =>
                    setAddFormData((prev) => ({ ...prev, periodLabel: e.target.value }))
                  }
                  placeholder="e.g. 2026-03"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Description</label>
                <input
                  type="text"
                  value={addFormData.description}
                  onChange={(e) =>
                    setAddFormData((prev) => ({ ...prev, description: e.target.value }))
                  }
                  placeholder="Line item description"
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={addFormData.quantity}
                    onChange={(e) =>
                      setAddFormData((prev) => ({ ...prev, quantity: e.target.value }))
                    }
                    placeholder="0"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Unit Price ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={addFormData.unitPrice}
                    onChange={(e) =>
                      setAddFormData((prev) => ({ ...prev, unitPrice: e.target.value }))
                    }
                    placeholder="0.00"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Category</label>
                <select
                  value={addFormData.category}
                  onChange={(e) =>
                    setAddFormData((prev) => ({
                      ...prev,
                      category: e.target.value as BillingLineItem['category'],
                    }))
                  }
                  className={selectClass}
                >
                  <option value="base">Base</option>
                  <option value="overage">Overage</option>
                  <option value="addon">Add-on</option>
                  <option value="credit_topup">Credit Top-up</option>
                </select>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setAddOpen(false)}
                disabled={addSubmitting}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={
                  addSubmitting ||
                  !addFormData.description.trim() ||
                  !addFormData.quantity ||
                  !addFormData.unitPrice
                }
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {addSubmitting ? 'Adding...' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Line Item Dialog */}
      {editOpen && editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-overlay"
            onClick={() => {
              setEditOpen(false);
              setEditItem(null);
            }}
          />
          <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground mb-4">Edit Line Item</h2>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Description</label>
                <input
                  type="text"
                  value={editFormData.description}
                  onChange={(e) =>
                    setEditFormData((prev) => ({ ...prev, description: e.target.value }))
                  }
                  placeholder="Line item description"
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={editFormData.quantity}
                    onChange={(e) =>
                      setEditFormData((prev) => ({ ...prev, quantity: e.target.value }))
                    }
                    placeholder="0"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Unit Price ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={editFormData.unitPrice}
                    onChange={(e) =>
                      setEditFormData((prev) => ({ ...prev, unitPrice: e.target.value }))
                    }
                    placeholder="0.00"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Category</label>
                <select
                  value={editFormData.category}
                  onChange={(e) =>
                    setEditFormData((prev) => ({
                      ...prev,
                      category: e.target.value as BillingLineItem['category'],
                    }))
                  }
                  className={selectClass}
                >
                  <option value="base">Base</option>
                  <option value="overage">Overage</option>
                  <option value="addon">Add-on</option>
                  <option value="credit_topup">Credit Top-up</option>
                </select>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setEditOpen(false);
                  setEditItem(null);
                }}
                disabled={editSubmitting}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleEdit}
                disabled={
                  editSubmitting ||
                  !editFormData.description.trim() ||
                  !editFormData.quantity ||
                  !editFormData.unitPrice
                }
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {editSubmitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={!!deleteItem}
        onOpenChange={(open) => {
          if (!open) setDeleteItem(null);
        }}
        title="Delete Line Item"
        description={`Delete line item '${deleteItem?.description ?? ''}'? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteSubmitting}
        loadingLabel="Deleting..."
      />
    </div>
  );
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

function SettingsTab({ deal, onSaved }: { deal: Deal; onSaved: () => void }) {
  const [name, setName] = useState(deal.name);
  const [status, setStatus] = useState(deal.status);
  const [overagePolicy, setOveragePolicy] = useState(deal.overagePolicy);
  const [thresholds, setThresholds] = useState(deal.overageAlertThresholds.join(', '));
  const [features, setFeatures] = useState(deal.features.join(', '));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const parsedThresholds = thresholds
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !isNaN(n));
    const parsedFeatures = features
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch(`/api/deals/${deal._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          status,
          overagePolicy,
          overageAlertThresholds: parsedThresholds,
          features: parsedFeatures,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSaveSuccess(true);
        onSaved();
      } else {
        setSaveError(data.error || `Request failed with status ${res.status}`);
      }
    } catch {
      setSaveError('Failed to connect to server');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <label className={labelClass}>Deal Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Deal['status'])}
          className={selectClass}
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="expired">Expired</option>
          <option value="canceled">Canceled</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Overage Policy</label>
        <select
          value={overagePolicy}
          onChange={(e) => setOveragePolicy(e.target.value as Deal['overagePolicy'])}
          className={selectClass}
        >
          <option value="hard_stop">Hard Stop</option>
          <option value="soft_cap">Soft Cap</option>
          <option value="auto_upgrade">Auto Upgrade</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Alert Thresholds (comma-separated percentages)</label>
        <input
          type="text"
          value={thresholds}
          onChange={(e) => setThresholds(e.target.value)}
          placeholder="50, 80, 90, 100"
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Features (comma-separated)</label>
        <input
          type="text"
          value={features}
          onChange={(e) => setFeatures(e.target.value)}
          placeholder="chat, search, voice"
          className={inputClass}
        />
      </div>

      {saveError && <p className="text-sm text-error">{saveError}</p>}
      {saveSuccess && <p className="text-sm text-success">Deal settings saved successfully.</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function DealDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dealId = params.id as string;

  const { data, loading, error, refetch } = useApi<DealDetailResponse>(`/api/deals/${dealId}`);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteDeal = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/deals');
      } else {
        const body = await res.json().catch(() => null);
        setDeleteError(body?.error || `Failed to delete deal (HTTP ${res.status})`);
        setDeleteOpen(false);
      }
    } catch {
      setDeleteError('Failed to connect to server');
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !data) {
    return (
      <div>
        <Breadcrumb
          items={[
            { label: 'Dashboard', href: '/' },
            { label: 'Deals', href: '/deals' },
            { label: 'Deal Detail' },
          ]}
        />
        <div className="mb-6">
          <PageHeader title="Deal Detail" description="Loading..." />
        </div>
        <SkeletonTable rows={6} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <Breadcrumb
          items={[
            { label: 'Dashboard', href: '/' },
            { label: 'Deals', href: '/deals' },
            { label: 'Deal Detail' },
          ]}
        />
        <div className="mb-6">
          <PageHeader title="Deal Detail" description={`Manage deal ${dealId}`} />
        </div>
        <EmptyState
          title="Failed to load deal"
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
      </div>
    );
  }

  if (!data?.deal) return null;

  const deal = data.deal;

  const tabs = [
    {
      id: 'overview',
      label: 'Overview',
      content: <OverviewTab deal={deal} onRefresh={refetch} />,
    },
    {
      id: 'credits',
      label: 'Credits',
      content: <CreditsTab dealId={dealId} />,
    },
    {
      id: 'line-items',
      label: 'Line Items',
      content: <LineItemsTab dealId={dealId} />,
    },
    {
      id: 'settings',
      label: 'Settings',
      content: <SettingsTab deal={deal} onSaved={refetch} />,
    },
  ];

  return (
    <div>
      <Breadcrumb
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Deals', href: '/deals' },
          { label: deal?.name || 'Deal Detail' },
        ]}
      />
      <div className="mb-6">
        <PageHeader
          title={deal.name}
          description={`Deal ${dealId} — ${capitalize(deal.scope)} scope`}
          actions={
            <button
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-error px-3 py-1.5 text-xs font-medium text-error-foreground hover:bg-error-muted transition-colors"
            >
              <Trash2 size={14} />
              Delete Deal
            </button>
          }
        />
      </div>

      {deleteError && (
        <div className="mb-4 rounded-md border border-error bg-error-subtle px-4 py-3 text-sm text-error">
          {deleteError}
        </div>
      )}

      <Tabs tabs={tabs} defaultValue="overview" />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Deal"
        description={`Are you sure you want to delete "${deal.name}"? This will permanently remove the deal, its line items, and credit ledger. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDeleteDeal}
        loading={deleting}
        loadingLabel="Deleting..."
      />
    </div>
  );
}
