'use client';

import { useState } from 'react';
import { BookOpen, ChevronDown, Plus, Search } from 'lucide-react';
import { AddSourceDialog } from '@/components/knowledge/AddSourceDialog';

const sortOptions = ['Newest first', 'Oldest first'];
const statusOptions = ['All statuses', 'Active', 'Syncing', 'Stale', 'Error'];

export default function KnowledgePage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(sortOptions[0]);
  const [status, setStatus] = useState(statusOptions[0]);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="min-h-[calc(100vh-10rem)]">
      <div className="border-b border-border-muted pb-3">
        <h1 className="text-[28px] font-semibold tracking-tight text-foreground">Knowledge Bases</h1>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-[360px]">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search knowledge bases..."
            className="h-10 w-full rounded-lg border border-border-muted bg-background pl-11 pr-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
          />
        </div>

        <SimpleSelect value={sort} options={sortOptions} onChange={setSort} />
        <SimpleSelect value={status} options={statusOptions} onChange={setStatus} />
      </div>

      <div className="mt-4 border-t border-border-muted" />

      <div className="flex min-h-[60vh] items-center justify-center px-6">
        <div className="max-w-[420px] text-center">
          <div className="mx-auto flex size-[72px] items-center justify-center rounded-3xl bg-background-muted text-foreground-muted">
            <BookOpen className="size-8" />
          </div>
          <h2 className="mt-6 text-[18px] font-semibold tracking-tight text-foreground">
            Create your first knowledge base
          </h2>
          <p className="mt-2 text-[15px] leading-7 text-foreground-muted">
            Knowledge bases let your agents query structured and unstructured data using natural
            language.
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mt-8 inline-flex h-10 items-center gap-2 rounded-lg bg-[#202225] px-5 text-sm font-medium text-white transition-colors hover:bg-[#2b2e33]"
          >
            <Plus className="size-4" />
            New Knowledge Base
          </button>
        </div>
      </div>

      <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function SimpleSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-muted bg-background px-4 text-sm text-foreground transition-colors hover:border-border"
      >
        <span>{value}</span>
        <ChevronDown className="size-4 text-foreground-subtle" />
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-20 min-w-full overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <div className="p-1.5">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className="flex w-full rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-background-muted"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
