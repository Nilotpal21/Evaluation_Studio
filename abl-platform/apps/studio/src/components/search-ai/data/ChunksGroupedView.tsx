/**
 * ChunksGroupedView Component
 *
 * Document-grouped accordion view for chunks. Replaces flat ChunksTable.
 * Documents appear as collapsible rows; expanding shows chunks inline
 * using ChunkExplorer flow-card patterns with per-document search.
 */

'use client';

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Search,
  Layers,
  Hash,
  Type,
  BarChart3,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  X,
  FileText,
  FileSpreadsheet,
  FileType,
} from 'lucide-react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { springs, STAGGER_DELAY } from '../../../lib/animation';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { JsonViewer } from '../../ui/JsonViewer';
import { Tooltip, TooltipProvider } from '../../ui/Tooltip';
import {
  fetchDocuments,
  fetchChunks,
  fetchAllChunks,
  type SearchAIDocument,
  type SearchAIChunk,
} from '../../../api/search-ai';

// ── Constants ──────────────────────────────────────────────────────────────────

const INITIAL_CHUNK_LIMIT = 20;
const CHUNK_LOAD_MORE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const CHUNK_STATUSES = ['indexed', 'pending', 'error'] as const;

const statusVariant: Record<string, BadgeVariant> = {
  indexed: 'success',
  pending: 'default',
  error: 'error',
};

type SortOption = 'date' | 'chunks' | 'name';

// ── Display helpers ───────────────────────────────────────────────────────────

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

function getFileIcon(title: string) {
  const lower = title.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls'))
    return <FileSpreadsheet className="w-4 h-4 text-success shrink-0" />;
  if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc'))
    return <FileText className="w-4 h-4 text-accent shrink-0" />;
  return <FileType className="w-4 h-4 text-muted shrink-0" />;
}

// ── Worst status helper ────────────────────────────────────────────────────────

function worstStatus(doc: SearchAIDocument, chunks?: SearchAIChunk[]): string {
  if (chunks && chunks.length > 0) {
    if (chunks.some((c) => c.status === 'error')) return 'error';
    if (chunks.some((c) => c.status === 'pending')) return 'pending';
    return 'indexed';
  }
  return doc.status;
}

/** Map document-level status to a chunk-level status for filtering.
 *  Documents go through many pipeline stages but for the chunks view
 *  we coalesce them into the three chunk-level statuses. */
function docStatusToChunkFilter(docStatus: string): string {
  if (docStatus === 'indexed' || docStatus === 'enriched') return 'indexed';
  if (docStatus === 'error' || docStatus === 'failed') return 'error';
  // Everything else (pending, extracting, extracted, enriching, embedding, processing, pending_field_selection)
  return 'pending';
}

// ── HighlightedText (local copy — same pattern as ChunkExplorer) ───────────────

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const parts: { text: string; match: boolean }[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIndex = 0;
  let searchPos = 0;

  while (searchPos < lowerText.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, searchPos);
    if (matchIndex === -1) break;
    if (matchIndex > lastIndex) {
      parts.push({ text: text.slice(lastIndex, matchIndex), match: false });
    }
    parts.push({ text: text.slice(matchIndex, matchIndex + query.length), match: true });
    lastIndex = matchIndex + query.length;
    searchPos = lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), match: false });
  }

  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-warning/30 text-foreground rounded-sm px-0.5">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

// ── MetadataSection (local copy — same pattern as ChunkExplorer) ───────────────

function MetadataSection({ title, data }: { title: string; data: Record<string, unknown> }) {
  const t = useTranslations('search_ai.chunks_grouped');
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="rounded-lg bg-background-muted overflow-hidden">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-background-muted/70 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted" />
        )}
        <span className="text-xs font-medium text-muted">{title}</span>
        <span className="ml-auto text-xs text-subtle">
          {t('fields_count', { count: Object.keys(data).length })}
        </span>
      </button>
      {isOpen && (
        <div className="px-2.5 pb-2">
          <JsonViewer data={data} maxDepth={3} copyable />
        </div>
      )}
    </div>
  );
}

// ── Truncate helper ────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  const flat = text.replace(/\n/g, ' ');
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface ChunksGroupedViewProps {
  indexId: string;
}

export function ChunksGroupedView({ indexId }: ChunksGroupedViewProps) {
  const t = useTranslations('search_ai.chunks_grouped');

  // Global search state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Status filter
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Sort
  const [sortBy, setSortBy] = useState<SortOption>('date');

  // Expanded documents (multiple)
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());

  // Reset on indexId change
  const [prevIndexId, setPrevIndexId] = useState(indexId);
  if (indexId !== prevIndexId) {
    setPrevIndexId(indexId);
    setSearchInput('');
    setDebouncedSearch('');
    setStatusFilter(null);
    setExpandedDocs(new Set());
  }

  // Debounce search
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value.trim());
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setDebouncedSearch('');
  }, []);

  // Fetch documents (all — no pagination for grouping, limit 200)
  const docSwrKey = useMemo(
    () => (indexId ? `/api/search-ai/indexes/${indexId}/documents?limit=200&groupView=1` : null),
    [indexId],
  );

  const {
    data: docData,
    isLoading: docsLoading,
    error: docsError,
    mutate: mutateDocs,
  } = useSWR(docSwrKey, () => fetchDocuments(indexId, { limit: 200 }));

  const documents = docData?.documents ?? [];

  // Global search: fetch matching chunks to determine which documents match
  const searchSwrKey = useMemo(
    () =>
      indexId && debouncedSearch
        ? `/api/search-ai/indexes/${indexId}/chunks?search=${encodeURIComponent(debouncedSearch)}&limit=200&includeContent=false`
        : null,
    [indexId, debouncedSearch],
  );

  const { data: searchData, isLoading: searchLoading } = useSWR(searchSwrKey, () =>
    fetchAllChunks(indexId, {
      search: debouncedSearch,
      limit: 200,
      includeContent: false,
    }),
  );

  // Set of document IDs that have matching chunks from global search
  const matchingDocIds = useMemo(() => {
    if (!debouncedSearch || !searchData?.chunks) return null; // null = no filter
    const ids = new Set<string>();
    for (const chunk of searchData.chunks) {
      if (chunk.documentId) ids.add(chunk.documentId);
    }
    return ids;
  }, [debouncedSearch, searchData]);

  // Auto-expand first matching document when global search results arrive
  useEffect(() => {
    if (matchingDocIds && matchingDocIds.size > 0) {
      // Find first matching doc in sorted order
      const sorted = [...documents];
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const firstMatch = sorted.find((d) => matchingDocIds.has(d._id));
      if (firstMatch) {
        setExpandedDocs(new Set([firstMatch._id]));
      }
    } else if (!debouncedSearch) {
      // Clear auto-expansions when search is cleared
    }
  }, [matchingDocIds, documents, debouncedSearch]);

  // Sort documents
  const sortedDocs = useMemo(() => {
    let sorted = [...documents];

    // Filter by global search matches
    if (matchingDocIds) {
      sorted = sorted.filter((d) => matchingDocIds.has(d._id));
    }

    // Filter by chunk status at the document level
    // Map document status to the three chunk-level statuses
    if (statusFilter) {
      sorted = sorted.filter((d) => docStatusToChunkFilter(d.status) === statusFilter);
    }

    switch (sortBy) {
      case 'date':
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'chunks':
        sorted.sort((a, b) => b.chunkCount - a.chunkCount);
        break;
      case 'name':
        sorted.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
        break;
    }
    return sorted;
  }, [documents, sortBy, matchingDocIds, statusFilter]);

  const hiddenDocCount = matchingDocIds || statusFilter ? documents.length - sortedDocs.length : 0;

  // Toggle document expansion
  const toggleDoc = useCallback((docId: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  }, []);

  // Error state
  if (docsError) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-6 text-center">
        <p className="text-sm text-error">{t('error_loading')}</p>
        <Button variant="ghost" size="sm" onClick={() => mutateDocs()} className="mt-2">
          {t('retry')}
        </Button>
      </div>
    );
  }

  // Loading state
  if (docsLoading) {
    return <GroupedViewSkeleton />;
  }

  // Empty state — no documents at all
  if (documents.length === 0) {
    return (
      <EmptyState
        icon={<Layers className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {/* Filter bar */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Global search */}
          <div className="relative flex-1 max-w-md min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('search_global_placeholder')}
              className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            />
            {searchInput && (
              <button
                onClick={clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort */}
          <div className="flex items-center gap-1.5 text-xs text-muted shrink-0">
            <span>{t('sort_label')}</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="bg-background-muted border border-default rounded-md text-foreground text-xs px-2 py-1.5 outline-none cursor-pointer"
            >
              <option value="date">{t('sort_newest')}</option>
              <option value="chunks">{t('sort_most_chunks')}</option>
              <option value="name">{t('sort_name_az')}</option>
            </select>
          </div>

          {/* Status chips */}
          <div className="flex items-center gap-1.5 ml-auto" role="group">
            <button
              onClick={() => setStatusFilter(null)}
              aria-pressed={statusFilter === null}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-default',
                statusFilter === null
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {t('filter_all')}
            </button>
            {CHUNK_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                aria-pressed={statusFilter === s}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-default',
                  statusFilter === s
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-background-muted text-muted hover:text-foreground',
                )}
              >
                {t(`filter_${s}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Search loading indicator */}
        {debouncedSearch && searchLoading && (
          <div className="text-xs text-muted px-1 animate-pulse">
            Searching chunks across all documents…
          </div>
        )}

        {/* Document accordion */}
        {sortedDocs.length > 0 ? (
          <div className="rounded-xl border border-default bg-background-elevated overflow-hidden divide-y divide-default">
            {sortedDocs.map((doc) => (
              <DocumentRow
                key={doc._id}
                doc={doc}
                indexId={indexId}
                isExpanded={expandedDocs.has(doc._id)}
                onToggle={() => toggleDoc(doc._id)}
                globalSearch={debouncedSearch}
                statusFilter={statusFilter}
              />
            ))}
          </div>
        ) : debouncedSearch && !searchLoading ? (
          <EmptyState
            icon={<Layers className="w-6 h-6" />}
            title={t('empty_search_title', { query: debouncedSearch })}
            description={t('empty_search_description')}
            action={
              <Button variant="ghost" size="sm" onClick={clearSearch}>
                {t('clear_search')}
              </Button>
            }
          />
        ) : null}

        {/* Hidden docs count */}
        {hiddenDocCount > 0 && (
          <div className="text-xs text-muted text-center py-1">
            {t('hidden_docs', { count: hiddenDocCount })}
          </div>
        )}

        {/* Stats footer */}
        <div className="flex items-center gap-4 text-xs text-muted px-1">
          <span>
            {t('stats_total', { count: documents.reduce((s, d) => s + d.chunkCount, 0) })}
          </span>
          <span>{t('stats_docs', { count: documents.length })}</span>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Document Row ───────────────────────────────────────────────────────────────

interface DocumentRowProps {
  doc: SearchAIDocument;
  indexId: string;
  isExpanded: boolean;
  onToggle: () => void;
  globalSearch: string;
  statusFilter: string | null;
}

function DocumentRow({
  doc,
  indexId,
  isExpanded,
  onToggle,
  globalSearch,
  statusFilter,
}: DocumentRowProps) {
  const t = useTranslations('search_ai.chunks_grouped');
  const title = displayDocTitle(doc.title) ?? 'Untitled';

  return (
    <div>
      {/* Header row */}
      <div
        className={clsx(
          'flex items-center px-4 py-3 gap-3 cursor-pointer transition-default select-none',
          isExpanded ? 'bg-accent/[0.03]' : 'hover:bg-background-muted',
        )}
        onClick={onToggle}
      >
        <span className="text-muted shrink-0 transition-transform duration-200">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>

        {getFileIcon(title)}

        <span className="text-sm font-medium text-foreground flex-1 min-w-0 truncate">{title}</span>

        <div className="flex items-center gap-3 shrink-0 text-xs text-muted">
          <span>
            {doc.chunkCount} chunk{doc.chunkCount !== 1 ? 's' : ''}
          </span>
          <Badge variant={statusVariant[worstStatus(doc)] ?? 'default'} dot>
            {worstStatus(doc)}
          </Badge>
        </div>
      </div>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.default}
            className="overflow-hidden"
          >
            <div className="mx-4 mb-4 ml-11">
              <DocumentChunksPanel
                indexId={indexId}
                doc={doc}
                globalSearch={globalSearch}
                statusFilter={statusFilter}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Document Chunks Panel (lazy loaded) ────────────────────────────────────────

interface DocumentChunksPanelProps {
  indexId: string;
  doc: SearchAIDocument;
  globalSearch: string;
  statusFilter: string | null;
}

function DocumentChunksPanel({
  indexId,
  doc,
  globalSearch,
  statusFilter,
}: DocumentChunksPanelProps) {
  const t = useTranslations('search_ai.chunks_grouped');

  // Per-document search
  const [localSearch, setLocalSearch] = useState('');
  const [debouncedLocalSearch, setDebouncedLocalSearch] = useState('');
  const localDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (localDebounceRef.current) clearTimeout(localDebounceRef.current);
    };
  }, []);

  const handleLocalSearchChange = useCallback((value: string) => {
    setLocalSearch(value);
    if (localDebounceRef.current) clearTimeout(localDebounceRef.current);
    localDebounceRef.current = setTimeout(() => {
      setDebouncedLocalSearch(value.trim());
    }, 200);
  }, []);

  // Expanded chunks
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [chunkLimit, setChunkLimit] = useState(INITIAL_CHUNK_LIMIT);
  const [showDist, setShowDist] = useState(false);

  // Fetch chunks for this document
  const { data, isLoading, error, mutate } = useSWR(
    `/api/search-ai/indexes/${indexId}/documents/${doc._id}/chunks?grouped=1`,
    () => fetchChunks(indexId, doc._id, { limit: 500, includeContent: true }),
  );

  const allChunks = data?.chunks ?? [];

  // Apply filters
  const activeSearch = globalSearch || debouncedLocalSearch;

  const filteredChunks = useMemo(() => {
    let result = allChunks;
    if (statusFilter) {
      result = result.filter((c) => c.status === statusFilter);
    }
    return result;
  }, [allChunks, statusFilter]);

  // Stats from all chunks (unfiltered for accurate totals)
  const stats = useMemo(() => {
    if (allChunks.length === 0) return null;
    const tokens = allChunks.map((c) => c.tokenCount);
    const total = tokens.reduce((a, b) => a + b, 0);
    return {
      total,
      avg: Math.round(total / tokens.length),
      min: Math.min(...tokens),
      max: Math.max(...tokens),
      count: allChunks.length,
    };
  }, [allChunks]);

  const maxTokenCount = stats?.max ?? 1;

  // Match chunks against search
  const chunkMatchesSearch = useCallback(
    (chunk: SearchAIChunk) => {
      if (!activeSearch) return true;
      return chunk.content?.toLowerCase().includes(activeSearch.toLowerCase()) ?? false;
    },
    [activeSearch],
  );

  // Visible chunks (with batched loading + search filtering)
  const visibleChunks = useMemo(() => {
    let base = filteredChunks;
    // When searching, show ONLY matching chunks (hide non-matches entirely)
    if (activeSearch) {
      return base.filter((c) => chunkMatchesSearch(c));
    }
    return base.slice(0, chunkLimit);
  }, [filteredChunks, chunkLimit, activeSearch, chunkMatchesSearch]);

  const remaining = filteredChunks.length - chunkLimit;

  const matchCount = useMemo(() => {
    if (!activeSearch) return 0;
    return filteredChunks.filter((c) => chunkMatchesSearch(c)).length;
  }, [filteredChunks, activeSearch, chunkMatchesSearch]);

  const toggleChunk = useCallback((chunkId: string) => {
    setExpandedChunks((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  }, []);

  const handleCopy = useCallback(async (chunkId: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedId(chunkId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4 rounded-xl border border-default bg-background">
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-8 rounded-lg" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-center">
        <p className="text-xs text-error">{t('error_loading_chunks')}</p>
        <Button variant="ghost" size="xs" onClick={() => mutate()} className="mt-1">
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-default bg-background p-4">
      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: t('stat_total_tokens'), value: stats.total.toLocaleString(), icon: Hash },
            { label: t('stat_avg_per_chunk'), value: stats.avg.toLocaleString(), icon: BarChart3 },
            { label: t('stat_smallest'), value: stats.min.toLocaleString(), icon: Type },
            { label: t('stat_largest'), value: stats.max.toLocaleString(), icon: Layers },
          ].map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-background-elevated"
            >
              <Icon className="w-3.5 h-3.5 text-muted shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted truncate">{label}</p>
                <p className="text-sm font-semibold text-foreground">{value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Token distribution (collapsible) */}
      {allChunks.length >= 1 && (
        <>
          <button
            onClick={() => setShowDist(!showDist)}
            className="flex items-center gap-1.5 text-xs text-accent hover:underline"
          >
            <ChevronRight
              className={clsx('w-3 h-3 transition-transform duration-200', showDist && 'rotate-90')}
            />
            {showDist ? t('hide_distribution') : t('show_distribution')}
          </button>

          <AnimatePresence>
            {showDist && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={springs.default}
                className="overflow-hidden"
              >
                <div className="space-y-1">
                  <div className="flex gap-px h-7 rounded-lg overflow-hidden bg-background-muted p-0.5">
                    {allChunks.map((chunk) => {
                      const intensity = chunk.tokenCount / maxTokenCount;
                      const isFiltered = activeSearch ? chunkMatchesSearch(chunk) : true;
                      return (
                        <Tooltip
                          key={chunk.id}
                          content={t('chunk_tooltip', {
                            index: chunk.chunkIndex,
                            tokens: chunk.tokenCount,
                          })}
                        >
                          <button
                            onClick={() => toggleChunk(chunk.id)}
                            className={clsx(
                              'flex-1 min-w-[2px] rounded-sm transition-all duration-200',
                              expandedChunks.has(chunk.id) &&
                                'ring-2 ring-accent ring-offset-1 ring-offset-background-muted',
                              !isFiltered && 'opacity-20',
                            )}
                            style={{
                              backgroundColor: `hsl(var(--accent-hsl) / ${0.2 + intensity * 0.8})`,
                            }}
                          />
                        </Tooltip>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] text-subtle">
                    <span>{t('chunk_label_start')}</span>
                    <span>{t('chunk_label_end', { index: allChunks.length - 1 })}</span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* Per-document search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
        <input
          type="text"
          value={localSearch}
          onChange={(e) => handleLocalSearchChange(e.target.value)}
          placeholder={t('search_doc_placeholder')}
          className="w-full pl-9 pr-20 py-1.5 text-xs rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        />
        {debouncedLocalSearch && (
          <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-accent font-medium">
            {t('search_found', { count: matchCount })}
          </span>
        )}
        {localSearch && (
          <button
            onClick={() => {
              setLocalSearch('');
              setDebouncedLocalSearch('');
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Chunk list */}
      <div className="relative space-y-1.5">
        {/* Connector line */}
        {visibleChunks.length > 1 && (
          <div className="absolute left-[18px] top-3 bottom-3 w-px bg-gradient-brand-fade pointer-events-none" />
        )}

        {visibleChunks.map((chunk, i) => {
          const isChunkExpanded = expandedChunks.has(chunk.id);
          const intensity = chunk.tokenCount / maxTokenCount;

          return (
            <motion.div
              key={chunk.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ ...springs.soft, delay: Math.min(i, 10) * STAGGER_DELAY }}
              className="relative pl-9"
            >
              {/* Node dot */}
              <div
                className={clsx(
                  'absolute left-3 top-3.5 w-2.5 h-2.5 rounded-full border-2 transition-all duration-200 z-[1]',
                  isChunkExpanded
                    ? 'bg-accent border-accent scale-125'
                    : activeSearch
                      ? 'bg-accent border-accent shadow-[0_0_6px_rgba(99,102,241,0.4)]'
                      : 'bg-background-elevated border-accent/40',
                )}
              />

              {/* Chunk card */}
              <div
                className={clsx(
                  'rounded-lg border transition-all duration-200 overflow-hidden cursor-pointer',
                  isChunkExpanded
                    ? 'border-accent/50 bg-background-elevated shadow-sm'
                    : 'border-default bg-background-elevated hover:border-accent/30',
                )}
              >
                {/* Header */}
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  onClick={() => toggleChunk(chunk.id)}
                >
                  <span className="text-muted shrink-0">
                    {isChunkExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </span>

                  <span className="text-xs font-mono font-medium text-accent shrink-0">
                    #{chunk.chunkIndex}
                  </span>

                  <span className="text-xs text-foreground truncate flex-1 min-w-0">
                    {chunk.content ? (
                      <HighlightedText text={truncate(chunk.content, 100)} query={activeSearch} />
                    ) : (
                      <span className="text-muted italic">{t('no_content')}</span>
                    )}
                  </span>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="w-10 h-1 rounded-full bg-background-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent/60"
                        style={{ width: `${intensity * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted font-mono w-8 text-right">
                      {chunk.tokenCount}
                    </span>
                    <Badge variant={statusVariant[chunk.status] ?? 'default'} dot>
                      {chunk.status}
                    </Badge>
                  </div>
                </div>

                {/* Expanded content */}
                <AnimatePresence>
                  {isChunkExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={springs.default}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-default">
                        <div className="px-4 py-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted">
                              {t('content_label')}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopy(chunk.id, chunk.content ?? '');
                              }}
                              className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default"
                            >
                              {copiedId === chunk.id ? (
                                <>
                                  <Check className="w-3 h-3 text-success" />
                                  <span className="text-success">{t('copied')}</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>{t('copy')}</span>
                                </>
                              )}
                            </button>
                          </div>
                          <div className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap font-mono bg-background rounded-lg p-3 max-h-52 overflow-y-auto border border-default">
                            {chunk.content ? (
                              <HighlightedText text={chunk.content} query={activeSearch} />
                            ) : (
                              <span className="text-muted italic">{t('no_content')}</span>
                            )}
                          </div>
                        </div>

                        {/* Metadata */}
                        {(chunk.metadata || chunk.canonicalMetadata) && (
                          <div className="px-4 py-3 border-t border-default space-y-2">
                            {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                              <MetadataSection title={t('metadata')} data={chunk.metadata} />
                            )}
                            {chunk.canonicalMetadata &&
                              Object.keys(chunk.canonicalMetadata).length > 0 && (
                                <MetadataSection
                                  title={t('canonical_metadata')}
                                  data={chunk.canonicalMetadata}
                                />
                              )}
                          </div>
                        )}

                        {/* Footer */}
                        <div className="px-4 py-2 border-t border-default bg-background-muted/50 flex items-center gap-4 text-[10px] text-muted">
                          <span>{t('id_label', { id: chunk.id })}</span>
                          <span>
                            {t('created_label', {
                              date: new Date(chunk.createdAt).toLocaleString(),
                            })}
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          );
        })}

        {/* Load more */}
        {!activeSearch && remaining > 0 && (
          <div className="text-center py-2">
            <button
              onClick={() => setChunkLimit((prev) => prev + CHUNK_LOAD_MORE)}
              className="text-xs text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg px-4 py-1.5 transition-default"
            >
              {t('show_more', {
                count: Math.min(remaining, CHUNK_LOAD_MORE),
                remaining,
              })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Loading Skeleton ───────────────────────────────────────────────────────────

function GroupedViewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 flex-1 max-w-md rounded-lg" />
        <Skeleton className="h-7 w-24 rounded-md" />
        <div className="flex gap-1.5 ml-auto">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-7 w-16 rounded-full" />
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden divide-y divide-default">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 flex-1 max-w-[300px] rounded" />
            <Skeleton className="h-4 w-16 rounded" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
