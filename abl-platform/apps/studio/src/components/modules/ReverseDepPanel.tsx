/**
 * ReverseDepPanel Component
 *
 * Displays consumer projects that depend on this module. Shows project name,
 * alias used, pinned version, and active deployment indicator.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Users, Activity } from 'lucide-react';

import { Badge } from '../ui/Badge';
import { listConsumers, type ModuleConsumer } from '../../api/modules';

// =============================================================================
// TYPES
// =============================================================================

interface ReverseDepPanelProps {
  projectId: string;
  className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ReverseDepPanel({ projectId, className }: ReverseDepPanelProps) {
  const t = useTranslations('modules.consumers');

  const [consumers, setConsumers] = useState<ModuleConsumer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    totalConsumers: number;
    activeDeployments: number;
  } | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listConsumers(projectId);
      if (result.success) {
        setConsumers(result.data);
        setSummary(result.summary);
      }
    } catch {
      setError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={className}>
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (consumers.length === 0) {
    return (
      <div className={className}>
        <p className="text-sm text-muted">{t('empty')}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Summary header */}
      {summary && (
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Users className="w-3.5 h-3.5" />
            <span>{t('consumerCount', { count: summary.totalConsumers })}</span>
          </div>
          {summary.activeDeployments > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-success">
              <Activity className="w-3.5 h-3.5" />
              <span>{t('activeDeployments', { count: summary.activeDeployments })}</span>
            </div>
          )}
        </div>
      )}

      {/* Consumer list */}
      <div className="space-y-1.5">
        {consumers.map((consumer) => (
          <div
            key={consumer.dependencyId}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-background-muted"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{consumer.projectName}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted font-mono">{consumer.alias}</span>
                <Badge variant="default" className="text-xs">
                  v{consumer.resolvedVersion}
                </Badge>
              </div>
            </div>

            {consumer.hasActiveDeployment && (
              <Badge variant="success" dot>
                {t('activeDeployment')}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
