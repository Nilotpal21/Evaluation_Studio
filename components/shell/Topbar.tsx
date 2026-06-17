'use client';

import { Bell } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PersonaSwitcher } from './PersonaSwitcher';

export function Topbar() {
  usePathname();

  return (
    <header className="h-12 border-b border-border bg-background-subtle flex items-center px-3 gap-3 shrink-0">
      <Link href="/projects" className="flex items-center group" aria-label="netomi — projects">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/netomi-logo.png"
          alt="netomi"
          className="h-6 w-auto transition-transform group-hover:scale-105"
        />
      </Link>

      <div className="flex-1" />

      <Popover.Root>
        <Popover.Trigger asChild>
          <button
          type="button"
            className="size-8 rounded-full hover:bg-background-muted text-foreground-muted hover:text-foreground transition-colors flex items-center justify-center relative"
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
            className="z-50 w-[320px] rounded-2xl border border-border bg-background-subtle shadow-xl p-2 animate-fade-in"
          >
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
              Recent notifications
            </div>
            <div className="space-y-1">
              <NotificationRow
                title="HubSpot EU Analytics was revoked and needs reauthorization"
                ago="2 min ago"
              />
              <NotificationRow
                title="Sandbox test failed for Salesforce Sandbox after the latest connector change"
                ago="14 min ago"
              />
              <NotificationRow
                title="Mode hub default generation model was updated to Claude Sonnet 4.6"
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
