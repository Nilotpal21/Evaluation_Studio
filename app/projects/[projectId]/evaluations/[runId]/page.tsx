'use client';

import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { ArrowRight, Clock3, FolderKanban, ShieldAlert, Sparkles } from 'lucide-react';
import {
  getEvaluationRunById,
  getVersionById,
} from '@/lib/mock-data';
import { apps } from '@/lib/mock-data/apps';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { Footer } from '@/components/shell/Footer';
import {
  ControlsStrip,
  SectionCard,
  StatusPill,
  benchmarkTone,
  runLabel,
  runTone,
} from '@/components/evaluation-studio/shared';
import { useBackingProjectId, useResolvedProject } from '@/lib/project-state';

export default function EvaluationRunDetailPage() {
  const params = useParams<{ projectId: string; runId: string }>();
  const project = useResolvedProject(params.projectId);
  const backingProjectId = useBackingProjectId(params.projectId);
  const run = getEvaluationRunById(params.runId);

  if (!project || !run || run.projectId !== backingProjectId) notFound();

  const app = apps.find((item) => item.id === run.appId);
  const version = run.versionId ? getVersionById(run.versionId) : null;

  return (
    <div className="space-y-6">
      <SyncActiveProject projectId={project.id} />

      <nav className="flex items-center gap-2 text-xs text-foreground-muted">
        <Link href="/projects" className="transition-colors hover:text-foreground">
          Projects
        </Link>
        <span>/</span>
        <Link href={`/projects/${project.id}/evaluations`} className="transition-colors hover:text-foreground">
          Evaluations
        </Link>
        <span>/</span>
        <span className="text-foreground">{run.id.replace('run_', '#')}</span>
      </nav>

      <header className="flex flex-col gap-4 border-b border-border-muted pb-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {run.mode === 'pre_prod' ? 'Pre-prod evaluation' : 'Production analysis'} ·{' '}
              <span className="font-mono">{app?.name ?? run.appId}</span>
              {version ? ` ${version.label}` : ''}
            </h1>
            <StatusPill tone={runTone(run)}>{runLabel(run)}</StatusPill>
          </div>
          <p className="mt-1.5 text-xs text-foreground-muted">
            Project: {project.name} · Started {run.startedAt} · Finished {run.finishedAt} ·
            Triggered by {run.triggeredBy}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/projects/${project.id}/validators`}
            className="inline-flex h-9 items-center rounded-md border border-border-muted px-3 text-sm text-foreground-muted transition-colors hover:bg-background-elevated hover:text-foreground"
          >
            Open validators
          </Link>
          <Link
            href={`/projects/${project.id}/monitoring`}
            className="inline-flex h-9 items-center rounded-md border border-border-muted px-3 text-sm text-foreground-muted transition-colors hover:bg-background-elevated hover:text-foreground"
          >
            {run.mode === 'pre_prod' ? 'Open monitoring' : 'View incidents'}
          </Link>
          <ControlsStrip projectId={project.id} />
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <SectionCard
          title="Real-time run progression"
          subtitle={
            run.mode === 'pre_prod'
              ? 'Pre-prod runs progress from ingestion through product decision and promotion.'
              : 'Production runs resolve the active prod version, collect traffic, and score live behavior.'
          }
        >
          <div className="space-y-4">
            {run.stages.map((stage, index) => (
              <div key={stage.id} className="grid grid-cols-[auto_1fr] gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex size-7 items-center justify-center rounded-full border text-xs font-medium ${
                      stage.state === 'complete'
                        ? 'border-success/30 bg-success-subtle text-success'
                        : stage.state === 'current'
                          ? 'border-info/30 bg-info/10 text-info'
                          : 'border-border-muted bg-background-muted text-foreground-subtle'
                    }`}
                  >
                    {index + 1}
                  </div>
                  {index < run.stages.length - 1 ? <div className="mt-1 h-full w-px bg-border-muted" /> : null}
                </div>
                <div className="pb-4">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">{stage.label}</div>
                    <StatusPill tone={stage.state === 'complete' ? 'success' : stage.state === 'current' ? 'info' : 'muted'}>
                      {stage.state}
                    </StatusPill>
                  </div>
                  <div className="mt-1 text-sm text-foreground-muted">{stage.note}</div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title={run.mode === 'pre_prod' ? 'Decision summary' : 'Health summary'}
          subtitle={run.summary}
          right={<Sparkles className="size-4 text-purple" />}
        >
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
              <div className="text-[10px] uppercase tracking-wide text-foreground-meta">
                {run.mode === 'pre_prod' ? 'Product decision' : 'Live outcome'}
              </div>
              <div className="mt-2 text-xl font-semibold capitalize">{runLabel(run)}</div>
              <div className="mt-1 text-foreground-muted">{run.compareSummary}</div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <MetricTile label="Coverage summary" value={run.coverageSummary} icon={<FolderKanban className="size-4" />} />
              <MetricTile
                label={run.mode === 'pre_prod' ? 'Blocking findings' : 'Incidents'}
                value={run.mode === 'pre_prod' ? String(run.validatorOutcomes.filter((item) => item.blocking && item.status !== 'pass').length) : String(run.incidentCount)}
                icon={<ShieldAlert className="size-4" />}
              />
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Validator outcomes"
        subtitle="Platform defaults and project overrides are both visible in the run."
      >
        <div className="space-y-3">
          {run.validatorOutcomes.map((outcome) => (
            <div key={outcome.validatorId} className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{outcome.validatorId.replace('val_', '').replaceAll('_', ' ')}</div>
                  <div className="mt-1 text-xs text-foreground-muted">{outcome.note}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={outcome.status === 'pass' ? 'success' : outcome.status === 'warn' ? 'warning' : 'error'}>
                    {outcome.status}
                  </StatusPill>
                  <StatusPill tone={benchmarkTone(outcome.origin)}>
                    {outcome.origin === 'project_override' ? 'Project override' : 'Platform default'}
                  </StatusPill>
                </div>
              </div>
              <div className="mt-3 grid gap-3 text-xs text-foreground-muted md:grid-cols-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Score</div>
                  <div className="mt-1 font-mono text-foreground">{outcome.score}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Threshold</div>
                  <div className="mt-1 font-mono text-foreground">{outcome.threshold}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Blocking</div>
                  <div className="mt-1 font-mono text-foreground">{outcome.blocking ? 'Yes' : 'No'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Mode</div>
                  <div className="mt-1 font-mono text-foreground">{run.mode === 'pre_prod' ? 'Pre-prod gate' : 'Production health'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <SectionCard
          title={run.mode === 'pre_prod' ? 'Top failing traces' : 'Top failing production traces'}
          subtitle="Representative sessions requiring attention."
        >
          <div className="space-y-3">
            {run.topFailures.map((failure) => (
              <div key={failure.id} className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
                <div className="text-sm font-medium">{failure.title}</div>
                <div className="mt-2 text-sm text-foreground-muted">{failure.summary}</div>
                <div className="mt-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs text-foreground-subtle">
                  Why it failed: {failure.whyItFailed}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title={run.mode === 'pre_prod' ? 'Operator guidance' : 'Recommended actions'}
          subtitle="This prototype treats revert and kill switch as always-available safety controls."
        >
          <div className="space-y-4">
            <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4 text-sm text-foreground-muted">
              {run.mode === 'pre_prod'
                ? 'When a pre-prod run promotes automatically, operators still retain the ability to revert the production binding or trigger a kill switch if live behavior looks unsafe.'
                : 'Production analyses never promote. They surface health, drift, and incidents so operators can decide whether to observe, revert, or stop traffic.'}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ActionCard
                title="Revert"
                body="Roll production back to the last safe version recorded by the project."
                icon={<Clock3 className="size-4" />}
              />
              <ActionCard
                title="Kill switch"
                body="Pause live traffic immediately for the project, agent, version, or tool scope."
                icon={<ShieldAlert className="size-4" />}
              />
            </div>
            <Link
              href={`/projects/${project.id}/monitoring`}
              className="inline-flex items-center gap-2 text-sm text-foreground-muted transition-colors hover:text-foreground"
            >
              Open monitoring dashboard
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </SectionCard>
      </div>

      <Footer />
    </div>
  );
}

function MetricTile({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-foreground-meta">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function ActionCard({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-2 text-sm text-foreground-muted">{body}</div>
    </div>
  );
}
