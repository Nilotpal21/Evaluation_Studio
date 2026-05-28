/**
 * GuardrailsPage Component
 *
 * Workspace-level admin page for guardrails management.
 * Two sections: Providers (tenant-level) and Policies (project-scoped).
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  ShieldCheck,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  RefreshCw,
  FileWarning,
  FlaskConical,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from 'sonner';
import { useProjectStore } from '../../store/project-store';
import { GuardrailProviderForm } from './GuardrailProviderForm';
import {
  useGuardrailProviders,
  useGuardrailPolicies,
  type GuardrailProvider,
  type GuardrailPolicy,
} from '../../hooks/useGuardrails';

// =============================================================================
// Health Status Badge
// =============================================================================

function HealthBadge({ status }: { status?: string }) {
  const t = useTranslations('admin');
  switch (status) {
    case 'healthy':
      return (
        <Badge variant="success" dot>
          {t('guardrails_extra.health_healthy')}
        </Badge>
      );
    case 'degraded':
      return (
        <Badge variant="warning" dot>
          {t('guardrails_extra.health_degraded')}
        </Badge>
      );
    case 'unhealthy':
      return (
        <Badge variant="error" dot>
          {t('guardrails_extra.health_unhealthy')}
        </Badge>
      );
    default:
      return (
        <Badge variant="default" dot>
          {t('guardrails_extra.health_unknown')}
        </Badge>
      );
  }
}

// =============================================================================
// Providers Section (tenant-level)
// =============================================================================

function ProvidersSection() {
  const t = useTranslations('admin');
  const {
    providers,
    isLoading,
    mutate,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    activateProvider,
  } = useGuardrailProviders();

  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<GuardrailProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuardrailProvider | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteProvider(deleteTarget._id);
      toast.success(t('guardrails.provider_deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails.provider_delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTest = async (provider: GuardrailProvider) => {
    setTestingId(provider._id);
    try {
      const result = await testProvider(provider._id);
      if (result.success) {
        toast.success(
          t('guardrails_extra.test_success', {
            latency: result.latencyMs ?? 0,
          }),
        );
      } else {
        toast.error(result.error || t('guardrails_extra.test_failed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails_extra.test_failed'));
    } finally {
      setTestingId(null);
      await mutate();
    }
  };

  const handleToggleActive = async (provider: GuardrailProvider) => {
    setTogglingId(provider._id);
    try {
      await activateProvider(provider._id, !provider.isActive);
      toast.success(
        provider.isActive
          ? t('guardrails_extra.provider_deactivated')
          : t('guardrails_extra.provider_activated'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails.provider_save_failed'));
    } finally {
      setTogglingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t('guardrails.providers_title')}
          </h3>
          <span className="text-xs text-muted">({providers.length})</span>
          <button
            onClick={() => mutate()}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {providers.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowCreate(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t('guardrails.add_provider')}
          </Button>
        )}
      </div>

      {providers.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="w-6 h-6" />}
          title={t('guardrails.providers_empty_title')}
          description={t('guardrails.providers_empty_description')}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowCreate(true)}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              {t('guardrails.add_provider')}
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-default overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-muted border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_name')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.provider_type_label')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.endpoint_label')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails_extra.col_health')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_status')}
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {providers.map((provider) => (
                <tr key={provider._id} className="hover:bg-background-muted transition-default">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{provider.name}</p>
                    {provider.displayName && provider.displayName !== provider.name && (
                      <p className="text-xs text-muted mt-0.5">{provider.displayName}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="info">{provider.adapterType}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted text-xs font-mono truncate max-w-[200px]">
                    {provider.endpoint || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <HealthBadge status={provider.healthStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleActive(provider)}
                      disabled={togglingId === provider._id}
                      className="flex items-center gap-1.5 text-xs transition-default disabled:opacity-50"
                      title={provider.isActive ? 'Deactivate' : 'Activate'}
                    >
                      {togglingId === provider._id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-muted" />
                      ) : provider.isActive ? (
                        <ToggleRight className="w-4 h-4 text-success" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-muted" />
                      )}
                      <span className={provider.isActive ? 'text-success' : 'text-muted'}>
                        {provider.isActive
                          ? t('guardrails_extra.enabled')
                          : t('guardrails_extra.disabled')}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTest(provider)}
                        disabled={testingId === provider._id}
                        className="p-1.5 text-muted hover:text-accent rounded transition-default disabled:opacity-50"
                        title="Test"
                      >
                        {testingId === provider._id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <FlaskConical className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => setEditTarget(provider)}
                        className="p-1.5 text-muted hover:text-accent rounded transition-default"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(provider)}
                        className="p-1.5 text-muted hover:text-error rounded transition-default"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <GuardrailProviderForm
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onSubmit={createProvider}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <GuardrailProviderForm
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          initial={editTarget}
          onSubmit={async (input) => {
            await updateProvider(editTarget._id, input);
            setEditTarget(null);
          }}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('guardrails.delete_provider_title')}
        description={t('guardrails.delete_provider_description', {
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('guardrails.delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// =============================================================================
// Policies Section (project-scoped)
// =============================================================================

function PoliciesSection() {
  const t = useTranslations('admin');
  const projects = useProjectStore((s) => s.projects);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projects[0]?.id || null,
  );

  const { policies, isLoading, mutate, deletePolicy, activatePolicy } =
    useGuardrailPolicies(selectedProjectId);

  const [deleteTarget, setDeleteTarget] = useState<GuardrailPolicy | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const projectOptions = useMemo(
    () =>
      projects.map((p) => ({
        value: p.id,
        label: p.name || p.id,
      })),
    [projects],
  );

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deletePolicy(deleteTarget._id);
      toast.success(t('guardrails.policy_deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails.policy_delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleActive = async (policy: GuardrailPolicy) => {
    setTogglingId(policy._id);
    try {
      await activatePolicy(policy._id, !policy.isActive);
      toast.success(
        policy.isActive
          ? t('guardrails_extra.policy_deactivated')
          : t('guardrails_extra.policy_activated'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails.policy_delete_failed'));
    } finally {
      setTogglingId(null);
    }
  };

  const scopeVariant = (scope: string): 'info' | 'warning' | 'accent' => {
    switch (scope) {
      case 'input':
        return 'info';
      case 'output':
        return 'warning';
      default:
        return 'accent';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{t('guardrails.policies_title')}</h3>
        <button
          onClick={() => mutate()}
          className="p-1 text-muted hover:text-foreground rounded transition-default"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="max-w-xs">
        {projectOptions.length > 0 ? (
          <Select
            label={t('guardrails.project_label')}
            options={projectOptions}
            value={selectedProjectId || ''}
            onChange={setSelectedProjectId}
          />
        ) : (
          <p className="text-sm text-muted">{t('guardrails.no_projects')}</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      ) : !selectedProjectId ? null : policies.length === 0 ? (
        <EmptyState
          icon={<FileWarning className="w-6 h-6" />}
          title={t('guardrails.policies_empty_title')}
          description={t('guardrails.policies_empty_description')}
        />
      ) : (
        <div className="rounded-xl border border-default overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-muted border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_name')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_scope')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_rules')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_status')}
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('guardrails.col_actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {policies.map((policy) => (
                <tr key={policy._id} className="hover:bg-background-muted transition-default">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{policy.name}</p>
                    {policy.description && (
                      <p className="text-xs text-muted mt-0.5 truncate max-w-[200px]">
                        {policy.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={scopeVariant(policy.scope?.type ?? 'tenant')}>
                      {policy.scope?.type ?? 'tenant'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted text-xs">
                    {t('guardrails_extra.rule_count', { count: policy.rules.length })}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleActive(policy)}
                      disabled={togglingId === policy._id}
                      className="flex items-center gap-1.5 text-xs transition-default disabled:opacity-50"
                      title={policy.isActive ? 'Deactivate' : 'Activate'}
                    >
                      {togglingId === policy._id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-muted" />
                      ) : policy.isActive ? (
                        <ToggleRight className="w-4 h-4 text-success" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-muted" />
                      )}
                      <span className={policy.isActive ? 'text-success' : 'text-muted'}>
                        {policy.isActive
                          ? t('guardrails_extra.enabled')
                          : t('guardrails_extra.disabled')}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <button
                        onClick={() => setDeleteTarget(policy)}
                        className="p-1.5 text-muted hover:text-error rounded transition-default"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('guardrails.delete_policy_title')}
        description={t('guardrails.delete_policy_description', {
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('guardrails.delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function GuardrailsPage() {
  const t = useTranslations('admin');

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <PageHeader title={t('guardrails.title')} description={t('guardrails.description')} />

        <div className="mt-8 space-y-10">
          <ProvidersSection />
          <div className="border-t border-default" />
          <PoliciesSection />
        </div>
      </div>
    </div>
  );
}
