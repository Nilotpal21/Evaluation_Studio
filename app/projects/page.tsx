'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Plus, Search, FolderOpen, Bot, Clock, ChevronDown } from 'lucide-react';
import { projects, type Project } from '@/lib/mock-data';
import { Footer } from '@/components/shell/Footer';

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export default function ProjectsPage() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = projects.filter((p) => p.status === 'active');
    if (!q) return active;
    return active.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.tag.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <button
          type="button"
          className="h-9 pl-3 pr-2 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-2"
        >
          <Plus className="size-3.5" />
          New Project
          <span className="size-5 -mr-1 rounded flex items-center justify-center bg-accent-foreground/10">
            <ChevronDown className="size-3" />
          </span>
        </button>
      </header>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find your workspace…"
          className="w-full h-11 bg-background-subtle border border-border-muted rounded-lg pl-9 pr-14 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40 focus:border-border"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-foreground-subtle font-mono border border-border-muted rounded px-1.5 py-0.5 pointer-events-none">
          ⌘ K
        </kbd>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 && (
          <p className="col-span-full text-xs text-foreground-muted text-center py-12 border border-dashed border-border-muted rounded-lg">
            No projects match {query ? `"${query}"` : 'your filters'}.
          </p>
        )}
        {filtered.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>

      <Footer />
    </div>
  );
}

function ProjectCard({ project: p }: { project: Project }) {
  return (
    <Link
      href={`/projects/${p.id}`}
      className="group rounded-lg border border-border-muted bg-background-subtle hover:border-border hover:bg-background-muted/40 transition-colors p-5 flex flex-col"
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="size-10 rounded-md bg-success-subtle text-success flex items-center justify-center shrink-0">
          <FolderOpen className="size-5" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-base font-semibold tracking-tight truncate group-hover:text-foreground transition-colors">
            {p.name}
          </div>
        </div>
      </div>

      <div className="h-px bg-border-muted mb-4" />

      <div className="flex items-center gap-4 text-xs text-foreground-muted">
        <span className="inline-flex items-center gap-1.5">
          <Bot className="size-3.5 text-foreground-subtle" />
          <span className="tabular-nums">{p.appCount}</span>{' '}
          {p.appCount === 1 ? 'agent' : 'agents'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 text-foreground-subtle" />
          <span className="tabular-nums">{formatDate(p.createdAt)}</span>
        </span>
      </div>
    </Link>
  );
}
