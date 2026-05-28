/**
 * DeploymentTab — environment binding, follow/pin deployment.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Select } from '../../../ui/Select';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Checkbox';
import { fetchDeployments, type Deployment } from '../../../../api/deployments';
import { updateChannel } from '../../../../api/channels';
import { updateConnection } from '../../../../api/channel-connections';
import { sanitizeError } from '../../../../lib/sanitize-error';
import type { ChannelTabProps } from '../types';
import { AUTO_RESOLVE_DEPLOYMENT_LABEL, ENVIRONMENT_OPTIONS, formatDate } from '../channel-utils';
import {
  buildConnectionBindingUpdate,
  buildSdkChannelBindingUpdate,
  isWorkingCopyBinding,
} from '../channel-binding-utils';

// =============================================================================
// COMPONENT
// =============================================================================

export function DeploymentTab({ projectId, channelDef, instance, onRefresh }: ChannelTabProps) {
  const t = useTranslations('channels.deployment');
  const [environment, setEnvironment] = useState(instance.environment || '');
  const [followEnvironment, setFollowEnvironment] = useState<boolean>(
    instance.followEnvironment ?? Boolean(instance.environment),
  );
  const [pinnedDeploymentId, setPinnedDeploymentId] = useState(instance.deploymentId || '');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnvironment(instance.environment || '');
    setFollowEnvironment(instance.followEnvironment ?? Boolean(instance.environment));
    setPinnedDeploymentId(instance.deploymentId || '');
  }, [instance.deploymentId, instance.environment, instance.followEnvironment, instance.updatedAt]);

  // ---------------------------------------------------------------------------
  // Fetch deployments on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchDeployments(projectId);
        if (!cancelled) {
          setDeployments(result.deployments);
        }
      } catch (err) {
        if (!cancelled) {
          const message = sanitizeError(err, 'Failed to load deployments');
          toast.error(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // ---------------------------------------------------------------------------
  // Active deployments grouped by environment
  // ---------------------------------------------------------------------------

  const activeDeployments = useMemo(
    () => deployments.filter((d) => d.status === 'active'),
    [deployments],
  );

  const deploymentOptions = useMemo(() => {
    const options = [{ label: AUTO_RESOLVE_DEPLOYMENT_LABEL, value: '' }];
    for (const d of activeDeployments) {
      const label = d.label || d.endpointSlug || d.id.slice(0, 8);
      const envLabel = d.environment ? ` (${d.environment})` : '';
      options.push({ label: `${label}${envLabel}`, value: d.id });
    }
    return options;
  }, [activeDeployments]);

  const activeDeployment = useMemo(() => {
    if (!environment) return null;

    const filtered = deployments
      .filter((d) => d.environment === environment && d.status === 'active')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return filtered[0] || null;
  }, [deployments, environment]);

  // ---------------------------------------------------------------------------
  // Webhook channels don't support deployment binding yet
  // ---------------------------------------------------------------------------

  const isWebhook = instance._source === 'webhook_subscription';
  const isWorkingCopy = isWorkingCopyBinding({ pinnedDeploymentId, environment });

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (isWebhook) return;

    setSaving(true);
    try {
      switch (instance._source) {
        case 'sdk_channel':
          await updateChannel(
            projectId,
            instance._sourceId,
            buildSdkChannelBindingUpdate({
              environment,
              followEnvironment,
              pinnedDeploymentId,
            }),
          );
          break;
        case 'channel_connection':
          await updateConnection(
            projectId,
            instance._sourceId,
            buildConnectionBindingUpdate({
              environment,
              followEnvironment,
              pinnedDeploymentId,
            }),
          );
          break;
      }

      toast.success(t('saved'));
      onRefresh();
    } catch (err) {
      const message = sanitizeError(err, t('save_failed'));
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [
    isWebhook,
    environment,
    followEnvironment,
    pinnedDeploymentId,
    instance._source,
    instance._sourceId,
    projectId,
    onRefresh,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isWebhook) {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-2.5 p-4 rounded-lg bg-background-muted border border-default">
          <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />
          <p className="text-sm text-muted">{t('webhook_info')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* A. Pin to Specific Deployment */}
      <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-4">
        <h4 className="text-sm font-semibold text-foreground">Deployment</h4>

        <div>
          <Select
            label="Pin to deployment"
            options={deploymentOptions}
            value={pinnedDeploymentId}
            onChange={(val) => {
              setPinnedDeploymentId(val);
              // Clear environment when pinning to a specific deployment
              if (val) {
                setEnvironment('');
                setFollowEnvironment(false);
              }
            }}
          />
          <p className="text-xs text-muted mt-1.5">
            Select a specific deployment to pin this channel to, or use environment-based
            auto-resolution below.
          </p>
        </div>
      </div>

      {/* B. Environment-based Resolution (alternative to pinning) */}
      {!pinnedDeploymentId && (
        <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-4">
          <h4 className="text-sm font-semibold text-foreground">{t('agent_version_title')}</h4>

          <div>
            <Select
              label={t('environment_label')}
              options={ENVIRONMENT_OPTIONS}
              value={environment}
              onChange={(value) => {
                setEnvironment(value);
                if (value) {
                  setPinnedDeploymentId('');
                  setFollowEnvironment(true);
                } else {
                  setFollowEnvironment(false);
                }
              }}
            />
            <p className="text-xs text-muted mt-1.5">{t('environment_hint')}</p>
          </div>

          {/* Follow Environment — SDK channels only */}
          {instance._source === 'sdk_channel' && (
            <Checkbox
              checked={followEnvironment}
              onChange={setFollowEnvironment}
              label={t('follow_env_label')}
              description={t('follow_env_description')}
            />
          )}
        </div>
      )}

      {/* C. Current Deployment Info */}
      <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-semibold text-foreground">{t('active_deployment_title')}</h4>

        {loading ? (
          <div className="flex items-center gap-2">
            <div className="skeleton h-4 w-32 rounded" />
          </div>
        ) : pinnedDeploymentId ? (
          <div className="flex items-center gap-3">
            {(() => {
              const pinned = deployments.find((d) => d.id === pinnedDeploymentId);
              return pinned ? (
                <>
                  <Badge variant="success" dot>
                    {pinned.label || pinned.endpointSlug || pinned.id.slice(0, 8)}
                  </Badge>
                  <span className="text-xs text-muted">
                    {pinned.environment} &middot;{' '}
                    {t('active_deployment_deployed', { date: formatDate(pinned.createdAt) })}
                  </span>
                </>
              ) : (
                <p className="text-xs text-warning">Pinned deployment not found</p>
              );
            })()}
          </div>
        ) : isWorkingCopy ? (
          <p className="text-xs text-muted">{ENVIRONMENT_OPTIONS[0]?.label}</p>
        ) : activeDeployment ? (
          <div className="flex items-center gap-3">
            <Badge variant="success" dot>
              v{activeDeployment.label || activeDeployment.id.slice(0, 8)}
            </Badge>
            <span className="text-xs text-muted">
              {t('active_deployment_deployed', { date: formatDate(activeDeployment.createdAt) })}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted">{t('active_deployment_none')}</p>
        )}
      </div>

      {/* D. Save */}
      <div className="flex justify-end">
        <Button variant="primary" size="md" loading={saving} onClick={handleSave}>
          {t('save_changes')}
        </Button>
      </div>
    </div>
  );
}
