'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  FilterBar,
  DataTable,
  StatusBadge,
  SkeletonTable,
  EmptyState,
  ConfirmDialog,
  relativeTime,
  type Column,
  type SelectFilter,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProvisionedModel {
  id: string;
  tenantId: string;
  displayName: string;
  provider: string;
  modelId: string;
  tier: string;
  isActive: boolean;
  capabilities: string[];
  connectionsCount: number;
  createdAt: string;
}

interface ModelsResponse {
  success: boolean;
  models: ProvisionedModel[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_OPTIONS = [
  { value: '', label: 'All providers' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure' },
  { value: 'google', label: 'Google' },
  { value: 'custom', label: 'Custom' },
];

const TIER_OPTIONS = [
  { value: '', label: 'All tiers' },
  { value: 'standard', label: 'Standard' },
  { value: 'premium', label: 'Premium' },
  { value: 'enterprise', label: 'Enterprise' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const TIER_BADGE_COLORS: Record<string, string> = {
  standard: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  balanced: 'bg-info/15 text-info border-info/25',
  premium: 'bg-purple/15 text-purple border-purple/25',
  enterprise: 'bg-warning/15 text-warning border-warning/25',
};

const PAGE_SIZE = 25;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toStatusVariant(isActive: boolean): StatusBadgeVariant {
  return isActive ? 'active' : 'suspended';
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncateId(id: string, maxLen = 12): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + '\u2026';
}

// ─── Provision Wizard Dialog (3-step) ─────────────────────────────────────────

const WIZARD_CAPABILITY_OPTIONS = ['text', 'tools', 'streaming', 'vision', 'realtime_voice'];

interface WizardFormData {
  // Step 1: Provider & Model
  tenantId: string;
  provider: string;
  modelId: string;
  // Step 2: Configuration
  displayName: string;
  temperature: string;
  maxTokens: string;
  capabilities: string[];
  tier: string;
  // Step 3: Connection
  apiKey: string;
  connectionName: string;
  authType: string;
}

const INITIAL_WIZARD_DATA: WizardFormData = {
  tenantId: '',
  provider: 'openai',
  modelId: '',
  displayName: '',
  temperature: '0.7',
  maxTokens: '4096',
  capabilities: ['text'],
  tier: 'balanced',
  apiKey: '',
  connectionName: 'default',
  authType: 'api_key',
};

interface ProvisionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function ProvisionDialog({ open, onClose, onCreated }: ProvisionDialogProps) {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<WizardFormData>(INITIAL_WIZARD_DATA);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateField = <K extends keyof WizardFormData>(key: K, value: WizardFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const toggleCapability = (cap: string) => {
    setFormData((prev) => ({
      ...prev,
      capabilities: prev.capabilities.includes(cap)
        ? prev.capabilities.filter((c) => c !== cap)
        : [...prev.capabilities, cap],
    }));
  };

  const handleClose = () => {
    setStep(1);
    setFormData(INITIAL_WIZARD_DATA);
    setError(null);
    onClose();
  };

  const validateStep1 = (): boolean => {
    if (!formData.tenantId.trim()) {
      setError('Tenant ID is required.');
      return false;
    }
    if (!formData.modelId.trim()) {
      setError('Model ID is required.');
      return false;
    }
    setError(null);
    return true;
  };

  const validateStep2 = (): boolean => {
    if (!formData.displayName.trim()) {
      setError('Display name is required.');
      return false;
    }
    setError(null);
    return true;
  };

  const handleSubmit = async () => {
    if (!formData.apiKey.trim()) {
      setError('API key is required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // Step A: Create the model with optional connection
      const res = await fetch('/api/tenant-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetTenantId: formData.tenantId.trim(),
          displayName: formData.displayName.trim(),
          provider: formData.provider,
          modelId: formData.modelId.trim(),
          temperature: parseFloat(formData.temperature),
          maxTokens: parseInt(formData.maxTokens, 10),
          capabilities: formData.capabilities,
          tier: formData.tier,
          connection: {
            connectionName: formData.connectionName.trim() || 'default',
            apiKey: formData.apiKey.trim(),
            authType: formData.authType,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || `Request failed with status ${res.status}`);
        return;
      }

      // Success
      setStep(1);
      setFormData(INITIAL_WIZARD_DATA);
      onCreated();
      onClose();
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const inputClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
  const selectClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
  const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

  const stepLabels = ['Provider & Model', 'Configure', 'Connection'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground">Provision Model</h2>

        {/* Step indicator */}
        <div className="mt-3 mb-5 flex items-center gap-2">
          {stepLabels.map((label, idx) => {
            const stepNum = idx + 1;
            const isActive = step === stepNum;
            const isCompleted = step > stepNum;
            return (
              <div key={label} className="flex items-center gap-2">
                {idx > 0 && (
                  <div className={`h-px w-6 ${isCompleted ? 'bg-accent' : 'bg-border'}`} />
                )}
                <div className="flex items-center gap-1.5">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : isCompleted
                          ? 'bg-accent/20 text-accent'
                          : 'bg-background-muted text-foreground-muted'
                    }`}
                  >
                    {stepNum}
                  </span>
                  <span
                    className={`text-xs ${isActive ? 'text-foreground' : 'text-foreground-muted'}`}
                  >
                    {label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Step 1: Provider & Model */}
        {step === 1 && (
          <div className="space-y-3">
            <div>
              <label htmlFor="provision-tenant-id" className={labelClass}>
                Tenant ID
              </label>
              <input
                id="provision-tenant-id"
                type="text"
                value={formData.tenantId}
                onChange={(e) => updateField('tenantId', e.target.value)}
                placeholder="Enter tenant ID"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="provision-provider" className={labelClass}>
                Provider
              </label>
              <select
                id="provision-provider"
                value={formData.provider}
                onChange={(e) => updateField('provider', e.target.value)}
                className={selectClass}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google</option>
                <option value="azure">Azure</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label htmlFor="provision-model-id" className={labelClass}>
                Model ID
              </label>
              <input
                id="provision-model-id"
                type="text"
                value={formData.modelId}
                onChange={(e) => updateField('modelId', e.target.value)}
                placeholder="e.g. gpt-4-turbo, claude-3-opus"
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="space-y-3">
            <div>
              <label htmlFor="provision-display-name" className={labelClass}>
                Display Name
              </label>
              <input
                id="provision-display-name"
                type="text"
                value={formData.displayName}
                onChange={(e) => updateField('displayName', e.target.value)}
                placeholder="e.g. GPT-4 Turbo"
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="provision-temperature" className={labelClass}>
                  Temperature
                </label>
                <input
                  id="provision-temperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={formData.temperature}
                  onChange={(e) => updateField('temperature', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="provision-max-tokens" className={labelClass}>
                  Max Tokens
                </label>
                <input
                  id="provision-max-tokens"
                  type="number"
                  min="1"
                  max="200000"
                  value={formData.maxTokens}
                  onChange={(e) => updateField('maxTokens', e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label htmlFor="provision-tier" className={labelClass}>
                Tier
              </label>
              <select
                id="provision-tier"
                value={formData.tier}
                onChange={(e) => updateField('tier', e.target.value)}
                className={selectClass}
              >
                <option value="standard">Standard</option>
                <option value="balanced">Balanced</option>
                <option value="premium">Premium</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
            <div>
              <label className={`${labelClass} mb-2`}>Capabilities</label>
              <div className="flex flex-wrap gap-3">
                {WIZARD_CAPABILITY_OPTIONS.map((cap) => (
                  <label key={cap} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.capabilities.includes(cap)}
                      onChange={() => toggleCapability(cap)}
                      className="rounded border-border"
                    />
                    <span className="text-foreground">
                      {cap.charAt(0).toUpperCase() + cap.slice(1).replace('_', ' ')}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Connection */}
        {step === 3 && (
          <div className="space-y-3">
            <div>
              <label htmlFor="provision-conn-name" className={labelClass}>
                Connection Name
              </label>
              <input
                id="provision-conn-name"
                type="text"
                value={formData.connectionName}
                onChange={(e) => updateField('connectionName', e.target.value)}
                placeholder="e.g. default, production"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="provision-api-key" className={labelClass}>
                API Key
              </label>
              <input
                id="provision-api-key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                placeholder="Enter API key"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="provision-auth-type" className={labelClass}>
                Auth Type
              </label>
              <select
                id="provision-auth-type"
                value={formData.authType}
                onChange={(e) => updateField('authType', e.target.value)}
                className={selectClass}
              >
                <option value="api_key">API Key</option>
                <option value="bearer">Bearer Token</option>
                <option value="oauth2">OAuth 2.0</option>
              </select>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-error">{error}</p>}

        <div className="mt-6 flex justify-between">
          <div>
            {step > 1 && (
              <button
                onClick={() => {
                  setError(null);
                  setStep((s) => s - 1);
                }}
                disabled={submitting}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              disabled={submitting}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Cancel
            </button>
            {step < 3 ? (
              <button
                onClick={() => {
                  if (step === 1 && !validateStep1()) return;
                  if (step === 2 && !validateStep2()) return;
                  setStep((s) => s + 1);
                }}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Provisioning...' : 'Provision Model'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ProvisionedModel | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (providerFilter) params.set('provider', providerFilter);
    if (tierFilter) params.set('tier', tierFilter);
    if (statusFilter) params.set('isActive', statusFilter === 'active' ? 'true' : 'false');
    return `/api/tenant-models?${params.toString()}`;
  }, [page, debouncedSearch, providerFilter, tierFilter, statusFilter]);

  const { data, loading, error, refetch } = useApi<ModelsResponse>(url);

  const handleProviderChange = (value: string) => {
    setProviderFilter(value);
    setPage(1);
  };

  const handleTierChange = (value: string) => {
    setTierFilter(value);
    setPage(1);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/tenant-models/${revokeTarget.id}`, {
        method: 'DELETE',
      });
      const result = await res.json();
      if (res.ok && result.success) {
        refetch();
      } else {
        setActionError(result.error || `Revoke failed with status ${res.status}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  const filters: SelectFilter[] = [
    {
      id: 'provider',
      label: 'Provider',
      value: providerFilter,
      options: PROVIDER_OPTIONS,
      onChange: handleProviderChange,
    },
    {
      id: 'tier',
      label: 'Tier',
      value: tierFilter,
      options: TIER_OPTIONS,
      onChange: handleTierChange,
    },
    {
      id: 'status',
      label: 'Status',
      value: statusFilter,
      options: STATUS_OPTIONS,
      onChange: handleStatusChange,
    },
  ];

  const columns: Column<ProvisionedModel>[] = [
    {
      key: 'displayName',
      header: 'Display Name',
      render: (row) => (
        <div>
          <div className="font-medium text-foreground">{row.displayName}</div>
          <div className="text-xs text-foreground-muted">{row.modelId}</div>
        </div>
      ),
      sortable: true,
      sortFn: (a, b) => a.displayName.localeCompare(b.displayName),
    },
    {
      key: 'provider',
      header: 'Provider',
      render: (row) => (
        <span className="text-foreground">{capitalize(row.provider || 'unknown')}</span>
      ),
      width: '120px',
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (row) => {
        const tier = row.tier ?? 'standard';
        const badgeColor = TIER_BADGE_COLORS[tier.toLowerCase()] ?? TIER_BADGE_COLORS.standard;
        return (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badgeColor}`}
          >
            {capitalize(tier)}
          </span>
        );
      },
      width: '130px',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={toStatusVariant(row.isActive)} />,
      width: '120px',
    },
    {
      key: 'tenantId',
      header: 'Tenant',
      render: (row) => (
        <span className="text-foreground-muted font-mono text-xs" title={row.tenantId}>
          {truncateId(row.tenantId)}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'capabilities',
      header: 'Capabilities',
      render: (row) => (
        <span className="text-xs text-foreground-muted">
          {Array.isArray(row.capabilities) && row.capabilities.length > 0
            ? row.capabilities.join(', ')
            : '\u2014'}
        </span>
      ),
      width: '180px',
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
      width: '120px',
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.isActive ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRevokeTarget(row);
            }}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-error border border-error/25 hover:bg-error/10 transition-colors"
          >
            Revoke
          </button>
        ) : (
          <span className="text-xs text-foreground-muted">Revoked</span>
        ),
      width: '90px',
    },
  ];

  const totalPages = data?.pagination?.totalPages ?? 1;

  return (
    <div>
      <PageHeader title="Model Provisioning" description="Manage LLM model access for tenants" />

      <FilterBar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search models...',
        }}
        filters={filters}
        actions={
          <button
            onClick={() => setProvisionOpen(true)}
            className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors"
          >
            Provision Model
          </button>
        }
        className="mb-6"
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

      {loading && !data ? (
        <SkeletonTable rows={8} />
      ) : error && !data ? (
        <EmptyState
          title="Failed to load models"
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
      ) : data && data.models.length > 0 ? (
        <div className={loading ? 'opacity-60 pointer-events-none transition-opacity' : ''}>
          <DataTable
            columns={columns}
            data={data.models}
            rowKey={(row) => row.id}
            onRowClick={(row) => router.push(`/models/${row.id}`)}
            pageSize={data.models.length || PAGE_SIZE}
          />

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-foreground-muted">
                Page {data.pagination.page} of {totalPages} ({data.pagination.total} models)
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
          title="No models found"
          description="No provisioned models match the current filters. Try adjusting your search or filter criteria."
        />
      )}

      {/* Provision Model Dialog */}
      <ProvisionDialog
        open={provisionOpen}
        onClose={() => setProvisionOpen(false)}
        onCreated={refetch}
      />

      {/* Revoke Confirm Dialog */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke Model"
        description={
          revokeTarget
            ? `Are you sure you want to revoke "${revokeTarget.displayName}"? This will deactivate the model and disable inference for the tenant.`
            : ''
        }
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevoke}
        loading={revoking}
        loadingLabel="Revoking..."
      />
    </div>
  );
}
