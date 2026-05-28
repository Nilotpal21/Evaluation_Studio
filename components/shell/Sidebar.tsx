'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  Bot,
  LineChart,
  Sparkles,
  Store,
  BookOpen,
  Settings,
  Inbox,
  FileSearch,
  Activity,
  Database,
  Cpu,
  Users,
  Settings2,
  ChevronLeft,
  type LucideIcon,
} from 'lucide-react';
import { useActivePersona, useActiveProjectId } from '@/lib/persona';
import { getProjectById } from '@/lib/mock-data';
import { cn } from '@/lib/utils';
import { ProjectSwitcher } from './ProjectSwitcher';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  count?: number;
}

interface NavGroup {
  primary: NavItem[];
  secondary: NavItem[];
}

const NAV: Record<'processOwner' | 'reviewer' | 'admin', NavGroup> = {
  processOwner: {
    primary: [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, href: '/' },
      { id: 'sops', label: 'SOPs', icon: FileText, href: '/sops' },
      { id: 'apps', label: 'Apps', icon: Bot, href: '/apps' },
      { id: 'evaluations', label: 'Evaluations', icon: LineChart, href: '/evaluations' },
      { id: 'knowledge', label: 'Knowledge', icon: Database, href: '/knowledge', count: 12 },
      { id: 'marketplace', label: 'Marketplace', icon: Store, href: '/marketplace' },
    ],
    secondary: [
      { id: 'docs', label: 'Docs', icon: BookOpen, href: '/docs' },
      { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
    ],
  },
  reviewer: {
    primary: [
      { id: 'queue', label: 'Queue', icon: Inbox, href: '/queue', count: 3 },
      { id: 'audit', label: 'Audit', icon: FileSearch, href: '/audit' },
    ],
    secondary: [
      { id: 'docs', label: 'Docs', icon: BookOpen, href: '/docs' },
      { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
    ],
  },
  admin: {
    primary: [
      { id: 'mc', label: 'Mission Control', icon: Activity, href: '/mission-control' },
      { id: 'audit', label: 'Audit', icon: FileSearch, href: '/audit' },
      { id: 'knowledge', label: 'Knowledge', icon: Database, href: '/knowledge', count: 12 },
      { id: 'models', label: 'Models', icon: Cpu, href: '/models', count: 7 },
      { id: 'marketplace', label: 'Marketplace', icon: Store, href: '/marketplace' },
    ],
    secondary: [
      { id: 'users', label: 'Users & Roles', icon: Users, href: '/users' },
      { id: 'tenant', label: 'Tenant Settings', icon: Settings2, href: '/settings' },
    ],
  },
};

export function Sidebar() {
  const active = useActivePersona();
  const activeProjectId = useActiveProjectId();
  const project = getProjectById(activeProjectId);
  const pathname = usePathname();

  const personaKey =
    active.role === 'Process Owner'
      ? 'processOwner'
      : active.role === 'Compliance Reviewer'
        ? 'reviewer'
        : 'admin';
  const { primary, secondary } = NAV[personaKey];
  const isProcessOwner = personaKey === 'processOwner';

  return (
    <aside className="w-[224px] shrink-0 border-r border-border bg-background-subtle flex flex-col">
      {isProcessOwner && project && (
        <div className="px-2 pt-3 pb-2 border-b border-border-muted space-y-1.5">
          <Link
            href="/projects"
            className="flex items-center gap-1 px-2 text-[10px] uppercase tracking-wide text-foreground-meta hover:text-foreground transition-colors font-medium"
          >
            <ChevronLeft className="size-3" />
            All projects
          </Link>
          <ProjectSwitcher variant="card" />
        </div>
      )}

      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {primary.map((item) => {
          // Process Owner's "Overview" item links to the active project's home.
          const href =
            isProcessOwner && item.id === 'overview' && project
              ? `/projects/${project.id}`
              : item.href;
          return (
            <NavRow
              key={item.id}
              item={{ ...item, href }}
              isActive={isActiveRoute(href, pathname, item.id === 'overview')}
            />
          );
        })}
        <div className="my-3 border-t border-border-muted" />
        {secondary.map((item) => (
          <NavRow key={item.id} item={item} isActive={isActiveRoute(item.href, pathname)} />
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

function NavRow({ item, isActive }: { item: NavItem; isActive: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
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
    </Link>
  );
}

function isActiveRoute(href: string, pathname: string, looseProjectMatch = false): boolean {
  if (looseProjectMatch && href.startsWith('/projects/')) {
    // "Overview" item — active for /projects/[id] and any descendant
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
