/**
 * VersionHistoryTab Component
 *
 * Version history table with diff viewer and restore capability.
 * Also conditionally renders ConfigDriftSection when drift is detected.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { DataTable, type Column } from '../../../ui/DataTable';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { ConfigDiffViewer } from './ConfigDiffViewer';
import { ConfigDriftSection } from './ConfigDriftSection';
import { useConfigVersions, type ConfigVersion } from '../../../../hooks/useConfigVersions';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { SyncHistoryTimeline } from '../SyncHistoryTimeline';

interface VersionHistoryTabProps {
  indexId: string;
  connectorId: string;
}

interface DiffData {
  fromVersion: number;
  toVersion: number;
  changes: Array<{
    path: string;
    oldValue: unknown;
    newValue: unknown;
    type: 'added' | 'removed' | 'changed';
  }>;
}

const PAGE_SIZE = 10;

export function VersionHistoryTab({ indexId, connectorId }: VersionHistoryTabProps) {
  const t = useTranslations('search_ai.sharepoint.config.history');

  const [page, setPage] = useState(1);
  const { versions, total, isLoading, mutate } = useConfigVersions(indexId, connectorId, {
    page,
    limit: PAGE_SIZE,
  });

  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const latestVersion = versions.length > 0 ? versions[0].version : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleViewDiff = useCallback(
    async (version: number) => {
      if (version === latestVersion) return;
      setDiffLoading(true);
      try {
        const resp = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/versions/diff?from=${version}&to=${latestVersion}`,
        );
        const result = await handleResponse<{ data: DiffData }>(resp);
        setDiffData(result.data);
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('diff_error')));
      } finally {
        setDiffLoading(false);
      }
    },
    [indexId, connectorId, latestVersion, t],
  );

  const handleRestore = useCallback(async () => {
    if (restoreTarget === null) return;
    setRestoring(true);
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/versions/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: restoreTarget }),
        },
      );
      await handleResponse(resp);
      toast.success(t('restore_success'));
      setRestoreTarget(null);
      mutate();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('restore_error')));
    } finally {
      setRestoring(false);
    }
  }, [indexId, connectorId, restoreTarget, mutate, t]);

  const SOURCE_BADGE_STYLES: Record<string, string> = {
    manual: 'border-purple text-purple bg-purple-subtle rounded-full',
    proposal: 'border-success text-success bg-success-subtle rounded-full',
    system: 'border-info text-info bg-info-subtle rounded-full',
    user: 'border-purple text-purple bg-purple-subtle rounded-full',
  };

  const columns: Column<ConfigVersion>[] = useMemo(
    () => [
      {
        key: 'version',
        label: t('col_version'),
        render: (row) => (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-sm font-semibold text-foreground">v{row.version}</span>
            {row.version === latestVersion && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold border border-success text-success bg-success-subtle w-fit">
                {t('badge_current')}
              </span>
            )}
          </div>
        ),
      },
      {
        key: 'date',
        label: t('col_date'),
        render: (row) => (
          <span className="text-xs text-muted">
            {new Date(row.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
            ,{' '}
            {new Date(row.createdAt).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        ),
      },
      {
        key: 'changedBy',
        label: t('col_changed_by'),
        render: (row) => (
          <span className="text-sm font-medium text-foreground">{row.changedBy}</span>
        ),
      },
      {
        key: 'source',
        label: t('col_source'),
        render: (row) => {
          const style = SOURCE_BADGE_STYLES[row.changeSource] || SOURCE_BADGE_STYLES.user;
          return (
            <span
              className={`inline-flex items-center px-2.5 py-0.5 text-[11px] font-medium border ${style}`}
            >
              {row.changeSource}
            </span>
          );
        },
      },
      {
        key: 'summary',
        label: t('col_summary'),
        render: (row) => <span className="text-sm text-muted">{row.summary}</span>,
      },
      {
        key: 'actions',
        label: '',
        width: 'w-24',
        render: (row) =>
          row.version !== latestVersion ? (
            <div className="flex flex-col gap-0.5 text-right">
              <button
                type="button"
                className="text-xs text-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  handleViewDiff(row.version);
                }}
                disabled={diffLoading}
              >
                {t('action_diff')}
              </button>
              <button
                type="button"
                className="text-xs text-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setRestoreTarget(row.version);
                }}
              >
                {t('action_restore')}
              </button>
            </div>
          ) : null,
      },
    ],
    [t, latestVersion, handleViewDiff, diffLoading],
  );

  return (
    <div className="p-6 space-y-6">
      {/* Drift section — only shows when drift detected */}
      <ConfigDriftSection
        indexId={indexId}
        connectorId={connectorId}
        onDriftResolved={() => mutate()}
      />

      {/* Configuration History */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">{t('title')}</h3>
        <p className="text-xs text-muted mb-3">{t('description')}</p>
        <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
          <DataTable
            columns={columns}
            data={versions}
            keyExtractor={(row) => row._id}
            emptyMessage={isLoading ? t('loading') : t('empty')}
          />
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-muted">
              {t('page_info', { page, total: totalPages })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                {t('prev')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Diff viewer */}
      {diffData && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-foreground">{t('diff_title')}</h3>
            <Button variant="ghost" size="xs" onClick={() => setDiffData(null)}>
              {t('diff_close')}
            </Button>
          </div>
          <ConfigDiffViewer
            fromVersion={diffData.fromVersion}
            toVersion={diffData.toVersion}
            changes={diffData.changes}
          />
        </div>
      )}

      {/* Restore confirmation */}
      {/* Sync history */}
      <div className="border-t border-default pt-6">
        <h3 className="text-sm font-semibold text-foreground mb-1">{t('sync_history_title')}</h3>
        <p className="text-xs text-muted mb-3">{t('sync_history_description')}</p>
        <SyncHistoryTimeline indexId={indexId} connectorId={connectorId} />
      </div>

      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={handleRestore}
        title={t('restore_title')}
        description={t('restore_description', { version: restoreTarget ?? 0 })}
        confirmLabel={t('restore_confirm')}
        variant="primary"
        loading={restoring}
      />
    </div>
  );
}
