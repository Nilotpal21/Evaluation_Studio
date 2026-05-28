/**
 * PromoteDeploymentDialog Component
 *
 * Dialog for promoting a deployment to another environment.
 * Shows target environment picker, label/description, and optional model overrides.
 */

import { useState, useEffect } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { promoteDeployment, type Deployment } from '../../api/deployments';

interface PromoteDeploymentDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  sourceDeployment: Deployment;
  onPromoted: () => void;
}

const ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

const envOrder: Record<string, number> = {
  dev: 0,
  staging: 1,
  production: 2,
};

export function PromoteDeploymentDialog({
  open,
  onClose,
  projectId,
  sourceDeployment,
  onPromoted,
}: PromoteDeploymentDialogProps) {
  const t = useTranslations('deployments');
  const sourceOrder = envOrder[sourceDeployment.environment] ?? 0;
  const forwardEnvs = ENVIRONMENTS.filter((e) => envOrder[e] > sourceOrder);

  const [targetEnv, setTargetEnv] = useState<string>(forwardEnvs[0] ?? '');
  const [label, setLabel] = useState(sourceDeployment.label ?? '');
  const [description, setDescription] = useState(sourceDeployment.description ?? '');
  const [showOverrides, setShowOverrides] = useState(false);
  const [promoting, setPromoting] = useState(false);

  // Reset form when source changes
  useEffect(() => {
    const fwd = ENVIRONMENTS.filter(
      (e) => envOrder[e] > (envOrder[sourceDeployment.environment] ?? 0),
    );
    setTargetEnv(fwd[0] ?? '');
    setLabel(sourceDeployment.label ?? '');
    setDescription(sourceDeployment.description ?? '');
    setShowOverrides(false);
  }, [sourceDeployment.id]);

  const manifest = sourceDeployment.agentVersionManifest ?? {};

  const handlePromote = async () => {
    if (!targetEnv) return;
    setPromoting(true);
    try {
      const result = await promoteDeployment(projectId, sourceDeployment.id, {
        targetEnvironment: targetEnv as 'dev' | 'staging' | 'production',
        label: label || undefined,
        description: description || undefined,
      });
      const envLabel = t(`env_labels.${targetEnv}`);
      const msg =
        result.channelsUpdated > 0
          ? t('promote_dialog.success_with_channels', {
              environment: envLabel,
              count: result.channelsUpdated,
            })
          : t('promote_dialog.success', { environment: envLabel });
      toast.success(msg);
      onClose();
      onPromoted();
    } catch (err) {
      toast.error(sanitizeError(err, t('promote_dialog.error')));
    } finally {
      setPromoting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('promote_dialog.title')} maxWidth="md">
      <div className="space-y-4">
        {/* Source info */}
        <div className="p-3 rounded-lg bg-background-subtle border border-default">
          <div className="text-xs text-muted mb-1">{t('promote_dialog.source_label')}</div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              #{sourceDeployment.id.substring(0, 8)}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-background-muted text-muted">
              {t(`env_labels.${sourceDeployment.environment}`)}
            </span>
            {sourceDeployment.label && (
              <span className="text-xs text-muted">{sourceDeployment.label}</span>
            )}
          </div>
        </div>

        {/* Target environment */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('promote_dialog.target_env_label')}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {ENVIRONMENTS.map((env) => {
              const isForward = envOrder[env] > sourceOrder;
              const isCurrent = env === sourceDeployment.environment;
              return (
                <button
                  key={env}
                  type="button"
                  disabled={!isForward}
                  onClick={() => setTargetEnv(env)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-default text-sm ${
                    !isForward
                      ? 'opacity-40 cursor-not-allowed border-default bg-background-subtle text-muted'
                      : targetEnv === env
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-default bg-background-subtle text-muted hover:border-muted'
                  }`}
                >
                  <span className="font-medium">{t(`env_labels.${env}`)}</span>
                  {isCurrent && (
                    <span className="text-xs opacity-70">{t('promote_dialog.current_label')}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent manifest (read-only) */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('promote_dialog.agents_promoted_label')}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(manifest).map(([agent, version]) => (
              <span
                key={agent}
                className="inline-flex items-center px-2 py-0.5 rounded bg-background-muted text-xs text-muted"
              >
                {agent}@{version}
              </span>
            ))}
          </div>
        </div>

        {/* Label & description */}
        <Input
          label={t('promote_dialog.label_label')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('promote_dialog.label_placeholder')}
        />
        <Input
          label={t('promote_dialog.description_label')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('promote_dialog.description_placeholder')}
        />

        {/* Collapsible model overrides */}
        <button
          type="button"
          onClick={() => setShowOverrides(!showOverrides)}
          className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default"
        >
          {showOverrides ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          {t('promote_dialog.model_overrides_label')}
        </button>
        {showOverrides && (
          <div className="p-3 rounded-lg bg-background-subtle border border-default text-xs text-muted">
            {sourceDeployment.modelOverrides ? (
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(sourceDeployment.modelOverrides, null, 2)}
              </pre>
            ) : (
              t('promote_dialog.no_overrides')
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('promote_dialog.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handlePromote}
            loading={promoting}
            disabled={!targetEnv}
            icon={<ArrowUpRight className="w-3.5 h-3.5" />}
            className="flex-1"
          >
            {t('promote_dialog.promote_button', {
              environment: targetEnv ? t(`env_labels.${targetEnv}`) : '...',
            })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
