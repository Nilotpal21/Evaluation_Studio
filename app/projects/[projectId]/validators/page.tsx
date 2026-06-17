'use client';

import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import {
  getProjectValidators,
} from '@/lib/mock-data';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { Footer } from '@/components/shell/Footer';
import { ValidatorCatalog } from '@/components/evaluation-studio/ValidatorCatalog';
import { ValidatorsToolbar } from '@/components/evaluation-studio/ValidatorsToolbar';
import { useBackingProjectId, useResolvedProject } from '@/lib/project-state';
import {
  SectionCard,
  SummaryTile,
} from '@/components/evaluation-studio/shared';

export default function ProjectValidatorsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useResolvedProject(projectId);
  const backingProjectId = useBackingProjectId(projectId);
  if (!project) notFound();

  const validators = getProjectValidators(backingProjectId);
  const customCount = validators.filter((validator) => validator.kind === 'custom').length;
  const overrideCount = validators.filter((validator) => validator.benchmarkOrigin === 'project_override').length;
  const blockingCount = validators.filter((validator) => validator.blockingInPreProd).length;

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
        <span className="text-foreground">Validators</span>
      </nav>

      <header className="flex flex-col gap-4 border-b border-border-muted pb-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Validators</h1>
          <p className="mt-1.5 max-w-3xl text-xs text-foreground-muted">
            Manage built-in and custom validators, benchmark overrides, golden answers, and
            knowledge links for {project.name}.
          </p>
        </div>
        <ValidatorsToolbar />
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Total validators"
          value={String(validators.length)}
          detail="Built-in and custom validators auto-apply at project scope."
          icon="shield"
        />
        <SummaryTile
          label="Custom validators"
          value={String(customCount)}
          detail="Reusable business logic owned by the project."
          icon="bot"
        />
        <SummaryTile
          label="Benchmark overrides"
          value={String(overrideCount)}
          detail="Project-level threshold overrides above platform defaults."
          icon="gauge"
        />
        <SummaryTile
          label="Blocking gates"
          value={String(blockingCount)}
          detail="Validators that can stop pre-prod promotion."
          icon="database"
        />
      </div>

      <SectionCard
        title="Validator catalog"
        subtitle="Benchmark ownership is always visible as platform default or project override."
      >
        <ValidatorCatalog validators={validators} />
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <SectionCard
          title="How validators are used"
          subtitle="Validators are configured once and auto-applied by Evaluation Studio."
        >
          <div className="space-y-3 text-sm text-foreground-muted">
            <p>
              Users do not manually select validators for each run. Once defined at the project
              level, the platform attaches built-in validators plus any relevant custom validators
              based on agent, environment, and benchmark policy.
            </p>
            <p>
              In `Pre-prod`, validator benchmark results drive the product&apos;s promotion decision.
              In `Prod`, the same validator layer scores live sessions, detects drift, and surfaces
              incidents on the monitoring dashboard.
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="Linked assets"
          subtitle="Custom validators can attach to golden answers and knowledge sources."
        >
          <div className="space-y-3">
            {validators
              .filter((validator) => validator.kind === 'custom')
              .map((validator) => (
                <div key={validator.id} className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
                  <div className="text-sm font-medium">{validator.name}</div>
                  <div className="mt-2 text-xs text-foreground-muted">
                    Golden answers: {validator.linkedGoldens.join(', ') || 'None'}
                  </div>
                  <div className="mt-1 text-xs text-foreground-muted">
                    Knowledge bases: {validator.linkedKnowledgeBases.join(', ') || 'None'}
                  </div>
                  <div className="mt-2 text-xs text-foreground-subtle">
                    Threshold: {validator.benchmarkLabel} · {validator.blockingInPreProd ? 'Blocking in pre-prod' : 'Advisory'}
                  </div>
                </div>
              ))}
          </div>
        </SectionCard>
      </div>

      <Footer />
    </div>
  );
}
