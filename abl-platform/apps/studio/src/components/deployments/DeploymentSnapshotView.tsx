'use client';

/**
 * DeploymentSnapshotView Component
 *
 * Shows the immutable variable snapshot captured at deployment time.
 * Displays snapshot hash, creation time, and table of env/config variables.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Lock, FileText, Hash } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { toast } from 'sonner';
import {
  fetchDeploymentSnapshot,
  fetchSnapshotValue,
  type DeploymentSnapshot,
  type SnapshotEnvVar,
} from '../../api/deployments';

interface DeploymentSnapshotViewProps {
  projectId: string;
  deploymentId: string;
}

export function DeploymentSnapshotView({ projectId, deploymentId }: DeploymentSnapshotViewProps) {
  const t = useTranslations('deployments.snapshot');
  const [snapshot, setSnapshot] = useState<DeploymentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reveal state for env var values
  const [revealedValues, setRevealedValues] = useState<Map<string, string>>(new Map());
  const [revealingKey, setRevealingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDeploymentSnapshot(projectId, deploymentId);
      setSnapshot(data.snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [projectId, deploymentId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReveal = async (envVar: SnapshotEnvVar) => {
    if (revealedValues.has(envVar.key)) {
      setRevealedValues((prev) => {
        const next = new Map(prev);
        next.delete(envVar.key);
        return next;
      });
      return;
    }

    setRevealingKey(envVar.key);
    try {
      const data = await fetchSnapshotValue(projectId, deploymentId, envVar.key);
      setRevealedValues((prev) => new Map(prev).set(envVar.key, data.value));
    } catch {
      toast.error(t('decrypt_error'));
    } finally {
      setRevealingKey(null);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted">{t('loading')}</div>;
  }

  if (error) {
    return <div className="py-8 text-center text-sm text-muted">{error}</div>;
  }

  if (!snapshot) {
    return <div className="py-8 text-center text-sm text-muted">{t('no_snapshot')}</div>;
  }

  const totalVars = snapshot.envVars.length + snapshot.configVars.length;

  return (
    <div className="space-y-4">
      {/* Snapshot metadata */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5 text-muted">
          <Hash className="w-3.5 h-3.5" />
          <span className="font-mono text-xs">{snapshot.snapshotHash.slice(0, 12)}</span>
        </div>
        <Badge variant="default">v{snapshot.snapshotVersion}</Badge>
        <Badge variant="accent">{t('variables_count', { count: totalVars })}</Badge>
        {snapshot.createdAt && (
          <span className="text-xs text-muted">
            {new Date(snapshot.createdAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Environment variables table */}
      {snapshot.envVars.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Lock className="w-3.5 h-3.5 text-muted" />
            <span className="text-sm font-medium text-foreground">
              {t('env_vars_heading', { count: snapshot.envVars.length })}
            </span>
          </div>
          <div className="border border-default rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_auto] gap-3 px-4 py-2 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
              <span>{t('col_key')}</span>
              <span>{t('col_value')}</span>
              <span className="w-16 text-right">{t('col_actions')}</span>
            </div>
            {snapshot.envVars.map((v) => (
              <div
                key={v.key}
                className="grid grid-cols-[1fr_2fr_auto] gap-3 items-center px-4 py-2.5 border-b border-default last:border-0 hover:bg-background-muted/30 transition-default"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-mono text-foreground truncate">{v.key}</span>
                  {v.isSecret && <Lock className="w-3 h-3 text-muted shrink-0" />}
                </div>
                <span className="text-sm font-mono text-muted truncate">
                  {revealedValues.has(v.key)
                    ? revealedValues.get(v.key)
                    : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                </span>
                <div className="flex items-center w-16 justify-end">
                  <button
                    onClick={() => handleReveal(v)}
                    disabled={revealingKey === v.key}
                    className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
                    title={revealedValues.has(v.key) ? t('hide_value') : t('reveal_value')}
                  >
                    {revealedValues.has(v.key) ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Config variables table */}
      {snapshot.configVars.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-3.5 h-3.5 text-muted" />
            <span className="text-sm font-medium text-foreground">
              {t('config_vars_heading', { count: snapshot.configVars.length })}
            </span>
          </div>
          <div className="border border-default rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr] gap-3 px-4 py-2 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
              <span>{t('col_key')}</span>
              <span>{t('col_value')}</span>
            </div>
            {snapshot.configVars.map((v) => (
              <div
                key={v.key}
                className="grid grid-cols-[1fr_2fr] gap-3 items-center px-4 py-2.5 border-b border-default last:border-0 hover:bg-background-muted/30 transition-default"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-mono text-foreground truncate">{v.key}</span>
                </div>
                <span className="text-sm font-mono text-muted truncate">{v.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalVars === 0 && (
        <div className="py-8 text-center text-sm text-muted">{t('no_variables')}</div>
      )}
    </div>
  );
}
