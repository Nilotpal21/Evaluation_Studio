'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Bot, CalendarRange, GitBranchPlus, Sparkles } from 'lucide-react';
import {
  getEvaluationAgentsForProject,
  getProjectRuns,
  getVersionById,
  type EvaluationMode,
} from '@/lib/mock-data';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { Footer } from '@/components/shell/Footer';
import { ControlsStrip, SectionCard, StatusPill } from '@/components/evaluation-studio/shared';
import { apps } from '@/lib/mock-data/apps';
import { useBackingProjectId, useProjectContext, useProjectState, useResolvedProject } from '@/lib/project-state';
import { cn } from '@/lib/utils';

const DURATIONS = ['Last 24 hours', 'Last 7 days', 'Last 30 days'] as const;

export default function NewEvaluationPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const project = useResolvedProject(params.projectId);
  const backingProjectId = useBackingProjectId(params.projectId);
  const projectContext = useProjectContext(params.projectId);
  const startPreProdRun = useProjectState((state) => state.startPreProdRun);
  const [mode, setMode] = useState<EvaluationMode>('pre_prod');
  const availableAgents = useMemo(
    () => (project ? getEvaluationAgentsForProject(backingProjectId, mode) : []),
    [backingProjectId, project, mode],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string>(availableAgents[0]?.id ?? '');
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [selectedDuration, setSelectedDuration] = useState<(typeof DURATIONS)[number]>('Last 7 days');
  const presetMode = searchParams.get('mode');
  const presetAgentId = searchParams.get('agentId');
  const presetVersionId = searchParams.get('versionId');
  const presetDuration = searchParams.get('duration');

  const currentAgent = useMemo(
    () => availableAgents.find((agent) => agent.id === selectedAgentId) ?? availableAgents[0],
    [availableAgents, selectedAgentId],
  );

  const candidateVersions = useMemo(() => {
    if (!currentAgent) return [];
    const profileRuns = getProjectRuns(backingProjectId).filter((run) => run.appId === currentAgent.id);
    return profileRuns
      .map((run) => (run.versionId ? getVersionById(run.versionId) : null))
      .filter((version): version is NonNullable<typeof version> => Boolean(version))
      .filter((version) => version.environment === 'candidate');
  }, [backingProjectId, currentAgent]);

  const defaultVersion = candidateVersions[0];
  const activeVersion = selectedVersionId
    ? getVersionById(selectedVersionId)
    : defaultVersion ?? null;

  useEffect(() => {
    const nextMode = searchParams.get('mode');
    if (nextMode === 'pre_prod' || nextMode === 'prod') {
      setMode(nextMode);
    }
  }, [searchParams]);

  useEffect(() => {
    const nextAgentId = searchParams.get('agentId');
    if (nextAgentId && availableAgents.some((agent) => agent.id === nextAgentId)) {
      setSelectedAgentId(nextAgentId);
      return;
    }

    if (projectContext?.selectedAgentId && availableAgents.some((agent) => agent.id === projectContext.selectedAgentId)) {
      setSelectedAgentId(projectContext.selectedAgentId);
      return;
    }

    if (availableAgents[0] && !availableAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(availableAgents[0].id);
    }
  }, [availableAgents, projectContext?.selectedAgentId, searchParams, selectedAgentId]);

  useEffect(() => {
    const nextVersionId = searchParams.get('versionId');
    if (mode === 'pre_prod' && nextVersionId && candidateVersions.some((version) => version.id === nextVersionId)) {
      setSelectedVersionId(nextVersionId);
      return;
    }

    if (mode === 'pre_prod' && candidateVersions[0] && !candidateVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(candidateVersions[0].id);
    }
  }, [candidateVersions, mode, searchParams, selectedVersionId]);

  useEffect(() => {
    const nextDuration = searchParams.get('duration') as (typeof DURATIONS)[number] | null;
    if (mode === 'prod' && nextDuration && DURATIONS.includes(nextDuration)) {
      setSelectedDuration(nextDuration);
    }
  }, [mode, searchParams]);

  if (!project) notFound();

  const preprodRunHref =
    currentAgent?.id === 'app_card_dispute_triage' || currentAgent?.id === 'app_fraud_triage'
      ? `/projects/${project.id}/evaluations/${
          currentAgent.id === 'app_card_dispute_triage'
            ? 'run_preprod_card_v24'
            : 'run_preprod_fraud_v11'
        }`
      : '';

  const prodRunHref =
    currentAgent?.id === 'app_card_dispute_triage'
      ? `/projects/${project.id}/evaluations/run_prod_card_7d`
      : '';

  const launchHref = mode === 'pre_prod' ? preprodRunHref : prodRunHref;
  const isPrefilledJourney =
    Boolean(presetMode && presetAgentId) &&
    ((presetMode === 'pre_prod' && Boolean(presetVersionId)) ||
      (presetMode === 'prod' && Boolean(presetDuration)));

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
        <span className="text-foreground">New evaluation</span>
      </nav>

      <header className="flex items-end justify-between gap-4 border-b border-border-muted pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isPrefilledJourney
              ? mode === 'pre_prod'
                ? 'Pre-prod evaluation ready'
                : 'Production analysis ready'
              : 'New evaluation'}
          </h1>
          <p className="mt-1.5 max-w-3xl text-xs text-foreground-muted">
            {isPrefilledJourney
              ? mode === 'pre_prod'
                ? 'Your candidate version is locked in. Start the pre-prod run and follow the product decision in real time.'
                : 'Your production scope is locked in. Start the live analysis and follow the health decision in real time.'
              : 'Choose the environment. Pre-prod qualifies a candidate version for promotion, while Prod analyzes live behavior over a selected window.'}
          </p>
        </div>
        <ControlsStrip projectId={project.id} />
      </header>

      <SectionCard
        title="Project context"
        subtitle="Evaluation Studio is always scoped to a single project."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <ContextMetric label="Project" value={project.name} detail={project.description} />
          <ContextMetric
            label="Pre-prod candidate agents"
            value={String(getEvaluationAgentsForProject(backingProjectId, 'pre_prod').length)}
            detail="Agents with at least one candidate version ready for qualification."
          />
          <ContextMetric
            label="Production agents"
            value={String(getEvaluationAgentsForProject(backingProjectId, 'prod').length)}
            detail="Agents currently serving production traffic in this project."
          />
        </div>
      </SectionCard>

      {!isPrefilledJourney ? (
        <>
          <SectionCard
            title="1. Choose environment"
            subtitle="The environment selection changes the journey and the dashboard."
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <ModeCard
                selected={mode === 'pre_prod'}
                title="Pre-prod"
                subtitle="Evaluate a candidate version using simulated sessions and promotion policy."
                icon={<GitBranchPlus className="size-5" />}
                onClick={() => {
                  setMode('pre_prod');
                  setSelectedVersionId('');
                }}
              />
              <ModeCard
                selected={mode === 'prod'}
                title="Prod"
                subtitle="Evaluate live production behavior using a selected production data window."
                icon={<CalendarRange className="size-5" />}
                onClick={() => setMode('prod')}
              />
            </div>
          </SectionCard>

          <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
            <SectionCard
              title={mode === 'pre_prod' ? '2. Select candidate agent and version' : '2. Select production agent and duration'}
              subtitle={
                mode === 'pre_prod'
                  ? 'Pre-prod will qualify one candidate build, then decide whether that version should promote.'
                  : 'Prod will collect live traffic for the selected window and score production health.'
              }
            >
              <div className="space-y-5">
                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-foreground-meta">Agent</div>
                  <div className="grid gap-2">
                    {availableAgents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setSelectedAgentId(agent.id);
                          setSelectedVersionId('');
                        }}
                        className={cn(
                          'rounded-lg border px-4 py-3 text-left transition-colors',
                          currentAgent?.id === agent.id
                            ? 'border-foreground bg-background-elevated'
                            : 'border-border-muted bg-background-muted/30 hover:bg-background-elevated/60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-mono text-sm">{agent.name}</div>
                            <div className="mt-0.5 text-xs text-foreground-muted">{agent.description}</div>
                          </div>
                          <Bot className="size-4 text-foreground-subtle" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {mode === 'pre_prod' ? (
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-foreground-meta">Version</div>
                    <div className="grid gap-2">
                      {candidateVersions.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-muted px-4 py-5 text-sm text-foreground-muted">
                          No seeded candidate versions yet for this agent.
                        </div>
                      ) : (
                        candidateVersions.map((version) => (
                          <button
                            key={version.id}
                            type="button"
                            onClick={() => setSelectedVersionId(version.id)}
                            className={cn(
                              'rounded-lg border px-4 py-3 text-left transition-colors',
                              (activeVersion?.id ?? defaultVersion?.id) === version.id
                                ? 'border-foreground bg-background-elevated'
                                : 'border-border-muted bg-background-muted/30 hover:bg-background-elevated/60',
                            )}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-medium">{version.label}</div>
                                <div className="mt-0.5 text-xs text-foreground-muted">{version.summary}</div>
                              </div>
                              <StatusPill tone="info">{version.model}</StatusPill>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-foreground-meta">Duration</div>
                    <div className="grid gap-2 md:grid-cols-3">
                      {DURATIONS.map((duration) => (
                        <button
                          key={duration}
                          type="button"
                          onClick={() => setSelectedDuration(duration)}
                          className={cn(
                            'rounded-lg border px-4 py-3 text-left text-sm transition-colors',
                            selectedDuration === duration
                              ? 'border-foreground bg-background-elevated'
                              : 'border-border-muted bg-background-muted/30 hover:bg-background-elevated/60',
                          )}
                        >
                          {duration}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard
              title={mode === 'pre_prod' ? '3. Launch pre-prod run' : '3. Launch production analysis'}
              subtitle={
                mode === 'pre_prod'
                  ? 'The product will decide whether this version should promote.'
                  : 'Validators will run on live production data for the selected window.'
              }
              right={<Sparkles className="size-4 text-purple" />}
            >
              <RunSummary
                projectName={project.name}
                mode={mode}
                agentName={currentAgent?.name ?? 'Select an agent'}
                versionLabel={activeVersion?.label ?? 'No version'}
                durationLabel={selectedDuration}
                launchHref={launchHref}
                bullets={
                  mode === 'pre_prod'
                    ? [
                        'Infer personas and expand pre-prod scenario coverage automatically.',
                        'Run simulated sessions and apply built-in plus project validators.',
                        'Unlock session evaluation and monitoring once the run starts.',
                      ]
                    : [
                        'Collect real production sessions for the selected window.',
                        'Run production validators and compare against baseline.',
                        'Surface health, drift, incidents, and operator controls in monitoring.',
                      ]
                }
                onRun={() => {
                  if (launchHref) {
                    if (mode === 'pre_prod') {
                      startPreProdRun(params.projectId);
                    }
                    router.push(launchHref);
                  }
                }}
              />
            </SectionCard>
          </div>
        </>
      ) : (
        <SectionCard
          title={mode === 'pre_prod' ? 'Pre-prod run ready' : 'Production analysis ready'}
          subtitle={
            mode === 'pre_prod'
              ? 'The configuration from project creation is already locked in. Start the pre-prod run and follow the promotion decision.'
              : 'The configuration from project creation is already locked in. Start the production analysis and follow the live health decision.'
          }
          right={<Sparkles className="size-4 text-purple" />}
        >
          <RunSummary
            projectName={project.name}
            mode={mode}
            agentName={currentAgent?.name ?? 'Select an agent'}
            versionLabel={activeVersion?.label ?? 'No version'}
            durationLabel={selectedDuration}
            launchHref={launchHref}
            bullets={
              mode === 'pre_prod'
                ? [
                    'Infer personas and expand pre-prod scenario coverage automatically.',
                    'Run simulated sessions and apply built-in plus project validators.',
                    'Unlock session evaluation and monitoring once the run starts.',
                  ]
                : [
                    'Collect real production sessions for the selected window.',
                    'Run production validators and compare against baseline.',
                    'Surface health, drift, incidents, and operator controls in monitoring.',
                  ]
            }
            onRun={() => {
              if (launchHref) {
                if (mode === 'pre_prod') {
                  startPreProdRun(params.projectId);
                }
                router.push(launchHref);
              }
            }}
          />
        </SectionCard>
      )}

      <Footer />
    </div>
  );
}

function RunSummary({
  projectName,
  mode,
  agentName,
  versionLabel,
  durationLabel,
  launchHref,
  bullets,
  onRun,
}: {
  projectName: string;
  mode: EvaluationMode;
  agentName: string;
  versionLabel: string;
  durationLabel: string;
  launchHref: string;
  bullets: string[];
  onRun: () => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
        <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Selected path</div>
        <div className="mt-2 text-base font-semibold">
          {projectName} → {mode === 'pre_prod' ? 'Pre-prod' : 'Prod'} → {agentName}
          {mode === 'pre_prod' ? ` → ${versionLabel}` : ` → ${durationLabel}`}
        </div>
        <p className="mt-2 text-xs text-foreground-muted">
          {mode === 'pre_prod'
            ? 'The platform will ingest the chosen version, infer personas, generate scenarios, run simulations, apply validators, resolve benchmark overrides, and make the promotion decision.'
            : 'The platform will fetch production sessions for the chosen duration, run validators, compare against baseline, and surface drift, regression, and health findings.'}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-border-muted p-4">
        <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Expected automation</div>
        <ul className="space-y-2 text-xs text-foreground-muted">
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!launchHref}
          onClick={onRun}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'pre_prod' ? 'Run Pre-prod Evaluation' : 'Run Production Analysis'}
          <ArrowRight className="size-4" />
        </button>
      </div>
      {!launchHref ? (
        <p className="text-xs text-warning">
          This prototype has seeded run detail for card-dispute and fraud-triage only.
        </p>
      ) : null}
    </div>
  );
}

function ModeCard({
  selected,
  title,
  subtitle,
  icon,
  onClick,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border p-4 text-left transition-colors',
        selected ? 'border-foreground bg-background-elevated' : 'border-border-muted bg-background-muted/30 hover:bg-background-elevated/60',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{title}</div>
          <div className="mt-1 text-sm text-foreground-muted">{subtitle}</div>
        </div>
        <div className="text-foreground-subtle">{icon}</div>
      </div>
    </button>
  );
}

function ContextMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background-muted/30 p-4">
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-foreground-muted">{detail}</div>
    </div>
  );
}
