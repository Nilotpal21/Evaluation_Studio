'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Grid2X2, List, Search, SlidersHorizontal } from 'lucide-react';
import { AppIcon } from '@/components/integrations/AppIcon';
import { cn } from '@/lib/utils';

type AppGroup = {
  appId: 'hubspot' | 'salesforce' | 'zendesk' | 'calendly';
  appName: string;
  connectors: Array<{
    id: string;
    connectionName: string;
    authType: string;
    availabilityStatus: 'active' | 'disabled' | 'revoked';
  }>;
};

const CATEGORY_LABELS: Record<AppGroup['appId'], string> = {
  hubspot: 'CRM',
  salesforce: 'CRM',
  zendesk: 'Support',
  calendly: 'Scheduling',
};

const CATEGORY_OPTIONS = ['All', 'CRM', 'Support', 'Scheduling'] as const;

export function ProjectAppsCatalog({
  projectId,
  appGroups,
}: {
  projectId: string;
  appGroups: AppGroup[];
}) {
  const [tab, setTab] = useState<'all' | 'connected'>('all');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORY_OPTIONS)[number]>('All');
  const [authorization, setAuthorization] = useState<'All' | 'OAuth2' | 'API' | 'PAT'>('All');

  const filteredApps = useMemo(() => {
    return appGroups.filter((group) => {
      const matchesTab = tab === 'all' || group.connectors.length > 0;
      const matchesQuery =
        !query.trim() ||
        group.appName.toLowerCase().includes(query.trim().toLowerCase()) ||
        group.connectors.some((connector) =>
          connector.connectionName.toLowerCase().includes(query.trim().toLowerCase()),
        );
      const matchesCategory =
        category === 'All' || CATEGORY_LABELS[group.appId] === category;
      const matchesAuthorization =
        authorization === 'All' ||
        group.connectors.some((connector) => normalizeAuth(connector.authType) === authorization);

      return matchesTab && matchesQuery && matchesCategory && matchesAuthorization;
    });
  }, [appGroups, authorization, category, query, tab]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">Integrations</h1>
          <p className="mt-1 text-[15px] text-foreground-muted">
            Configure integrations to connect with your account.
          </p>
        </div>
        <div className="w-full max-w-[280px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="h-12 w-full rounded-xl border border-border bg-background-subtle pl-10 pr-4 text-[15px] text-foreground outline-none transition focus:border-accent/40"
            />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex rounded-xl bg-background-muted p-1">
          {[
            ['all', 'All integrations'],
            ['connected', 'Connected'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value as 'all' | 'connected')}
              className={cn(
                'rounded-xl px-4 py-2 text-[14px] font-medium transition-colors',
                tab === value
                  ? 'bg-background-subtle text-foreground shadow-[0_2px_8px_rgba(15,23,42,0.08)]'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <FilterButton
            label="Category"
            value={category}
            options={[...CATEGORY_OPTIONS]}
            onSelect={(value) => setCategory(value as (typeof CATEGORY_OPTIONS)[number])}
          />
          <FilterButton
            label="Authorization"
            value={authorization}
            options={['All', 'OAuth2', 'API', 'PAT']}
            onSelect={(value) => setAuthorization(value as 'All' | 'OAuth2' | 'API' | 'PAT')}
          />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-background-subtle text-foreground-muted"
            aria-label="List view"
          >
            <List className="size-4.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-background-subtle text-foreground"
            aria-label="Grid view"
          >
            <Grid2X2 className="size-4.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {filteredApps.map((group) => {
          return (
            <Link
              key={group.appId}
              href={`/projects/${projectId}/apps/${group.appId}`}
              className="rounded-[18px] border border-border bg-background-subtle p-5 transition hover:border-accent/30 hover:shadow-[0_10px_22px_rgba(15,23,42,0.05)]"
            >
              <div className="flex items-start gap-4">
                <AppIcon appId={group.appId} className="size-10 rounded-full border-0 bg-background-muted" />
              </div>

              <div className="mt-5">
                <h2 className="text-[18px] font-semibold tracking-tight text-foreground">{group.appName}</h2>
                <p className="mt-2 text-[13px] leading-6 text-foreground-muted">
                  {descriptionForApp(group.appId)}
                </p>
              </div>

            </Link>
          );
        })}
      </div>
    </div>
  );
}

function FilterButton({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: string[];
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-background-subtle px-4 text-[14px] text-foreground"
      >
        <SlidersHorizontal className="size-3.5 text-foreground-subtle" />
        <span>{label}</span>
        <ChevronDown className="size-3.5 text-foreground-subtle" />
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-20 min-w-[200px] rounded-xl border border-border bg-background-subtle p-1.5 shadow-[0_18px_48px_rgba(15,23,42,0.12)]">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onSelect(option);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                value === option ? 'bg-accent-subtle text-accent' : 'text-foreground-muted hover:bg-background-muted',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function descriptionForApp(appId: AppGroup['appId']) {
  if (appId === 'hubspot') return 'Connect HubSpot to sync customer, activity, and usage data.';
  if (appId === 'salesforce') return 'Connect Salesforce for account, contact, and pipeline visibility.';
  if (appId === 'zendesk') return 'Connect Zendesk to manage tickets, agents, and support reporting.';
  return 'Connect Calendly for invitee, meeting, and scheduling usage workflows.';
}

function normalizeAuth(authType: string): 'OAuth2' | 'API' | 'PAT' {
  if (authType.toLowerCase() === 'oauth') return 'OAuth2';
  if (authType.toLowerCase() === 'api') return 'API';
  return 'PAT';
}
