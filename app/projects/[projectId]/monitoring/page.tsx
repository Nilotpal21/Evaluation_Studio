'use client';

import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { Activity, AlertTriangle, ArrowRight, Gauge, Radar, ShieldCheck } from 'lucide-react';
import {
  getProjectMonitoringIncidents,
  getProjectMonitoringSnapshot,
  getProjectRuns,
} from '@/lib/mock-data';
import { apps } from '@/lib/mock-data/apps';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { Footer } from '@/components/shell/Footer';
import { useBackingProjectId, useProjectContext, useResolvedProject } from '@/lib/project-state';
import {
  SectionCard,
  StatusPill,
  SummaryTile,
  healthTone,
} from '@/components/evaluation-studio/shared';

export default function ProjectMonitoringPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useResolvedProject(projectId);
  const backingProjectId = useBackingProjectId(projectId);
  const projectContext = useProjectContext(projectId);
  const snapshot = getProjectMonitoringSnapshot(backingProjectId);

  if (!project) notFound();

  if (projectContext?.environment === 'pre_prod' && !projectContext.monitoringEnabled) {
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
          <span className="text-foreground">Monitoring</span>
        </nav>

        <section className="rounded-lg border border-border-muted bg-background-subtle p-8">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight">Monitoring is locked</h1>
            <p className="mt-2 text-sm leading-6 text-foreground-muted">
              Run the pre-prod evaluation first. Monitoring unlocks once the evaluation starts and
              the product activates the run control plane.
            </p>
            <div className="mt-5">
              <Link
                href={`/projects/${project.id}/evaluations/new?mode=pre_prod&agentId=${projectContext.selectedAgentId}${projectContext.selectedVersionId ? `&versionId=${projectContext.selectedVersionId}` : ''}`}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
              >
                Run Pre-prod Evaluation
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    );
  }

  if (!snapshot) notFound();

  const incidents = getProjectMonitoringIncidents(backingProjectId);
  const prodRun = getProjectRuns(backingProjectId).find((run) => run.mode === 'prod');
  const app = apps.find((item) => item.id === snapshot.activeAppId);

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
        <span className="text-foreground">Monitoring</span>
      </nav>

      <header className="flex flex-col gap-4 border-b border-border-muted pb-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
            <StatusPill tone={healthTone(snapshot.health)}>{snapshot.health.replace('_', ' ')}</StatusPill>
          </div>
          <p className="mt-1.5 max-w-3xl text-xs text-foreground-muted">
            Real-time health, validator outcomes, drift detection, and operator controls for{' '}
            {project.name}.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label="Active agent" value={app?.name ?? snapshot.activeAppId} detail={`Monitoring ${snapshot.activeVersionId.replace('ver_', '').toUpperCase()}`} icon="bot" />
        <SummaryTile label="Success rate" value={snapshot.successRate} detail={`Policy incidents: ${snapshot.policyIncidents}`} icon="shield" />
        <SummaryTile label="Latency" value={snapshot.p95Latency} detail={`Tool failure rate ${snapshot.toolFailureRate}`} icon="gauge" />
        <SummaryTile label="Drift score" value={snapshot.driftScore} detail={`${snapshot.activeAlerts} active alerts`} icon="database" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <SectionCard
          title="Live health"
          subtitle="A condensed operator view of the current production state."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <HealthCard
              title="Continuous validators"
              value="Routing and policy stable"
              detail="3 validators active · 1 warning-level finding"
              icon={<ShieldCheck className="size-4 text-success" />}
            />
            <HealthCard
              title="Drift"
              value="Clarification drift +5.1"
              detail="Concentrated in ambiguous card nickname handling"
              icon={<Radar className="size-4 text-warning" />}
            />
            <HealthCard
              title="Cost"
              value={snapshot.runCost}
              detail="Within project override budget"
              icon={<Gauge className="size-4 text-foreground-subtle" />}
            />
            <HealthCard
              title="Traffic volume"
              value="8,420 sessions"
              detail="Last 7 days across digital and voice"
              icon={<Activity className="size-4 text-info" />}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Incident stream"
          subtitle="Recent operator-visible issues surfaced by production validation."
        >
          <div className="space-y-3">
            {incidents.map((incident) => (
              <div key={incident.id} className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className={`size-4 ${
                      incident.severity === 'critical'
                        ? 'text-error'
                        : incident.severity === 'warning'
                          ? 'text-warning'
                          : 'text-info'
                    }`}
                  />
                  <div className="text-sm font-medium">{incident.title}</div>
                  <StatusPill tone={incident.severity === 'critical' ? 'error' : incident.severity === 'warning' ? 'warning' : 'info'}>
                    {incident.severity}
                  </StatusPill>
                </div>
                <div className="mt-2 text-sm text-foreground-muted">{incident.detail}</div>
                <div className="mt-2 text-xs text-foreground-subtle">{incident.detectedAt}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <SectionCard
          title="Trace inspector"
          subtitle="Representative failing traces that explain the current warning state."
        >
          <div className="space-y-3">
            {prodRun?.topFailures.map((failure) => (
              <div key={failure.id} className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
                <div className="text-sm font-medium">{failure.title}</div>
                <div className="mt-2 text-sm text-foreground-muted">{failure.summary}</div>
                <div className="mt-3 rounded-md border border-border-muted bg-background px-3 py-2 text-xs text-foreground-subtle">
                  {failure.whyItFailed}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Operator questions"
          subtitle="This view should answer the core questions in real time."
        >
          <div className="space-y-3 text-sm text-foreground-muted">
            <QuestionRow question="What is happening now?" answer={`Production version ${snapshot.activeVersionId.replace('ver_', '').toUpperCase()} is live and healthy enough to continue, but warning-level drift is active.`} />
            <QuestionRow question="What decision did the system make?" answer={prodRun?.summary ?? 'No production analysis has completed yet.'} />
            <QuestionRow question="Is production safe?" answer="Yes for now. No blocking policy failures are open, but clarification drift should be reviewed." />
            <QuestionRow question="Can I stop it immediately?" answer="Yes. Kill switch and revert are available in the current project control plane." />
          </div>
          <Link
            href={`/projects/${project.id}/evaluations/${prodRun?.id ?? ''}`}
            className="mt-4 inline-flex items-center gap-2 text-sm text-foreground-muted transition-colors hover:text-foreground"
          >
            Open production run detail
            <ArrowRight className="size-3.5" />
          </Link>
        </SectionCard>
      </div>

      <Footer />
    </div>
  );
}

function HealthCard({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-foreground-meta">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-2 text-base font-semibold">{value}</div>
      <div className="mt-1 text-sm text-foreground-muted">{detail}</div>
    </div>
  );
}

function QuestionRow({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
      <div className="text-sm font-medium text-foreground">{question}</div>
      <div className="mt-1.5">{answer}</div>
    </div>
  );
}
