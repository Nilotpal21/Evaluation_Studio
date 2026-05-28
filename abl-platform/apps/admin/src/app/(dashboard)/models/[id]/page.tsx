'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { Breadcrumb } from '../../../../components/ui/breadcrumb';
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface ModelDetail {
  id: string;
  tenantId: string;
  displayName: string;
  provider: string;
  modelId: string;
  tier: string;
  temperature: number;
  maxTokens: number;
  capabilities: string[];
  isActive: boolean;
  inferenceEnabled: boolean;
  createdAt: string;
}

interface ModelConnection {
  id: string;
  connectionName: string;
  credentialId: string | null;
  authType: string;
  isActive: boolean;
  isPrimary: boolean;
  createdAt: string;
}

interface ModelDetailResponse {
  success: boolean;
  model: ModelDetail;
  connections: ModelConnection[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TIER_OPTIONS = ['standard', 'balanced', 'premium', 'enterprise'];
const CAPABILITY_OPTIONS = ['text', 'tools', 'streaming', 'vision', 'realtime_voice'];

const TIER_BADGE_COLORS: Record<string, string> = {
  standard: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  balanced: 'bg-info/15 text-info border-info/25',
  premium: 'bg-purple/15 text-purple border-purple/25',
  enterprise: 'bg-warning/15 text-warning border-warning/25',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toStatusVariant(isActive: boolean): StatusBadgeVariant {
  return isActive ? 'active' : 'suspended';
}

// ─── Settings Form ──────────────────────────────────────────────────────────

function SettingsForm({ model, onSaved }: { model: ModelDetail; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(model.displayName);
  const [tier, setTier] = useState(model.tier);
  const [temperature, setTemperature] = useState(String(model.temperature));
  const [maxTokens, setMaxTokens] = useState(String(model.maxTokens));
  const [capabilities, setCapabilities] = useState<string[]>(model.capabilities || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const toggleCapability = (cap: string) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`/api/tenant-models/${model.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          tier,
          temperature: parseFloat(temperature),
          maxTokens: parseInt(maxTokens, 10),
          capabilities,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || `Request failed with status ${res.status}`);
        return;
      }
      setSuccessMessage('Settings saved successfully');
      onSaved();
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background-subtle p-5">
      <h3 className="text-sm font-medium text-foreground mb-4">Model Settings</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-foreground-muted mb-1">
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="h-9 w-full max-w-md rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground-muted mb-1">Tier</label>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="h-9 w-full max-w-md rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4 max-w-md">
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">
              Temperature
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">
              Max Tokens
            </label>
            <input
              type="number"
              min="1"
              max="200000"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground-muted mb-2">
            Capabilities
          </label>
          <div className="flex flex-wrap gap-3">
            {CAPABILITY_OPTIONS.map((cap) => (
              <label key={cap} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.includes(cap)}
                  onChange={() => toggleCapability(cap)}
                  className="rounded border-border bg-background-subtle text-accent"
                />
                <span className="text-foreground">
                  {cap.charAt(0).toUpperCase() + cap.slice(1).replace('_', ' ')}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-error">{error}</p>}
        {successMessage && <p className="text-sm text-success">{successMessage}</p>}

        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}

// ─── Connections Table ──────────────────────────────────────────────────────

function ConnectionsSection({
  modelId,
  connections,
  onRefresh,
}: {
  modelId: string;
  connections: ModelConnection[];
  onRefresh: () => void;
}) {
  const [validating, setValidating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelConnection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleValidate = async (connId: string) => {
    setValidating(connId);
    setActionError(null);
    try {
      const res = await fetch(`/api/tenant-models/${modelId}/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'validate', connId }),
      });
      const data = await res.json();
      if (data.valid === true) {
        setActionError(null);
      } else if (data.valid === false) {
        setActionError(`Validation failed: ${data.message}`);
      } else {
        setActionError(data.message || 'Validation result inconclusive');
      }
    } catch {
      setActionError('Failed to validate connection');
    } finally {
      setValidating(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(deleteTarget.id);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/tenant-models/${modelId}/connections?connId=${deleteTarget.id}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
      } else {
        setActionError(data.error || 'Failed to delete connection');
      }
    } catch {
      setActionError('Failed to connect to server');
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  };

  const columns: Column<ModelConnection>[] = [
    {
      key: 'connectionName',
      header: 'Name',
      render: (row) => <span className="font-medium text-foreground">{row.connectionName}</span>,
    },
    {
      key: 'credentialId',
      header: 'Credential ID',
      render: (row) => (
        <span className="font-mono text-xs text-foreground-muted">{row.credentialId || '--'}</span>
      ),
      width: '180px',
    },
    {
      key: 'authType',
      header: 'Type',
      render: (row) => <span className="text-foreground-muted">{row.authType}</span>,
      width: '120px',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={toStatusVariant(row.isActive)} />,
      width: '120px',
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleValidate(row.id);
            }}
            disabled={validating === row.id}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-accent border border-accent/25 hover:bg-accent/10 transition-colors disabled:opacity-50"
          >
            {validating === row.id ? 'Validating...' : 'Validate'}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(row);
            }}
            disabled={deleting === row.id}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-error border border-error/25 hover:bg-error/10 transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      ),
      width: '200px',
    },
  ];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">Connections</h3>

      {actionError && (
        <div className="flex items-center justify-between rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="ml-4 text-xs font-medium hover:text-error-muted transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {connections.length > 0 ? (
        <DataTable columns={columns} data={connections} rowKey={(row) => row.id} pageSize={10} />
      ) : (
        <EmptyState
          title="No connections"
          description="This model has no connections configured."
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Connection"
        description={
          deleteTarget
            ? `Are you sure you want to delete connection "${deleteTarget.connectionName}"? This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleting !== null}
        loadingLabel="Deleting..."
      />
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ModelDetailPage() {
  const params = useParams();
  const router = useRouter();
  const modelId = params.id as string;

  const { data, loading, error, refetch } = useApi<ModelDetailResponse>(
    `/api/tenant-models/${modelId}`,
  );

  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      const res = await fetch(`/api/tenant-models/${modelId}`, {
        method: 'DELETE',
      });
      const result = await res.json();
      if (res.ok && result.success) {
        router.push('/models');
      }
    } catch {
      // Error handled in UI
    } finally {
      setRevoking(false);
      setRevokeOpen(false);
    }
  };

  if (loading && !data) {
    return (
      <div>
        <Breadcrumb
          items={[
            { label: 'Dashboard', href: '/' },
            { label: 'Models', href: '/models' },
            { label: 'Model Detail' },
          ]}
        />
        <PageHeader title="Model Detail" description="Loading..." />
        <div className="space-y-4 mt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-lg border border-border bg-background-subtle animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <Breadcrumb
          items={[
            { label: 'Dashboard', href: '/' },
            { label: 'Models', href: '/models' },
            { label: 'Model Detail' },
          ]}
        />
        <PageHeader title="Model Detail" description="" />
        <EmptyState
          title="Failed to load model"
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

  if (!data) return null;

  const { model, connections } = data;
  const tierBadge = TIER_BADGE_COLORS[model.tier?.toLowerCase()] ?? TIER_BADGE_COLORS.standard;

  return (
    <div>
      <Breadcrumb
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Models', href: '/models' },
          { label: 'Model Detail' },
        ]}
      />
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <PageHeader
            title={model.displayName}
            description={`${model.provider} / ${model.modelId}`}
          />
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tierBadge}`}
            >
              {model.tier ? model.tier.charAt(0).toUpperCase() + model.tier.slice(1) : 'Standard'}
            </span>
            <StatusBadge status={toStatusVariant(model.isActive)} />
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Settings Form */}
        <SettingsForm model={model} onSaved={refetch} />

        {/* Connections Table */}
        <ConnectionsSection modelId={modelId} connections={connections} onRefresh={refetch} />

        {/* Revoke Model */}
        {model.isActive && (
          <div className="rounded-lg border border-error/25 bg-error/5 p-5">
            <h3 className="text-sm font-medium text-error mb-2">Danger Zone</h3>
            <p className="text-sm text-foreground-muted mb-4">
              Revoking this model will deactivate it and disable inference for the tenant.
            </p>
            <button
              onClick={() => setRevokeOpen(true)}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-error-foreground hover:bg-error-muted transition-colors"
            >
              Revoke Model
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke Model"
        description={`Are you sure you want to revoke "${model.displayName}"? This will deactivate the model and disable inference for the tenant.`}
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevoke}
        loading={revoking}
        loadingLabel="Revoking..."
      />
    </div>
  );
}
