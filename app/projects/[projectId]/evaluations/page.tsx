'use client';

import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { ArrowRight, FolderGit2, Plus } from 'lucide-react';
import {
  getProjectMonitoringIncidents,
  getProjectMonitoringSnapshot,
  getProjectRuns,
} from '@/lib/mock-data';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { Footer } from '@/components/shell/Footer';
import { ControlsStrip, RunTable, SummaryTile } from '@/components/evaluation-studio/shared';
import { useBackingProjectId, useResolvedProject } from '@/lib/project-state';

export default function ProjectEvaluationsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useResolvedProject(projectId);
  const backingProjectId = useBackingProjectId(projectId);
  if (!project) notFound();

  const runs = getProjectRuns(backingProjectId);
  const monitoring = getProjectMonitoringSnapshot(backingProjectId);
  const incidents = getProjectMonitoringIncidents(backingProjectId);
  const latestPreProd = runs.find((run) => run.mode === 'pre_prod');
  const latestProd = runs.find((run) => run.mode === 'prod');

  return (
    <div className="space-y-6">
      <SyncActiveProject projectId={project.id} />

      <nav className="flex items-center gap-2 text-xs text-foreground-muted">
        <Link href="/projects" className="transition-colors hover:text-foreground">
          Projects
        </Link>
        <span>/</span>
        <Link href={`/projects/${project.id}`} className="transition-colors hover:text-foreground">
          {project.name}
        </Link>
        <span>/</span>
        <span className="text-foreground">Evaluations</span>
      </nav>

      <header className="flex items-end justify-between gap-4 border-b border-border-muted pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evaluation Studio</h1>
          <p className="mt-1.5 max-w-3xl text-xs text-foreground-muted">
            Run autonomous evaluations in pre-prod or production. Promotion, monitoring, and
            operator controls stay scoped to {project.name}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${project.id}/evaluations/new`}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
          >
            <Plus className="size-4" />
            New evaluation
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Latest pre-prod outcome"
          value={latestPreProd ? (latestPreProd.decision ?? latestPreProd.status).replace('_', ' ') : 'None'}
          detail={latestPreProd ? latestPreProd.summary : 'No pre-prod evaluations yet'}
          icon="shield"
        />
        <SummaryTile
          label="Latest prod health"
          value={latestProd ? (latestProd.health ?? latestProd.status).replace('_', ' ') : 'None'}
          detail={latestProd ? latestProd.summary : 'No production analyses yet'}
          icon="gauge"
        />
        <SummaryTile
          label="Active production version"
          value={monitoring?.activeVersionId.replace('ver_', '').toUpperCase() ?? '—'}
          detail={monitoring ? `Monitoring ${monitoring.activeAlerts} active alerts` : 'No live monitoring snapshot'}
          icon="bot"
        />
        <SummaryTile
          label="Open incidents"
          value={String(incidents.length)}
          detail={incidents[0]?.title ?? 'No active incidents'}
          icon="database"
        />
      </div>

      <section className="rounded-lg border border-border-muted bg-background-subtle p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Operator controls</div>
            <div className="mt-0.5 text-xs text-foreground-muted">
              Autonomous promotion is enabled, but operators can always revert or stop traffic.
            </div>
          </div>
          <ControlsStrip projectId={project.id} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Evaluation history</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Project-scoped pre-prod qualification runs and production analyses.
            </p>
          </div>
          <Link
            href={`/projects/${project.id}/validators`}
            className="inline-flex items-center gap-1 text-xs text-foreground-muted transition-colors hover:text-foreground"
          >
            Open validators
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
        {runs.length > 0 ? (
          <RunTable runs={runs} projectId={project.id} />
        ) : (
          <div className="rounded-lg border border-dashed border-border-muted bg-background-subtle px-6 py-12 text-center text-sm text-foreground-muted">
            No evaluations yet. Create the first run for this project.
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border-muted bg-background-subtle p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FolderGit2 className="size-4 text-foreground-muted" />
          Flow summary
        </div>
        <p className="mt-2 text-sm text-foreground-muted">
          Users first choose the project, then `Pre-prod` or `Prod`. Pre-prod reveals an agent and
          version picker, then the product decides whether to promote. Prod reveals an agent and a
          duration picker, then validators run against real production data and surface health,
          drift, and incidents on the monitoring dashboard.
        </p>
      </section>

      <Footer />
    </div>
  );
}
