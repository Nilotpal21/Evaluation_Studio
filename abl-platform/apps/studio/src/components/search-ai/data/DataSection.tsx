/**
 * DataSection Component
 *
 * Combined data view: segmented control toggles between documents and sources views.
 * Documents view: source filter bar + search input + paginated document table.
 * Sources view: sources table with management actions.
 */

import { useState, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Input } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { SourceFilterBar } from './SourceFilterBar';
import { DocumentTable } from './DocumentTable';
import { FileUploadDialog } from './FileUploadDialog';
import { SourcesTable } from './SourcesTable';
import { ChunksGroupedView } from './ChunksGroupedView';
import { AddSourceButton } from './AddSourceButton';
import type {
  SearchAISource,
  KnowledgeBaseDetail,
  JsonSchemaPreviewResponse,
} from '../../../api/search-ai';
import { rediscoverJsonFields } from '../../../api/search-ai';
import { JsonFieldSelectionDialog } from './JsonFieldSelectionDialog';
import { useDataTabFilterStore, type DataView } from '../../../store/data-tab-filter-store';

interface DataSectionProps {
  indexId: string;
  sources: SearchAISource[];
  onRefreshSources: () => void;
  onRefreshKnowledgeBase?: () => void;
  knowledgeBase?: KnowledgeBaseDetail;
  /** Called when user clicks a non-configuring web source to navigate to USP */
  onNavigateToSource?: (sourceId: string) => void;
}

const DEBOUNCE_MS = 300;

export function DataSection({
  indexId,
  sources,
  onRefreshSources,
  onRefreshKnowledgeBase,
  knowledgeBase,
  onNavigateToSource,
}: DataSectionProps) {
  const t = useTranslations('search_ai.data');
  const pendingFilter = useDataTabFilterStore((s) => s.pendingFilter);
  const consumeFilter = useDataTabFilterStore((s) => s.consumeFilter);
  const [activeView, setActiveView] = useState<DataView>('sources');
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [uploadTarget, setUploadTarget] = useState<{
    sourceId: string;
    sourceName: string;
  } | null>(null);

  // refreshKey counter to force DocumentTable SWR re-fetch after upload
  const [docRefreshKey, setDocRefreshKey] = useState(0);

  // JSON field selection dialog state
  const [jsonFieldDialogOpen, setJsonFieldDialogOpen] = useState(false);
  const [jsonPreviewData, setJsonPreviewData] = useState<JsonSchemaPreviewResponse | null>(null);

  // One-shot flag for programmatic AddSource dialog open (from SetupGuide #68)
  const [autoOpenAddSource, setAutoOpenAddSource] = useState(false);

  // Source resume: when user clicks a configuring source card, open crawl flow with this sourceId
  const [resumeSourceId, setResumeSourceId] = useState<string | null>(null);

  // Consume pending filter reactively — fires on mount AND when filter changes while mounted
  useEffect(() => {
    if (!pendingFilter) return;
    const pending = consumeFilter();
    if (!pending) return;

    // sourceId implies documents view and takes precedence over view/sourceType
    if (pending.sourceId) {
      setActiveSourceId(pending.sourceId);
      setActiveFilter(null);
      setActiveView('documents');
    } else {
      if (pending.view) setActiveView(pending.view);
      if (pending.sourceType) {
        setActiveFilter(pending.sourceType);
        setActiveSourceId(null);
      }
    }
    if (pending.statusFilter) {
      setActiveView('documents');
      setStatusFilter(pending.statusFilter);
    }
    // autoOpenAddSource is independent of filter dimensions (learning from B4: no conflict)
    if (pending.autoOpenAddSource) {
      setAutoOpenAddSource(true);
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

  const handleSourceAdded = (source?: { _id: string; name: string; sourceType: string }) => {
    onRefreshSources();
    if (source && (source.sourceType === 'manual' || source.sourceType === 'file')) {
      // Source was created eagerly (non-file types) — open dialog with it pre-selected
      setUploadTarget({ sourceId: source._id, sourceName: source.name });
    } else if (!source) {
      // File upload: source deferred to upload time — open dialog without a source
      setUploadTarget({ sourceId: '', sourceName: '' });
    }
  };

  const handleUploadToSource = (sourceId: string, sourceName: string) => {
    setUploadTarget({ sourceId, sourceName });
  };

  // Clear stale sourceId when source no longer exists in list
  useEffect(() => {
    if (activeSourceId && !sources.some((s) => s._id === activeSourceId)) {
      setActiveSourceId(null);
      toast.info(t('source_removed_filter_cleared'));
    }
  }, [sources, activeSourceId, t]);

  // Resolve the active source: prefer sourceId (exact match), fall back to sourceType
  const activeSource = activeSourceId
    ? sources.find((s) => s._id === activeSourceId)
    : activeFilter
      ? sources.find((s) => s.sourceType === activeFilter)
      : undefined;

  return (
    <div className="space-y-4">
      {/* View toggle + Add source */}
      <div className="flex items-center justify-between">
        <SegmentedControl
          options={[
            { id: 'sources', label: t('view_sources') },
            { id: 'documents', label: t('view_documents') },
            { id: 'chunks', label: t('view_chunks') },
          ]}
          value={activeView}
          onChange={(v) => {
            const next = v as DataView;
            setActiveView(next);
            // Clear externally-set filters when leaving documents view;
            // preserve activeFilter (sourceType chip) since user explicitly set it
            if (next !== 'documents') {
              setStatusFilter(null);
              setActiveSourceId(null);
              setAutoOpenAddSource(false);
            }
          }}
          size="sm"
        />
        <AddSourceButton
          indexId={indexId}
          onSourceAdded={handleSourceAdded}
          autoOpen={autoOpenAddSource}
          onAutoOpenConsumed={() => setAutoOpenAddSource(false)}
          resumeSourceId={resumeSourceId}
          onResumeSourceConsumed={() => setResumeSourceId(null)}
        />
      </div>

      {activeView === 'documents' ? (
        <>
          {/* Filter bar + search */}
          <div className="space-y-3">
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
                    aria-label={t('aria_clear_status_filter', { status: statusFilter })}
                  >
                    <span className="text-muted">{t('filter_status')}:</span>
                    <span className="capitalize">{statusFilter}</span>
                    <X className="w-3 h-3 text-muted" aria-hidden="true" />
                  </button>
                )}
                {activeSourceId && activeSource && (
                  <button
                    className="inline-flex items-center gap-1.5 rounded-full border border-default bg-background-elevated px-3 py-1 text-xs font-medium text-foreground transition-default hover:border-accent"
                    onClick={() => setActiveSourceId(null)}
                    aria-label={t('aria_clear_source_filter', { source: activeSource.name })}
                  >
                    <span className="text-muted">{t('filter_source')}:</span>
                    <span>{activeSource.name}</span>
                    <X className="w-3 h-3 text-muted" aria-hidden="true" />
                  </button>
                )}
                {/* Clear all filters */}
                {(statusFilter ? 1 : 0) + (activeSourceId ? 1 : 0) + (activeFilter ? 1 : 0) >=
                  1 && (
                  <button
                    className="text-xs text-muted hover:text-foreground transition-default"
                    onClick={() => {
                      setStatusFilter(null);
                      setActiveSourceId(null);
                      setActiveFilter(null);
                      setSearchInput('');
                    }}
                  >
                    {t('clear_all_filters')}
                  </button>
                )}
              </div>
            )}

            {/* Search input */}
            <Input
              icon={<Search className="w-4 h-4" />}
              placeholder={t('search_placeholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          {/* Document table */}
          <DocumentTable
            indexId={indexId}
            projectId={knowledgeBase?.projectId ?? ''}
            kbId={knowledgeBase?._id ?? ''}
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
            onDocumentDeleted={onRefreshKnowledgeBase}
            onConfigureFields={async () => {
              try {
                const preview = await rediscoverJsonFields(indexId);
                if (preview?.fields?.length > 0) {
                  setJsonPreviewData(preview);
                  setJsonFieldDialogOpen(true);
                } else {
                  toast.info('No fields found. Delete and re-upload the JSON file.', {
                    duration: 5000,
                  });
                }
              } catch {
                toast.error('Failed to load field configuration.');
              }
            }}
          />
        </>
      ) : activeView === 'chunks' ? (
        <ChunksGroupedView indexId={indexId} />
      ) : (
        <SourcesTable
          indexId={indexId}
          sources={sources}
          onRefresh={onRefreshSources}
          onViewDocuments={(sourceId) => {
            setActiveView('documents');
            setStatusFilter(null);
            setActiveSourceId(sourceId);
            setActiveFilter(null);
          }}
          onUploadToSource={handleUploadToSource}
          onResumeSource={setResumeSourceId}
          onNavigateToSource={onNavigateToSource}
          knowledgeBase={knowledgeBase}
        />
      )}

      {/* SharePoint connector detail panel is now mounted at KBDetailLayout level
         so it's accessible from any section (Home, Data, etc.) */}

      {/* File upload dialog — always rendered since both views may trigger it */}
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
          onRefreshSources();
        }}
      />
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
            onRefreshKnowledgeBase?.();
          }}
        />
      )}
    </div>
  );
}
