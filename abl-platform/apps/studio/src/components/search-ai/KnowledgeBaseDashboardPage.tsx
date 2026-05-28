/**
 * KnowledgeBaseDashboardPage Component
 *
 * Knowledge base list page at /projects/:id/search.
 * Shows metric cards, searchable/sortable card grid, and create KB action.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  BookOpen,
  Plus,
  Database,
  Layers,
  AlertTriangle,
  FileText,
  Link2,
  Clock,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { useKnowledgeBases } from '../../hooks/useKnowledgeBases';
import { ListPageShell } from '../ui/ListPageShell';
import { MetricCard } from '../ui/MetricCard';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog';
import type { KnowledgeBase } from '../../api/search-ai';

const PAGE_SIZE = 9;

const statusVariant: Record<string, BadgeVariant> = {
  ready: 'success',
  active: 'success',
  creating: 'info',
  indexing: 'info',
  rebuilding: 'warning',
  error: 'error',
};

type SortOption = 'newest' | 'oldest' | 'name-asc' | 'name-desc';

const SORT_OPTIONS: { value: SortOption; labelKey: string }[] = [
  { value: 'newest', labelKey: 'sort_newest' },
  { value: 'oldest', labelKey: 'sort_oldest' },
  { value: 'name-asc', labelKey: 'sort_name_asc' },
  { value: 'name-desc', labelKey: 'sort_name_desc' },
];

const STATUS_FILTER_OPTIONS = [
  { value: 'all', labelKey: 'filter_all' },
  { value: 'active', labelKey: 'filter_active' },
  { value: 'indexing', labelKey: 'filter_indexing' },
  { value: 'error', labelKey: 'filter_error' },
];

function isActiveStatus(status: string): boolean {
  return status === 'ready' || status === 'active';
}

function isIndexingStatus(status: string): boolean {
  return status === 'creating' || status === 'indexing' || status === 'rebuilding';
}

function isErrorStatus(status: string): boolean {
  return status === 'error';
}

function formatRelativeTime(
  iso: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, params?: any) => string,
): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return t('time_just_now');
  if (diffMin < 60) return t('time_minutes_ago', { count: diffMin });
  if (diffHr < 24) return t('time_hours_ago', { count: diffHr });
  if (diffDays < 30) return t('time_days_ago', { count: diffDays });
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── KB Card Sub-component ───────────────────────────────────────────────────

function KBCard({ kb, onClick }: { kb: KnowledgeBase; onClick: () => void }) {
  const t = useTranslations('search_ai.dashboard');
  return (
    <Card onClick={onClick} hoverable padding="md">
      <div className="flex flex-col gap-3">
        {/* Header: name + status */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground truncate flex-1">{kb.name}</h3>
          <Badge variant={statusVariant[kb.status] ?? 'default'} dot>
            {kb.status}
          </Badge>
        </div>

        {/* Description */}
        {kb.description ? (
          <p className="text-xs text-muted line-clamp-2 leading-relaxed">{kb.description}</p>
        ) : (
          <p className="text-xs text-subtle italic">{t('no_description')}</p>
        )}

        {/* Metrics row */}
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <FileText className="w-3.5 h-3.5" />
            {t('doc_count', { count: kb.documentCount ?? 0 })}
          </span>
          <span className="inline-flex items-center gap-1">
            <Link2 className="w-3.5 h-3.5" />
            {t('source_count', { count: kb.connectorCount ?? 0 })}
          </span>
        </div>

        {/* Footer: last updated */}
        <div className="flex items-center gap-1 text-xs text-subtle pt-1 border-t border-default">
          <Clock className="w-3 h-3" />
          <span>{t('updated_time', { time: formatRelativeTime(kb.updatedAt, t) })}</span>
        </div>
      </div>
    </Card>
  );
}

// ─── Loading Skeleton ────────────────────────────────────────────────────────

function KBCardSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-full mb-1" />
      <Skeleton className="h-3 w-3/4 mb-3" />
      <div className="flex items-center gap-4 mb-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

// ─── Main Page Component ─────────────────────────────────────────────────────

export function KnowledgeBaseDashboardPage() {
  const t = useTranslations('search_ai.dashboard');
  const { projectId, navigate } = useNavigationStore();
  const { knowledgeBases, aggregateDocStats, isLoading, error, refresh } =
    useKnowledgeBases(projectId);
  const [createOpen, setCreateOpen] = useState(false);

  // Search, sort, filter state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Debounced search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }, []);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  // Compute metrics from full list (before filters)
  // TODO: These metrics are computed client-side from the first page (limit=50).
  // For tenants with >50 KBs, counts will be truncated. Replace with a dedicated
  // server-side /knowledge-bases/stats endpoint for accurate aggregated counts.
  const metrics = useMemo(() => {
    const active = knowledgeBases.filter((kb) => isActiveStatus(kb.status)).length;
    return {
      total: knowledgeBases.length,
      active,
      totalDocuments: aggregateDocStats.totalDocuments,
      failedDocuments: aggregateDocStats.failedDocuments,
    };
  }, [knowledgeBases, aggregateDocStats]);

  // Filter + sort + paginate
  const { paginatedKBs, filteredTotal } = useMemo(() => {
    let filtered = knowledgeBases;

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase();
      filtered = filtered.filter((kb) => kb.name.toLowerCase().includes(query));
    }

    // Status filter
    if (statusFilter === 'active') {
      filtered = filtered.filter((kb) => isActiveStatus(kb.status));
    } else if (statusFilter === 'indexing') {
      filtered = filtered.filter((kb) => isIndexingStatus(kb.status));
    } else if (statusFilter === 'error') {
      filtered = filtered.filter((kb) => isErrorStatus(kb.status));
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'oldest':
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        default:
          return 0;
      }
    });

    // Paginate
    const start = (page - 1) * PAGE_SIZE;
    const paginated = sorted.slice(start, start + PAGE_SIZE);

    return { paginatedKBs: paginated, filteredTotal: sorted.length };
  }, [knowledgeBases, debouncedSearch, statusFilter, sortBy, page]);

  // Reset page when filters change
  const handleStatusFilterChange = useCallback((value: string) => {
    setStatusFilter(value);
    setPage(1);
  }, []);

  const handleSortChange = useCallback((value: string) => {
    if (SORT_OPTIONS.some((o) => o.value === value)) {
      setSortBy(value as SortOption);
    }
    setPage(1);
  }, []);

  if (!projectId) {
    return (
      <ListPageShell title={t('title')}>
        <div className="mt-8">
          <EmptyState
            icon={<BookOpen className="w-6 h-6" />}
            title={t('no_project_title')}
            description={t('no_project_description')}
          />
        </div>
      </ListPageShell>
    );
  }

  // Build filter defs for ListPageShell
  const filters = [
    {
      id: 'sort',
      label: t('filter_sort'),
      options: SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
      value: sortBy,
      onChange: handleSortChange,
    },
    {
      id: 'status',
      label: t('filter_status'),
      options: STATUS_FILTER_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
      value: statusFilter,
      onChange: handleStatusFilterChange,
    },
  ];

  const isEmptyStateShown =
    !isLoading && !error && (knowledgeBases.length === 0 || paginatedKBs.length === 0);

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={t('description')}
        hidePrimaryAction={isEmptyStateShown}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)}>
            {t('new_kb')}
          </Button>
        }
        searchPlaceholder={t('search_placeholder')}
        searchValue={searchInput}
        onSearchChange={handleSearchChange}
        filters={filters}
        pagination={
          filteredTotal > PAGE_SIZE
            ? {
                page,
                pageSize: PAGE_SIZE,
                total: filteredTotal,
                onPageChange: setPage,
              }
            : undefined
        }
      >
        {/* Metric Cards */}
        {!isLoading && knowledgeBases.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <MetricCard
              icon={<Database className="w-4 h-4" />}
              label={t('stat_total')}
              value={metrics.total}
            />
            <MetricCard
              icon={<Layers className="w-4 h-4" />}
              label={t('stat_active')}
              value={metrics.active}
            />
            <MetricCard
              icon={<FileText className="w-4 h-4" />}
              label={t('stat_total_documents')}
              value={metrics.totalDocuments}
            />
            <MetricCard
              icon={<AlertTriangle className="w-4 h-4" />}
              label={t('stat_failed_documents')}
              value={metrics.failedDocuments}
            />
          </div>
        )}

        {/* Content */}
        {error ? (
          <EmptyState
            icon={<AlertTriangle className="w-6 h-6" />}
            title={t('error_title')}
            description={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                {t('retry')}
              </Button>
            }
          />
        ) : isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <KBCardSkeleton key={i} />
            ))}
          </div>
        ) : knowledgeBases.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="w-6 h-6" />}
            title={t('empty_title')}
            description={t('empty_description')}
            action={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)}>
                {t('new_kb')}
              </Button>
            }
          />
        ) : paginatedKBs.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="w-6 h-6" />}
            title={t('no_results_title')}
            description={t('no_results_description')}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedKBs.map((kb) => (
              <KBCard
                key={kb._id}
                kb={kb}
                onClick={() => navigate(`/projects/${projectId}/search-ai/${kb._id}`)}
              />
            ))}
          </div>
        )}
      </ListPageShell>

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        onCreated={(kbId) => {
          setCreateOpen(false);
          refresh();
          navigate(`/projects/${projectId}/search-ai/${kbId}`);
        }}
      />
    </>
  );
}
