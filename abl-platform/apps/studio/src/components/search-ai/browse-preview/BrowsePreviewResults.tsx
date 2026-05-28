/**
 * BrowsePreviewResults
 *
 * Document card grid + sort controls + pagination for Browse SDK preview.
 */

'use client';

import { useMemo } from 'react';
import { FileSearch, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AttributeTier } from '../../../api/search-ai';
import { Select } from '../../ui/Select';
import { Pagination } from '../../ui/Pagination';
import { EmptyState } from '../../ui/EmptyState';
import { BrowseDocumentCard, type BrowseDocument } from './BrowseDocumentCard';

const PAGE_SIZE = 12;

interface BrowsePreviewResultsProps {
  documents: BrowseDocument[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  sortBy: string;
  onSortChange: (sort: string) => void;
  includeBeta: boolean;
  isLoading?: boolean;
}

export function BrowsePreviewResults({
  documents,
  total,
  page,
  onPageChange,
  sortBy,
  onSortChange,
  includeBeta,
  isLoading = false,
}: BrowsePreviewResultsProps) {
  const t = useTranslations('search_ai.browse');
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const SORT_OPTIONS = useMemo(
    () => [
      { value: 'relevance', label: t('sort_relevance') },
      { value: 'date_desc', label: t('sort_newest') },
      { value: 'date_asc', label: t('sort_oldest') },
      { value: 'title_asc', label: t('sort_title_asc') },
    ],
    [t],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Results header */}
      <div className="flex items-center justify-between px-1 mb-4">
        <p className="text-sm text-muted">{t('document_count_label', { count: total })}</p>
        <div className="w-40">
          <Select
            options={SORT_OPTIONS}
            value={sortBy}
            onChange={onSortChange}
            placeholder={t('sort_by')}
          />
        </div>
      </div>

      {/* Document grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      ) : documents.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1">
          {documents.map((doc) => (
            <BrowseDocumentCard
              key={doc.id}
              document={doc}
              includeBeta={includeBeta}
              onClick={() => {
                if (doc.sourceUrl) {
                  window.open(doc.sourceUrl, '_blank', 'noopener,noreferrer');
                }
              }}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileSearch className="w-6 h-6" />}
          title={t('no_documents_title')}
          description={t('no_documents_description')}
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 pt-3 border-t border-default">
          <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
        </div>
      )}
    </div>
  );
}
