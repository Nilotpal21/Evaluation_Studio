'use client';

import { useState } from 'react';
import {
  LayoutDashboard,
  FolderKanban,
  Bot,
  Workflow,
  Database,
  BookOpen,
  Store,
  LineChart,
  Settings,
  Code2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
}

const primary: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderKanban, count: 6 },
  { id: 'agents', label: 'Agents', icon: Bot, count: 22 },
  { id: 'flows', label: 'Flows', icon: Workflow },
  { id: 'knowledge', label: 'Knowledge', icon: Database },
  { id: 'evals', label: 'Evals', icon: LineChart },
];

const secondary: NavItem[] = [
  { id: 'docs', label: 'Docs', icon: BookOpen },
  { id: 'marketplace', label: 'Marketplace', icon: Store },
  { id: 'cli', label: 'CLI', icon: Code2 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const [active, setActive] = useState('dashboard');

  return (
    <aside className="w-[220px] shrink-0 border-r border-border bg-background-subtle flex flex-col">
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {primary.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            isActive={active === item.id}
            onClick={() => setActive(item.id)}
          />
        ))}
        <div className="my-3 border-t border-border-muted" />
        {secondary.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            isActive={active === item.id}
            onClick={() => setActive(item.id)}
          />
        ))}
      </nav>

      <div className="mx-2 mb-3 mt-2 rounded-lg border border-border-muted bg-background-muted/60 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="size-1.5 rounded-full bg-success animate-pulse" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-muted">
            System
          </span>
        </div>
        <p className="text-xs text-foreground">All systems operational</p>
        <p className="text-[11px] text-foreground-subtle mt-0.5">Updated 2 min ago</p>
      </div>
    </aside>
  );
}

function NavRow({
  item,
  isActive,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
        isActive
          ? 'bg-background-elevated text-foreground'
          : 'text-foreground-muted hover:bg-background-elevated/60 hover:text-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
      {item.count !== undefined && (
        <span
          className={cn(
            'text-[10px] font-mono tabular-nums',
            isActive ? 'text-foreground-muted' : 'text-foreground-subtle',
          )}
        >
          {item.count}
        </span>
      )}
    </button>
  );
}
