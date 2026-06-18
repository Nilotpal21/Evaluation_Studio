'use client';

import { useEffect, useMemo, useState } from 'react';
import { notFound, useParams } from 'next/navigation';
import Link from 'next/link';
import { Plus, X, Archive, Save, Trash2 } from 'lucide-react';
import { personas } from '@/lib/mock-data';
import { Footer } from '@/components/shell/Footer';
import { PickerSelect } from '@/components/ui/PickerSelect';
import {
  useProjectContext,
  useResolvedProject,
  useScopedProjectAppIds,
} from '@/lib/project-state';
import { cn } from '@/lib/utils';

const TABS = [
  'Overview',
  'Membership & RBAC',
  'Reviewer pool',
  'Knowledge scope',
  'Model overrides',
  'Tools',
  'Cost & budget',
  'Channels',
  'Archive',
] as const;

type Tab = (typeof TABS)[number];

export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>();
  const project = useResolvedProject(params.projectId);
  const context = useProjectContext(params.projectId);
  const scopedAppIds = useScopedProjectAppIds(params.projectId);
  const [tab, setTab] = useState<Tab>('Overview');
  const [hasChanges, setHasChanges] = useState(false);

  if (!project) notFound();

  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.replace('#', ''));
    if (TABS.includes(hash as Tab)) {
      setTab(hash as Tab);
    }
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `#${encodeURIComponent(tab)}`);
  }, [tab]);

  const owner = useMemo(
    () => Object.values(personas).find((persona) => persona.id === project.ownerPersonaId) ?? personas.processOwner,
    [project.ownerPersonaId],
  );

  return (
    <div className="space-y-4">
      <nav className="text-xs text-foreground-muted flex items-center gap-2">
        <Link href="/projects" className="hover:text-foreground transition-colors">
          Projects
        </Link>
        <span className="text-foreground-subtle">/</span>
        <Link
          href={`/projects/${project.id}`}
          className="hover:text-foreground transition-colors"
        >
          {project.name}
        </Link>
        <span className="text-foreground-subtle">/</span>
        <span className="text-foreground">Settings</span>
      </nav>

      <header>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{project.name} · Settings</h1>
            <p className="mt-1 text-[11px] text-foreground-muted">
              Project-scoped configuration for membership, reviewer pool, knowledge scope, model overrides,
              tools, budget, channels, and archive state.
            </p>
          </div>
          <button
            type="button"
            disabled={!hasChanges}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
              hasChanges
                ? 'bg-accent text-accent-foreground hover:bg-accent-muted'
                : 'cursor-not-allowed border border-border-muted bg-background-subtle text-foreground-subtle',
            )}
          >
            <Save className="size-3.5" />
            Save changes
          </button>
        </div>
      </header>

      <div className="overflow-x-auto">
        <div className="inline-flex min-w-max items-center gap-1 rounded-xl border border-border-muted bg-background-subtle p-1">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
                tab === t
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border-muted bg-background-subtle p-4">
        {tab === 'Overview' && (
          <OverviewTab
            projectName={project.name}
            projectId={project.id}
            ownerName={owner.name}
            createdAt={project.createdAt}
            environment={context?.environment ?? 'prod'}
            onDirty={() => setHasChanges(true)}
          />
        )}
        {tab === 'Membership & RBAC' && <MembershipTab />}
        {tab === 'Reviewer pool' && <ReviewerPoolTab />}
        {tab === 'Knowledge scope' && <KnowledgeScopeTab projectName={project.name} />}
        {tab === 'Model overrides' && <ModelOverridesTab />}
        {tab === 'Tools' && <ToolsTab appCount={scopedAppIds.length} />}
        {tab === 'Cost & budget' && (
          <CostBudgetTab monthlyBudget={project.monthlyBudget} mtdSpend={project.mtdSpend} />
        )}
        {tab === 'Channels' && (
          <ChannelsTab defaultChannels={project.defaultChannels} />
        )}
        {tab === 'Archive' && <ArchiveTab projectName={project.name} />}
      </div>

      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-2.5 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function OverviewTab({
  projectName,
  projectId,
  ownerName,
  createdAt,
  environment,
  onDirty,
}: {
  projectName: string;
  projectId: string;
  ownerName: string;
  createdAt: string;
  environment: 'prod' | 'pre_prod';
  onDirty: () => void;
}) {
  return (
    <Section title="Overview">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="max-w-xl space-y-3">
        <Field label="Project name">
          <input
            defaultValue={projectName}
            onChange={onDirty}
            className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
          />
        </Field>
        <Field label="Description">
          <textarea
            defaultValue="Business-area scope for the project."
            onChange={onDirty}
            className="h-20 w-full resize-none rounded-md border border-border-muted bg-background-muted/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
          />
        </Field>
        <Field label="Tags">
          <input
            defaultValue={projectName}
            onChange={onDirty}
            className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
          />
        </Field>
        </div>
        <div className="rounded-md border border-border-muted bg-background p-3.5">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-3">
            Project metadata
          </div>
          <div className="space-y-2.5 text-xs text-foreground-muted">
            <MetaRow label="Project ID" value={projectId} mono />
            <MetaRow label="Created by" value={ownerName} />
            <MetaRow label="Created at" value={createdAt} />
            <MetaRow
              label="Environment"
              value={environment === 'pre_prod' ? 'Pre-prod project' : 'Prod project'}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function MembershipTab() {
  const [inviteRole, setInviteRole] = useState('Process Owner');
  return (
    <Section title="Membership & RBAC">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2">
            Current members
          </div>
          <div className="space-y-1.5">
            {[personas.processOwner, personas.reviewer, personas.admin].map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs"
              >
                <span className="size-7 rounded-full bg-purple/20 text-purple flex items-center justify-center text-[10px] font-medium shrink-0">
                  {p.initials}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-foreground truncate">{p.name}</div>
                  <div className="text-[11px] text-foreground-subtle">{p.role}</div>
                </div>
                <button className="text-foreground-subtle hover:text-foreground transition-colors">
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2">
            Invite a member
          </div>
          <div className="space-y-2.5">
            <input
              placeholder="email@cornerstone.cu"
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            />
            <PickerSelect
              value={inviteRole}
              onChange={(value) => setInviteRole(value)}
              options={[
                { value: 'Process Owner', label: 'Process Owner' },
                { value: 'Reviewer', label: 'Reviewer' },
                { value: 'Project Admin', label: 'Project Admin' },
                { value: 'Knowledge Editor', label: 'Knowledge Editor' },
                { value: 'Observer', label: 'Observer' },
              ]}
              triggerClassName="h-9 rounded-md bg-background-muted/60 px-3"
            />
            <button className="h-9 px-4 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5">
              <Plus className="size-3.5" />
              Send invitation
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function ReviewerPoolTab() {
  return (
    <Section title="Reviewer pool">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        Submissions in this project route to these reviewers. Dual approval is enforced for
        money-moving tools, Reg E disputes, and member NPI access.
      </p>
      <div className="mb-3 space-y-1.5">
        {[personas.reviewer].map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs"
          >
            <span className="size-7 rounded-full bg-success-subtle text-success flex items-center justify-center text-[10px] font-medium shrink-0">
              {p.initials}
            </span>
            <div className="flex-1 min-w-0">
              <div>{p.name}</div>
              <div className="text-[11px] text-foreground-subtle">
                {p.role} · active
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {[
          'Money-moving tools require dual approval',
          'Reg E disputes require dual approval',
          'Member NPI access requires dual approval',
          'Escalate to tenant-wide compliance pool when queue is empty for > 24h',
        ].map((rule) => (
          <label key={rule} className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              defaultChecked
              className="size-3.5 rounded border-border-muted bg-background-muted text-foreground focus:ring-1 focus:ring-border-focus/40"
            />
            <span>{rule}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

function KnowledgeScopeTab({ projectName }: { projectName: string }) {
  return (
    <Section title="Knowledge scope">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        This project inherits tenant-wide sources and can attach project-scoped sources that apply
        only to {projectName}.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border-muted bg-background p-3">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2">
            Tenant-wide (read-only)
          </div>
          <ul className="text-xs text-foreground-muted space-y-1">
            <li>· Reg D and Reg E basics</li>
            <li>· Member identity policy</li>
            <li>· FFIEC guidance</li>
            <li>· TCPA outbound rules</li>
          </ul>
        </div>
        <div className="rounded-md border border-border-muted bg-background p-3">
          <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2">
            Project-scoped
          </div>
          <ul className="text-xs text-foreground-muted space-y-1">
            <li>· Cornerstone Card Services FAQ</li>
            <li>· Card dispute disclosures</li>
          </ul>
          <button className="mt-3 text-[11px] text-foreground-muted hover:text-foreground transition-colors flex items-center gap-1">
            <Plus className="size-3" />
            Attach a tenant-wide source as project default
          </button>
        </div>
      </div>
    </Section>
  );
}

function ModelOverridesTab() {
  const purposes = [
    'Routing',
    'Response generation',
    'AI Helper',
    'Embedding (Knowledge)',
    'Evaluation grading',
    'Monitoring evaluator',
  ];
  return (
    <Section title="Model overrides">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        Each purpose inherits the tenant default unless overridden here. Overriding a purpose means
        this project no longer follows the tenant-wide model assignment for that function.
      </p>
      <div className="space-y-1.5">
        {purposes.map((purpose, idx) => (
          <div
            key={purpose}
            className="flex items-center gap-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium">{purpose}</div>
              <div className="text-[11px] text-foreground-subtle">
                {idx === 1
                  ? 'Override: Azure OpenAI GPT-4o (Cornerstone tenant)'
                  : 'Inherit tenant default'}
              </div>
            </div>
            <button className="text-[11px] text-foreground-muted hover:text-foreground transition-colors">
              Change
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ToolsTab({ appCount }: { appCount: number }) {
  return (
    <Section title="Tools and connectors">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        Apps in this project can use these tools. Tenant-wide tools are inherited. Project-scoped
        tools can be attached or restricted here. Current scoped agent count: {appCount}.
      </p>
      <div className="space-y-1.5">
        {[
          { name: 'Core banking (Symitar)', scope: 'tenant-wide', moves: false },
          { name: 'Card processor (Visa DPS)', scope: 'project-scoped', moves: false },
          { name: 'Payments (ACH origination)', scope: 'project-scoped', moves: true },
          { name: 'Salesforce CRM', scope: 'tenant-wide', moves: false },
        ].map((t) => (
          <div
            key={t.name}
            className="flex items-center gap-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium">{t.name}</div>
              <div className="text-[11px] text-foreground-subtle">{t.scope}</div>
            </div>
            {t.moves && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning uppercase tracking-wide font-medium">
                Money-moving
              </span>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function CostBudgetTab({
  monthlyBudget,
  mtdSpend,
}: {
  monthlyBudget: number;
  mtdSpend: number;
}) {
  const pct = Math.round((mtdSpend / monthlyBudget) * 100);
  return (
    <Section title="Cost & budget">
      <div className="grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Field label="Monthly budget (USD)">
            <input
              type="number"
              defaultValue={monthlyBudget}
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40 font-mono"
            />
          </Field>
          <Field label="Warning threshold (% of budget)">
            <input
              type="number"
              defaultValue={80}
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40 font-mono"
            />
          </Field>
          <Field label="Hard cap (% of budget)">
            <input
              type="number"
              defaultValue={120}
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40 font-mono"
            />
          </Field>
        </div>
        <div>
          <div className="rounded-md border border-border-muted bg-background p-3.5">
            <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
              MTD spend
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1">
              ${mtdSpend.toLocaleString()}
            </div>
            <div className="text-xs text-foreground-muted mt-0.5">
              of ${monthlyBudget.toLocaleString()} budgeted · {pct}%
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-background-elevated overflow-hidden">
              <div
                className={cn(
                  'h-full',
                  pct >= 95 ? 'bg-error' : pct >= 80 ? 'bg-warning' : 'bg-success/80',
                )}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className="mt-3 space-y-1 text-[11px] text-foreground-muted">
              <div>Apps · ${Math.round(mtdSpend * 0.42).toLocaleString()}</div>
              <div>Helper · ${Math.round(mtdSpend * 0.18).toLocaleString()}</div>
              <div>Continuous eval · ${Math.round(mtdSpend * 0.24).toLocaleString()}</div>
              <div>Knowledge ingestion · ${Math.round(mtdSpend * 0.16).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function ChannelsTab({
  defaultChannels,
}: {
  defaultChannels: ('digital' | 'voice' | 'sms' | 'email')[];
}) {
  const all: ('digital' | 'voice' | 'sms' | 'email')[] = ['digital', 'voice', 'sms', 'email'];
  return (
    <Section title="Default channels">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        New apps generated in this project default to these channels.
      </p>
      <div className="flex items-center gap-2">
        {all.map((c) => {
          const on = defaultChannels.includes(c);
          return (
            <span
              key={c}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border',
                on
                  ? 'bg-background-elevated text-foreground border-border'
                  : 'bg-background-muted/40 text-foreground-subtle border-border-muted',
              )}
            >
              <span
                className={cn('size-1.5 rounded-full', on ? 'bg-success' : 'bg-foreground-subtle')}
              />
              {c}
            </span>
          );
        })}
      </div>
      <div className="mt-3 rounded-md border border-border-muted bg-background p-3 text-xs text-foreground-muted">
        Channel-specific guardrails are auto-applied. Example: TCPA protections remain active for SMS
        and disclosure ordering stays enforced for voice experiences.
      </div>
    </Section>
  );
}

function ArchiveTab({ projectName }: { projectName: string }) {
  return (
    <Section title="Archive this project">
      <p className="mb-3 max-w-2xl text-xs text-foreground-muted">
        Archiving pauses all apps in <span className="font-medium">{projectName}</span>. SOPs,
        audit, and historical data remain queryable. You can restore the project later.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button className="flex h-9 items-center gap-1.5 rounded-md border border-warning/40 px-4 text-xs font-medium text-warning transition-colors hover:bg-warning-subtle">
          <Archive className="size-3.5" />
          Archive project
        </button>
        <button className="flex h-9 items-center gap-1.5 rounded-md border border-error/40 px-4 text-xs font-medium text-error transition-colors hover:bg-error-subtle">
          <Trash2 className="size-3.5" />
          Delete project
        </button>
      </div>
      <p className="mt-3 max-w-2xl text-[11px] text-foreground-subtle">
        Delete is a destructive action. In this prototype it is visual only and does not remove the
        project from local state.
      </p>
    </Section>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-foreground-subtle">{label}</span>
      <span className={cn('text-right text-foreground', mono && 'font-mono text-[11px]')}>
        {value}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-foreground-meta">
        {label}
      </label>
      {children}
    </div>
  );
}
