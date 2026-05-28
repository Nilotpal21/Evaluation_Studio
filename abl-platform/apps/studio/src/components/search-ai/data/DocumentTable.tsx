/**
 * DocumentTable Component
 *
 * Paginated document table with source filtering, search,
 * checkbox selection, and bulk actions (reprocess/delete).
 */

import { useState, useMemo, useCallback, Fragment } from 'react';
import { useTranslations } from 'next-intl';
import {
  FileText,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Trash2,
  Upload,
  AlertCircle,
} from 'lucide-react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { PipelineStatusTooltip } from './PipelineStatusTooltip';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import {
  fetchDocuments,
  bulkReprocessDocuments,
  bulkDeleteDocuments,
} from '../../../api/search-ai';
import type { SearchAIDocument, SearchAISource } from '../../../api/search-ai';
import { sanitizeError } from '@/lib/sanitize-error';
import { formatBytes } from '@/lib/upload-constants';
import { classifyError } from '@/lib/search-ai-pipeline-stages';

/** Extract a readable document name from a title that may be a URL.
 *  e.g. "https://contoso.sharepoint.com/.../Shared%20Documents/Report.pdf" → "Report.pdf" */
function displayTitle(title: string | undefined | null): string | null {
  if (!title) return null;
  // If it looks like a URL, extract and decode the filename
  if (title.startsWith('http://') || title.startsWith('https://')) {
    try {
      const pathname = new URL(title).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop();
      if (lastSegment) return decodeURIComponent(lastSegment);
    } catch {
      // Not a valid URL — fall through
    }
  }
  return title;
}

/** MIME type → human-readable short label */
const MIME_LABELS: Record<string, string> = {
  'application/json': 'JSON',
  'application/pdf': 'PDF',
  'text/csv': 'CSV',
  'text/plain': 'Text',
  'text/html': 'HTML',
  'text/markdown': 'Markdown',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/tiff': 'TIFF',
  'image/bmp': 'BMP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel': 'XLS',
  'application/msword': 'DOC',
};

/** Human-readable file type from document contentType field */
function displayFileType(doc: SearchAIDocument): string {
  const ct = doc.contentType;
  if (ct) {
    const label = MIME_LABELS[ct];
    if (label) return label;
    // Fallback: extract subtype from "type/subtype"
    const sub = ct.split('/')[1];
    if (sub) return sub.toUpperCase();
  }
  // Fallback: infer from title extension
  const title = doc.title;
  if (title) {
    const ext = title.split('.').pop()?.toLowerCase();
    if (ext && ext.length <= 5 && ext !== title.toLowerCase()) {
      return ext.toUpperCase();
    }
  }
  return '\u2014';
}
import { CrawledPageViewer } from '../viewer/CrawledPageViewer';

interface DocumentTableProps {
  indexId: string;
  /** Project ID for pipeline trigger API */
  projectId: string;
  /** Knowledge base ID for pipeline trigger API */
  kbId: string;
  sourceFilter: string | null;
  /** Filter by document status (e.g., 'error', 'pending') */
  statusFilter?: string | null;
  searchQuery: string;
  /** Counter to force SWR re-fetch after upload */
  refreshKey?: number;
  /** Active source details for upload shortcut */
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
  onUploadToSource?: (sourceId: string, sourceName: string) => void;
  /** All sources in this KB — used to resolve source name for per-doc re-upload */
  sources?: SearchAISource[];
  /** Clear active status filter */
  onClearStatusFilter?: () => void;
  /** Clear active source filter */
  /** Called after documents are deleted to refresh KB-level counts */
  onDocumentDeleted?: () => void;
  onClearSourceFilter?: () => void;
  onConfigureFields?: () => Promise<void> | void;
}

const PAGE_SIZE = 20;

const FAILED_STATUSES = new Set(['error', 'failed']);

function formatDate(iso: string | null): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ErrorExpansionRow({
  doc,
  canUpload,
  suggestsReupload,
  suggestion,
  onReupload,
  onRetry,
  onRemove,
  t,
}: {
  doc: SearchAIDocument;
  canUpload: boolean;
  suggestsReupload: boolean;
  suggestion: { hint: string };
  onReupload: (e: React.MouseEvent) => void;
  onRetry: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <tr className="border-b border-default bg-error/5" role="alert">
      <td colSpan={6} className="px-4 py-3">
        <div className="flex items-start gap-3 pl-10">
          <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-error">{t('error_inline_title')}</p>
            <p className="text-xs text-muted mt-1">
              {doc.processingError ?? t('error_inline_description')}
            </p>
            <p className="text-xs text-info mt-1.5 font-medium">{suggestion.hint}</p>
            <div className="flex items-center gap-2 mt-2.5">
              {suggestsReupload && canUpload ? (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={<Upload className="w-3 h-3" />}
                    onClick={onReupload}
                  >
                    {t('error_inline_reupload')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<RotateCcw className="w-3 h-3" />}
                    onClick={onRetry}
                  >
                    {t('error_inline_retry')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={<RotateCcw className="w-3 h-3" />}
                    onClick={onRetry}
                  >
                    {t('error_inline_retry')}
                  </Button>
                  {canUpload && (
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<Upload className="w-3 h-3" />}
                      onClick={onReupload}
                    >
                      {t('error_inline_reupload')}
                    </Button>
                  )}
                </>
              )}
              <Button
                variant="ghost"
                size="xs"
                className="text-error hover:text-error"
                icon={<Trash2 className="w-3 h-3" />}
                onClick={onRemove}
              >
                {t('error_inline_remove')}
              </Button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function DocumentTable({
  indexId,
  projectId,
  kbId,
  sourceFilter,
  statusFilter,
  searchQuery,
  refreshKey,
  sourceId,
  sourceName,
  sourceType,
  onUploadToSource,
  sources: allSources,
  onClearStatusFilter,
  onClearSourceFilter,
  onDocumentDeleted,
  onConfigureFields,
}: DocumentTableProps) {
  const t = useTranslations('search_ai.doc_table');
  const sourceMap = useMemo(
    () => new Map((allSources ?? []).map((s) => [s._id, s.name])),
    [allSources],
  );
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const [reuploadDoc, setReuploadDoc] = useState<SearchAIDocument | null>(null);
  const [isReuploading, setIsReuploading] = useState(false);

  // Reset to page 0 when filters change
  const filterKey = `${sourceId ?? 'none'}-${sourceFilter ?? 'all'}-${statusFilter ?? 'all'}-${searchQuery}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setOffset(0);
    setSelectedIds(new Set());
  }

  const swrKey = useMemo(
    () =>
      `/api/search-ai/indexes/${indexId}/documents?limit=${PAGE_SIZE}&offset=${offset}` +
      `${sourceId ? `&sourceId=${sourceId}` : ''}` +
      `${sourceFilter ? `&sourceType=${sourceFilter}` : ''}` +
      `${statusFilter ? `&status=${statusFilter}` : ''}` +
      `${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}` +
      `${refreshKey != null ? `&_r=${refreshKey}` : ''}`,
    [indexId, offset, sourceId, sourceFilter, statusFilter, searchQuery, refreshKey],
  );

  const { data, isLoading, error, mutate } = useSWR(
    indexId ? swrKey : null,
    () =>
      fetchDocuments(indexId, {
        limit: PAGE_SIZE,
        offset,
        sourceId: sourceId ?? undefined,
        sourceType: sourceFilter ?? undefined,
        status: statusFilter ?? undefined,
        search: searchQuery || undefined,
      }),
    {
      revalidateOnFocus: true,
      refreshInterval: (latestData?: { documents: SearchAIDocument[] }) => {
        // Poll at 1s only while documents are still processing; stop when all settled
        const hasActive = latestData?.documents?.some((d) =>
          ['pending', 'extracting', 'enriching', 'embedding'].includes(d.status),
        );
        return hasActive ? 1_000 : 0;
      },
      dedupingInterval: 0,
    },
  );

  const documents = data?.documents ?? [];
  const total = data?.total ?? 0;
  const hasMore = data?.pagination?.hasMore ?? false;

  const showingStart = total > 0 ? offset + 1 : 0;
  const showingEnd = Math.min(offset + PAGE_SIZE, total);

  const allOnPageSelected =
    documents.length > 0 && documents.every((doc: SearchAIDocument) => selectedIds.has(doc._id));

  const handleSelectAll = useCallback(() => {
    if (allOnPageSelected) {
      // Deselect all on current page
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const doc of documents) {
          next.delete(doc._id);
        }
        return next;
      });
    } else {
      // Select all on current page
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const doc of documents) {
          next.add(doc._id);
        }
        return next;
      });
    }
  }, [allOnPageSelected, documents]);

  const handleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handlePageChange = useCallback((newOffset: number) => {
    setOffset(newOffset);
    setSelectedIds(new Set());
  }, []);

  const handleReprocess = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setIsReprocessing(true);
    try {
      const result = await bulkReprocessDocuments(projectId, kbId, Array.from(selectedIds));
      toast.success(t('reprocess_success', { count: result.triggeredCount ?? selectedIds.size }));
      setSelectedIds(new Set());
      mutate();
    } catch (err) {
      toast.error(sanitizeError(err, t('bulk_operation_failed')));
    } finally {
      setIsReprocessing(false);
    }
  }, [selectedIds, projectId, kbId, mutate, t]);

  const handleReprocessSingle = useCallback(
    async (docId: string) => {
      setIsReprocessing(true);
      try {
        const result = await bulkReprocessDocuments(projectId, kbId, [docId]);
        toast.success(t('reprocess_success', { count: result.triggeredCount ?? 1 }));
        mutate();
      } catch (err) {
        toast.error(sanitizeError(err, t('bulk_operation_failed')));
      } finally {
        setIsReprocessing(false);
      }
    },
    [projectId, kbId, mutate, t],
  );

  const handleDeleteConfirmed = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    try {
      const { deletedCount, failedCount } = await bulkDeleteDocuments(
        indexId,
        Array.from(selectedIds),
      );
      if (failedCount > 0) {
        toast.error(t('bulk_operation_failed'));
      } else {
        toast.success(t('delete_success', { count: deletedCount }));
      }
      // Close viewer if the displayed document was deleted
      if (selectedDocumentId && selectedIds.has(selectedDocumentId)) {
        setSelectedDocumentId(null);
      }
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
      mutate();
      // Refresh KB-level data (documentCount)
      onDocumentDeleted?.();
    } catch (err) {
      toast.error(sanitizeError(err, t('bulk_operation_failed')));
    } finally {
      setIsDeleting(false);
    }
  }, [selectedIds, selectedDocumentId, indexId, mutate, onDocumentDeleted, t]);

  const handleReuploadConfirmed = useCallback(async () => {
    if (!reuploadDoc) return;
    setIsReuploading(true);
    try {
      await bulkDeleteDocuments(indexId, [reuploadDoc._id]);
      setExpandedErrorId(null);
      mutate();
      onDocumentDeleted?.();
      const docSourceName = reuploadDoc.sourceId ? sourceMap.get(reuploadDoc.sourceId) : undefined;
      if (reuploadDoc.sourceId && docSourceName && onUploadToSource) {
        onUploadToSource(reuploadDoc.sourceId, docSourceName);
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('bulk_operation_failed')));
    } finally {
      setIsReuploading(false);
      setReuploadDoc(null);
    }
  }, [reuploadDoc, indexId, sourceMap, onUploadToSource, mutate, onDocumentDeleted, t]);

  if (error) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-6 text-center">
        <p className="text-sm text-error">{t('error_loading')}</p>
        <Button variant="ghost" size="sm" onClick={() => mutate()} className="mt-2">
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
        <div className="animate-pulse space-y-0">
          {/* Header skeleton */}
          <div className="grid grid-cols-6 gap-4 px-4 py-3 border-b border-default bg-background-muted">
            {['w-6', 'w-24', 'w-16', 'w-14', 'w-20', 'w-14'].map((w, i) => (
              <div key={i} className={`h-3 ${w} bg-background-elevated rounded`} />
            ))}
          </div>
          {/* Row skeletons */}
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-6 gap-4 px-4 py-3 border-b border-default last:border-0"
            >
              <div className="h-3 w-4 bg-background-muted rounded" />
              <div className="h-3 w-40 bg-background-muted rounded" />
              <div className="h-3 w-16 bg-background-muted rounded" />
              <div className="h-5 w-14 bg-background-muted rounded-full" />
              <div className="h-3 w-24 bg-background-muted rounded" />
              <div className="h-3 w-12 bg-background-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (documents.length === 0) {
    const canUpload = sourceType === 'manual' && sourceId && sourceName && onUploadToSource;
    const hasActiveFilters = !!(statusFilter || sourceId || sourceFilter || searchQuery);
    const canClear = !!((statusFilter && onClearStatusFilter) || (sourceId && onClearSourceFilter));

    // Determine contextual title and description
    let emptyTitle: string;
    let emptyDesc: string;
    if (searchQuery) {
      emptyTitle = t('no_matching');
      emptyDesc = t('empty_search_desc');
    } else if (hasActiveFilters) {
      emptyTitle = t('no_matching_filters');
      emptyDesc = t('empty_filters_desc');
    } else {
      emptyTitle = t('empty_title');
      emptyDesc = t('empty_desc');
    }

    return (
      <EmptyState
        icon={<FileText className="w-6 h-6" />}
        title={emptyTitle}
        description={emptyDesc}
        action={
          canClear ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onClearStatusFilter?.();
                onClearSourceFilter?.();
              }}
            >
              {t('clear_filters')}
            </Button>
          ) : canUpload ? (
            <Button
              size="sm"
              icon={<Upload className="w-4 h-4" />}
              onClick={() => onUploadToSource(sourceId, sourceName)}
            >
              {t('upload_files')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent-subtle px-4 py-2 backdrop-blur-sm">
          <span className="text-sm font-medium text-foreground">
            {t('selected_count', { count: selectedIds.size })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              loading={isReprocessing}
              onClick={handleReprocess}
            >
              {t('bulk_reprocess')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              onClick={() => setShowDeleteConfirm(true)}
            >
              {t('bulk_delete')}
            </Button>
          </div>
        </div>
      )}

      {/* Upload shortcut for file sources */}
      {sourceType === 'manual' && sourceId && sourceName && onUploadToSource && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload className="w-3.5 h-3.5" />}
            onClick={() => onUploadToSource(sourceId, sourceName)}
          >
            {t('upload_files')}
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default bg-background-muted">
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={handleSelectAll}
                  className="accent-accent rounded cursor-pointer"
                  aria-label={t('select_all')}
                />
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                {t('col_title')}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                {t('col_type')}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                {t('col_status')}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                {t('col_created')}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                {t('col_size')}
              </th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc: SearchAIDocument) => {
              const isFailed = FAILED_STATUSES.has(doc.status);
              const isExpanded = expandedErrorId === doc._id;
              const canConfigureFields =
                doc.status === 'pending_field_selection' && !!onConfigureFields;

              return (
                <Fragment key={doc._id}>
                  <tr
                    className="border-b border-default last:border-0 hover:bg-background-muted/50 transition-default cursor-pointer"
                    aria-expanded={isFailed ? isExpanded : undefined}
                    onClick={() => {
                      if (isFailed) {
                        setExpandedErrorId(isExpanded ? null : doc._id);
                      } else {
                        setSelectedDocumentId(doc._id);
                      }
                    }}
                  >
                    <td className="w-10 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(doc._id)}
                        onChange={() => handleSelectOne(doc._id)}
                        className="accent-accent rounded cursor-pointer"
                        aria-label={t('select_row', {
                          title: displayTitle(doc.title) ?? t('untitled_document'),
                        })}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {displayTitle(doc.title) ?? t('untitled_document')}
                        </span>
                        {isFailed && <AlertCircle className="w-3.5 h-3.5 text-error shrink-0" />}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-muted text-xs">{displayFileType(doc)}</span>
                    </td>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <PipelineStatusTooltip
                        status={doc.status}
                        processingError={doc.processingError}
                        onClick={canConfigureFields ? onConfigureFields : undefined}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-muted text-xs">{formatDate(doc.createdAt)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-muted text-xs">
                        {doc.contentSizeBytes ? formatBytes(doc.contentSizeBytes) : '\u2014'}
                      </span>
                    </td>
                  </tr>

                  {isFailed &&
                    isExpanded &&
                    (() => {
                      const suggestion = classifyError(doc.processingError);
                      const docSourceName = doc.sourceId ? sourceMap.get(doc.sourceId) : undefined;
                      const canUpload = !!(doc.sourceId && docSourceName && onUploadToSource);

                      return (
                        <ErrorExpansionRow
                          doc={doc}
                          canUpload={canUpload}
                          suggestsReupload={suggestion.action === 'reupload'}
                          suggestion={suggestion}
                          onReupload={(e) => {
                            e.stopPropagation();
                            setReuploadDoc(doc);
                          }}
                          onRetry={(e) => {
                            e.stopPropagation();
                            handleReprocessSingle(doc._id);
                          }}
                          onRemove={(e) => {
                            e.stopPropagation();
                            setSelectedIds(new Set([doc._id]));
                            setShowDeleteConfirm(true);
                          }}
                          t={t}
                        />
                      );
                    })()}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-muted">
          {t('showing', { start: showingStart, end: showingEnd, total })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={offset === 0}
            onClick={() => handlePageChange(Math.max(0, offset - PAGE_SIZE))}
            aria-label={t('aria_prev_page')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!hasMore}
            onClick={() => handlePageChange(offset + PAGE_SIZE)}
            aria-label={t('aria_next_page')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteConfirmed}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_message', { count: selectedIds.size })}
        confirmLabel={t('confirm_delete_button')}
        variant="danger"
        loading={isDeleting}
      />

      {/* Re-upload confirmation dialog */}
      <ConfirmDialog
        open={!!reuploadDoc}
        onClose={() => setReuploadDoc(null)}
        onConfirm={handleReuploadConfirmed}
        title={t('confirm_reupload_title')}
        description={t('confirm_reupload_message', {
          title: displayTitle(reuploadDoc?.title) ?? t('untitled_document'),
        })}
        confirmLabel={t('confirm_reupload_button')}
        variant="danger"
        loading={isReuploading}
      >
        <ul className="text-xs text-muted text-left w-full mb-4 space-y-1 list-disc pl-4">
          <li>{t('confirm_reupload_detail_doc')}</li>
          <li>{t('confirm_reupload_detail_chunks')}</li>
          <li>{t('confirm_reupload_detail_embeddings')}</li>
        </ul>
      </ConfirmDialog>

      {/* Document detail drawer */}
      <CrawledPageViewer
        open={!!selectedDocumentId}
        onClose={() => setSelectedDocumentId(null)}
        indexId={indexId}
        documentId={selectedDocumentId ?? ''}
      />
    </div>
  );
}
