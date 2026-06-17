'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Settings,
  Inbox,
  FileSearch,
  Activity,
  Database,
  Cpu,
  Users,
  Settings2,
  Rocket,
  Store,
  ChevronLeft,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';
import { useActivePersona, useActiveProjectId } from '@/lib/persona';
import { getProjectById } from '@/lib/mock-data';
import { useProjectNavAccess } from '@/lib/project-state';
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
      { id: 'evaluations', label: 'Evaluation Studio', icon: Activity, href: '/evaluations' },
      { id: 'mode-hub', label: 'Mode hub', icon: Cpu, href: '/mode-hub' },
      { id: 'knowledge-base', label: 'Knowledge Base', icon: Database, href: '/knowledge' },
      { id: 'session-evaluation', label: 'Session evaluation', icon: ClipboardList, href: '/session-evaluation' },
      { id: 'validators', label: 'Validators', icon: FileSearch, href: '/validators' },
      { id: 'monitoring', label: 'Monitoring', icon: Activity, href: '/mission-control' },
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
      { id: 'mc', label: 'Monitoring', icon: Activity, href: '/mission-control' },
      { id: 'deployments', label: 'Deployments', icon: Rocket, href: '/deployments' },
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
  const navAccess = useProjectNavAccess(activeProjectId);
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
    <aside className="w-[220px] shrink-0 border-r border-border bg-background-subtle flex flex-col">
      {isProcessOwner && project && (
        <div className="px-3 pt-3 pb-2.5 border-b border-border-muted space-y-1">
          <Link
            href="/projects"
            className="flex items-center gap-1 px-2 text-[11px] text-foreground-meta hover:text-foreground transition-colors font-medium"
          >
            <ChevronLeft className="size-3" />
            All projects
          </Link>
          <ProjectSwitcher variant="card" />
        </div>
      )}

      <nav className="flex-1 px-2.5 py-3 space-y-0.5">
        {primary.map((item) => {
          let href = item.href;
          if (personaKey === 'processOwner' && item.id === 'evaluations' && activeProjectId) {
            href = `/projects/${activeProjectId}/evaluations`;
          }
          if (personaKey === 'processOwner' && item.id === 'session-evaluation' && activeProjectId) {
            href = `/projects/${activeProjectId}/preprod`;
          }
          if (personaKey === 'processOwner' && item.id === 'validators' && activeProjectId) {
            href = `/projects/${activeProjectId}/validators`;
          }
          if (personaKey === 'processOwner' && item.id === 'monitoring' && activeProjectId) {
            href = `/projects/${activeProjectId}/monitoring`;
          }
          if (personaKey === 'admin' && item.id === 'mc' && activeProjectId) {
            href = `/projects/${activeProjectId}/monitoring`;
          }
          const disabled =
            personaKey === 'processOwner' && item.id === 'session-evaluation'
              ? !navAccess.sessionEvaluationEnabled
              : personaKey === 'processOwner' && item.id === 'monitoring'
                ? !navAccess.monitoringEnabled
                : false;
          return (
            <NavRow
              key={item.id}
              item={{ ...item, href }}
              disabled={disabled}
              isActive={isActiveRoute(href, pathname)}
            />
          );
        })}
        <div className="my-3 border-t border-border-muted" />
        {secondary.map((item) => (
          <NavRow key={item.id} item={item} isActive={isActiveRoute(item.href, pathname)} />
        ))}
      </nav>

      <div className="mx-2.5 mb-2.5 mt-2 rounded-xl border border-border-muted bg-background-muted p-2.5">
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

function NavRow({ item, isActive, disabled = false }: { item: NavItem; isActive: boolean; disabled?: boolean }) {
  const Icon = item.icon;
  const classes = cn(
    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors',
    disabled
      ? 'cursor-not-allowed text-foreground-subtle opacity-50'
      : isActive
        ? 'bg-accent-subtle text-accent'
        : 'text-foreground-muted hover:bg-background-muted hover:text-foreground',
  );

  if (disabled) {
    return (
      <div className={classes} aria-disabled="true">
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        {item.count !== undefined && (
          <span className="text-[10px] font-mono tabular-nums text-foreground-subtle">
            {item.count}
          </span>
        )}
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={classes}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
      {item.count !== undefined && (
        <span
          className={cn(
            'text-[10px] font-mono tabular-nums',
            isActive ? 'text-accent' : 'text-foreground-subtle',
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
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
