'use client';

/**
 * ChunkExplorer Component
 *
 * Interactive chunk visualization for a document. Features:
 * - Visual token distribution heatmap bar
 * - Connected chunk flow with animated cards
 * - Expandable chunk detail with metadata inspector
 * - Search/filter within chunks
 * - Chunk stats overview
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Layers,
  Hash,
  Type,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  BarChart3,
  AlignLeft,
  Grid3X3,
  X,
} from 'lucide-react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import { springs, STAGGER_DELAY } from '../../lib/animation';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Dialog } from '../ui/Dialog';
import { fetchChunks } from '../../api/search-ai';
import type { SearchAIChunk } from '../../api/search-ai';
import { Skeleton } from '../ui/Skeleton';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { JsonViewer } from '../ui/JsonViewer';

// ── Public Dialog Wrapper ────────────────────────────────────────────────────
// Use this from any view (CrawledPagesView, ConnectorsTab, etc.)

export interface ChunkExplorerDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  documentId: string;
  documentTitle: string;
  totalChunks: number;
}

export function ChunkExplorerDialog({
  open,
  onClose,
  indexId,
  documentId,
  documentTitle,
  totalChunks,
}: ChunkExplorerDialogProps) {
  const t = useTranslations('search_ai.chunk_explorer');
  // When totalChunks is 0 (unknown), omit the count from the description —
  // ChunkExplorer will show the real count from the API response once loaded.
  const description =
    totalChunks > 0 ? t('chunks_count', { count: totalChunks }) : t('loading_chunks');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={documentTitle}
      description={description}
      maxWidth="5xl"
    >
      <TooltipProvider>
        <ChunkExplorer indexId={indexId} documentId={documentId} totalChunks={totalChunks} />
      </TooltipProvider>
    </Dialog>
  );
}

// ── Internal Visualization ───────────────────────────────────────────────────

interface ChunkExplorerProps {
  indexId: string;
  documentId: string;
  totalChunks: number;
}

type ViewMode = 'flow' | 'grid' | 'list';

const statusVariant: Record<string, BadgeVariant> = {
  indexed: 'success',
  embedded: 'success',
  pending: 'default',
  processing: 'info',
  error: 'error',
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

function ChunkExplorer({ indexId, documentId, totalChunks }: ChunkExplorerProps) {
  const t = useTranslations('search_ai.chunk_explorer');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flow');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading } = useSWR(
    `/api/search-ai/indexes/${indexId}/documents/${documentId}/chunks`,
    () => fetchChunks(indexId, documentId, { limit: 200, includeContent: true }),
  );

  const chunks = data?.chunks ?? [];
  const pagination = data?.pagination;

  const filteredChunks = useMemo(() => {
    if (!searchQuery.trim()) return chunks;
    const q = searchQuery.toLowerCase();
    return chunks.filter(
      (c) => c.content?.toLowerCase().includes(q) || String(c.chunkIndex).includes(q),
    );
  }, [chunks, searchQuery]);

  const stats = useMemo(() => {
    if (chunks.length === 0) return null;
    const tokens = chunks.map((c) => c.tokenCount);
    const total = tokens.reduce((a, b) => a + b, 0);
    const max = Math.max(...tokens);
    const min = Math.min(...tokens);
    const avg = Math.round(total / tokens.length);
    return { total, max, min, avg, count: chunks.length };
  }, [chunks]);

  const maxTokenCount = stats?.max ?? 1;

  const handleCopyContent = useCallback(async (chunkId: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedId(chunkId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const toggleExpand = useCallback((chunkId: string) => {
    setExpandedChunkId((prev) => (prev === chunkId ? null : chunkId));
  }, []);

  if (isLoading) {
    return <ChunkExplorerSkeleton />;
  }

  return (
    <div className="space-y-4">
      {/* View mode toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          {t('chunks_loaded', { count: pagination?.total ?? totalChunks })}
        </p>
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-background-muted">
          {[
            { id: 'flow' as ViewMode, icon: AlignLeft, label: t('view_flow') },
            { id: 'grid' as ViewMode, icon: Grid3X3, label: t('view_grid') },
            { id: 'list' as ViewMode, icon: BarChart3, label: t('view_list') },
          ].map(({ id, icon: Icon, label }) => (
            <Tooltip key={id} content={label}>
              <button
                onClick={() => setViewMode(id)}
                className={clsx(
                  'p-1.5 rounded-md transition-default',
                  viewMode === id
                    ? 'bg-background-elevated text-foreground shadow-sm'
                    : 'text-muted hover:text-foreground',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Stats Bar */}
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
                <p className="text-xs text-muted truncate">{label}</p>
                <p className="text-sm font-semibold text-foreground">{value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Token Distribution Heatmap */}
      {chunks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">{t('token_distribution')}</p>
          <div className="flex gap-px h-8 rounded-lg overflow-hidden bg-background-muted p-0.5">
            {chunks.map((chunk, i) => {
              const intensity = chunk.tokenCount / maxTokenCount;
              const isExpanded = expandedChunkId === chunk.id;
              const isFiltered = searchQuery.trim()
                ? chunk.content?.toLowerCase().includes(searchQuery.toLowerCase())
                : true;
              return (
                <Tooltip
                  key={chunk.id}
                  content={t('chunk_token_tooltip', {
                    index: chunk.chunkIndex,
                    tokens: chunk.tokenCount,
                  })}
                >
                  <button
                    onClick={() => toggleExpand(chunk.id)}
                    className={clsx(
                      'flex-1 min-w-[3px] rounded-sm transition-all duration-200 relative',
                      isExpanded && 'ring-2 ring-accent ring-offset-1 ring-offset-background-muted',
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
          <div className="flex justify-between text-xs text-subtle">
            <span>{t('chunk_label', { index: 0 })}</span>
            <span>{t('chunk_label', { index: chunks.length - 1 })}</span>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
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

      {searchQuery && (
        <p className="text-xs text-muted">
          {t('search_results', { matched: filteredChunks.length, total: chunks.length })}
        </p>
      )}

      {/* Chunk Content */}
      {viewMode === 'flow' && (
        <ChunkFlowView
          chunks={filteredChunks}
          expandedChunkId={expandedChunkId}
          maxTokenCount={maxTokenCount}
          copiedId={copiedId}
          searchQuery={searchQuery}
          onToggleExpand={toggleExpand}
          onCopy={handleCopyContent}
        />
      )}
      {viewMode === 'grid' && (
        <ChunkGridView
          chunks={filteredChunks}
          expandedChunkId={expandedChunkId}
          maxTokenCount={maxTokenCount}
          copiedId={copiedId}
          searchQuery={searchQuery}
          onToggleExpand={toggleExpand}
          onCopy={handleCopyContent}
        />
      )}
      {viewMode === 'list' && (
        <ChunkListView
          chunks={filteredChunks}
          expandedChunkId={expandedChunkId}
          maxTokenCount={maxTokenCount}
          copiedId={copiedId}
          searchQuery={searchQuery}
          onToggleExpand={toggleExpand}
          onCopy={handleCopyContent}
        />
      )}
    </div>
  );
}

// ── Shared chunk view props ──────────────────────────────────────────────────

interface ChunkViewProps {
  chunks: SearchAIChunk[];
  expandedChunkId: string | null;
  maxTokenCount: number;
  copiedId: string | null;
  searchQuery: string;
  onToggleExpand: (id: string) => void;
  onCopy: (id: string, content: string) => void;
}

// ── Flow View ────────────────────────────────────────────────────────────────

function ChunkFlowView({
  chunks,
  expandedChunkId,
  maxTokenCount,
  copiedId,
  searchQuery,
  onToggleExpand,
  onCopy,
}: ChunkViewProps) {
  return (
    <div className="relative">
      {/* Connector line */}
      {chunks.length > 1 && (
        <div className="absolute left-5 top-4 bottom-4 w-px bg-gradient-brand-fade" />
      )}

      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {chunks.map((chunk, i) => (
            <motion.div
              key={chunk.id}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ ...springs.soft, delay: i * STAGGER_DELAY }}
            >
              <ChunkFlowCard
                chunk={chunk}
                index={i}
                isExpanded={expandedChunkId === chunk.id}
                maxTokenCount={maxTokenCount}
                isCopied={copiedId === chunk.id}
                searchQuery={searchQuery}
                onToggle={() => onToggleExpand(chunk.id)}
                onCopy={() => onCopy(chunk.id, chunk.content ?? '')}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface ChunkFlowCardProps {
  chunk: SearchAIChunk;
  index: number;
  isExpanded: boolean;
  maxTokenCount: number;
  isCopied: boolean;
  searchQuery: string;
  onToggle: () => void;
  onCopy: () => void;
}

function ChunkFlowCard({
  chunk,
  isExpanded,
  maxTokenCount,
  isCopied,
  searchQuery,
  onToggle,
  onCopy,
}: ChunkFlowCardProps) {
  const t = useTranslations('search_ai.chunk_explorer');
  const intensity = chunk.tokenCount / maxTokenCount;

  return (
    <div className="relative pl-10">
      {/* Node dot on connector */}
      <div
        className={clsx(
          'absolute left-3.5 top-4 w-3 h-3 rounded-full border-2 transition-all duration-200',
          isExpanded
            ? 'bg-accent border-accent scale-125'
            : 'bg-background-elevated border-accent/40',
        )}
      />

      <div
        className={clsx(
          'rounded-xl border transition-all duration-200 overflow-hidden cursor-pointer group',
          isExpanded
            ? 'border-accent/50 bg-background-elevated shadow-sm'
            : 'border-default bg-background-elevated hover:border-accent/30 hover:shadow-sm',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5" onClick={onToggle}>
          <button className="text-muted hover:text-foreground shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>

          <span className="text-xs font-mono font-medium text-accent shrink-0">
            #{chunk.chunkIndex}
          </span>

          {/* Token bar mini */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-foreground truncate flex-1">
                {chunk.content ? (
                  <HighlightedText
                    text={truncate(chunk.content.replace(/\n/g, ' '), 120)}
                    query={searchQuery}
                  />
                ) : (
                  <span className="text-muted italic">{t('no_content')}</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Token count with mini bar */}
            <div className="flex items-center gap-1.5">
              <div className="w-12 h-1.5 rounded-full bg-background-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent/60 transition-all"
                  style={{ width: `${intensity * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted font-mono w-10 text-right">
                {chunk.tokenCount}
              </span>
            </div>

            <Badge variant={statusVariant[chunk.status] ?? 'default'} dot>
              {chunk.status}
            </Badge>
          </div>
        </div>

        {/* Expanded content */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={springs.default}
              className="overflow-hidden"
            >
              <div className="border-t border-default">
                {/* Content section */}
                <div className="px-4 py-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">{t('content_label')}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopy();
                      }}
                      className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default"
                    >
                      {isCopied ? (
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
                  <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap font-mono bg-background rounded-lg p-3 max-h-64 overflow-y-auto border border-default">
                    {chunk.content ? (
                      <HighlightedText text={chunk.content} query={searchQuery} />
                    ) : (
                      <span className="text-muted italic">{t('no_content_available')}</span>
                    )}
                  </div>
                </div>

                {/* Metadata section */}
                {(chunk.metadata || chunk.canonicalMetadata) && (
                  <div className="px-4 py-3 border-t border-default space-y-2">
                    {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                      <MetadataSection title={t('metadata')} data={chunk.metadata} />
                    )}
                    {chunk.canonicalMetadata && Object.keys(chunk.canonicalMetadata).length > 0 && (
                      <MetadataSection
                        title={t('canonical_metadata')}
                        data={chunk.canonicalMetadata}
                      />
                    )}
                  </div>
                )}

                {/* Footer info */}
                <div className="px-4 py-2 border-t border-default bg-background-muted/50 flex items-center gap-4 text-xs text-muted">
                  <span>{t('id_label', { id: chunk.id })}</span>
                  <span>
                    {t('created_label', { date: new Date(chunk.createdAt).toLocaleString() })}
                  </span>
                  {chunk.updatedAt !== chunk.createdAt && (
                    <span>
                      {t('updated_label', { date: new Date(chunk.updatedAt).toLocaleString() })}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Grid View ────────────────────────────────────────────────────────────────

function ChunkGridView({
  chunks,
  expandedChunkId,
  maxTokenCount,
  copiedId,
  searchQuery,
  onToggleExpand,
  onCopy,
}: ChunkViewProps) {
  const t = useTranslations('search_ai.chunk_explorer');
  return (
    <div className="grid grid-cols-2 gap-2">
      <AnimatePresence initial={false}>
        {chunks.map((chunk, i) => {
          const intensity = chunk.tokenCount / maxTokenCount;
          const isExpanded = expandedChunkId === chunk.id;

          return (
            <motion.div
              key={chunk.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ ...springs.soft, delay: i * STAGGER_DELAY * 0.5 }}
              className={clsx(
                'rounded-xl border p-3 transition-all duration-200 cursor-pointer group',
                isExpanded
                  ? 'border-accent/50 bg-background-elevated shadow-sm col-span-2'
                  : 'border-default bg-background-elevated hover:border-accent/30',
              )}
              onClick={() => onToggleExpand(chunk.id)}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-medium text-accent">
                    #{chunk.chunkIndex}
                  </span>
                  <Badge variant={statusVariant[chunk.status] ?? 'default'} dot>
                    {chunk.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-8 h-1.5 rounded-full bg-background-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent/60"
                      style={{ width: `${intensity * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted font-mono">{chunk.tokenCount}</span>
                </div>
              </div>

              {/* Preview */}
              <p className="text-xs text-foreground/80 leading-relaxed line-clamp-3">
                {chunk.content ? (
                  <HighlightedText
                    text={truncate(chunk.content.replace(/\n/g, ' '), isExpanded ? 500 : 150)}
                    query={searchQuery}
                  />
                ) : (
                  <span className="text-muted italic">{t('no_content')}</span>
                )}
              </p>

              {/* Expanded */}
              {isExpanded && chunk.content && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  transition={springs.default}
                  className="mt-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">{t('full_content')}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopy(chunk.id, chunk.content ?? '');
                      }}
                      className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
                    >
                      {copiedId === chunk.id ? (
                        <Check className="w-3 h-3 text-success" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                  <div className="text-xs text-foreground/90 whitespace-pre-wrap font-mono bg-background rounded-lg p-3 max-h-48 overflow-y-auto border border-default">
                    <HighlightedText text={chunk.content} query={searchQuery} />
                  </div>
                  {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                    <MetadataSection title={t('metadata')} data={chunk.metadata} />
                  )}
                </motion.div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ── List View (compact table) ────────────────────────────────────────────────

function ChunkListView({
  chunks,
  expandedChunkId,
  maxTokenCount,
  copiedId,
  searchQuery,
  onToggleExpand,
  onCopy,
}: ChunkViewProps) {
  const t = useTranslations('search_ai.chunk_explorer');
  return (
    <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
      {/* Table header */}
      <div className="grid grid-cols-[60px_1fr_80px_80px_80px] gap-2 px-3 py-2 border-b border-default bg-background-muted/50 text-xs font-medium text-muted uppercase tracking-wider">
        <span>#</span>
        <span>{t('col_content_preview')}</span>
        <span className="text-right">{t('col_tokens')}</span>
        <span className="text-center">{t('col_status')}</span>
        <span className="text-center">{t('col_actions')}</span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-default">
        {chunks.map((chunk, i) => {
          const intensity = chunk.tokenCount / maxTokenCount;
          const isExpanded = expandedChunkId === chunk.id;

          return (
            <motion.div
              key={chunk.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * STAGGER_DELAY * 0.3 }}
            >
              {/* Row */}
              <div
                className={clsx(
                  'grid grid-cols-[60px_1fr_80px_80px_80px] gap-2 px-3 py-2.5 cursor-pointer transition-default items-center',
                  isExpanded ? 'bg-accent/5' : 'hover:bg-background-muted',
                )}
                onClick={() => onToggleExpand(chunk.id)}
              >
                <span className="text-xs font-mono font-medium text-accent">
                  {chunk.chunkIndex}
                </span>
                <p className="text-sm text-foreground truncate">
                  {chunk.content ? (
                    <HighlightedText
                      text={truncate(chunk.content.replace(/\n/g, ' '), 100)}
                      query={searchQuery}
                    />
                  ) : (
                    <span className="text-muted italic">{t('no_content')}</span>
                  )}
                </p>
                <div className="flex items-center justify-end gap-1.5">
                  <div className="w-10 h-1.5 rounded-full bg-background-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent/60"
                      style={{ width: `${intensity * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted font-mono">{chunk.tokenCount}</span>
                </div>
                <div className="text-center">
                  <Badge variant={statusVariant[chunk.status] ?? 'default'} dot>
                    {chunk.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(chunk.id, chunk.content ?? '');
                    }}
                    className="p-1 text-muted hover:text-foreground rounded transition-default"
                  >
                    {copiedId === chunk.id ? (
                      <Check className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Expanded detail */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={springs.default}
                    className="overflow-hidden"
                  >
                    <div className="px-4 py-3 bg-background-muted/30 space-y-3">
                      <div className="text-sm text-foreground/90 whitespace-pre-wrap font-mono bg-background rounded-lg p-3 max-h-48 overflow-y-auto border border-default">
                        {chunk.content ? (
                          <HighlightedText text={chunk.content} query={searchQuery} />
                        ) : (
                          <span className="text-muted italic">{t('no_content')}</span>
                        )}
                      </div>
                      {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                        <MetadataSection title={t('metadata')} data={chunk.metadata} />
                      )}
                      <div className="flex gap-4 text-xs text-muted">
                        <span>{t('id_label', { id: chunk.id })}</span>
                        <span>
                          {t('created_label', { date: new Date(chunk.createdAt).toLocaleString() })}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ── Metadata Section ──────────────────────────────────────────────────────────

function MetadataSection({ title, data }: { title: string; data: Record<string, unknown> }) {
  const t = useTranslations('search_ai.chunk_explorer');
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

// ── Text Highlighting ─────────────────────────────────────────────────────────

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

// ── Loading Skeleton ──────────────────────────────────────────────────────────

function ChunkExplorerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>

      <Skeleton className="h-8 rounded-lg" />
      <Skeleton className="h-9 rounded-lg" />

      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
