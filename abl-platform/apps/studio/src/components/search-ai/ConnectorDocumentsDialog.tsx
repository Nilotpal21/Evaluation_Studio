'use client';

/**
 * ConnectorDocumentsDialog
 *
 * Shows all documents synced by a connector/source with:
 * - Compact stats bar (total docs, chunks, avg, errors)
 * - Searchable/filterable document list
 * - Click any row to open ChunkExplorerDialog
 */

import { useState, useMemo, useCallback } from 'react';
import { Search, FileText, Layers, AlertCircle, BarChart3, Trash2, X } from 'lucide-react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ChunkExplorerDialog } from './ChunkExplorer';
import { fetchDocuments, deleteDocument } from '../../api/search-ai';
import type { SearchAIDocument } from '../../api/search-ai';
import { sanitizeError } from '@/lib/sanitize-error';
import { toast } from 'sonner';

interface ConnectorDocumentsDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  sourceId: string;
  sourceName: string;
}

const statusVariant: Record<string, BadgeVariant> = {
  indexed: 'success',
  enriched: 'info',
  extracted: 'info',
  pending: 'default',
  error: 'error',
};

function displayDocTitle(title: string | undefined | null): string {
  if (!title) return '—';
  if (title.startsWith('http://') || title.startsWith('https://')) {
    try {
      const pathname = new URL(title).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop();
      if (lastSegment) return decodeURIComponent(lastSegment);
    } catch {
      // fall through
    }
  }
  return title;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type StatusFilter = 'all' | 'indexed' | 'pending' | 'error';

export function ConnectorDocumentsDialog({
  open,
  onClose,
  indexId,
  sourceId,
  sourceName,
}: ConnectorDocumentsDialogProps) {
  const t = useTranslations('search_ai.connector_docs');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedDoc, setSelectedDoc] = useState<SearchAIDocument | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmDoc, setDeleteConfirmDoc] = useState<SearchAIDocument | null>(null);

  const { data, isLoading, mutate } = useSWR(
    open
      ? `/api/search-ai/indexes/${indexId}/documents?sourceId=${sourceId}&status=${statusFilter === 'all' ? '' : statusFilter}&search=${searchQuery}`
      : null,
    () =>
      fetchDocuments(indexId, {
        sourceId,
        status: statusFilter === 'all' ? undefined : statusFilter,
        search: searchQuery || undefined,
        limit: 200,
      }),
  );

  const documents = data?.documents ?? [];
  const total = data?.total ?? 0;

  const stats = useMemo(() => {
    if (documents.length === 0) return null;
    const totalChunks = documents.reduce((sum, d) => sum + d.chunkCount, 0);
    const avgChunks = documents.length > 0 ? Math.round(totalChunks / documents.length) : 0;
    const errorCount = documents.filter((d) => d.status === 'error').length;
    return { totalDocs: total, totalChunks, avgChunks, errorCount };
  }, [documents, total]);

  const handleDelete = useCallback((doc: SearchAIDocument) => {
    setDeleteConfirmDoc(doc);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirmDoc) return;
    setDeletingId(deleteConfirmDoc._id);
    setDeleteConfirmDoc(null);
    try {
      await deleteDocument(indexId, deleteConfirmDoc._id);
      mutate();
      toast.success(t('toast_deleted', { title: deleteConfirmDoc.title }));
    } catch (err) {
      toast.error(sanitizeError(err, t('error_delete')));
    } finally {
      setDeletingId(null);
    }
  }, [deleteConfirmDoc, indexId, mutate, t]);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t('dialog_title', { name: sourceName })}
        description={
          stats
            ? t('dialog_desc', {
                docs: stats.totalDocs,
                chunks: stats.totalChunks.toLocaleString(),
              })
            : undefined
        }
        maxWidth="5xl"
      >
        {isLoading ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-4">
            {/* Stats Bar */}
            {stats && (
              <div className="grid grid-cols-4 gap-2">
                {[
                  {
                    label: t('stat_documents'),
                    value: stats.totalDocs.toLocaleString(),
                    icon: FileText,
                  },
                  {
                    label: t('stat_total_chunks'),
                    value: stats.totalChunks.toLocaleString(),
                    icon: Layers,
                  },
                  {
                    label: t('stat_avg_chunks'),
                    value: stats.avgChunks.toLocaleString(),
                    icon: BarChart3,
                  },
                  {
                    label: t('stat_errors'),
                    value: stats.errorCount.toLocaleString(),
                    icon: AlertCircle,
                    highlight: stats.errorCount > 0,
                  },
                ].map(({ label, value, icon: Icon, highlight }) => (
                  <div
                    key={label}
                    className={clsx(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border',
                      highlight
                        ? 'border-error/30 bg-error/5'
                        : 'border-default bg-background-elevated',
                    )}
                  >
                    <Icon
                      className={clsx(
                        'w-3.5 h-3.5 shrink-0',
                        highlight ? 'text-error' : 'text-muted',
                      )}
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-muted truncate">{label}</p>
                      <p
                        className={clsx(
                          'text-sm font-semibold',
                          highlight ? 'text-error' : 'text-foreground',
                        )}
                      >
                        {value}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Search + Filter */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('search_placeholder')}
                  className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-background-muted">
                {(['all', 'indexed', 'pending', 'error'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={clsx(
                      'px-2.5 py-1.5 text-xs font-medium rounded-md transition-default capitalize',
                      statusFilter === s
                        ? 'bg-background-elevated text-foreground shadow-sm'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {t(`filter_${s}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Document List */}
            {documents.length === 0 ? (
              <EmptyState
                icon={<FileText className="w-6 h-6" />}
                title={t('empty_title')}
                description={
                  searchQuery || statusFilter !== 'all'
                    ? t('empty_desc_filtered')
                    : t('empty_desc_default')
                }
              />
            ) : (
              <div className="rounded-xl border border-default bg-background-elevated overflow-hidden max-h-[50vh] overflow-y-auto">
                {/* Header */}
                <div className="grid grid-cols-[1fr_80px_80px_90px_100px_40px] gap-2 px-3 py-2 border-b border-default bg-background-muted/50 text-xs font-medium text-muted uppercase tracking-wider sticky top-0 z-10">
                  <span>{t('col_title')}</span>
                  <span className="text-right">{t('col_chunks')}</span>
                  <span className="text-right">{t('col_size')}</span>
                  <span className="text-center">{t('col_status')}</span>
                  <span>{t('col_created')}</span>
                  <span />
                </div>

                {/* Rows */}
                <div className="divide-y divide-default">
                  {documents.map((doc) => (
                    <div
                      key={doc._id}
                      className="grid grid-cols-[1fr_80px_80px_90px_100px_40px] gap-2 px-3 py-2.5 items-center cursor-pointer hover:bg-background-muted transition-default"
                      onClick={() => setSelectedDoc(doc)}
                    >
                      <span className="text-sm font-medium text-foreground truncate">
                        {displayDocTitle(doc.title)}
                      </span>
                      <span className="text-sm text-muted text-right font-mono">
                        {doc.chunkCount}
                      </span>
                      <span className="text-xs text-muted text-right">
                        {doc.contentSizeBytes ? formatBytes(doc.contentSizeBytes) : '\u2014'}
                      </span>
                      <div className="text-center">
                        <Badge variant={statusVariant[doc.status] ?? 'default'} dot>
                          {doc.status}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted">{formatDate(doc.createdAt)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(doc);
                        }}
                        disabled={deletingId === doc._id}
                        className="p-1 rounded-md text-muted hover:text-error hover:bg-error/10 transition-default disabled:opacity-50"
                        title={t('delete_tooltip')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Chunk Explorer for selected document */}
      {selectedDoc && (
        <ChunkExplorerDialog
          open={!!selectedDoc}
          onClose={() => setSelectedDoc(null)}
          indexId={indexId}
          documentId={selectedDoc._id}
          documentTitle={selectedDoc.title}
          totalChunks={selectedDoc.chunkCount}
        />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteConfirmDoc}
        onClose={() => setDeleteConfirmDoc(null)}
        onConfirm={confirmDelete}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_desc', { title: deleteConfirmDoc?.title ?? '' })}
        confirmLabel={t('delete_confirm_button')}
      />
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-9 rounded-lg" />
      <div className="space-y-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-11 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
