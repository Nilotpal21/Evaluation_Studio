'use client';

import { useState } from 'react';
import { Plus, MoreHorizontal, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { personas, projects } from '@/lib/mock-data';
import { Footer } from '@/components/shell/Footer';
import { cn } from '@/lib/utils';

interface MockUser {
  id: string;
  name: string;
  initials: string;
  email: string;
  role: string;
  projects: string[];
  status: 'active' | 'invited';
  lastSeenAgo: string;
  hue: 'purple' | 'success' | 'info' | 'warning';
}

const mockUsers: MockUser[] = [
  {
    id: personas.processOwner.id,
    name: personas.processOwner.name,
    initials: personas.processOwner.initials,
    email: personas.processOwner.email,
    role: 'Process Owner',
    projects: ['proj_card_services', 'proj_collections', 'proj_member_onboarding'],
    status: 'active',
    lastSeenAgo: '2 min ago',
    hue: 'purple',
  },
  {
    id: personas.reviewer.id,
    name: personas.reviewer.name,
    initials: personas.reviewer.initials,
    email: personas.reviewer.email,
    role: 'Compliance Reviewer',
    projects: ['proj_card_services', 'proj_member_onboarding', 'proj_collections', 'proj_lending'],
    status: 'active',
    lastSeenAgo: '14 min ago',
    hue: 'success',
  },
  {
    id: personas.admin.id,
    name: personas.admin.name,
    initials: personas.admin.initials,
    email: personas.admin.email,
    role: 'Credit Union Admin',
    projects: ['proj_card_services', 'proj_member_onboarding', 'proj_collections', 'proj_lending'],
    status: 'active',
    lastSeenAgo: 'now',
    hue: 'info',
  },
  {
    id: 'u_md',
    name: 'Marco Davis',
    initials: 'MD',
    email: 'marco.davis@cornerstone.cu',
    role: 'Compliance Co-Reviewer',
    projects: ['proj_card_services'],
    status: 'active',
    lastSeenAgo: '1 hr ago',
    hue: 'success',
  },
  {
    id: 'u_ks',
    name: 'Kira Singh',
    initials: 'KS',
    email: 'kira.singh@cornerstone.cu',
    role: 'Knowledge Editor',
    projects: ['proj_card_services', 'proj_collections'],
    status: 'active',
    lastSeenAgo: '3 hr ago',
    hue: 'warning',
  },
  {
    id: 'u_lt',
    name: 'Liam Thompson',
    initials: 'LT',
    email: 'liam.thompson@cornerstone.cu',
    role: 'Process Owner',
    projects: ['proj_lending'],
    status: 'invited',
    lastSeenAgo: 'never',
    hue: 'purple',
  },
];

const hueClasses = {
  purple: 'bg-purple/20 text-purple',
  success: 'bg-success-subtle text-success',
  info: 'bg-info-subtle text-info',
  warning: 'bg-warning-subtle text-warning',
};

export default function UsersPage() {
  const [search, setSearch] = useState('');
  const filtered = mockUsers.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.role.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 pb-4 border-b border-border-muted">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users &amp; Roles</h1>
          <p className="text-xs text-foreground-muted mt-1.5">
            {mockUsers.length} members across {projects.length} projects · manage RBAC and
            invitations.
          </p>
        </div>
        <button
          type="button"
          onClick={() => toast.success('Invitation flow opened')}
          className="h-9 px-3.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5"
        >
          <Plus className="size-3.5" />
          Invite member
        </button>
      </header>

      <div className="relative max-w-md">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or role…"
          className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
        />
      </div>

      <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_max-content_max-content] items-center gap-3 px-4 py-2.5 border-b border-border-muted text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
          <div>Member</div>
          <div>Role</div>
          <div>Projects</div>
          <div>Last seen</div>
          <div></div>
        </div>
        {filtered.length === 0 ? (
          <p className="px-4 py-12 text-xs text-foreground-muted text-center">
            No members match your search.
          </p>
        ) : (
          filtered.map((u) => (
            <div
              key={u.id}
              className="grid grid-cols-[2fr_1fr_1fr_max-content_max-content] items-center gap-3 px-4 py-3 border-b last:border-b-0 border-border-muted hover:bg-background-muted/40 transition-colors text-xs"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={cn(
                    'size-8 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0',
                    hueClasses[u.hue],
                  )}
                >
                  {u.initials}
                </span>
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate flex items-center gap-1.5">
                    {u.name}
                    {u.status === 'invited' && (
                      <span className="text-[10px] uppercase tracking-wide text-foreground-meta font-mono bg-background-elevated px-1.5 py-0.5 rounded">
                        Invited
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground-subtle font-mono truncate inline-flex items-center gap-1">
                    <Mail className="size-2.5" />
                    {u.email}
                  </div>
                </div>
              </div>
              <div className="text-foreground-muted truncate">{u.role}</div>
              <div className="text-foreground-muted font-mono tabular-nums">{u.projects.length}</div>
              <div className="text-foreground-subtle whitespace-nowrap text-[11px] font-mono">
                {u.lastSeenAgo}
              </div>
              <button
                type="button"
                className="size-7 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center justify-center"
                aria-label="Member actions"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </section>

      <Footer />
    </div>
  );
}
