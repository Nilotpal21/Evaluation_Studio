/**
 * GuardrailsConfigPage
 *
 * Top-level project guardrails page with three tabs:
 *   - Policies: Project-scoped guardrail policy list
 *   - Providers: Tenant-scoped guardrail provider configs
 *   - Audit: Guardrail evaluation history (stub)
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Shield,
  Plug,
  FileText,
  ToggleLeft,
  ToggleRight,
  Pencil,
  Trash2,
  Plus,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useGuardrailPolicies, useGuardrailProviders } from '../../hooks/useGuardrails';
import type {
  GuardrailPolicy,
  GuardrailProvider,
  CreateProviderInput,
} from '../../hooks/useGuardrails';
import { toast } from 'sonner';
import { PageHeader } from '../ui/PageHeader';
import { Tabs } from '../ui/Tabs';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { GuardrailProviderForm } from '../admin/GuardrailProviderForm';
import { GuardrailPolicyForm } from './GuardrailPolicyForm';

// =============================================================================
// TYPES
// =============================================================================

type GuardrailTab = 'policies' | 'providers' | 'audit';

// =============================================================================
// POLICIES TAB
// =============================================================================

function PoliciesTab() {
  const t = useTranslations('guardrails_config');
  const tAdmin = useTranslations('admin.guardrails');
  const { projectId } = useNavigationStore();
  const { policies, isLoading, error, createPolicy, updatePolicy, deletePolicy, activatePolicy } =
    useGuardrailPolicies(projectId);
  const {
    policies: tenantPolicies,
    isLoading: isTenantPoliciesLoading,
    error: tenantPoliciesError,
  } = useGuardrailPolicies(null, { scope: 'tenant' });

  const [showForm, setShowForm] = useState(false);
  const [editPolicy, setEditPolicy] = useState<GuardrailPolicy | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deletePolicyObj = policies.find((p) => p._id === deleteId);

  const getPolicyStatus = (policy: GuardrailPolicy): 'draft' | 'active' | 'archived' => {
    if (policy.status === 'archived') {
      return 'archived';
    }
    return policy.isActive ? 'active' : 'draft';
  };

  const getPolicyBadgeVariant = (
    status: 'draft' | 'active' | 'archived',
  ): 'default' | 'success' | 'warning' => {
    if (status === 'active') {
      return 'success';
    }
    if (status === 'archived') {
      return 'warning';
    }
    return 'default';
  };

  const activeTenantBaselines = tenantPolicies.filter(
    (policy) => getPolicyStatus(policy) === 'active',
  );

  const handleSubmit = async (input: Record<string, unknown>) => {
    if (editPolicy) {
      const result = await updatePolicy(editPolicy._id, input as any);
      return { autoDeactivated: result?.autoDeactivated === true };
    }
    await createPolicy(input as any);
    return { autoDeactivated: false };
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deletePolicy(deleteId);
      toast.success(tAdmin('policy_deleted'));
    } catch {
      toast.error(tAdmin('policy_delete_failed'));
    }
    setDeleteId(null);
  };

  const handleToggleActive = async (policy: GuardrailPolicy) => {
    try {
      await activatePolicy(policy._id, !policy.isActive);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update policy status';
      toast.error(message);
      // Auto-open the policy editor so the user can act on the error
      // (typically: enable at least one rule to satisfy the activation gate).
      if (!policy.isActive) {
        setEditPolicy(policy);
        setShowForm(true);
      }
    }
  };

  if (isLoading || isTenantPoliciesLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="text-center text-sm text-error">{error}</div>;
  }

  return (
    <>
      <div className="space-y-6">
        {activeTenantBaselines.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider">
                  Tenant baselines affecting runtime
                </h3>
                <p className="text-xs text-muted mt-1">
                  These active tenant policies are applied before this project&apos;s local
                  guardrail policies.
                </p>
              </div>
              <Badge variant="info" appearance="outlined">
                Read only
              </Badge>
            </div>

            {activeTenantBaselines.map((policy: GuardrailPolicy) => {
              const status = getPolicyStatus(policy);
              return (
                <div
                  key={`tenant-${policy._id}`}
                  className="flex items-center justify-between p-4 bg-background-elevated rounded-xl border border-default"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground truncate">
                        {policy.name}
                      </h3>
                      <Badge variant="info" appearance="outlined">
                        Tenant
                      </Badge>
                      <Badge variant={getPolicyBadgeVariant(status)}>
                        {status === 'active'
                          ? tAdmin('status_active')
                          : status === 'archived'
                            ? tAdmin('status_archived')
                            : tAdmin('status_draft')}
                      </Badge>
                    </div>
                    {policy.description && (
                      <p className="text-xs text-muted mt-1 truncate">{policy.description}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tenantPoliciesError && (
          <div className="text-xs text-warning">
            Tenant baseline policies are temporarily unavailable: {tenantPoliciesError}
          </div>
        )}

        <div className="space-y-3">
          {/* Header with Add button */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider">
              {policies.length} {policies.length === 1 ? 'policy' : 'policies'}
            </h3>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => {
                setEditPolicy(undefined);
                setShowForm(true);
              }}
            >
              {t('add_policy')}
            </Button>
          </div>

          {policies.length === 0 ? (
            <EmptyState
              icon={<Shield className="w-6 h-6" />}
              title={t('policies_empty.title')}
              description={t('policies_empty.description')}
            />
          ) : (
            policies.map((policy: GuardrailPolicy) =>
              (() => {
                const status = getPolicyStatus(policy);
                return (
                  <div
                    key={policy._id}
                    className="flex items-center justify-between p-4 bg-background-elevated rounded-xl border border-default hover:border-accent transition-default"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-foreground truncate">
                          {policy.name}
                        </h3>
                        <Badge variant={getPolicyBadgeVariant(status)}>
                          {status === 'active'
                            ? tAdmin('status_active')
                            : status === 'archived'
                              ? tAdmin('status_archived')
                              : tAdmin('status_draft')}
                        </Badge>
                      </div>
                      {policy.description && (
                        <p className="text-xs text-muted mt-1 truncate">{policy.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(policy)}
                        className="p-1.5 rounded-lg hover:bg-background-muted text-muted hover:text-foreground transition-default"
                        aria-label={policy.isActive ? 'Deactivate' : 'Activate'}
                      >
                        {policy.isActive ? (
                          <ToggleRight className="w-4 h-4 text-success" />
                        ) : (
                          <ToggleLeft className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditPolicy(policy);
                          setShowForm(true);
                        }}
                        className="p-1.5 rounded-lg hover:bg-background-muted text-muted hover:text-foreground transition-default"
                        aria-label="Edit policy"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteId(policy._id)}
                        className="p-1.5 rounded-lg hover:bg-error-subtle text-muted hover:text-error transition-default"
                        aria-label="Delete policy"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })(),
            )
          )}
        </div>
      </div>

      {/* Policy form dialog */}
      <GuardrailPolicyForm
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditPolicy(undefined);
        }}
        onSubmit={handleSubmit}
        initial={editPolicy}
        projectId={projectId ?? ''}
      />

      {/* Delete confirmation dialog */}
      {deleteId && (
        <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground">
              {tAdmin('delete_policy_title')}
            </h3>
            <p className="text-sm text-muted">
              {tAdmin('delete_policy_description', { name: deletePolicyObj?.name ?? '' })}
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setDeleteId(null)} className="flex-1">
                {tAdmin('cancel')}
              </Button>
              <Button variant="danger" onClick={handleDelete} className="flex-1">
                {tAdmin('delete_confirm')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

// =============================================================================
// PROVIDERS TAB
// =============================================================================

function ProvidersTab() {
  const t = useTranslations('guardrails_config');
  const tAdmin = useTranslations('admin.guardrails');
  const { providers, isLoading, error, createProvider, updateProvider, deleteProvider } =
    useGuardrailProviders();

  const [showForm, setShowForm] = useState(false);
  const [editProvider, setEditProvider] = useState<GuardrailProvider | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteProviderObj = providers.find((p) => p._id === deleteId);

  const handleSubmit = async (input: CreateProviderInput) => {
    if (editProvider) {
      await updateProvider(editProvider._id, input);
    } else {
      await createProvider(input);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteProvider(deleteId);
      toast.success(tAdmin('provider_deleted'));
    } catch {
      toast.error(tAdmin('provider_delete_failed'));
    }
    setDeleteId(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="text-center text-sm text-error">{error}</div>;
  }

  return (
    <>
      <div className="space-y-3">
        {/* Header with Add button */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider">
            {providers.length} {providers.length === 1 ? 'provider' : 'providers'}
          </h3>
          {providers.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => {
                setEditProvider(undefined);
                setShowForm(true);
              }}
            >
              {t('add_provider')}
            </Button>
          )}
        </div>

        {providers.length === 0 ? (
          <EmptyState
            icon={<Plug className="w-6 h-6" />}
            title={t('providers_empty.title')}
            description={t('providers_empty.description')}
            action={
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => {
                  setEditProvider(undefined);
                  setShowForm(true);
                }}
              >
                {t('add_provider')}
              </Button>
            }
          />
        ) : (
          providers.map((provider: GuardrailProvider) => (
            <div
              key={provider._id}
              className="flex items-center justify-between p-4 bg-background-elevated rounded-xl border border-default hover:border-accent transition-default"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-foreground">{provider.name}</h3>
                  <span className="text-xs text-muted font-mono">{provider.adapterType}</span>
                  <Badge variant={provider.isActive ? 'success' : 'default'}>
                    {provider.isActive ? t('status.active') : t('status.disabled')}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                  {provider.endpoint && (
                    <span>
                      {t('endpoint_label')} {provider.endpoint}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditProvider(provider);
                    setShowForm(true);
                  }}
                  className="p-1.5 rounded-lg hover:bg-background-muted text-muted hover:text-foreground transition-default"
                  aria-label="Edit provider"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteId(provider._id)}
                  className="p-1.5 rounded-lg hover:bg-error-subtle text-muted hover:text-error transition-default"
                  aria-label="Delete provider"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Provider form dialog */}
      <GuardrailProviderForm
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditProvider(undefined);
        }}
        onSubmit={handleSubmit}
        initial={editProvider}
      />

      {/* Delete confirmation dialog */}
      {deleteId && (
        <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground">
              {tAdmin('delete_provider_title')}
            </h3>
            <p className="text-sm text-muted">
              {tAdmin('delete_provider_description', { name: deleteProviderObj?.name ?? '' })}
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setDeleteId(null)} className="flex-1">
                {tAdmin('cancel')}
              </Button>
              <Button variant="danger" onClick={handleDelete} className="flex-1">
                {tAdmin('delete_confirm')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

// =============================================================================
// AUDIT TAB (stub)
// =============================================================================

function AuditTab() {
  const t = useTranslations('guardrails_config');
  return (
    <EmptyState
      icon={<FileText className="w-6 h-6" />}
      title={t('audit_stub.title')}
      description={t('audit_stub.description')}
    />
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

const TAB_DEFS: { id: GuardrailTab; labelKey: string; Icon: typeof Shield }[] = [
  { id: 'policies', labelKey: 'tab.policies', Icon: Shield },
  { id: 'providers', labelKey: 'tab.providers', Icon: Plug },
  { id: 'audit', labelKey: 'tab.audit', Icon: FileText },
];

export function GuardrailsConfigPage() {
  const t = useTranslations('guardrails_config');
  const [activeTab, setActiveTab] = useState<GuardrailTab>('policies');

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader title={t('title')} description={t('subtitle')} />

        <Tabs
          tabs={TAB_DEFS.map(({ id, labelKey, Icon }) => ({
            id,
            label: t(labelKey),
            icon: <Icon className="w-3.5 h-3.5" />,
          }))}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as GuardrailTab)}
          layoutId="guardrails-tabs"
          className="mt-6"
        />

        <div className="mt-6">
          {activeTab === 'policies' && <PoliciesTab />}
          {activeTab === 'providers' && <ProvidersTab />}
          {activeTab === 'audit' && <AuditTab />}
        </div>
      </div>
    </div>
  );
}
