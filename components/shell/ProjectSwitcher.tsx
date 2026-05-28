'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronsUpDown, Check, ArrowUpRight, Search } from 'lucide-react';
import { projects, getProjectById, type Project } from '@/lib/mock-data';
import { usePersona } from '@/lib/persona';

function projectInitial(p: Project) {
  return p.name.trim().charAt(0).toUpperCase();
}

function ProjectBadge({ project, size = 'sm' }: { project: Project; size?: 'sm' | 'md' | 'lg' }) {
  const dims =
    size === 'lg'
      ? 'size-8 text-sm rounded-md'
      : size === 'md'
        ? 'size-6 text-[11px] rounded'
        : 'size-5 text-[10px] rounded';
  return (
    <span
      className={`${dims} bg-success-subtle border border-border-muted text-success font-semibold flex items-center justify-center shrink-0`}
    >
      {projectInitial(project)}
    </span>
  );
}

interface ProjectSwitcherProps {
  variant?: 'compact' | 'card';
}

export function ProjectSwitcher({ variant = 'compact' }: ProjectSwitcherProps) {
  const activeProjectId = usePersona((s) => s.activeProjectId);
  const setActiveProject = usePersona((s) => s.setActiveProject);
  const active = getProjectById(activeProjectId);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const list = projects.filter((p) => p.status === 'active');
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  }, [query]);

  return (
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery('')}>
      <DropdownMenu.Trigger asChild>
        {variant === 'card' ? (
          <button
            type="button"
            className="w-full flex items-center gap-2.5 text-left p-2 rounded-md hover:bg-background-elevated transition-colors"
            aria-label="Switch project"
          >
            {active ? (
              <ProjectBadge project={active} size="lg" />
            ) : (
              <span className="size-8 rounded-md bg-background-elevated border border-border-muted" />
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold tracking-tight truncate text-foreground">
                {active?.name ?? 'No project'}
              </span>
              {active && (
                <span className="block text-[11px] text-foreground-subtle tabular-nums">
                  {active.appCount} {active.appCount === 1 ? 'agent' : 'agents'}
                </span>
              )}
            </span>
            <ChevronsUpDown className="size-3.5 text-foreground-subtle shrink-0" />
          </button>
        ) : (
          <button
            type="button"
            className="flex items-center gap-2 px-2 py-1 rounded-md text-foreground hover:bg-background-elevated transition-colors text-xs"
            aria-label="Switch project"
          >
            {active ? (
              <ProjectBadge project={active} />
            ) : (
              <span className="size-5 rounded bg-background-elevated border border-border-muted" />
            )}
            <span className="truncate max-w-[140px] font-medium">
              {active?.name ?? 'No project'}
            </span>
            <ChevronsUpDown className="size-3 text-foreground-subtle" />
          </button>
        )}
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[260px] rounded-lg border border-border bg-background-elevated shadow-xl p-1 animate-fade-in"
        >
          <div className="px-1.5 pt-1.5 pb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search projects…"
                className="w-full h-8 bg-background-muted/60 border border-border-muted rounded-md pl-8 pr-2 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-foreground-muted text-center">
                No projects match.
              </div>
            )}
            {filtered.map((p) => {
              const isActive = p.id === activeProjectId;
              return (
                <DropdownMenu.Item
                  key={p.id}
                  onSelect={() => setActiveProject(p.id)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs cursor-pointer outline-none focus:bg-background-muted data-[highlighted]:bg-background-muted"
                >
                  <ProjectBadge project={p} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-foreground font-medium truncate">
                      {p.name}
                    </span>
                    <span className="block text-[11px] text-foreground-muted">
                      {p.appCount} apps · {p.memberCount} members
                    </span>
                  </span>
                  {isActive && <Check className="size-3.5 text-foreground-muted shrink-0" />}
                </DropdownMenu.Item>
              );
            })}
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-border-muted" />
          <DropdownMenu.Item asChild>
            <Link
              href="/projects"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-foreground-muted hover:text-foreground cursor-pointer outline-none focus:bg-background-muted data-[highlighted]:bg-background-muted"
            >
              View all projects
              <ArrowUpRight className="size-3" />
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
