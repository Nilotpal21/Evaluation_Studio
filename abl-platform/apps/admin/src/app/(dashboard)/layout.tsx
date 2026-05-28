'use client';

import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  SlidersHorizontal,
  Brain,
  FileText,
  ShieldCheck,
  Activity,
  BarChart3,
  TrendingUp,
  Settings,
  Lock,
  LogOut,
  ExternalLink,
  Search,
  ToggleLeft,
  LayoutTemplate,
  UserCog,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'OVERVIEW',
    items: [{ href: '/', label: 'Dashboard', icon: <LayoutDashboard size={18} /> }],
  },
  {
    label: 'TENANTS',
    items: [
      { href: '/tenants', label: 'Tenant Management', icon: <Users size={18} /> },
      {
        href: '/config-overrides',
        label: 'Config Overrides',
        icon: <SlidersHorizontal size={18} />,
      },
      { href: '/models', label: 'Model Provisioning', icon: <Brain size={18} /> },
      { href: '/deals', label: 'Deal Management', icon: <FileText size={18} /> },
      { href: '/features', label: 'Feature Catalog', icon: <ToggleLeft size={18} /> },
    ],
  },
  {
    label: 'OPERATIONS',
    items: [
      { href: '/resilience', label: 'Resilience Controls', icon: <ShieldCheck size={18} /> },
      { href: '/health', label: 'System Health', icon: <Activity size={18} /> },
      { href: '/access', label: 'Access Control', icon: <UserCog size={18} /> },
    ],
  },
  {
    label: 'OBSERVABILITY',
    items: [
      { href: '/traces', label: 'Trace Inspector', icon: <Search size={18} /> },
      { href: '/usage', label: 'Usage & Analytics', icon: <TrendingUp size={18} /> },
      { href: '/audit', label: 'Audit Log', icon: <BarChart3 size={18} /> },
    ],
  },
  {
    label: 'MARKETPLACE',
    items: [{ href: '/templates', label: 'Templates Manager', icon: <LayoutTemplate size={18} /> }],
  },
  {
    label: 'INFRASTRUCTURE',
    items: [
      { href: '/config', label: 'Configuration', icon: <Settings size={18} /> },
      { href: '/secrets', label: 'Secrets', icon: <Lock size={18} /> },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <nav className="w-64 bg-background-subtle border-r border-default flex flex-col">
        <div className="p-6">
          <h1 className="text-lg font-bold text-foreground">Admin Dashboard</h1>
          <p className="text-xs text-subtle mt-0.5">Agent Platform</p>
        </div>

        <div className="flex-1 px-3 space-y-6 overflow-y-auto">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <h3 className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">
                {group.label}
              </h3>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className={`flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-sm transition-default ${
                          active
                            ? 'bg-accent-subtle text-foreground border-l-2 border-accent font-medium'
                            : 'text-muted hover:text-foreground hover:bg-background-muted'
                        }`}
                      >
                        {item.icon}
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="p-3 mt-auto border-t border-default space-y-1">
          <a
            href="/api/auth/logout"
            className="flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-sm text-error transition-default hover:bg-error-subtle"
          >
            <LogOut size={18} />
            Logout
          </a>
          <a
            href={process.env.NEXT_PUBLIC_BITBUCKET_REPO_URL || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-sm text-subtle transition-default hover:text-foreground hover:bg-background-muted"
          >
            <ExternalLink size={18} />
            Bitbucket
          </a>
          <a
            href={process.env.NEXT_PUBLIC_ARGOCD_URL || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-sm text-subtle transition-default hover:text-foreground hover:bg-background-muted"
          >
            <ExternalLink size={18} />
            ArgoCD
          </a>
        </div>
      </nav>

      <main className="flex-1 p-8 overflow-auto">
        <div className="animate-fade-in-up">{children}</div>
      </main>
    </div>
  );
}
