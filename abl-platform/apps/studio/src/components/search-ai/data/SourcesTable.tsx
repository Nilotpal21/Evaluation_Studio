/**
 * SourcesTable Component
 *
 * Shows all sources with management actions. Enterprise connectors
 * open ConnectorDetailPanel; non-enterprise sources open SourceDetailPanel.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { Upload, Eye, Trash2, Plus, Search, LayoutGrid, List } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { getSourceDisplayName } from '@/lib/upload-constants';
import { DataTable, type Column } from '../../ui/DataTable';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { ConnectorDetailPanel } from '../ConnectorDetailPanel';
import { SourceDetailPanel } from './SourceDetailPanel';
import { SourcesCardGrid } from './SourcesCardGrid';
import { SourcesAggregateSummary, type SourceAggregates } from './SourcesAggregateSummary';
import { BulkActionsToolbar } from './BulkActionsToolbar';
import { SourcesToolbar, type GroupBy } from './SourcesToolbar';
import { fetchEnterpriseConnectors, deleteSource, deleteConnector } from '../../../api/search-ai';
import type { SearchAISource, KnowledgeBaseDetail } from '../../../api/search-ai';
import { getCrawlHistory } from '../../../api/crawl';
import type { CrawlJob } from '../../../api/crawl';
import { useConnectorStore, type ConnectorTab } from '../../../store/connector-store';

/** Active crawl job statuses — jobs in these states mean crawl is in progress */
const ACTIVE_CRAWL_STATUSES = new Set(['queued', 'crawling', 'ingesting']);

/**
 * Derive the effective display status for a source.
 * If the source has an active crawl job (queued/crawling/ingesting),
 * override the status to 'crawling' so the UI shows a pulsing indicator.
 * The backend never sets Source.status = 'crawling' — it only tracks this on CrawlJob.
 */
function getEffectiveStatus(source: SearchAISource, activeCrawlMap: Map<string, CrawlJob>): string {
  const activeJob = activeCrawlMap.get(source._id);
  if (activeJob && ACTIVE_CRAWL_STATUSES.has(activeJob.status)) {
    return 'crawling';
  }
  return source.status;
}

interface SourcesTableProps {
  indexId: string;
  sources: SearchAISource[];
  onRefresh: () => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
  onAddSource?: () => void;
  /** Called when user clicks a configuring web source to resume the crawl flow */
  onResumeSource?: (sourceId: string) => void;
  /** Called when user clicks a non-configuring web source to navigate to USP */
  onNavigateToSource?: (sourceId: string) => void;
  aggregates?: SourceAggregates | null;
  knowledgeBase?: KnowledgeBaseDetail;
}

const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  awaiting_auth: 'warning',
  configuring: 'default',
  draft: 'default',
  pending: 'default',
  syncing: 'info',
  crawling: 'info',
  partial: 'warning',
  disabled: 'default',
  error: 'error',
  auth_failed: 'error',
};

const VIEW_MODE_STORAGE_KEY = 'sp-sources-view-mode';

function sourceTypeLabel(sourceType: string, t: (key: string) => string): string {
  switch (sourceType) {
    case 'manual':
    case 'file':
      return t('type_manual');
    case 'web':
      return t('type_web');
    case 'database':
      return t('type_database');
    case 'api':
      return t('type_api');
    case 'sharepoint':
      return t('type_sharepoint');
    default:
      return sourceType;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SourcesTable({
  indexId,
  sources,
  onRefresh,
  onViewDocuments,
  onUploadToSource,
  onAddSource,
  onResumeSource,
  onNavigateToSource,
  aggregates,
  knowledgeBase,
}: SourcesTableProps) {
  const t = useTranslations('search_ai.sources_table');
  const tDetail = useTranslations('search_ai.source_detail');

  // ─── Active crawl job detection ──────────────────────────────────────
  // Fetch recent crawl jobs to derive which sources have crawls in progress.
  // The backend never sets Source.status = 'crawling', so we cross-reference
  // the CrawlJob list to show a pulsing "crawling" indicator on the sources list.
  const { data: crawlHistoryData } = useSWR(
    indexId ? ['crawl-history-for-sources', indexId] : null,
    () => getCrawlHistory(indexId, 50),
    { refreshInterval: 10000, revalidateOnFocus: true },
  );

  const activeCrawlMap = useMemo(() => {
    const map = new Map<string, CrawlJob>();
    if (!crawlHistoryData?.jobs) return map;
    for (const job of crawlHistoryData.jobs) {
      if (job.sourceId && ACTIVE_CRAWL_STATUSES.has(job.status)) {
        // Keep the most recent active job per source
        if (!map.has(job.sourceId)) {
          map.set(job.sourceId, job);
        }
      }
    }
    return map;
  }, [crawlHistoryData]);

  // Build sourceId → effective status map for card grid
  const effectiveStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      const effective = getEffectiveStatus(s, activeCrawlMap);
      if (effective !== s.status) {
        map.set(s._id, effective);
      }
    }
    return map;
  }, [sources, activeCrawlMap]);

  // View mode: card (<=6 sources) or table (>=7), with manual override
  const autoViewMode = sources.length <= 6 ? 'card' : 'table';
  const [viewModeOverride, setViewModeOverride] = useState<'card' | 'table' | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === 'card' || stored === 'table' ? stored : null;
  });
  const viewMode = viewModeOverride ?? autoViewMode;

  const handleViewModeChange = useCallback((mode: string) => {
    const m = mode as 'card' | 'table';
    setViewModeOverride(m);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, m);
  }, []);

  const viewModeOptions = useMemo(
    () => [
      { id: 'card', label: t('view_card'), icon: <LayoutGrid className="w-3.5 h-3.5" /> },
      { id: 'table', label: t('view_table'), icon: <List className="w-3.5 h-3.5" /> },
    ],
    [t],
  );

  // Enterprise connector map: sourceId → connectorId
  const [connectorMap, setConnectorMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadConnectorMap() {
      try {
        const result = await fetchEnterpriseConnectors(indexId);
        if (!cancelled && result.data?.connectors) {
          const map: Record<string, string> = {};
          for (const c of result.data.connectors) {
            if (c.sourceId) {
              map[c.sourceId] = c._id;
            }
          }
          setConnectorMap(map);
        }
      } catch {
        // Non-critical
      }
    }
    loadConnectorMap();
    return () => {
      cancelled = true;
    };
  }, [indexId, sources]);

  // Panel state
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const selectedSource = selectedSourceId
    ? (sources.find((s) => s._id === selectedSourceId) ?? null)
    : null;
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [connectorPanelOpen, setConnectorPanelOpen] = useState(false);
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    documentCount: number;
    sourceType?: string;
    connectorId?: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Search state
  const DEBOUNCE_MS = 300;
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Reset search when sources change
  useEffect(() => {
    setSearchInput('');
    setDebouncedSearch('');
  }, [sources]);

  // Grouping + status filter state
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Record<string, true>>({});
  const selectedCount = Object.keys(selectedIds).length;
  const someSelected = selectedCount > 0;
  const allSelectedAreSP =
    someSelected &&
    Object.keys(selectedIds).every(
      (id) => sources.find((s) => s._id === id)?.sourceType === 'sharepoint',
    );
  const [bulkLoading, setBulkLoading] = useState(false);

  // Filtered sources for display (search by name + status filter)
  // Must be declared before toggleSelectAll which references it
  const filteredSources = useMemo(() => {
    let result = sources;
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(query));
    }
    if (statusFilter) {
      result = result.filter((s) => s.status === statusFilter);
    }
    return result;
  }, [sources, debouncedSearch, statusFilter]);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = true;
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedCount === filteredSources.length) {
      setSelectedIds({});
    } else {
      const next: Record<string, true> = {};
      for (const s of filteredSources) {
        next[s._id] = true;
      }
      setSelectedIds(next);
    }
  }, [filteredSources, selectedCount]);

  const clearSelection = useCallback(() => {
    setSelectedIds({});
  }, []);

  // Reset selection on source changes
  useEffect(() => {
    setSelectedIds({});
  }, [sources]);

  // Grouped sources for group-by rendering
  const groupedSources = useMemo(() => {
    if (groupBy === 'none') return null;
    const groups: Record<string, typeof filteredSources> = {};
    for (const s of filteredSources) {
      const key = groupBy === 'type' ? s.sourceType : groupBy === 'status' ? s.status : 'default';
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    return groups;
  }, [filteredSources, groupBy]);

  // Status counts for quick filter pills
  const statusCountsMap = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of sources) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    return counts;
  }, [sources]);

  // Health summary — count all known statuses so numbers add up (#81)
  // Always compute from FULL source list, not filtered.
  // Uses effective status (with frontend-derived crawling) for accurate counts.
  const healthCounts = useMemo(() => {
    let active = 0;
    let syncing = 0;
    let crawling = 0;
    let errorCount = 0;
    let disabled = 0;
    let pending = 0;
    for (const s of sources) {
      const effectiveStatus = getEffectiveStatus(s, activeCrawlMap);
      if (effectiveStatus === 'active') active++;
      else if (effectiveStatus === 'syncing') syncing++;
      else if (effectiveStatus === 'crawling') crawling++;
      else if (effectiveStatus === 'error') errorCount++;
      else if (effectiveStatus === 'disabled') disabled++;
      else if (effectiveStatus === 'pending') pending++;
    }
    return {
      total: sources.length,
      active,
      syncing,
      crawling,
      error: errorCount,
      disabled,
      pending,
    };
  }, [sources, activeCrawlMap]);

  const openPanel = useConnectorStore((s) => s.openPanel);

  const handleRowClick = useCallback(
    (row: SearchAISource) => {
      // Configuring web sources → resume crawl flow (also handle legacy 'draft' status)
      if (
        (row.status === 'configuring' || row.status === 'draft') &&
        row.sourceType === 'web' &&
        onResumeSource
      ) {
        onResumeSource(row._id);
        return;
      }

      const isManual = row.sourceType === 'manual' || row.sourceType === 'file';
      const cId = connectorMap[row._id];
      if (cId && row.sourceType === 'sharepoint') {
        // SharePoint: open new SharePointDetailPanel via store
        // Draft/pending → Connect tab; Active/syncing/error → Overview tab
        const isDraft = row.status === 'pending' || row.status === 'disabled';
        const tab: ConnectorTab = isDraft ? 'connect' : 'overview';
        openPanel(cId, { isNew: false, tab });
      } else if (cId && !isManual) {
        // Non-SharePoint enterprise connector: use old panel
        // (manual/file sources have auto-created ConnectorConfig but should use SourceDetailPanel)
        setSelectedConnectorId(cId);
        setConnectorPanelOpen(true);
      } else if (row.sourceType === 'web' && onNavigateToSource) {
        // Web sources (non-configuring) → Unified Source Page
        onNavigateToSource(row._id);
      } else {
        // Manual/file/database/api sources → SourceDetailPanel
        setSelectedSourceId(row._id);
        setSourcePanelOpen(true);
      }
    },
    [connectorMap, openPanel, onResumeSource, onNavigateToSource],
  );

  const handleDeleteClick = useCallback(
    (row: SearchAISource, e: React.MouseEvent) => {
      e.stopPropagation();
      setDeleteTarget({
        id: row._id,
        name: row.name,
        documentCount: row.documentCount,
        sourceType: row.sourceType,
        connectorId: connectorMap[row._id],
      });
    },
    [connectorMap],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      // For SharePoint connectors, delete the connector (which also deletes source + revokes token)
      if (
        deleteTarget.connectorId &&
        (deleteTarget.sourceType === 'sharepoint' || deleteTarget.sourceType === 'connector')
      ) {
        await deleteConnector(indexId, deleteTarget.connectorId);
        // Close the SharePoint detail panel if it's open for this connector
        const store = useConnectorStore.getState();
        if (store.activeConnectorId === deleteTarget.connectorId) {
          store.closePanel();
        }
      } else {
        await deleteSource(indexId, deleteTarget.id);
      }
      toast.success(t('delete_success'));
      setDeleteTarget(null);
      onRefresh();
    } catch (err: unknown) {
      const msg = sanitizeError(err, t('delete_error'));
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }, [indexId, deleteTarget, onRefresh, t]);

  const hasSharePointSources = useMemo(
    () => sources.some((s) => s.sourceType === 'sharepoint'),
    [sources],
  );

  // Bulk action handlers (call backend bulk-actions API)
  const handleBulkAction = useCallback(
    async (action: string) => {
      if (selectedCount === 0) return;
      setBulkLoading(true);
      try {
        const { apiFetch, handleResponse } = await import('../../../lib/api-client');
        const resp = await apiFetch(`/api/search-ai/indexes/${indexId}/connectors/bulk-actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, sourceIds: Object.keys(selectedIds) }),
        });
        await handleResponse(resp);
        toast.success(t('bulk_success'));
        clearSelection();
        onRefresh();
      } catch (err: unknown) {
        const msg = sanitizeError(err, t('bulk_error'));
        toast.error(msg);
      } finally {
        setBulkLoading(false);
      }
    },
    [indexId, selectedIds, selectedCount, clearSelection, onRefresh, t],
  );

  const columns: Column<SearchAISource>[] = useMemo(
    () => [
      {
        key: 'select',
        label: '',
        width: 'w-10',
        render: (row) => (
          <input
            type="checkbox"
            checked={!!selectedIds[row._id]}
            onChange={() => toggleSelection(row._id)}
            onClick={(e) => e.stopPropagation()}
            className="rounded border-default"
            aria-label={t('select_row')}
          />
        ),
      },
      {
        key: 'name',
        label: t('col_name'),
        sortable: true,
        sortValue: (row) => getSourceDisplayName(row.name),
        render: (row) => (
          <span className="font-medium text-foreground">{getSourceDisplayName(row.name)}</span>
        ),
      },
      {
        key: 'type',
        label: t('col_type'),
        render: (row) => <Badge variant="info">{sourceTypeLabel(row.sourceType, tDetail)}</Badge>,
      },
      {
        key: 'status',
        label: t('col_status'),
        render: (row) => {
          const effectiveStatus = getEffectiveStatus(row, activeCrawlMap);
          return (
            <Badge
              variant={statusVariant[effectiveStatus] ?? 'default'}
              dot
              pulse={effectiveStatus === 'crawling' || effectiveStatus === 'syncing'}
            >
              {effectiveStatus}
            </Badge>
          );
        },
      },
      {
        key: 'docs',
        label: t('col_docs'),
        sortable: true,
        sortValue: (row) => row.documentCount,
        render: (row) => {
          const effectiveStatus = getEffectiveStatus(row, activeCrawlMap);
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onViewDocuments(row._id, row.name);
              }}
              className="text-info hover:underline font-medium"
              aria-label={t('action_view_docs')}
            >
              {effectiveStatus === 'crawling' ? (
                <span className="text-info">
                  {row.documentCount.toLocaleString()}
                  <span className="animate-pulse">&hellip;</span>
                </span>
              ) : (
                row.documentCount.toLocaleString()
              )}
            </button>
          );
        },
      },
      {
        key: 'lastSync',
        label: t('col_last_sync'),
        render: (row) => {
          const effectiveStatus = getEffectiveStatus(row, activeCrawlMap);
          return effectiveStatus === 'crawling' ? (
            <span className="text-info text-sm">{tDetail('crawling_status')}</span>
          ) : (
            <span className="text-xs text-muted">{formatDate(row.lastSyncAt)}</span>
          );
        },
      },
      // Conditional SP columns
      ...(hasSharePointSources
        ? [
            {
              key: 'sites' as const,
              label: t('col_sites'),
              render: (row: SearchAISource) =>
                row.sourceType === 'sharepoint' ? (
                  <span className="text-xs text-muted">
                    {String((row as unknown as Record<string, unknown>).siteCount ?? '—')}
                  </span>
                ) : (
                  <span className="text-xs text-muted">—</span>
                ),
            },
          ]
        : []),
      {
        key: 'actions',
        label: t('col_actions'),
        width: 'w-28',
        render: (row) => (
          <div className="flex items-center gap-1">
            {(row.sourceType === 'manual' || row.sourceType === 'file') && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUploadToSource(row._id, row.name);
                }}
                className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
                title={t('action_upload')}
                aria-label={t('action_upload')}
              >
                <Upload className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onViewDocuments(row._id, row.name);
              }}
              className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
              title={t('action_view_docs')}
              aria-label={t('action_view_docs')}
            >
              <Eye className="w-4 h-4" />
            </button>
            <button
              onClick={(e) => handleDeleteClick(row, e)}
              className="p-1.5 text-muted hover:text-error rounded-lg transition-default"
              title={t('action_delete')}
              aria-label={t('action_delete')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ),
      },
    ],
    [
      t,
      tDetail,
      onViewDocuments,
      onUploadToSource,
      handleDeleteClick,
      hasSharePointSources,
      selectedIds,
      toggleSelection,
      activeCrawlMap,
    ],
  );

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={<Plus className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  return (
    <>
      {/* Health summary bar */}
      <div
        className="flex items-center gap-4 text-xs text-muted px-1 mb-3"
        role="status"
        aria-label={t('health_summary')}
      >
        <span>{t('health_total', { count: healthCounts.total })}</span>
        {healthCounts.active > 0 && (
          <span className="text-success">{t('health_active', { count: healthCounts.active })}</span>
        )}
        {healthCounts.syncing > 0 && (
          <span className="text-info">{t('health_syncing', { count: healthCounts.syncing })}</span>
        )}
        {healthCounts.crawling > 0 && (
          <span className="text-info">
            {t('health_crawling', { count: healthCounts.crawling })}
          </span>
        )}
        {healthCounts.error > 0 && (
          <span className="text-error">{t('health_error', { count: healthCounts.error })}</span>
        )}
        {healthCounts.pending > 0 && (
          <span>{t('health_pending', { count: healthCounts.pending })}</span>
        )}
        {healthCounts.disabled > 0 && (
          <span>{t('health_disabled', { count: healthCounts.disabled })}</span>
        )}
      </div>

      {/* Aggregate summary */}
      {aggregates && (
        <SourcesAggregateSummary aggregates={aggregates} sourceCount={sources.length} />
      )}

      {/* Toolbar: search + group-by + quick filter pills + view toggle */}
      <SourcesToolbar
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        statusCounts={statusCountsMap}
      />

      {/* Card or table view — with optional grouping */}
      {filteredSources.length === 0 && (debouncedSearch || statusFilter) ? (
        <EmptyState
          icon={<Search className="w-6 h-6" />}
          title={t('no_matching', { query: debouncedSearch || statusFilter || '' })}
        />
      ) : groupedSources ? (
        <div className="space-y-4">
          {Object.entries(groupedSources).map(([groupKey, groupItems]) => (
            <div key={groupKey}>
              <h3 className="text-sm font-medium text-muted mb-2 capitalize">
                {groupKey} ({groupItems.length})
              </h3>
              {viewMode === 'card' ? (
                <SourcesCardGrid
                  sources={groupItems}
                  connectorMap={connectorMap}
                  onCardClick={handleRowClick}
                  onDeleteClick={handleDeleteClick}
                  onViewDocuments={onViewDocuments}
                  onUploadToSource={onUploadToSource}
                  knowledgeBase={knowledgeBase}
                  effectiveStatusMap={effectiveStatusMap}
                />
              ) : (
                <div className="rounded-xl border border-default bg-background-elevated overflow-hidden mb-2">
                  <DataTable
                    columns={columns}
                    data={groupItems}
                    keyExtractor={(row) => row._id}
                    onRowClick={handleRowClick}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : viewMode === 'card' ? (
        <SourcesCardGrid
          sources={filteredSources}
          connectorMap={connectorMap}
          onCardClick={handleRowClick}
          onDeleteClick={handleDeleteClick}
          onViewDocuments={onViewDocuments}
          onUploadToSource={onUploadToSource}
          onAddSource={onAddSource}
          knowledgeBase={knowledgeBase}
          effectiveStatusMap={effectiveStatusMap}
        />
      ) : (
        <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
          <DataTable
            columns={columns}
            data={filteredSources}
            keyExtractor={(row) => row._id}
            onRowClick={handleRowClick}
          />
        </div>
      )}

      {/* Source detail panel (non-enterprise) */}
      {selectedSource && (
        <SourceDetailPanel
          open={sourcePanelOpen}
          onClose={() => {
            setSourcePanelOpen(false);
            setSelectedSourceId(null);
          }}
          source={selectedSource}
          indexId={indexId}
          connectorId={selectedSource ? (connectorMap[selectedSource._id] ?? null) : null}
          onRefresh={onRefresh}
          onViewDocuments={() => {
            setSourcePanelOpen(false);
            if (selectedSource) {
              onViewDocuments(selectedSource._id, selectedSource.name);
            }
          }}
          onUploadFiles={
            selectedSource.sourceType === 'manual' || selectedSource.sourceType === 'file'
              ? () => {
                  setSourcePanelOpen(false);
                  if (selectedSource) {
                    onUploadToSource(selectedSource._id, selectedSource.name);
                  }
                }
              : undefined
          }
        />
      )}

      {/* Connector detail panel (enterprise) */}
      {selectedConnectorId && (
        <ConnectorDetailPanel
          open={connectorPanelOpen}
          onClose={() => {
            setConnectorPanelOpen(false);
            setSelectedConnectorId(null);
          }}
          indexId={indexId}
          connectorId={selectedConnectorId}
          onRefresh={onRefresh}
        />
      )}

      {/* Bulk actions toolbar */}
      {someSelected && (
        <BulkActionsToolbar
          selectedCount={selectedCount}
          allAreSP={allSelectedAreSP}
          onPause={() => handleBulkAction('pause')}
          onResume={() => handleBulkAction('resume')}
          onSyncNow={() => handleBulkAction('sync_now')}
          onDelete={() => handleBulkAction('delete')}
          onReAuth={allSelectedAreSP ? () => handleBulkAction('re_auth') : undefined}
          onApplySchedule={allSelectedAreSP ? () => handleBulkAction('apply_schedule') : undefined}
          onExportConfigs={allSelectedAreSP ? () => handleBulkAction('export_configs') : undefined}
          onClearSelection={clearSelection}
          loading={bulkLoading}
        />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_message', {
          name: deleteTarget?.name ?? '',
          count: deleteTarget?.documentCount ?? 0,
        })}
        confirmLabel={t('confirm_delete_button')}
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
