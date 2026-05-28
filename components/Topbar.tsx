import { Search, Bell, Plus, ChevronDown } from 'lucide-react';
import { currentUser } from '@/lib/mock-data';

export function Topbar() {
  return (
    <header className="h-12 border-b border-border bg-background-subtle flex items-center px-4 gap-3 shrink-0">
      <div className="flex items-center gap-2">
        <div className="size-6 rounded-md bg-foreground flex items-center justify-center">
          <span className="text-background text-[10px] font-bold">S</span>
        </div>
        <span className="text-sm font-medium tracking-tight">Studio</span>
      </div>

      <button className="flex items-center gap-1.5 ml-3 px-2 py-1 rounded-md text-foreground-muted hover:bg-background-elevated hover:text-foreground transition-colors text-xs">
        <span className="size-4 rounded bg-purple/20 text-purple flex items-center justify-center font-semibold text-[10px]">
          K
        </span>
        <span>{currentUser.org}</span>
        <ChevronDown className="size-3" />
      </button>

      <div className="flex-1 max-w-md mx-auto relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle" />
        <input
          placeholder="Search agents, projects, runs..."
          className="w-full h-7 bg-background-muted/60 border border-border-muted rounded-md pl-8 pr-12 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
        />
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-foreground-subtle font-mono border border-border-muted rounded px-1 py-px">
          ⌘K
        </kbd>
      </div>

      <button className="h-7 px-2.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5">
        <Plus className="size-3.5" />
        New project
      </button>

      <button className="size-7 rounded-md hover:bg-background-elevated text-foreground-muted hover:text-foreground transition-colors flex items-center justify-center relative">
        <Bell className="size-3.5" />
        <span className="absolute top-1 right-1 size-1.5 rounded-full bg-info" />
      </button>

      <div className="size-7 rounded-full bg-accent-subtle border border-border flex items-center justify-center text-[11px] font-medium text-foreground">
        {currentUser.initials}
      </div>
    </header>
  );
}
