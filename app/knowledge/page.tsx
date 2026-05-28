'use client';

import { useMemo, useState } from 'react';
import { Plus, Search, MoreHorizontal } from 'lucide-react';
import {
  knowledgeSources,
  knowledgeStats,
  type KnowledgeMode,
  type KnowledgeStatus,
  type KnowledgeSource,
} from '@/lib/mock-data';
import { SourceCard } from '@/components/knowledge/SourceCard';
import { SourceDetailSheet } from '@/components/knowledge/SourceDetailSheet';
import { AddSourceDialog } from '@/components/knowledge/AddSourceDialog';
import { Footer } from '@/components/shell/Footer';
import { cn } from '@/lib/utils';

const MODES: { id: KnowledgeMode | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'upload', label: 'Upload' },
  { id: 'connector', label: 'Connector' },
  { id: 'crawl', label: 'Crawl' },
  { id: 'authored', label: 'Authored' },
  { id: 'api', label: 'API' },
];

const STATUSES: { id: KnowledgeStatus | 'all'; label: string; dot: string }[] = [
  { id: 'all', label: 'All', dot: 'bg-foreground-subtle' },
  { id: 'active', label: 'Active', dot: 'bg-success' },
  { id: 'syncing', label: 'Syncing', dot: 'bg-info' },
  { id: 'stale', label: 'Stale', dot: 'bg-warning' },
  { id: 'error', label: 'Error', dot: 'bg-error' },
  { id: 'deprecated', label: 'Deprecated', dot: 'bg-foreground-subtle' },
];

export default function KnowledgePage() {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<KnowledgeMode | 'all'>('all');
  const [status, setStatus] = useState<KnowledgeStatus | 'all'>('all');
  const [selected, setSelected] = useState<KnowledgeSource | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const filtered = useMemo(() => {
    return knowledgeSources.filter((s) => {
      if (mode !== 'all' && s.mode !== mode) return false;
      if (status !== 'all' && s.status !== status) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !s.name.toLowerCase().includes(q) &&
          !s.provider?.toLowerCase().includes(q) &&
          !s.tags.some((t) => t.toLowerCase().includes(q))
        )
          return false;
      }
      return true;
    });
  }, [mode, status, search]);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 pb-4 border-b border-border-muted">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge Library</h1>
          <p className="text-xs text-foreground-muted mt-1.5 font-mono tabular-nums">
            {knowledgeStats.total} sources · {knowledgeStats.documents.toLocaleString()} documents ·{' '}
            {knowledgeStats.chunks.toLocaleString()} chunks indexed · last sync{' '}
            {knowledgeStats.lastSyncAgo}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="h-9 px-3.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5"
          >
            <Plus className="size-3.5" />
            Add source
          </button>
          <button
            type="button"
            className="size-9 rounded-md border border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center justify-center"
            aria-label="More options"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </header>

      <section className="space-y-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, provider, or tag…"
            className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md pl-9 pr-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium pr-1">
            Mode
          </div>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                'px-2 py-1 rounded-md text-[11px] font-medium border transition-colors',
                mode === m.id
                  ? 'bg-background-elevated border-border text-foreground'
                  : 'bg-background-muted/40 border-border-muted text-foreground-muted hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium pr-1">
            Status
          </div>
          {STATUSES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStatus(s.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors',
                status === s.id
                  ? 'bg-background-elevated border-border text-foreground'
                  : 'bg-background-muted/40 border-border-muted text-foreground-muted hover:text-foreground',
              )}
            >
              <span className={cn('size-1.5 rounded-full', s.dot)} />
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.length === 0 ? (
          <p className="col-span-full text-xs text-foreground-muted text-center py-12 border border-dashed border-border-muted rounded-lg">
            No sources match your filters.
          </p>
        ) : (
          filtered.map((s) => (
            <SourceCard key={s.id} source={s} onClick={() => setSelected(s)} />
          ))
        )}
      </div>

      <Footer />

      <SourceDetailSheet
        source={selected}
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
      />
      <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
