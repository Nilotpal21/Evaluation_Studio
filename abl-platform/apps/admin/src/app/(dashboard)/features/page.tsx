'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { ToggleLeft, Search, CheckCircle, XCircle, RefreshCw, Loader2 } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import { PageHeader, SkeletonCard, EmptyState } from '@agent-platform/admin-ui';
import { featureTierIntent, getBadgeIntentStyles } from '@agent-platform/design-tokens';
import type {
  FeatureCatalogEntry,
  FeatureCatalogResponse,
  TenantFeaturesResponse,
} from '../../../types/api';

// ─── Tier Badge ────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: string }) {
  const styles = getBadgeIntentStyles(featureTierIntent(tier));
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles.badge}`}
    >
      {tier}
    </span>
  );
}

// ─── Feature Card ──────────────────────────────────────────────────────────

function FeatureCard({ featureKey, entry }: { featureKey: string; entry: FeatureCatalogEntry }) {
  return (
    <div className="rounded-lg border border-border bg-background-subtle p-5 transition-colors hover:bg-background-muted">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground truncate">{entry.name}</h3>
        <TierBadge tier={entry.tier} />
      </div>
      <p className="text-xs text-foreground-muted leading-relaxed mb-3">{entry.description}</p>
      <div className="flex justify-between text-xs">
        <span className="text-foreground-muted">Key</span>
        <span className="text-foreground font-mono">{featureKey}</span>
      </div>
    </div>
  );
}

// ─── Feature Toggle Switch ────────────────────────────────────────────────

function FeatureToggle({
  checked,
  saving,
  onToggle,
}: {
  checked: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={saving}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-success' : 'bg-background-elevated'
      }`}
    >
      {saving ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={12} className="animate-spin text-accent-foreground" />
        </span>
      ) : (
        <span
          className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      )}
    </button>
  );
}

// ─── Tenant Feature Row ────────────────────────────────────────────────────

function TenantFeatureRow({
  featureKey,
  enabled,
  catalog,
  onToggle,
  saving,
  feedback,
}: {
  featureKey: string;
  enabled: boolean;
  catalog: Record<string, FeatureCatalogEntry>;
  onToggle: (featureId: string, newEnabled: boolean) => void;
  saving: boolean;
  feedback: { type: 'success' | 'error'; message: string } | null;
}) {
  const entry = catalog[featureKey];
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-background-subtle px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        {enabled ? (
          <CheckCircle size={16} className="shrink-0 text-success" />
        ) : (
          <XCircle size={16} className="shrink-0 text-foreground-muted" />
        )}
        <div className="min-w-0">
          <span className="text-sm font-medium text-foreground">{entry?.name ?? featureKey}</span>
          {entry?.description && (
            <p className="text-xs text-foreground-muted truncate">{entry.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {feedback && (
          <span
            className={`text-xs ${feedback.type === 'success' ? 'text-success' : 'text-error'}`}
          >
            {feedback.message}
          </span>
        )}
        {entry && <TierBadge tier={entry.tier} />}
        <FeatureToggle
          checked={enabled}
          saving={saving}
          onToggle={() => onToggle(featureKey, !enabled)}
        />
      </div>
    </div>
  );
}

// ─── Tenant Lookup Section ─────────────────────────────────────────────────

function TenantFeatureLookup({ catalog }: { catalog: Record<string, FeatureCatalogEntry> }) {
  const [tenantIdInput, setTenantIdInput] = useState('');
  const [lookupTenantId, setLookupTenantId] = useState<string | null>(null);
  const [savingFeatures, setSavingFeatures] = useState<Record<string, boolean>>({});
  const [featureFeedback, setFeatureFeedback] = useState<
    Record<string, { type: 'success' | 'error'; message: string }>
  >({});

  const { data, loading, error, refetch } = useApi<TenantFeaturesResponse>(
    lookupTenantId ? `/api/features/${encodeURIComponent(lookupTenantId)}` : null,
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = tenantIdInput.trim();
      if (trimmed) {
        setLookupTenantId(trimmed);
        // Clear feedback when looking up a new tenant
        setFeatureFeedback({});
      }
    },
    [tenantIdInput],
  );

  const handleToggle = useCallback(
    async (featureId: string, newEnabled: boolean) => {
      if (!lookupTenantId) return;

      setSavingFeatures((prev) => ({ ...prev, [featureId]: true }));
      setFeatureFeedback((prev) => {
        const next = { ...prev };
        delete next[featureId];
        return next;
      });

      try {
        const res = await fetch(`/api/features/${encodeURIComponent(lookupTenantId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ featureId, enabled: newEnabled }),
        });

        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }

        const result = await res.json();

        if (!res.ok || !result.success) {
          const errorMsg =
            typeof result.error === 'string'
              ? result.error
              : result.error?.message || 'Toggle failed';
          setFeatureFeedback((prev) => ({
            ...prev,
            [featureId]: { type: 'error', message: errorMsg },
          }));
          return;
        }

        setFeatureFeedback((prev) => ({
          ...prev,
          [featureId]: { type: 'success', message: 'Saved' },
        }));

        // Clear success feedback after 2 seconds
        setTimeout(() => {
          setFeatureFeedback((prev) => {
            const next = { ...prev };
            if (next[featureId]?.type === 'success') {
              delete next[featureId];
            }
            return next;
          });
        }, 2000);

        // Refetch to confirm the change
        refetch();
      } catch {
        setFeatureFeedback((prev) => ({
          ...prev,
          [featureId]: { type: 'error', message: 'Network error' },
        }));
      } finally {
        setSavingFeatures((prev) => ({ ...prev, [featureId]: false }));
      }
    },
    [lookupTenantId, refetch],
  );

  const featureEntries = useMemo(() => {
    if (!data?.features) return [];
    return Object.keys(catalog)
      .map((key) => [key, data.features[key] === true] as const)
      .sort(([, a], [, b]) => {
        if (a === b) return 0;
        return a ? -1 : 1;
      });
  }, [catalog, data]);

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-1">
        <Search size={16} className="text-foreground-muted" />
        <h2 className="text-sm font-semibold text-foreground">Tenant Feature Lookup</h2>
      </div>
      <p className="text-xs text-foreground-muted mb-4">
        Resolve which features are enabled for a specific tenant based on their plan and active
        deals.
      </p>

      <form onSubmit={handleSubmit} className="flex items-center gap-3 mb-6">
        <input
          type="text"
          value={tenantIdInput}
          onChange={(e) => setTenantIdInput(e.target.value)}
          placeholder="Enter tenant ID..."
          className="flex-1 max-w-md rounded-md border border-border bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
        />
        <button
          type="submit"
          disabled={!tenantIdInput.trim() || loading}
          className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading && <RefreshCw size={14} className="animate-spin" />}
          Check Features
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-error bg-error-subtle px-4 py-3 mb-4">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {data?.success && (
        <div>
          <div className="flex items-center gap-4 mb-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-foreground-muted">Tenant</span>
              <span className="rounded bg-background-elevated px-2 py-0.5 text-xs font-mono text-foreground-subtle">
                {data.tenantId}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-foreground-muted">Plan</span>
              <TierBadge tier={data.planTier} />
            </div>
          </div>

          <div className="space-y-2">
            {featureEntries.map(([key, enabled]) => (
              <TenantFeatureRow
                key={key}
                featureKey={key}
                enabled={enabled}
                catalog={catalog}
                onToggle={handleToggle}
                saving={!!savingFeatures[key]}
                feedback={featureFeedback[key] ?? null}
              />
            ))}
          </div>

          {featureEntries.length === 0 && (
            <EmptyState title="No features" description="No features are defined in the catalog." />
          )}
        </div>
      )}
    </section>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function FeaturesPage() {
  const { data, loading, error, refetch } = useApi<FeatureCatalogResponse>('/api/features');

  const catalogEntries = useMemo(() => {
    if (!data?.catalog) return [];
    return Object.entries(data.catalog);
  }, [data]);

  if (loading && !data) {
    return (
      <div>
        <PageHeader
          title="Feature Catalog"
          description="Platform feature flags and tenant feature resolution"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
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
        onClick={() => refetch()}
        className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
      >
        <RefreshCw size={14} />
        Retry
      </button>
    );
    return (
      <div>
        <PageHeader
          title="Feature Catalog"
          description="Platform feature flags and tenant feature resolution"
        />
        <EmptyState
          title="Failed to load feature catalog"
          description={error}
          action={retryButton}
        />
      </div>
    );
  }

  const catalog = data?.catalog ?? {};

  return (
    <div>
      <PageHeader
        title="Feature Catalog"
        description="Platform feature flags and tenant feature resolution"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">
              {catalogEntries.length} feature{catalogEntries.length !== 1 ? 's' : ''}
            </span>
            <ToggleLeft size={16} className="text-foreground-muted" />
          </div>
        }
      />

      {catalogEntries.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {catalogEntries.map(([key, entry]) => (
            <FeatureCard key={key} featureKey={key} entry={entry} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No features"
          description="The feature catalog is empty. Features will appear here once configured."
        />
      )}

      <TenantFeatureLookup catalog={catalog} />
    </div>
  );
}
