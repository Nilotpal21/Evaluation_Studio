/**
 * VocabularyReviewDialog
 *
 * Modal dialog for reviewing auto-generated and manual vocabulary terms
 * for a specific canonical field. Supports bulk approve/reject via checkboxes.
 *
 * Opened from the My Fields tab in FieldsTab via the BookOpen icon button.
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Check, X, BookOpen } from 'lucide-react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { DataTable, type Column } from '../ui/DataTable';
import { EmptyState } from '../ui/EmptyState';
import {
  getVocabularyByFieldRef,
  reviewVocabularyTerms,
  type VocabularyEntry,
  type VocabularyByFieldRefResponse,
} from '../../api/search-ai';

interface VocabularyReviewDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  fieldRef: string;
  fieldLabel: string;
}

const confidenceVariant = (c: number): BadgeVariant => {
  if (c >= 0.8) return 'success';
  if (c >= 0.5) return 'warning';
  return 'error';
};

export function VocabularyReviewDialog({
  open,
  onClose,
  indexId,
  fieldRef,
  fieldLabel,
}: VocabularyReviewDialogProps) {
  const t = useTranslations('search_ai.vocab_review');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const confidenceLabel = useCallback(
    (c: number): string => {
      if (c >= 0.8) return t('confidence_high');
      if (c >= 0.5) return t('confidence_medium');
      return t('confidence_low');
    },
    [t],
  );
  const [reviewLoading, setReviewLoading] = useState(false);

  // Fetch vocabulary entries for this fieldRef via SWR
  const swrKey = open && indexId && fieldRef ? `vocabulary:${indexId}:${fieldRef}` : null;
  const { data, error, isLoading, mutate } = useSWR<VocabularyByFieldRefResponse>(swrKey, () =>
    getVocabularyByFieldRef(indexId, fieldRef),
  );

  const entries = useMemo(() => data?.entries ?? [], [data]);

  // Group entries by generatedBy
  const autoEntries = useMemo(() => entries.filter((e) => e.generatedBy === 'auto'), [entries]);
  const manualEntries = useMemo(() => entries.filter((e) => e.generatedBy === 'manual'), [entries]);

  // Toggle selection
  const toggleSelect = useCallback((id: string) => {
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

  // Select all in a group
  const selectAllInGroup = useCallback((group: VocabularyEntry[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = group.every((e) => next.has(e.id));
      if (allSelected) {
        group.forEach((e) => next.delete(e.id));
      } else {
        group.forEach((e) => next.add(e.id));
      }
      return next;
    });
  }, []);

  // Bulk review action
  const handleReview = useCallback(
    async (action: 'approve' | 'reject') => {
      if (selectedIds.size === 0) return;
      setReviewLoading(true);
      try {
        const result = await reviewVocabularyTerms(indexId, action, Array.from(selectedIds));
        toast.success(
          action === 'approve'
            ? t('terms_approved', { count: result.updatedCount })
            : t('terms_rejected', { count: result.updatedCount }),
        );
        setSelectedIds(new Set());
        mutate();
      } catch (err) {
        toast.error(
          sanitizeError(err, action === 'approve' ? t('approve_failed') : t('reject_failed')),
        );
      } finally {
        setReviewLoading(false);
      }
    },
    [indexId, selectedIds, mutate, t],
  );

  // Reset selection when dialog closes
  const handleClose = useCallback(() => {
    setSelectedIds(new Set());
    onClose();
  }, [onClose]);

  // Table columns for vocabulary entries
  const columns: Column<VocabularyEntry>[] = useMemo(
    () => [
      {
        key: 'select',
        label: '',
        width: 'w-[40px]',
        render: (entry) => (
          <input
            type="checkbox"
            checked={selectedIds.has(entry.id)}
            onChange={() => toggleSelect(entry.id)}
            className="rounded border-default text-accent focus:ring-border-focus cursor-pointer"
          />
        ),
      },
      {
        key: 'term',
        label: t('col_term'),
        sortable: true,
        sortValue: (entry) => entry.term,
        render: (entry) => (
          <div>
            <span className="font-medium text-foreground">{entry.term}</span>
            {entry.description && (
              <div className="text-xs text-muted mt-0.5 truncate max-w-[200px]">
                {entry.description}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'aliases',
        label: t('col_aliases'),
        render: (entry) =>
          entry.aliases.length > 0 ? (
            <span className="text-xs text-muted">{entry.aliases.join(', ')}</span>
          ) : (
            <span className="text-xs text-subtle">--</span>
          ),
      },
      {
        key: 'confidence',
        label: t('col_confidence'),
        sortable: true,
        sortValue: (entry) => entry.confidence ?? 0,
        width: 'w-[110px]',
        render: (entry) =>
          entry.confidence != null ? (
            <Badge variant={confidenceVariant(entry.confidence)} className="text-xs">
              <span className="font-mono font-semibold">{Math.round(entry.confidence * 100)}%</span>
              <span className="ml-1">{confidenceLabel(entry.confidence)}</span>
            </Badge>
          ) : (
            <span className="text-xs text-subtle">--</span>
          ),
      },
      {
        key: 'enabled',
        label: t('col_status'),
        width: 'w-[80px]',
        render: (entry) => (
          <Badge variant={entry.enabled ? 'success' : 'default'} dot className="text-xs">
            {entry.enabled ? t('status_active') : t('status_disabled')}
          </Badge>
        ),
      },
    ],
    [selectedIds, toggleSelect, t, confidenceLabel],
  );

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('title', { fieldLabel })}
      description={t('description', { fieldRef })}
      maxWidth="lg"
    >
      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm text-muted animate-pulse">{t('loading')}</div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="text-center py-8">
          <p className="text-sm text-error mb-2">{t('load_error')}</p>
          <Button size="sm" variant="secondary" onClick={() => mutate()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && entries.length === 0 && (
        <EmptyState
          icon={<BookOpen className="w-6 h-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      )}

      {/* Content */}
      {!isLoading && !error && entries.length > 0 && (
        <div className="space-y-4">
          {/* Bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="sticky top-0 z-10 flex items-center justify-between bg-accent-subtle border border-accent-muted p-3 rounded-xl">
              <span className="text-sm font-medium text-foreground">
                {t('terms_selected', { count: selectedIds.size })}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Check className="w-3.5 h-3.5" />}
                  onClick={() => handleReview('approve')}
                  loading={reviewLoading}
                >
                  {t('approve_selected')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<X className="w-3.5 h-3.5" />}
                  onClick={() => handleReview('reject')}
                  loading={reviewLoading}
                >
                  {t('reject_selected')}
                </Button>
              </div>
            </div>
          )}

          {/* Auto-generated terms section */}
          {autoEntries.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="purple" className="text-xs">
                  {t('auto_generated')}
                </Badge>
                <span className="text-xs text-muted">
                  ({t('terms_count', { count: autoEntries.length })})
                </span>
                <button
                  onClick={() => selectAllInGroup(autoEntries)}
                  className="text-xs text-accent hover:underline ml-auto"
                >
                  {autoEntries.every((e) => selectedIds.has(e.id))
                    ? t('deselect_all')
                    : t('select_all')}
                </button>
              </div>
              <DataTable columns={columns} data={autoEntries} keyExtractor={(e) => e.id} />
            </div>
          )}

          {/* Manual terms section */}
          {manualEntries.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="info" className="text-xs">
                  {t('manual')}
                </Badge>
                <span className="text-xs text-muted">
                  ({t('terms_count', { count: manualEntries.length })})
                </span>
                <button
                  onClick={() => selectAllInGroup(manualEntries)}
                  className="text-xs text-accent hover:underline ml-auto"
                >
                  {manualEntries.every((e) => selectedIds.has(e.id))
                    ? t('deselect_all')
                    : t('select_all')}
                </button>
              </div>
              <DataTable columns={columns} data={manualEntries} keyExtractor={(e) => e.id} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
