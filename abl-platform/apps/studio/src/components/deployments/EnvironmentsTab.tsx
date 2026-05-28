/**
 * EnvironmentsTab Component
 *
 * Shows environment cards (dev, staging, production) with their active deployment,
 * plus deployment history below.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Plus, Rocket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DeploymentCard } from './DeploymentCard';
import { CreateDeploymentDialog } from './CreateDeploymentDialog';
import { EnvironmentVariablesSection } from './EnvironmentVariablesSection';
import { PromoteDeploymentDialog } from './PromoteDeploymentDialog';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  fetchDeployments,
  retireDeployment,
  rollbackDeployment,
  type Deployment,
} from '../../api/deployments';

interface EnvironmentsTabProps {
  projectId: string;
}

const ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

const envColors: Record<string, string> = {
  dev: 'bg-info-subtle border-info',
  staging: 'bg-warning-subtle border-warning',
  production: 'bg-success-subtle border-success',
};

export function EnvironmentsTab({ projectId }: EnvironmentsTabProps) {
  const t = useTranslations('deployments');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [defaultEnv, setDefaultEnv] = useState<string | undefined>();
  const [retireTarget, setRetireTarget] = useState<Deployment | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<Deployment | null>(null);
  const [isRetiring, setIsRetiring] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDeployments(projectId);
      setDeployments(data.deployments);
    } catch {
      toast.error(t('load_failed'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const activeByEnv = (env: string) =>
    deployments.find((d) => d.environment === env && d.status === 'active');

  const historyDeployments = deployments.filter((d) => d.status !== 'active');

  const handleRetire = async () => {
    if (!retireTarget) return;
    setIsRetiring(true);
    try {
      await retireDeployment(projectId, retireTarget.id);
      toast.success(t('retire_success'));
      setRetireTarget(null);
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('retire_failed')));
    } finally {
      setIsRetiring(false);
    }
  };

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    setIsRollingBack(true);
    try {
      await rollbackDeployment(projectId, rollbackTarget.id);
      toast.success(t('environments_tab.rollback_success'));
      setRollbackTarget(null);
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('rollback_failed')));
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleNewDeploy = (env?: string) => {
    setDefaultEnv(env);
    setShowCreateDialog(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {t('environments_tab.active_deployments_count', {
            count: deployments.filter((d) => d.status === 'active').length,
          })}
        </p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => handleNewDeploy()}
        >
          {t('environments_tab.new_deploy')}
        </Button>
      </div>

      {/* Base (Default) variables — shared across all environments */}
      <div className="rounded-xl border p-4 bg-background-elevated border-default">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t('env_labels.base', { defaultMessage: 'Base (Default)' })}
          </h3>
          <Badge variant="default">fallback</Badge>
        </div>
        <p className="text-xs text-muted mb-2">
          {t('environments_tab.base_description', {
            defaultMessage:
              'Variables defined here apply to all environments unless overridden by an environment-specific value.',
          })}
        </p>
        <EnvironmentVariablesSection projectId={projectId} environment="global" />
      </div>

      {/* Environment cards */}
      <div className="space-y-4">
        {ENVIRONMENTS.map((env) => {
          const active = activeByEnv(env);

          return (
            <div key={env} className={`rounded-xl border p-4 ${envColors[env]}`}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {t(`env_labels.${env}`)}
                  </h3>
                  {active && <Badge variant="success">{t('status.active')}</Badge>}
                </div>
                {!active && (
                  <Button variant="primary" size="sm" onClick={() => handleNewDeploy(env)}>
                    {t('environments_tab.deploy_now')}
                  </Button>
                )}
              </div>

              {active ? (
                <DeploymentCard
                  deployment={active}
                  onRetire={() => setRetireTarget(active)}
                  onRollback={() => setRollbackTarget(active)}
                  onPromote={() => setPromoteTarget(active)}
                />
              ) : (
                <p className="text-sm text-muted py-2">
                  {t('environments_tab.no_active_deployment')}
                </p>
              )}

              <EnvironmentVariablesSection projectId={projectId} environment={env} />
            </div>
          );
        })}
      </div>

      {/* Deployment History */}
      {historyDeployments.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted mb-3">
            {t('environments_tab.deployment_history')}
          </h3>
          <div className="space-y-2">
            {historyDeployments.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-4 p-3 rounded-lg bg-background-elevated border border-default text-sm"
              >
                <span className="text-xs font-mono text-muted">#{d.id.substring(0, 8)}</span>
                <Badge variant="default">{d.environment}</Badge>
                <Badge variant={d.status === 'draining' ? 'warning' : 'default'}>{d.status}</Badge>
                <span className="text-xs text-muted flex-1">
                  {Object.entries(d.agentVersionManifest ?? {})
                    .map(([a, v]) => `${a}@${v}`)
                    .join(', ')}
                </span>
                <span className="text-xs text-muted">
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state when no deployments at all */}
      {deployments.length === 0 && (
        <EmptyState
          icon={<Rocket className="w-6 h-6" />}
          title={t('environments_tab.no_deployments_title')}
          description={t('environments_tab.no_deployments_description')}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => handleNewDeploy()}
            >
              {t('create')}
            </Button>
          }
        />
      )}

      {/* Create deployment dialog */}
      <CreateDeploymentDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        projectId={projectId}
        defaultEnvironment={defaultEnv}
        onCreated={load}
      />

      {/* Retire confirmation */}
      <ConfirmDialog
        open={!!retireTarget}
        onClose={() => setRetireTarget(null)}
        onConfirm={handleRetire}
        title={t('environments_tab.retire_dialog_title')}
        description={t('environments_tab.retire_dialog_description', {
          id: retireTarget?.id.substring(0, 8) ?? '',
          environment: retireTarget?.environment ?? '',
        })}
        confirmLabel={t('card.retire')}
        variant="danger"
        loading={isRetiring}
      />

      {/* Rollback confirmation */}
      <ConfirmDialog
        open={!!rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={handleRollback}
        title={t('environments_tab.rollback_dialog_title')}
        description={t('environments_tab.rollback_dialog_description', {
          environment: rollbackTarget?.environment ?? '',
        })}
        confirmLabel={t('card.rollback')}
        variant="danger"
        loading={isRollingBack}
      />

      {/* Promote dialog */}
      {promoteTarget && (
        <PromoteDeploymentDialog
          open={!!promoteTarget}
          onClose={() => setPromoteTarget(null)}
          projectId={projectId}
          sourceDeployment={promoteTarget}
          onPromoted={load}
        />
      )}
    </div>
  );
}
