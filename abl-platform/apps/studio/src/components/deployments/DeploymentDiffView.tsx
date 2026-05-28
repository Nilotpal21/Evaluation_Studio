'use client';

/**
 * DeploymentDiffView Component
 *
 * Shows the diff between two deployment variable snapshots.
 * Color-coded: green for added, red for removed, amber for changed.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Plus, Minus, RefreshCw, CheckCircle2, Hash } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  fetchSnapshotDiff,
  type SnapshotDiff,
  type SnapshotDiffEntry,
} from '../../api/deployments';

interface DeploymentDiffViewProps {
  projectId: string;
  deploymentId: string;
  compareWithId: string;
  sourceLabel?: string;
  targetLabel?: string;
}

export function DeploymentDiffView({
  projectId,
  deploymentId,
  compareWithId,
  sourceLabel,
  targetLabel,
}: DeploymentDiffViewProps) {
  const t = useTranslations('deployments.diff');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identical, setIdentical] = useState(false);
  const [sourceHash, setSourceHash] = useState('');
  const [targetHash, setTargetHash] = useState('');
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSnapshotDiff(projectId, deploymentId, compareWithId);
      setIdentical(data.identical);
      setSourceHash(data.sourceHash);
      setTargetHash(data.targetHash);
      setDiff(data.diff || null);
    } catch (err) {
      setError(sanitizeError(err, t('load_error')));
    } finally {
      setLoading(false);
    }
  }, [projectId, deploymentId, compareWithId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted">{t('loading')}</div>;
  }

  if (error) {
    return <div className="py-8 text-center text-sm text-error">{error}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Hash comparison */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5 text-muted">
          <Hash className="w-3 h-3" />
          <span className="font-mono">{sourceHash.slice(0, 12)}</span>
          {sourceLabel && <span className="text-subtle">({sourceLabel})</span>}
        </div>
        <span className="text-muted">{t('vs')}</span>
        <div className="flex items-center gap-1.5 text-muted">
          <Hash className="w-3 h-3" />
          <span className="font-mono">{targetHash.slice(0, 12)}</span>
          {targetLabel && <span className="text-subtle">({targetLabel})</span>}
        </div>
      </div>

      {/* Identical state */}
      {identical && (
        <div className="flex items-center gap-2 py-8 justify-center text-sm text-success">
          <CheckCircle2 className="w-5 h-5" />
          <span>{t('identical')}</span>
        </div>
      )}

      {/* Diff content */}
      {!identical && diff && (
        <div className="space-y-3">
          {/* Summary badges */}
          <div className="flex items-center gap-2">
            {diff.added.length > 0 && (
              <Badge variant="success" dot>
                {t('added_count', { count: diff.added.length })}
              </Badge>
            )}
            {diff.removed.length > 0 && (
              <Badge variant="error" dot>
                {t('removed_count', { count: diff.removed.length })}
              </Badge>
            )}
            {diff.changed.length > 0 && (
              <Badge variant="warning" dot>
                {t('changed_count', { count: diff.changed.length })}
              </Badge>
            )}
          </div>

          {/* Diff table */}
          <div className="border border-default rounded-lg overflow-hidden">
            <div className="grid grid-cols-[auto_1fr_auto] gap-3 px-4 py-2 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
              <span className="w-6" />
              <span>{t('col_key')}</span>
              <span>{t('col_type')}</span>
            </div>

            {/* Added */}
            {diff.added.map((entry) => (
              <DiffRow key={`add-${entry.key}`} entry={entry} change="added" />
            ))}

            {/* Removed */}
            {diff.removed.map((entry) => (
              <DiffRow key={`rm-${entry.key}`} entry={entry} change="removed" />
            ))}

            {/* Changed */}
            {diff.changed.map((entry) => (
              <DiffRow key={`chg-${entry.key}`} entry={entry} change="changed" />
            ))}
          </div>
        </div>
      )}

      {!identical && !diff && (
        <div className="py-8 text-center text-sm text-muted">{t('no_detailed_diff')}</div>
      )}
    </div>
  );
}

// =============================================================================
// Internal Components
// =============================================================================

function DiffRow({
  entry,
  change,
}: {
  entry: SnapshotDiffEntry;
  change: 'added' | 'removed' | 'changed';
}) {
  const bgColor = {
    added: 'bg-success-subtle/30',
    removed: 'bg-error-subtle/30',
    changed: 'bg-warning-subtle/30',
  }[change];

  const textColor = {
    added: 'text-success',
    removed: 'text-error',
    changed: 'text-warning',
  }[change];

  const Icon = {
    added: Plus,
    removed: Minus,
    changed: RefreshCw,
  }[change];

  return (
    <div
      className={clsx(
        'grid grid-cols-[auto_1fr_auto] gap-3 items-center px-4 py-2 border-b border-default last:border-0',
        bgColor,
      )}
    >
      <span className={clsx('w-6 flex items-center justify-center', textColor)}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className="text-sm font-mono text-foreground truncate">{entry.key}</span>
      <Badge variant={entry.type === 'env' ? 'info' : 'purple'}>{entry.type}</Badge>
    </div>
  );
}
