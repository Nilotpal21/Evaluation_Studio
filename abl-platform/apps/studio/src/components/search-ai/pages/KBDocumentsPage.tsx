'use client';

/**
 * KBDocumentsPage
 *
 * Standalone documents page using ListPageShell. Wraps the existing DocumentTable
 * with source filtering via SourceFilterBar.
 * Handles pending filters from the data-tab-filter-store (e.g., from Overview stat cards).
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { ListPageShell } from '../../ui/ListPageShell';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/Input';
import { useKBDetail } from '../context/KBDetailContext';
import { DocumentTable } from '../data/DocumentTable';
import { SourceFilterBar } from '../data/SourceFilterBar';
import { FileUploadDialog } from '../data/FileUploadDialog';
import { JsonFieldSelectionDialog } from '../data/JsonFieldSelectionDialog';
import { AddSourceButton } from '../data/AddSourceButton';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
import { rediscoverJsonFields } from '../../../api/search-ai';
import type { JsonSchemaPreviewResponse } from '../../../api/search-ai';

const DEBOUNCE_MS = 300;

export function KBDocumentsPage() {
  const t = useTranslations('search_ai.kb_pages');
  const tData = useTranslations('search_ai.data');
  const { knowledgeBase, sources, refreshSources, refresh } = useKBDetail();

  const indexId = knowledgeBase.searchIndexId ?? '';

  // Filter state
  const pendingFilter = useDataTabFilterStore((s) => s.pendingFilter);
  const consumeFilter = useDataTabFilterStore((s) => s.consumeFilter);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Upload dialog state
  const [uploadTarget, setUploadTarget] = useState<{
    sourceId: string;
    sourceName: string;
  } | null>(null);
  const [docRefreshKey, setDocRefreshKey] = useState(0);

  // JSON field selection dialog state
  const [jsonFieldDialogOpen, setJsonFieldDialogOpen] = useState(false);
  const [jsonPreviewData, setJsonPreviewData] = useState<JsonSchemaPreviewResponse | null>(null);

  // Consume pending filter on mount or when filter changes
  useEffect(() => {
    if (!pendingFilter) return;
    const pending = consumeFilter();
    if (!pending) return;

    if (pending.sourceId) {
      setActiveSourceId(pending.sourceId);
      setActiveFilter(null);
    } else {
      if (pending.sourceType) {
        setActiveFilter(pending.sourceType);
        setActiveSourceId(null);
      }
    }
    if (pending.statusFilter) {
      setStatusFilter(pending.statusFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFilter]);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchInput]);

  // Clear stale sourceId when source no longer exists
  useEffect(() => {
    if (activeSourceId && !sources.some((s) => s._id === activeSourceId)) {
      setActiveSourceId(null);
      toast.info(tData('source_removed_filter_cleared'));
    }
  }, [sources, activeSourceId, tData]);

  const activeSource = activeSourceId
    ? sources.find((s) => s._id === activeSourceId)
    : activeFilter
      ? sources.find((s) => s.sourceType === activeFilter)
      : undefined;

  const handleUploadToSource = (sourceId: string, sourceName: string) => {
    setUploadTarget({ sourceId, sourceName });
  };

  const handleSourceAdded = (source?: { _id: string; name: string; sourceType: string }) => {
    refreshSources();
    if (source && (source.sourceType === 'manual' || source.sourceType === 'file')) {
      setUploadTarget({ sourceId: source._id, sourceName: source.name });
    } else if (!source) {
      setUploadTarget({ sourceId: '', sourceName: '' });
    }
  };

  return (
    <ListPageShell
      title={t('documents_title')}
      primaryAction={<AddSourceButton indexId={indexId} onSourceAdded={handleSourceAdded} />}
    >
      {/* Filter bar */}
      <div className="space-y-3 mb-4">
        <SourceFilterBar
          sources={sources}
          activeFilter={activeFilter}
          onFilterChange={(f) => {
            setActiveFilter(f);
            setActiveSourceId(null);
          }}
          onUploadToSource={handleUploadToSource}
          activeSourceId={activeSourceId}
          activeSourceName={activeSource?.name ?? null}
          onClearSourceId={() => setActiveSourceId(null)}
          onSelectSource={(sourceId) => {
            setActiveSourceId(sourceId);
            setActiveFilter(null);
          }}
          knowledgeBase={knowledgeBase}
        />

        {/* Active filter badges */}
        {(statusFilter || activeSourceId || activeFilter) && (
          <div className="flex items-center gap-2">
            {statusFilter && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-default bg-background-elevated px-3 py-1 text-xs font-medium text-foreground transition-default hover:border-accent"
                onClick={() => setStatusFilter(null)}
                aria-label={tData('aria_clear_status_filter', { status: statusFilter })}
              >
                <span className="text-muted">{tData('filter_status')}:</span>
                <span className="capitalize">{statusFilter}</span>
                <X className="w-3 h-3 text-muted" aria-hidden="true" />
              </button>
            )}
            {activeSourceId && activeSource && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-default bg-background-elevated px-3 py-1 text-xs font-medium text-foreground transition-default hover:border-accent"
                onClick={() => setActiveSourceId(null)}
                aria-label={tData('aria_clear_source_filter', { source: activeSource.name })}
              >
                <span className="text-muted">{tData('filter_source')}:</span>
                <span>{activeSource.name}</span>
                <X className="w-3 h-3 text-muted" aria-hidden="true" />
              </button>
            )}
            <button
              className="text-xs text-muted hover:text-foreground transition-default"
              onClick={() => {
                setStatusFilter(null);
                setActiveSourceId(null);
                setActiveFilter(null);
                setSearchInput('');
              }}
            >
              {tData('clear_all_filters')}
            </button>
          </div>
        )}

        {/* Search input */}
        <Input
          icon={<Search className="w-4 h-4" />}
          placeholder={tData('search_placeholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      {/* Document table */}
      <DocumentTable
        indexId={indexId}
        projectId={knowledgeBase.projectId}
        kbId={knowledgeBase._id}
        sourceFilter={activeSourceId ? null : activeFilter}
        statusFilter={statusFilter}
        searchQuery={debouncedSearch}
        refreshKey={docRefreshKey}
        sourceId={activeSourceId ?? undefined}
        sourceName={activeSource?.name}
        sourceType={activeSource?.sourceType}
        onUploadToSource={handleUploadToSource}
        sources={sources}
        onClearStatusFilter={() => setStatusFilter(null)}
        onClearSourceFilter={() => setActiveSourceId(null)}
        onDocumentDeleted={refresh}
        onConfigureFields={async () => {
          try {
            const preview = await rediscoverJsonFields(indexId);
            if (preview?.fields?.length > 0) {
              setJsonPreviewData(preview);
              setJsonFieldDialogOpen(true);
            } else {
              toast.info(tData('clear_all_filters'), { duration: 5000 });
            }
          } catch {
            toast.error(t('error_loading'));
          }
        }}
      />

      {/* File upload dialog */}
      <FileUploadDialog
        open={!!uploadTarget}
        onClose={() => setUploadTarget(null)}
        indexId={indexId}
        sourceId={uploadTarget?.sourceId}
        sourceName={uploadTarget?.sourceName}
        sources={sources}
        onUploadComplete={() => {
          setUploadTarget(null);
          setDocRefreshKey((k) => k + 1);
          refreshSources();
        }}
      />

      {/* JSON field selection dialog */}
      {jsonPreviewData && (
        <JsonFieldSelectionDialog
          open={jsonFieldDialogOpen}
          onClose={() => {
            setJsonFieldDialogOpen(false);
            setJsonPreviewData(null);
          }}
          indexId={indexId}
          previewData={jsonPreviewData}
          onSaved={() => {
            setJsonFieldDialogOpen(false);
            setJsonPreviewData(null);
            setDocRefreshKey((k) => k + 1);
            refresh();
          }}
        />
      )}
    </ListPageShell>
  );
}
