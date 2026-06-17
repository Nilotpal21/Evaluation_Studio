import Link from 'next/link';
import {
  AlertOctagon,
  ArrowRight,
  Bot,
  Database,
  Gauge,
  Power,
  RefreshCcw,
  ShieldCheck,
} from 'lucide-react';
import {
  type BenchmarkOrigin,
  type ControlEvent,
  type EvaluationRun,
  type HealthState,
  type ProjectValidator,
  getProjectControls,
  getVersionById,
} from '@/lib/mock-data';
import { apps } from '@/lib/mock-data/apps';
import { cn } from '@/lib/utils';

export function StatusPill({
  tone,
  children,
}: {
  tone:
    | 'neutral'
    | 'success'
    | 'warning'
    | 'error'
    | 'info'
    | 'muted';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-success-subtle text-success border-success/20'
      : tone === 'warning'
        ? 'bg-warning-subtle text-warning border-warning/20'
        : tone === 'error'
          ? 'bg-error-subtle text-error border-error/20'
          : tone === 'info'
            ? 'bg-info/10 text-info border-info/20'
            : tone === 'muted'
              ? 'bg-background-muted text-foreground-subtle border-border-muted'
              : 'bg-background-elevated text-foreground border-border-muted';

  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide', toneClass)}>
      {children}
    </span>
  );
}

export function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-border-muted px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-foreground-muted">{subtitle}</p> : null}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function SummaryTile({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: 'gauge' | 'bot' | 'database' | 'shield';
}) {
  const Icon =
    icon === 'bot' ? Bot : icon === 'database' ? Database : icon === 'shield' ? ShieldCheck : Gauge;

  return (
    <div className="rounded-lg border border-border-muted bg-background-subtle p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-foreground-meta">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-foreground-muted">{detail}</div>
    </div>
  );
}

export function benchmarkTone(origin: BenchmarkOrigin) {
  return origin === 'project_override' ? 'warning' : 'info';
}

export function healthTone(health: HealthState) {
  switch (health) {
    case 'healthy':
      return 'success';
    case 'warning':
    case 'drift_detected':
      return 'warning';
    case 'regression_detected':
    case 'critical':
      return 'error';
  }
}

export function runTone(run: EvaluationRun) {
  if (run.status === 'promoted' || run.decision === 'promote') return 'success';
  if (run.status === 'held' || run.status === 'warning' || run.decision === 'hold') return 'warning';
  if (run.status === 'rejected' || run.status === 'critical' || run.decision === 'reject') return 'error';
  if (run.status === 'running') return 'info';
  return 'neutral';
}

export function runLabel(run: EvaluationRun) {
  if (run.mode === 'pre_prod') {
    return run.decision ? run.decision.replace('_', ' ') : run.status;
  }
  return run.health ? run.health.replace('_', ' ') : run.status;
}

export function ControlsStrip({ projectId }: { projectId: string }) {
  const controls = getProjectControls(projectId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {controls.map((control) => (
        <ControlChip key={control.id} control={control} />
      ))}
    </div>
  );
}

function ControlChip({ control }: { control: ControlEvent }) {
  const isKill = control.kind === 'kill_switch';
  const Icon = isKill ? Power : RefreshCcw;

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
        isKill
          ? 'border-error/30 text-error hover:bg-error-subtle'
          : 'border-border-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {isKill ? 'Kill switch' : 'Revert'}
    </button>
  );
}

export function RunTable({ runs, projectId }: { runs: EvaluationRun[]; projectId: string }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <div className="grid grid-cols-[1.1fr_.8fr_1fr_1fr_.9fr_1fr_auto] gap-3 border-b border-border-muted px-4 py-2.5 text-[10px] uppercase tracking-wide text-foreground-meta">
        <div>Run</div>
        <div>Mode</div>
        <div>Agent</div>
        <div>Version / window</div>
        <div>Started</div>
        <div>Result</div>
        <div></div>
      </div>
      {runs.map((run) => {
        const app = apps.find((item) => item.id === run.appId);
        const version = run.versionId ? getVersionById(run.versionId) : null;
        return (
          <Link
            key={run.id}
            href={`/projects/${projectId}/evaluations/${run.id}`}
            className="grid grid-cols-[1.1fr_.8fr_1fr_1fr_.9fr_1fr_auto] gap-3 border-b border-border-muted px-4 py-3 text-sm transition-colors hover:bg-background-muted/40 last:border-b-0"
          >
            <div>
              <div className="font-mono text-foreground">{run.id.replace('run_', '#')}</div>
              <div className="mt-0.5 text-[11px] text-foreground-subtle">{run.summary}</div>
            </div>
            <div className="text-xs text-foreground-muted">{run.mode === 'pre_prod' ? 'Pre-prod' : 'Prod'}</div>
            <div className="font-mono text-xs text-foreground">{app?.name ?? run.appId}</div>
            <div className="text-xs text-foreground-muted">{version?.label ?? run.durationLabel ?? '—'}</div>
            <div className="text-xs text-foreground-subtle">{run.startedAt}</div>
            <div>
              <StatusPill tone={runTone(run)}>{runLabel(run)}</StatusPill>
            </div>
            <div className="flex items-center justify-end text-foreground-subtle">
              <ArrowRight className="size-3.5" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function ValidatorTable({ validators }: { validators: ProjectValidator[] }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <div className="grid grid-cols-[1.4fr_.8fr_.8fr_.8fr_1fr_1fr_.8fr] gap-3 border-b border-border-muted px-4 py-2.5 text-[10px] uppercase tracking-wide text-foreground-meta">
        <div>Validator</div>
        <div>Type</div>
        <div>Scope</div>
        <div>Environments</div>
        <div>Benchmark</div>
        <div>Linked assets</div>
        <div>Last used</div>
      </div>
      {validators.map((validator) => (
        <div
          key={validator.id}
          className="grid grid-cols-[1.4fr_.8fr_.8fr_.8fr_1fr_1fr_.8fr] gap-3 border-b border-border-muted px-4 py-3 text-sm last:border-b-0"
        >
          <div>
            <div className="font-medium text-foreground">{validator.name}</div>
            <div className="mt-0.5 text-[11px] text-foreground-subtle">{validator.description}</div>
          </div>
          <div className="text-xs text-foreground-muted">{validator.kind === 'built_in' ? 'Built-in' : 'Custom'}</div>
          <div className="text-xs text-foreground-muted">
            {validator.appliesTo === 'all_agents' ? 'All agents' : `${validator.appliesTo.length} agents`}
          </div>
          <div className="text-xs text-foreground-muted">
            {validator.environments.map((environment) => environment.replace('_', '-')).join(', ')}
          </div>
          <div className="flex items-start">
            <StatusPill tone={benchmarkTone(validator.benchmarkOrigin)}>
              {validator.benchmarkOrigin === 'project_override' ? 'Project override' : 'Platform default'}
            </StatusPill>
          </div>
          <div className="text-xs text-foreground-muted">
            {validator.linkedGoldens.length + validator.linkedKnowledgeBases.length} linked
          </div>
          <div className="text-xs text-foreground-subtle">{validator.lastUsed}</div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-muted bg-background-subtle px-6 py-12 text-center">
      <AlertOctagon className="mx-auto size-8 text-foreground-subtle" />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm text-foreground-muted">{body}</p>
      <Link
        href={href}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
      >
        {cta}
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
