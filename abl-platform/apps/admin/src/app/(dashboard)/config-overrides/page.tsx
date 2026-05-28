'use client';

import { useState, useMemo, useCallback } from 'react';
import { Search, Settings2, Trash2, Pencil, Check, X, AlertTriangle } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  SkeletonTable,
  EmptyState,
  ConfirmDialog,
  formatNumber,
  formatBytes,
  formatMs,
} from '@agent-platform/admin-ui';
import type {
  TenantSummary,
  TenantsResponse,
  PlanDefaultsResponse,
  TenantConfigResponse,
  PlanTier,
  TenantLimits,
} from '../../../types/api';

// ─── Constants ─────────────────────────────────────────────────────────────

const PLAN_TIERS: PlanTier[] = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'];

const PLAN_BADGE_COLORS: Record<string, string> = {
  FREE: 'bg-foreground/10 text-foreground-muted border-foreground/15',
  TEAM: 'bg-info/15 text-info border-info/25',
  BUSINESS: 'bg-purple/15 text-purple border-purple/25',
  ENTERPRISE: 'bg-warning/15 text-warning border-warning/25',
};

/** Human-friendly labels for limit keys */
const LIMIT_LABELS: Record<keyof TenantLimits, string> = {
  maxConcurrentSessions: 'Concurrent Sessions',
  maxServiceTimeoutMs: 'Service Timeout',
  maxResponseBodyBytes: 'Response Body Size',
  maxConcurrentServiceCalls: 'Concurrent Service Calls',
  maxPendingTimers: 'Pending Timers',
  maxAgentsPerProject: 'Agents per Project',
  maxEventTypesPerApp: 'Event Types per App',
  maxProjectsPerOrg: 'Projects per Org',
  requestsPerMinute: 'Requests / min',
  tokensPerMinute: 'Tokens / min',
  toolCallsPerMinute: 'Tool Calls / min',
  messagesPerMonth: 'Messages / month',
  traceRetentionDays: 'Trace Retention',
  sessionRetentionDays: 'Session Retention',
  auditLogRetentionDays: 'Audit Log Retention',
  archiveRetentionDays: 'Archive Retention',
};

/** Keys that represent durations in milliseconds */
const MS_KEYS = new Set<string>(['maxServiceTimeoutMs']);

/** Keys that represent byte sizes */
const BYTES_KEYS = new Set<string>(['maxResponseBodyBytes']);

/** Keys that represent day durations */
const DAYS_KEYS = new Set<string>([
  'traceRetentionDays',
  'sessionRetentionDays',
  'auditLogRetentionDays',
  'archiveRetentionDays',
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatLimitValue(key: string, value: number): string {
  if (value === -1) return 'Unlimited';
  if (value === 0 && DAYS_KEYS.has(key)) return 'Disabled';
  if (MS_KEYS.has(key)) return formatMs(value);
  if (BYTES_KEYS.has(key)) return formatBytes(value);
  if (DAYS_KEYS.has(key)) return `${formatNumber(value)} days`;
  return formatNumber(value);
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ConfigOverridesPage() {
  // ── Plan defaults ──
  const {
    data: plansData,
    loading: plansLoading,
    error: plansError,
    refetch: refetchPlans,
  } = useApi<PlanDefaultsResponse>('/api/tenant-config/plans');

  // ── Tenant picker ──
  const { data: tenantsData } = useApi<TenantsResponse>('/api/tenants?limit=100');
  const [tenantSearch, setTenantSearch] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // ── Tenant config ──
  const tenantConfigUrl = selectedTenantId ? `/api/tenant-config/${selectedTenantId}` : null;
  const {
    data: tenantConfig,
    loading: configLoading,
    error: configError,
    refetch: refetchConfig,
  } = useApi<TenantConfigResponse>(tenantConfigUrl);

  // ── Edit overrides ──
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Clear overrides confirmation ──
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  // ── Filtered tenant list ──
  const filteredTenants = useMemo(() => {
    if (!tenantsData?.tenants) return [];
    if (!tenantSearch) return tenantsData.tenants;
    const lower = tenantSearch.toLowerCase();
    return tenantsData.tenants.filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.slug.toLowerCase().includes(lower) ||
        t._id.toLowerCase().includes(lower),
    );
  }, [tenantsData, tenantSearch]);

  const selectedTenant = useMemo(
    () => tenantsData?.tenants.find((t) => t._id === selectedTenantId) ?? null,
    [tenantsData, selectedTenantId],
  );

  // ── Limit keys for the plan defaults table ──
  const limitKeys = useMemo(() => {
    if (!plansData?.plans) return [];
    return Object.keys(plansData.plans.FREE.limits) as (keyof TenantLimits)[];
  }, [plansData]);

  // ── Override detection: compare resolved config against plan defaults ──
  const overriddenKeys = useMemo(() => {
    if (!tenantConfig?.config || !tenantConfig?.planDefaults) return new Set<string>();
    const keys = new Set<string>();
    const resolved = tenantConfig.config.limits;
    const defaults = tenantConfig.planDefaults.limits;
    for (const key of Object.keys(resolved) as (keyof TenantLimits)[]) {
      if (resolved[key] !== defaults[key]) {
        keys.add(key);
      }
    }
    return keys;
  }, [tenantConfig]);

  // ── Enter edit mode ──
  const startEditing = useCallback(() => {
    if (!tenantConfig?.config) return;
    const values: Record<string, string> = {};
    // Pre-populate with current overrides (raw values from the API)
    const overrides = tenantConfig.overrides ?? {};
    for (const key of Object.keys(overrides)) {
      values[key] = String(overrides[key]);
    }
    setEditValues(values);
    setSaveError(null);
    setEditMode(true);
  }, [tenantConfig]);

  // ── Cancel edit mode ──
  const cancelEditing = useCallback(() => {
    setEditMode(false);
    setEditValues({});
    setSaveError(null);
  }, []);

  // ── Save overrides ──
  const saveOverrides = useCallback(async () => {
    if (!selectedTenantId) return;
    setSaving(true);
    setSaveError(null);

    // Build numeric payload -- skip empty values
    const payload: Record<string, number> = {};
    for (const [key, val] of Object.entries(editValues)) {
      const trimmed = val.trim();
      if (trimmed === '') continue;
      const num = Number(trimmed);
      if (isNaN(num)) {
        setSaveError(`Invalid number for "${LIMIT_LABELS[key as keyof TenantLimits] ?? key}"`);
        setSaving(false);
        return;
      }
      payload[key] = num;
    }

    if (Object.keys(payload).length === 0) {
      setSaveError('No overrides to save. Add at least one value.');
      setSaving(false);
      return;
    }

    try {
      const res = await fetch(`/api/tenant-config/${selectedTenantId}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveError(data.error ?? `Request failed (${res.status})`);
        setSaving(false);
        return;
      }
      setEditMode(false);
      setEditValues({});
      refetchConfig();
    } catch {
      setSaveError('Failed to connect to server');
    } finally {
      setSaving(false);
    }
  }, [selectedTenantId, editValues, refetchConfig]);

  // ── Clear overrides ──
  const clearOverrides = useCallback(async () => {
    if (!selectedTenantId) return;
    setClearing(true);
    try {
      const res = await fetch(`/api/tenant-config/${selectedTenantId}/overrides`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveError(data.error ?? `Clear failed (${res.status})`);
        setClearing(false);
        setClearDialogOpen(false);
        return;
      }
      setClearDialogOpen(false);
      refetchConfig();
    } catch {
      setSaveError('Failed to connect to server');
    } finally {
      setClearing(false);
    }
  }, [selectedTenantId, refetchConfig]);

  // ── Select tenant ──
  const selectTenant = useCallback((tenant: TenantSummary) => {
    setSelectedTenantId(tenant._id);
    setDropdownOpen(false);
    setTenantSearch('');
    setEditMode(false);
    setEditValues({});
    setSaveError(null);
  }, []);

  return (
    <div>
      <PageHeader
        title="Config Overrides"
        description="Compare plan defaults and manage per-tenant quota overrides."
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        {/* ── Left panel: Plan Defaults Comparison ── */}
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-4">Plan Defaults Comparison</h2>

          {plansLoading ? (
            <SkeletonTable rows={10} />
          ) : plansError ? (
            <EmptyState
              title="Failed to load plan defaults"
              description={plansError}
              action={
                <button
                  onClick={refetchPlans}
                  className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
                >
                  Retry
                </button>
              }
            />
          ) : plansData?.plans ? (
            <div className="overflow-hidden rounded-lg border border-border bg-background-subtle">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                        Limit
                      </th>
                      {PLAN_TIERS.map((tier) => (
                        <th
                          key={tier}
                          className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-foreground-muted"
                        >
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PLAN_BADGE_COLORS[tier]}`}
                          >
                            {tier}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {limitKeys.map((key) => (
                      <tr
                        key={key}
                        className="border-b border-border last:border-b-0 hover:bg-background-muted transition-colors duration-150"
                      >
                        <td className="px-4 py-2.5 text-sm text-foreground">
                          {LIMIT_LABELS[key] ?? key}
                        </td>
                        {PLAN_TIERS.map((tier) => (
                          <td
                            key={tier}
                            className="px-4 py-2.5 text-sm text-right text-foreground-muted tabular-nums"
                          >
                            {formatLimitValue(key, plansData.plans[tier].limits[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Right panel: Tenant Config Inspector ── */}
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-4">Tenant Config Inspector</h2>

          {/* Tenant picker */}
          <div className="relative mb-6">
            <div
              className="flex items-center gap-2 h-10 px-3 rounded-md border border-border bg-background-subtle cursor-pointer"
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <Search className="h-4 w-4 text-foreground-subtle" />
              {selectedTenant ? (
                <span className="text-sm text-foreground">
                  {selectedTenant.name}{' '}
                  <span className="text-foreground-muted">({selectedTenant.slug})</span>
                </span>
              ) : (
                <span className="text-sm text-foreground-subtle">
                  Select a tenant to inspect...
                </span>
              )}
            </div>

            {dropdownOpen && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-background-subtle shadow-lg">
                <div className="p-2">
                  <input
                    type="text"
                    value={tenantSearch}
                    onChange={(e) => setTenantSearch(e.target.value)}
                    placeholder="Filter tenants..."
                    autoFocus
                    className="w-full h-8 px-3 rounded border border-border bg-background text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent"
                  />
                </div>
                <ul className="max-h-60 overflow-y-auto">
                  {filteredTenants.length === 0 ? (
                    <li className="px-4 py-3 text-sm text-foreground-muted">No tenants found</li>
                  ) : (
                    filteredTenants.map((tenant) => (
                      <li
                        key={tenant._id}
                        onClick={() => selectTenant(tenant)}
                        className="px-4 py-2 text-sm text-foreground cursor-pointer hover:bg-background-muted transition-colors"
                      >
                        <div className="font-medium">{tenant.name}</div>
                        <div className="text-xs text-foreground-muted">
                          {tenant.slug} &middot; {tenant.planTier ?? 'free'}
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
          </div>

          {/* No tenant selected state */}
          {!selectedTenantId && (
            <EmptyState
              icon={<Settings2 className="h-10 w-10" />}
              title="No tenant selected"
              description="Select a tenant above to view their resolved configuration and manage overrides."
            />
          )}

          {/* Loading state */}
          {selectedTenantId && configLoading && <SkeletonTable rows={8} />}

          {/* Error state */}
          {selectedTenantId && configError && (
            <EmptyState
              title="Failed to load tenant config"
              description={configError}
              action={
                <button
                  onClick={refetchConfig}
                  className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
                >
                  Retry
                </button>
              }
            />
          )}

          {/* Tenant config display */}
          {selectedTenantId && tenantConfig?.config && !configLoading && (
            <div>
              {/* Tenant meta */}
              <div className="mb-4 flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${PLAN_BADGE_COLORS[tenantConfig.config.plan] ?? PLAN_BADGE_COLORS.FREE}`}
                >
                  {tenantConfig.config.plan}
                </span>
                {overriddenKeys.size > 0 && (
                  <span className="text-xs text-success">
                    {overriddenKeys.size} override{overriddenKeys.size !== 1 ? 's' : ''} active
                  </span>
                )}
              </div>

              {/* Action buttons */}
              <div className="mb-4 flex items-center gap-2">
                {!editMode ? (
                  <>
                    <button
                      onClick={startEditing}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit Overrides
                    </button>
                    {overriddenKeys.size > 0 && (
                      <button
                        onClick={() => setClearDialogOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-error/30 text-error hover:bg-error/10 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Clear All
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      onClick={saveOverrides}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEditing}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:opacity-50 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  </>
                )}
              </div>

              {/* Save error */}
              {saveError && (
                <div className="mb-4 flex items-center gap-2 rounded-md bg-error/10 border border-error/25 px-3 py-2 text-sm text-error">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {saveError}
                </div>
              )}

              {/* Resolved config table */}
              <div className="overflow-hidden rounded-lg border border-border bg-background-subtle">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                          Limit
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-foreground-muted">
                          Plan Default
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-foreground-muted">
                          {editMode ? 'Override Value' : 'Resolved'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Object.keys(tenantConfig.config.limits) as (keyof TenantLimits)[]).map(
                        (key) => {
                          const resolved = tenantConfig.config.limits[key];
                          const planDefault = tenantConfig.planDefaults.limits[key];
                          const isOverridden = overriddenKeys.has(key);

                          return (
                            <tr
                              key={key}
                              className="border-b border-border last:border-b-0 hover:bg-background-muted transition-colors duration-150"
                            >
                              <td className="px-4 py-2.5 text-sm text-foreground">
                                {LIMIT_LABELS[key] ?? key}
                              </td>
                              <td className="px-4 py-2.5 text-sm text-right text-foreground-muted tabular-nums">
                                {formatLimitValue(key, planDefault)}
                              </td>
                              <td className="px-4 py-2.5 text-sm text-right tabular-nums">
                                {editMode ? (
                                  <input
                                    type="text"
                                    value={editValues[key] ?? ''}
                                    onChange={(e) =>
                                      setEditValues((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                      }))
                                    }
                                    placeholder={String(planDefault)}
                                    className="w-28 h-7 px-2 text-right text-sm rounded border border-border bg-background text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent"
                                  />
                                ) : (
                                  <span
                                    className={
                                      isOverridden
                                        ? 'text-success font-medium'
                                        : 'text-foreground-muted'
                                    }
                                  >
                                    {formatLimitValue(key, resolved)}
                                    {isOverridden && (
                                      <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-70">
                                        override
                                      </span>
                                    )}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Clear overrides confirmation */}
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title="Clear All Overrides"
        description={`This will remove all custom limit overrides for ${selectedTenant?.name ?? 'this tenant'} and revert to plan defaults. This action cannot be undone.`}
        confirmLabel="Clear Overrides"
        variant="destructive"
        onConfirm={clearOverrides}
        loading={clearing}
        loadingLabel="Clearing..."
      />
    </div>
  );
}
