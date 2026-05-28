'use client';

import { Search, Bell, Plus } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PersonaSwitcher } from './PersonaSwitcher';

export function Topbar() {
  const pathname = usePathname();
  // On the Projects landing, hide workspace / project / search / upload —
  // those affordances only make sense once a project is the active context.
  const isProjectsLanding = pathname === '/projects';

  return (
    <header className="h-12 border-b border-border bg-background-subtle flex items-center px-4 gap-3 shrink-0">
      <Link href="/" className="flex items-center group" aria-label="Eltropy — home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/eltropy-logo.png"
          alt="Eltropy"
          className="h-8 w-auto transition-transform group-hover:scale-105"
        />
      </Link>

      {!isProjectsLanding && (
        <>
          <div className="flex-1 max-w-sm mx-auto relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle pointer-events-none" />
            <input
              placeholder="Search SOPs, apps, evaluations, knowledge…"
              className="w-full h-7 bg-background-muted/60 border border-border-muted rounded-md pl-8 pr-12 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-foreground-subtle font-mono border border-border-muted rounded px-1 py-px pointer-events-none">
              ⌘K
            </kbd>
          </div>

          <Link
            href="/sops/new"
            className="h-7 px-2.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5"
          >
            <Plus className="size-3.5" />
            Upload SOP
          </Link>
        </>
      )}

      {isProjectsLanding && <div className="flex-1" />}

      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="size-7 rounded-md hover:bg-background-elevated text-foreground-muted hover:text-foreground transition-colors flex items-center justify-center relative"
            aria-label="Notifications"
          >
            <Bell className="size-3.5" />
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-info" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 w-[320px] rounded-lg border border-border bg-background-elevated shadow-xl p-2 animate-fade-in"
          >
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
              Recent notifications
            </div>
            <div className="space-y-1">
              <NotificationRow
                title="hardship-assist needs your co-approval"
                ago="2 min ago"
              />
              <NotificationRow
                title="Continuous evaluation flagged a 4-point drop on Reg E disclosure"
                ago="14 min ago"
              />
              <NotificationRow
                title="Helper suggestion ready: improve Hardship eligibility logic"
                ago="32 min ago"
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <PersonaSwitcher />
    </header>
  );
}

function NotificationRow({ title, ago }: { title: string; ago: string }) {
  return (
    <button
      type="button"
      className="w-full text-left px-2 py-2 rounded-md hover:bg-background-muted transition-colors"
    >
      <div className="text-xs text-foreground">{title}</div>
      <div className="text-[11px] text-foreground-subtle mt-0.5">{ago}</div>
    </button>
  );
}
