/**
 * BillingPage Component
 *
 * Comprehensive billing dashboard showing:
 * - Current plan tier with upgrade CTA
 * - Active deals with phase indicators and renewal dates
 * - Credit balance with progress bars and per-feature breakdown
 * - Published billing usage reporting (billing units, session counts, and
 *   project/channel breakdowns)
 *
 * Data sourced from workspace billing API + published billing usage reports.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Zap,
  BarChart3,
  CreditCard,
  ArrowUpRight,
  Calendar,
  Sparkles,
  Phone,
  Bell,
  Plus,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import {
  useBillingDeals,
  useBillingCredits,
  useTenantFeatures,
  useBillingUsageReport,
  requestUpgrade,
  requestTopup,
  type BillingDeal,
  type CreditBalance,
} from '../../hooks/useBilling';
import { useAlertConfigs, type AlertConfig, type CreateAlertInput } from '../../hooks/useAlerts';
import {
  BillingUsageReportPanel,
  getBillingDateRange,
  type BillingDateRange,
} from '../billing/BillingUsageReportPanel';

// =============================================================================
// TYPES
// =============================================================================

interface ProjectInfo {
  id: string;
  name: string;
}

interface ProjectListItem {
  id?: string;
  _id?: string;
  name: string;
}

interface ProjectsResponse {
  projects?: ProjectListItem[];
  data?: ProjectListItem[];
}

// =============================================================================
// BILLING SUB-COMPONENTS
// =============================================================================

function PlanTierCard({
  planTier,
  onUpgrade,
}: {
  planTier: string | null;
  onUpgrade: (plan: string) => void;
}) {
  const t = useTranslations('admin');
  const tier = planTier || 'FREE';
  const tierColors: Record<string, string> = {
    FREE: 'text-muted',
    TEAM: 'text-info',
    BUSINESS: 'text-purple',
    ENTERPRISE: 'text-accent',
  };

  return (
    <div className="bg-background-elevated border border-default rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="text-xs text-muted uppercase tracking-wider">
            {t('billing.current_plan')}
          </span>
          <h3 className={clsx('text-2xl font-bold mt-1', tierColors[tier] || 'text-foreground')}>
            {tier}
          </h3>
        </div>
        <CreditCard className="w-8 h-8 text-muted" />
      </div>
      {tier !== 'ENTERPRISE' && (
        <button
          onClick={() => {
            const nextTier = tier === 'FREE' ? 'TEAM' : tier === 'TEAM' ? 'BUSINESS' : 'ENTERPRISE';
            onUpgrade(nextTier);
          }}
          className="w-full px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 transition-default flex items-center justify-center gap-2"
        >
          <ArrowUpRight className="w-4 h-4" />
          {t('billing.upgrade_plan')}
        </button>
      )}
      {tier === 'ENTERPRISE' && (
        <div className="text-xs text-muted text-center py-2">{t('billing.highest_plan')}</div>
      )}
    </div>
  );
}

function CreditBalanceCard({ credits }: { credits: CreditBalance | null }) {
  const t = useTranslations('admin');
  if (!credits || credits.allocated === 0) {
    return (
      <div className="bg-background-elevated border border-default rounded-xl p-6 shadow-sm">
        <span className="text-xs text-muted uppercase tracking-wider">
          {t('billing.credit_balance')}
        </span>
        <div className="mt-3 text-sm text-muted">{t('billing.no_credits')}</div>
      </div>
    );
  }

  const usagePercent = credits.allocated > 0 ? (credits.consumed / credits.allocated) * 100 : 0;
  const barColor = usagePercent > 90 ? 'bg-error' : usagePercent > 70 ? 'bg-warning' : 'bg-accent';

  return (
    <div className="bg-background-elevated border border-default rounded-xl p-6 shadow-sm">
      <span className="text-xs text-muted uppercase tracking-wider">
        {t('billing.credit_balance')}
      </span>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-foreground">
          {credits.remaining.toLocaleString()}
        </span>
        <span className="text-sm text-muted">/ {credits.allocated.toLocaleString()}</span>
      </div>
      <div className="mt-3 h-2 bg-background-muted rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(100, usagePercent)}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-muted text-right">
        {t('billing.used_percent', { percent: usagePercent.toFixed(1) })}
      </div>

      {/* Per-feature breakdown */}
      {Object.keys(credits.featureBreakdown).length > 0 && (
        <div className="mt-4 space-y-2">
          <span className="text-xs text-muted uppercase tracking-wider">
            {t('billing.per_feature')}
          </span>
          {Object.entries(credits.featureBreakdown).map(([feature, data]) => {
            const pct = data.allocated > 0 ? (data.consumed / data.allocated) * 100 : 0;
            return (
              <div key={feature}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground capitalize">{feature.replace(/_/g, ' ')}</span>
                  <span className="text-muted">
                    {data.consumed} / {data.allocated}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 bg-background-muted rounded-full overflow-hidden">
                  <div
                    className={clsx(
                      'h-full rounded-full',
                      pct > 90 ? 'bg-error' : pct > 70 ? 'bg-warning' : 'bg-info',
                    )}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DealCard({ deal }: { deal: BillingDeal }) {
  const t = useTranslations('admin');
  const now = new Date();
  const activePhase = deal.phases.find((p) => {
    const start = new Date(p.startDate);
    const end = new Date(p.endDate);
    return now >= start && now <= end;
  });

  return (
    <div className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-foreground truncate">{deal.name}</h4>
        <Badge variant={deal.status === 'active' ? 'success' : 'default'}>{deal.status}</Badge>
      </div>
      {activePhase && (
        <div className="flex items-center gap-1.5 text-xs text-muted mb-2">
          <Sparkles className="w-3 h-3" />
          <span>{t('billing.deal_phase', { name: activePhase.name })}</span>
        </div>
      )}
      {deal.renewalDate && (
        <div className="flex items-center gap-1.5 text-xs text-muted mb-2">
          <Calendar className="w-3 h-3" />
          <span>
            {t('billing.deal_renews', { date: new Date(deal.renewalDate).toLocaleDateString() })}
          </span>
        </div>
      )}
      {deal.features.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {deal.features.slice(0, 4).map((f) => (
            <Badge key={f} variant="info">
              {f.replace(/_/g, ' ')}
            </Badge>
          ))}
          {deal.features.length > 4 && <Badge variant="default">+{deal.features.length - 4}</Badge>}
        </div>
      )}
    </div>
  );
}

function ContactSalesCard() {
  const t = useTranslations('admin');
  return (
    <div className="bg-background-elevated border border-accent/20 rounded-xl p-6 shadow-sm bg-gradient-surface-accent">
      <div className="flex items-center gap-3 mb-3">
        <Phone className="w-5 h-5 text-accent" />
        <h4 className="text-sm font-semibold text-foreground">
          {t('billing.contact_sales_title')}
        </h4>
      </div>
      <p className="text-xs text-muted mb-4">{t('billing.contact_sales_description')}</p>
      <a
        href="mailto:sales@kore.ai"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-accent text-accent text-sm font-medium hover:bg-accent/10 transition-default"
      >
        {t('billing.contact_sales_cta')}
        <ArrowUpRight className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

// =============================================================================
// ALERT CONFIGURATION SECTION
// =============================================================================

const ALERT_TYPE_LABELS: Record<string, string> = {
  usage_threshold: 'Usage Threshold',
  credit_low: 'Credit Low',
  health_degraded: 'Health Degraded',
  feature_limit: 'Feature Limit',
};

const CHANNEL_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  email: 'Email',
};

function AlertConfigSection() {
  const t = useTranslations('admin');
  const { configs, loading, createAlert, updateAlert, deleteAlert } = useAlertConfigs();
  const [addOpen, setAddOpen] = useState(false);
  const [formData, setFormData] = useState<CreateAlertInput>({
    type: 'usage_threshold',
    threshold: 80,
    channel: 'webhook',
    target: '',
    enabled: true,
    cooldownMinutes: 60,
  });
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = async () => {
    if (!formData.target.trim()) return;
    setSubmitting(true);
    const ok = await createAlert(formData);
    if (ok) {
      setAddOpen(false);
      setFormData({
        type: 'usage_threshold',
        threshold: 80,
        channel: 'webhook',
        target: '',
        enabled: true,
        cooldownMinutes: 60,
      });
    }
    setSubmitting(false);
  };

  const handleToggle = async (config: AlertConfig) => {
    await updateAlert(config._id, { enabled: !config.enabled });
  };

  const handleDelete = async (id: string) => {
    await deleteAlert(id);
  };

  if (loading) {
    return (
      <div className="bg-background-elevated border border-default rounded-xl p-6">
        <div className="skeleton h-4 w-40 mb-4 rounded" />
        <div className="skeleton h-20 w-full rounded" />
      </div>
    );
  }

  return (
    <div className="bg-background-elevated border border-default rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-muted" />
          <h3 className="text-sm font-semibold text-foreground">
            {t('billing.alert_section_title')}
          </h3>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 transition-default"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('billing.alert_add')}
        </button>
      </div>

      {configs.length === 0 ? (
        <p className="text-sm text-muted">{t('billing.alert_no_rules')}</p>
      ) : (
        <div className="space-y-2">
          {configs.map((config) => (
            <div
              key={config._id}
              className="flex items-center justify-between rounded-lg border border-default p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => handleToggle(config)}
                  className={clsx(
                    'relative w-9 h-5 rounded-full transition-colors shrink-0',
                    config.enabled ? 'bg-accent' : 'bg-background-muted',
                  )}
                >
                  <span
                    className={clsx(
                      'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      config.enabled && 'translate-x-4',
                    )}
                  />
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={config.enabled ? 'success' : 'default'}>
                      {config.type === 'usage_threshold'
                        ? t('billing.alert_type_usage_threshold')
                        : config.type === 'credit_low'
                          ? t('billing.alert_type_credit_low')
                          : config.type === 'health_degraded'
                            ? t('billing.alert_type_health_degraded')
                            : config.type === 'feature_limit'
                              ? t('billing.alert_type_feature_limit')
                              : config.type}
                    </Badge>
                    <span className="text-xs text-muted">
                      {'>'}= {config.threshold}%
                    </span>
                    <Badge variant="info">
                      {config.channel === 'webhook'
                        ? t('billing.alert_channel_webhook')
                        : config.channel === 'email'
                          ? t('billing.alert_channel_email')
                          : config.channel}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted truncate mt-0.5">{config.target}</p>
                </div>
              </div>
              <button
                onClick={() => handleDelete(config._id)}
                className="p-1.5 rounded-md text-muted hover:text-error hover:bg-error/10 transition-default shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add Alert Dialog */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-overlay" onClick={() => setAddOpen(false)} />
          <div className="relative z-50 w-full max-w-md rounded-xl border border-default bg-background-elevated p-6 shadow-xl">
            <h2 className="text-base font-semibold text-foreground mb-4">
              {t('billing.alert_dialog_title')}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('billing.alert_type_label')}
                </label>
                <Select
                  options={[
                    { value: 'usage_threshold', label: t('billing.alert_type_usage_threshold') },
                    { value: 'credit_low', label: t('billing.alert_type_credit_low') },
                    { value: 'health_degraded', label: t('billing.alert_type_health_degraded') },
                    { value: 'feature_limit', label: t('billing.alert_type_feature_limit') },
                  ]}
                  value={formData.type}
                  onChange={(v) =>
                    setFormData((prev) => ({
                      ...prev,
                      type: v as CreateAlertInput['type'],
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('billing.alert_threshold_label')}
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.threshold}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      threshold: parseInt(e.target.value, 10) || 0,
                    }))
                  }
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('billing.alert_channel_label')}
                </label>
                <Select
                  options={[
                    { value: 'webhook', label: t('billing.alert_channel_webhook') },
                    { value: 'email', label: t('billing.alert_channel_email') },
                  ]}
                  value={formData.channel}
                  onChange={(v) =>
                    setFormData((prev) => ({
                      ...prev,
                      channel: v as CreateAlertInput['channel'],
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('billing.alert_target_label', {
                    channel:
                      formData.channel === 'webhook'
                        ? t('billing.alert_target_url')
                        : t('billing.alert_target_email'),
                  })}
                </label>
                <input
                  type={formData.channel === 'email' ? 'email' : 'url'}
                  value={formData.target}
                  onChange={(e) => setFormData((prev) => ({ ...prev, target: e.target.value }))}
                  placeholder={
                    formData.channel === 'webhook'
                      ? 'https://example.com/webhook'
                      : 'alerts@example.com'
                  }
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('billing.alert_cooldown_label')}
                </label>
                <input
                  type="number"
                  min="1"
                  value={formData.cooldownMinutes}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      cooldownMinutes: parseInt(e.target.value, 10) || 60,
                    }))
                  }
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setAddOpen(false)}
                disabled={submitting}
                className="px-4 py-2 rounded-lg border border-default text-sm font-medium text-muted hover:bg-background-muted transition-default"
              >
                {t('billing.alert_cancel')}
              </button>
              <button
                onClick={handleAdd}
                disabled={submitting || !formData.target.trim()}
                className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 transition-default disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? t('billing.alert_adding') : t('billing.alert_add_button')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function BillingPage() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const { deals } = useBillingDeals();
  const { credits } = useBillingCredits();
  const { planTier: subscriptionPlanTier } = useTenantFeatures();

  const handleUpgrade = async (plan: string) => {
    try {
      await requestUpgrade(plan);
    } catch {
      // Silently handle — placeholder flow
    }
  };

  const handleTopup = async () => {
    try {
      await requestTopup();
    } catch {
      // Silently handle — placeholder flow
    }
  };

  // Use actual subscription plan tier from the billing features endpoint
  const planTier = subscriptionPlanTier || 'FREE';
  const [dateRange, setDateRange] = useState<BillingDateRange>('7d');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const usageRange = useMemo(() => getBillingDateRange(dateRange), [dateRange]);
  const {
    report: data,
    isLoading,
    error: usageError,
  } = useBillingUsageReport({
    windowStart: usageRange.windowStart,
    windowEnd: usageRange.windowEnd,
    granularity: 'day',
    projectId,
  });

  // Fetch projects for the dropdown
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await apiFetch(`/api/projects?tenantId=${tenantId}`);
        if (!response.ok) {
          if (!cancelled) {
            setProjects([]);
          }
          return;
        }

        const payload = (await response.json()) as ProjectsResponse;
        const items = payload.projects ?? payload.data ?? [];
        const nextProjects = items.flatMap((project) => {
          const id = project.id ?? project._id;
          return id ? [{ id, name: project.name }] : [];
        });

        if (!cancelled) {
          setProjects(nextProjects);
        }
      } catch {
        if (!cancelled) {
          setProjects([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const projectNameMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  if (!tenantId) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <EmptyState
            icon={<BarChart3 className="w-6 h-6" />}
            title={t('billing.no_workspace_title')}
            description={t('billing.no_workspace_description')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <PageHeader title={t('billing.title')} description={t('billing.description')} />

        {/* ── Plan + Credits + Top-up Row ─────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <PlanTierCard planTier={planTier} onUpgrade={handleUpgrade} />
          <CreditBalanceCard credits={credits} />
          <div className="space-y-4">
            <button
              onClick={handleTopup}
              className="w-full px-4 py-2.5 rounded-lg border border-default bg-background-elevated text-foreground text-sm font-medium hover:bg-background-muted transition-default flex items-center justify-center gap-2"
            >
              <Zap className="w-4 h-4 text-warning" />
              {t('billing.top_up_credits')}
            </button>
            <ContactSalesCard />
          </div>
        </div>

        {/* ── Active Deals ────────────────────────────────────────────── */}
        {deals.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              {t('billing.active_deals')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {deals.map((deal) => (
                <DealCard key={deal._id} deal={deal} />
              ))}
            </div>
          </div>
        )}

        <BillingUsageReportPanel
          report={data}
          isLoading={isLoading}
          error={usageError}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          selectedProjectId={projectId}
          projectNameMap={projectNameMap}
          showTopDivider
          projectFilter={{
            options: [
              { value: '', label: t('billing.all_projects') },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ],
            value: projectId || '',
            onChange: (value) => setProjectId(value || null),
          }}
        />

        {/* ── Alert Configuration ──────────────────────────────────────── */}
        <div className="border-t border-default pt-6">
          <AlertConfigSection />
        </div>
      </div>
    </div>
  );
}
