/**
 * DeploymentCard Component
 *
 * Displays a single deployment with manifest, status, and actions.
 */

import { ArrowUpRight, Clock, Eye, Hash, RotateCcw, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { Deployment } from '../../api/deployments';

interface DeploymentCardProps {
  deployment: Deployment;
  onPreview?: () => void;
  onRetire?: () => void;
  onRollback?: () => void;
  onPromote?: () => void;
}

function useTimeAgo() {
  const t = useTranslations('deployments.card');
  return (dateStr: string): string => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return t('time_just_now');
    if (seconds < 3600) return t('time_minutes_ago', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return t('time_hours_ago', { count: Math.floor(seconds / 3600) });
    return t('time_days_ago', { count: Math.floor(seconds / 86400) });
  };
}

const statusVariants: Record<string, 'success' | 'warning' | 'default'> = {
  active: 'success',
  draining: 'warning',
  retired: 'default',
};

export function DeploymentCard({
  deployment,
  onPreview,
  onRetire,
  onRollback,
  onPromote,
}: DeploymentCardProps) {
  const t = useTranslations('deployments');
  const timeAgo = useTimeAgo();
  const manifest = deployment.agentVersionManifest ?? {};
  const agentCount = Object.keys(manifest).length;
  const isActive = deployment.status === 'active';
  const isDraining = deployment.status === 'draining';

  return (
    <div className="p-4 rounded-lg bg-background-elevated border border-default">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5 text-muted" />
              {deployment.id.substring(0, 8)}
            </span>
            <Badge variant={statusVariants[deployment.status] || 'default'}>
              {deployment.status}
            </Badge>
            {deployment.label && <span className="text-xs text-muted">{deployment.label}</span>}
          </div>

          {/* Metadata */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
            <span>{t('card.agents_count', { count: agentCount })}</span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {timeAgo(deployment.createdAt)}
            </span>
            {deployment.channelCount !== undefined && (
              <span>{t('card.channels_count', { count: deployment.channelCount })}</span>
            )}
          </div>

          {/* Agent manifest */}
          <div className="flex flex-wrap gap-1.5 mt-2">
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

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onPreview && (isActive || isDraining) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Eye className="w-3.5 h-3.5" />}
              onClick={onPreview}
            >
              {t('card.preview')}
            </Button>
          )}
          {onPromote && isActive && deployment.environment !== 'production' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowUpRight className="w-3.5 h-3.5" />}
              onClick={onPromote}
            >
              {t('card.promote')}
            </Button>
          )}
          {onRollback && (isActive || isDraining) && deployment.previousDeploymentId && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              onClick={onRollback}
            >
              {t('card.rollback')}
            </Button>
          )}
          {onRetire && (isActive || isDraining) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<XCircle className="w-3.5 h-3.5" />}
              onClick={onRetire}
            >
              {t('card.retire')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
